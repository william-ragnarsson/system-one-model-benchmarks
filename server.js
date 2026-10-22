// Image sort: a tiny local server that ranks images against a prompt with the
// OpenAI Decisions API (gpt-6-luna) and records speed, tokens and cost per run.
// No dependencies. Run with `npm start` (reads OPENAI_API_KEY from .env).

import { createServer } from 'node:http'
import { readFile, appendFile } from 'node:fs/promises'
import { join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(ROOT, 'public')
const IMAGES_DIR = join(ROOT, 'data', 'animals')
const RUNS_FILE = join(ROOT, 'runs.jsonl')

const PORT = Number(process.env.PORT) || 3000
const CONCURRENCY = Number(process.env.CONCURRENCY) || 8
const MODEL = 'gpt-6-luna'
const ENDPOINT = `${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/decisions`
// gpt-6-luna on /v1/decisions bills input tokens only: $0.10 per 1M, no output or cache charges.
const USD_PER_INPUT_TOKEN = 0.1 / 1_000_000
const MAX_RETRIES = 3
const REQUEST_TIMEOUT_MS = 60_000

const SCORE_LEVELS = ['Not at all', 'Slightly', 'Moderately', 'Very', 'Extremely'].map(label => ({ label }))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

// ---------- Decisions API ----------

function buildQuestion(type, prompt) {
  const asked = prompt.endsWith('?')
  if (type === 'score') {
    return {
      type: 'score',
      name: 'match',
      instructions: asked ? prompt : `How well does this image match the description: "${prompt}"?`,
      levels: SCORE_LEVELS,
    }
  }
  return {
    type: 'predicate',
    name: 'match',
    instructions: asked ? prompt : `Does this image match the description: "${prompt}"?`,
  }
}

async function decide({ dataUrl, question, detail, signal }) {
  const body = JSON.stringify({
    model: MODEL,
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: dataUrl, detail }] }],
    questions: [question],
  })
  for (let attempt = 0; ; attempt++) {
    const started = performance.now()
    let res, json
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      })
      json = await res.json().catch(() => null)
    } catch (err) {
      // Network failures and timeouts are retried; a cancelled run is not.
      if (signal.aborted || attempt >= MAX_RETRIES) {
        throw err.name === 'TimeoutError' ? new Error(`No answer within ${REQUEST_TIMEOUT_MS / 1000} s`) : err
      }
      await sleep(retryDelayMs(null, attempt), signal)
      continue
    }
    const latencyMs = performance.now() - started
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(res, attempt), signal)
      continue
    }
    if (!res.ok) throw Object.assign(new Error(json?.error?.message || `HTTP ${res.status}`), { status: res.status })
    return {
      json,
      latencyMs,
      processingMs: Number(res.headers.get('openai-processing-ms')) || null,
      retries: attempt,
    }
  }
}

function retryDelayMs(res, attempt) {
  const header = Number(res?.headers.get('retry-after'))
  return Number.isFinite(header) && header > 0 ? header * 1000 : 500 * 2 ** attempt
}

function sleep(ms, signal) {
  return new Promise((done, fail) => {
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason) }, { once: true })
  })
}

// ---------- Images ----------

const dataUrlCache = new Map()

// manifest.json: { dataset: { name, url, license }, images: [{ file, label, ... }] }
async function loadDataset() {
  try {
    const { dataset = null, images = [] } = JSON.parse(await readFile(join(IMAGES_DIR, 'manifest.json'), 'utf8'))
    return { dataset, images }
  } catch {
    return { dataset: null, images: [] }
  }
}

async function imageDataUrl(file) {
  if (!dataUrlCache.has(file)) {
    const bytes = await readFile(join(IMAGES_DIR, file))
    const mime = MIME[extname(file).toLowerCase()] || 'image/jpeg'
    dataUrlCache.set(file, `data:${mime};base64,${bytes.toString('base64')}`)
  }
  return dataUrlCache.get(file)
}

// ---------- Sorting ----------

async function mapPool(items, limit, fn) {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function handleSort(req, res) {
  const { prompt: rawPrompt, type = 'predicate', detail = 'auto' } = await readJson(req)
  const prompt = String(rawPrompt ?? '').trim().slice(0, 500)
  if (!prompt) return sendJson(res, 400, { error: 'Enter a prompt to sort by.' })
  if (!['predicate', 'score'].includes(type)) return sendJson(res, 400, { error: 'Unknown question type.' })
  if (!['auto', 'low', 'high'].includes(detail)) return sendJson(res, 400, { error: 'Unknown image detail.' })
  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 400, { error: 'OPENAI_API_KEY is not set. Add it to .env and restart the server.' })
  }
  const { images } = await loadDataset()
  if (!images.length) return sendJson(res, 400, { error: 'No images found. Run `npm run fetch-images` first.' })

  const question = buildQuestion(type, prompt)
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableFinished) controller.abort() })

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
  const send = message => res.write(JSON.stringify(message) + '\n')
  send({ type: 'start', total: images.length, question })

  const items = []
  let fatal = null // a bad key or missing access fails every request, so stop at the first one
  const started = performance.now()
  await mapPool(images, CONCURRENCY, async image => {
    if (controller.signal.aborted) return
    const item = { id: image.file }
    try {
      const result = await decide({ dataUrl: await imageDataUrl(image.file), question, detail, signal: controller.signal })
      const answer = result.json?.answers?.[0]
      item.latency_ms = Math.round(result.latencyMs)
      item.processing_ms = result.processingMs
      item.retries = result.retries
      item.input_tokens = result.json?.usage?.input_tokens ?? 0
      item.cost_usd = item.input_tokens * USD_PER_INPUT_TOKEN
      if (answer?.type === 'predicate') item.value = answer.probability
      else if (answer?.type === 'score') Object.assign(item, { value: answer.score, confidence: answer.confidence })
      else if (answer?.type === 'refusal') item.refused = true
      else item.error = 'Unexpected answer from the API.'
    } catch (err) {
      if (controller.signal.aborted) return
      if (err.status === 401 || err.status === 403) {
        fatal = err.message
        return controller.abort()
      }
      item.error = err.message
    }
    items.push(item)
    send({ type: 'item', ...item })
  })
  if (fatal) {
    send({ type: 'error', error: fatal })
    return res.end()
  }
  if (controller.signal.aborted) return

  const run = summarize({ prompt, type, detail, question, items, wallMs: performance.now() - started })
  await appendFile(RUNS_FILE, JSON.stringify(run) + '\n').catch(err => console.error('Could not write runs.jsonl:', err.message))
  send({ type: 'done', run })
  res.end()
}

function summarize({ prompt, type, detail, question, items, wallMs }) {
  const answered = items.filter(item => item.value != null)
  const latencies = answered.map(item => item.latency_ms).sort((a, b) => a - b)
  const inputTokens = items.reduce((total, item) => total + (item.input_tokens || 0), 0)
  const costUsd = inputTokens * USD_PER_INPUT_TOKEN
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    model: MODEL,
    prompt,
    type,
    detail,
    instructions: question.instructions,
    concurrency: CONCURRENCY,
    images: items.length,
    answered: answered.length,
    refused: items.filter(item => item.refused).length,
    errors: items.filter(item => item.error).length,
    retries: items.reduce((total, item) => total + (item.retries || 0), 0),
    wall_ms: Math.round(wallMs),
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      mean: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    },
    images_per_second: items.length ? +(items.length / (wallMs / 1000)).toFixed(2) : 0,
    input_tokens: inputTokens,
    tokens_per_image: answered.length ? Math.round(inputTokens / answered.length) : null,
    cost_usd: costUsd,
    cost_per_1k_images_usd: answered.length ? (costUsd / answered.length) * 1000 : null,
  }
}

function percentile(sorted, q) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}

async function readRuns() {
  try {
    const lines = (await readFile(RUNS_FILE, 'utf8')).trim().split('\n').filter(Boolean)
    return lines.slice(-50).reverse().map(line => JSON.parse(line))
  } catch {
    return []
  }
}

// ---------- HTTP ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 10_000) break
  }
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function serveFile(res, baseDir, relativePath) {
  try {
    const filePath = resolve(baseDir, '.' + decodeURIComponent(relativePath))
    if (!filePath.startsWith(baseDir + sep)) return sendJson(res, 404, { error: 'Not found' })
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' })
    res.end(body)
  } catch {
    sendJson(res, 404, { error: 'Not found' })
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'POST' && pathname === '/api/sort') return await handleSort(req, res)
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
    if (pathname === '/api/config') {
      return sendJson(res, 200, {
        model: MODEL,
        concurrency: CONCURRENCY,
        usdPerMillionInputTokens: USD_PER_INPUT_TOKEN * 1_000_000,
        hasKey: Boolean(process.env.OPENAI_API_KEY),
        ...(await loadDataset()),
      })
    }
    if (pathname === '/api/runs') return sendJson(res, 200, await readRuns())
    if (pathname.startsWith('/images/')) return await serveFile(res, IMAGES_DIR, pathname.slice('/images'.length))
    return await serveFile(res, PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname)
  } catch (err) {
    console.error(err)
    if (!res.headersSent) sendJson(res, 500, { error: err.message })
    else res.end()
  }
})

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Try PORT=3001 npm start.` : err.message)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Image sort running at http://localhost:${PORT}`)
  if (!process.env.OPENAI_API_KEY) console.log('OPENAI_API_KEY is not set yet. Add it to .env and restart.')
})
