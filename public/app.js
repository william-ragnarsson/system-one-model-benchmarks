const $ = selector => document.querySelector(selector)

const form = $('#form')
const promptInput = $('#prompt')
const typeSelect = $('#type')
const detailSelect = $('#detail')
const button = $('#go')
const grid = $('#grid')

const cards = new Map() // image file -> { el, image, result }
let running = null // AbortController of the active run

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 3 })
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')

init()

async function init() {
  let config
  try {
    config = await fetch('/api/config').then(res => res.json())
  } catch {
    return showNotice('Could not reach the server. Is `npm start` running?', true)
  }
  $('#model').textContent = `${config.model} · Decisions API`
  renderGrid(config.images)
  renderCredits(config.dataset)
  setStat('images', config.images.length)
  if (!config.images.length) showNotice('No images yet. Run `npm run fetch-images`, then reload.')
  else if (!config.hasKey) showNotice('Add your OpenAI API key to .env as OPENAI_API_KEY, then restart the server.')

  const runs = await fetch('/api/runs').then(res => res.json()).catch(() => [])
  for (const run of runs.reverse()) addRunRow(run)
}

// ---------- Sorting ----------

form.addEventListener('submit', event => {
  event.preventDefault()
  if (running) running.abort()
  else sort()
})

for (const link of document.querySelectorAll('.examples .link')) {
  link.addEventListener('click', () => {
    if (running) return
    promptInput.value = link.textContent
    form.requestSubmit()
  })
}

async function sort() {
  const prompt = promptInput.value.trim()
  if (!prompt || !cards.size) return
  const type = typeSelect.value
  const detail = detailSelect.value

  running = new AbortController()
  setRunning(true)
  hideNotice()
  resetCards()

  const live = { total: cards.size, done: 0, tokens: 0, cost: 0, latencies: [], errors: [], started: performance.now() }
  const ticker = setInterval(() => renderLive(live), 100)
  try {
    const res = await fetch('/api/sort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, type, detail }),
      signal: running.signal,
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`)

    for await (const message of readLines(res.body)) {
      if (message.type === 'start') live.total = message.total
      if (message.type === 'item') {
        applyResult(message, type)
        live.done++
        live.tokens += message.input_tokens || 0
        live.cost += message.cost_usd || 0
        if (message.value != null) live.latencies.push(message.latency_ms)
        if (message.error) live.errors.push(message.error)
      }
      if (message.type === 'done') live.run = message.run
      if (message.type === 'error') throw new Error(message.error)
    }
  } catch (err) {
    if (err.name !== 'AbortError') live.failure = err.message
  } finally {
    clearInterval(ticker)
    running = null
    setRunning(false)
  }

  if (live.run) {
    renderRun(live.run)
    addRunRow(live.run)
  } else {
    renderLive(live)
  }
  if (live.done) arrange(type)
  else for (const card of cards.values()) card.el.classList.remove('pending')

  if (live.failure) showNotice(live.failure, true)
  else if (live.errors.length) showNotice(`${live.errors.length} of ${live.total} images failed: ${live.errors[0]}`, true)
}

async function* readLines(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) if (line.trim()) yield JSON.parse(line)
  }
}

function setRunning(isRunning) {
  button.textContent = isRunning ? 'Stop' : 'Sort'
  typeSelect.disabled = isRunning
  detailSelect.disabled = isRunning
  promptInput.readOnly = isRunning
}

// ---------- Grid ----------

function renderGrid(images) {
  grid.replaceChildren()
  cards.clear()
  for (const image of images) {
    const el = document.createElement('figure')
    el.className = 'card'
    el.innerHTML = `
      <a target="_blank" rel="noreferrer"><img loading="lazy" decoding="async" alt=""></a>
      <figcaption><span class="label"><span class="rank"></span><span class="name"></span></span><span class="value"></span></figcaption>
      <div class="meter"><i></i></div>`
    if (image.source) el.querySelector('a').href = image.source
    el.querySelector('img').src = `/images/${encodeURI(image.thumb || image.file)}`
    el.querySelector('img').alt = image.label
    el.querySelector('.name').textContent = image.label
    el.title = [image.label, credit(image)].filter(Boolean).join('\n')
    grid.append(el)
    cards.set(image.file, { el, image, result: null })
  }
}

function resetCards() {
  for (const card of cards.values()) {
    card.result = null
    card.el.classList.add('pending')
    card.el.classList.remove('failed')
    card.el.style.opacity = ''
    card.el.querySelector('.rank').textContent = ''
    card.el.querySelector('.value').textContent = ''
    card.el.querySelector('.meter i').style.width = '0'
    card.el.title = [card.image.label, credit(card.image)].filter(Boolean).join('\n')
  }
  $('#bar').style.width = '0'
}

function applyResult(result, type) {
  const card = cards.get(result.id)
  if (!card) return
  card.result = { ...result, strength: result.value == null ? null : type === 'score' ? result.value / 4 : result.value }
  card.el.classList.remove('pending')
  const value = card.el.querySelector('.value')
  if (card.result.strength == null) {
    card.el.classList.add('failed')
    value.textContent = result.refused ? 'refused' : 'error'
    card.el.title = [
      card.image.label,
      result.refused ? 'The model declined to answer.' : result.error,
      credit(card.image),
    ].filter(Boolean).join('\n')
    return
  }
  value.textContent = result.value.toFixed(2)
  card.el.querySelector('.meter i').style.width = `${card.result.strength * 100}%`
  card.el.title = [
    card.image.label,
    `${type === 'score' ? 'score' : 'probability'} ${result.value.toFixed(3)}${result.confidence != null ? ` · confidence ${result.confidence.toFixed(2)}` : ''}`,
    `${formatMs(result.latency_ms)} · ${formatInt(result.input_tokens)} tokens · ${usd.format(result.cost_usd)}`,
    credit(card.image),
  ].filter(Boolean).join('\n')
}

function credit(image) {
  return image.author ? `Photo: ${image.author} (${image.license})` : ''
}

// Reorders cards by strength, animating each card from its old slot (FLIP).
function arrange() {
  const entries = [...cards.values()]
  const before = new Map(entries.map(card => [card, card.el.getBoundingClientRect()]))
  entries.sort((a, b) => (b.result?.strength ?? -1) - (a.result?.strength ?? -1))

  entries.forEach((card, index) => {
    grid.append(card.el)
    const strength = card.result?.strength
    card.el.querySelector('.rank').textContent = strength == null ? '' : `${index + 1}`
    card.el.style.opacity = card.result ? 0.35 + 0.65 * (strength ?? 0) : ''
  })

  if (reduceMotion.matches) return
  for (const card of entries) {
    const from = before.get(card)
    const to = card.el.getBoundingClientRect()
    const dx = from.left - to.left
    const dy = from.top - to.top
    if (!dx && !dy) continue
    card.el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 500, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
    )
  }
}

// ---------- Stats ----------

function setStat(key, text) {
  $(`#s-${key}`).textContent = text ?? '—'
}

function renderLive(live) {
  const latencies = [...live.latencies].sort((a, b) => a - b)
  setStat('images', `${live.done} / ${live.total}`)
  setStat('wall', formatMs(performance.now() - live.started))
  setStat('p50', formatMs(percentile(latencies, 0.5)))
  setStat('p95', formatMs(percentile(latencies, 0.95)))
  setStat('tokens', formatInt(live.tokens))
  setStat('cost', usd.format(live.cost))
  $('#bar').style.width = `${(live.done / Math.max(live.total, 1)) * 100}%`
}

function renderRun(run) {
  setStat('images', run.answered === run.images ? formatInt(run.images) : `${run.answered} / ${run.images}`)
  setStat('wall', formatMs(run.wall_ms))
  setStat('p50', formatMs(run.latency_ms.p50))
  setStat('p95', formatMs(run.latency_ms.p95))
  setStat('tokens', formatInt(run.input_tokens))
  setStat('cost', usd.format(run.cost_usd))
  $('#bar').style.width = '100%'
}

function addRunRow(run) {
  const row = document.createElement('tr')
  const cells = [
    run.prompt,
    run.type,
    run.detail,
    run.answered === run.images ? formatInt(run.images) : `${run.answered} / ${run.images}`,
    formatMs(run.wall_ms),
    formatMs(run.latency_ms.p50),
    formatMs(run.latency_ms.p95),
    formatInt(run.tokens_per_image),
    usd.format(run.cost_usd),
    run.cost_per_1k_images_usd == null ? '—' : usd.format(run.cost_per_1k_images_usd),
  ]
  cells.forEach((text, index) => {
    const cell = document.createElement('td')
    cell.textContent = text
    if (index === 0) {
      cell.className = 'prompt'
      cell.title = `${run.instructions}\n${new Date(run.at).toLocaleString()} · concurrency ${run.concurrency}`
    }
    if (index >= 3) cell.className = 'num'
    row.append(cell)
  })
  $('#runs').prepend(row)
  $('#runs-section').hidden = false
}

function renderCredits(dataset) {
  if (!dataset) return
  const footer = $('#credits')
  footer.append('Images: ')
  const link = document.createElement('a')
  link.href = dataset.url
  link.textContent = dataset.name
  link.target = '_blank'
  link.rel = 'noreferrer'
  footer.append(link, ` · ${dataset.license}`)
}

// ---------- Helpers ----------

function showNotice(text, isError = false) {
  const notice = $('#notice')
  notice.textContent = text
  notice.classList.toggle('error', isError)
  notice.hidden = false
}

function hideNotice() {
  $('#notice').hidden = true
}

function percentile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null
}

function formatMs(ms) {
  if (ms == null) return '—'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

function formatInt(n) {
  return n == null ? '—' : Math.round(n).toLocaleString('en-US')
}
