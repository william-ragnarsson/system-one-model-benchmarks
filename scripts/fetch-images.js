// Downloads the benchmark photo set from iNaturalist into data/animals/ and
// writes data/animals/manifest.json with per-photo credits.
// The photos are fixed (hand-picked: wild, live, adult, clearly visible), so every
// run benchmarks the same images. Each is CC0, CC BY or CC BY-SA; the license is
// checked again at download time and a photo that is no longer open is skipped.
// No dependencies. Run with `npm run fetch-images`.

import { mkdir, writeFile, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'data', 'animals')
const STAGING_DIR = join(ROOT, 'data', 'animals.partial')

const API = 'https://api.inaturalist.org/v1/observations'
const USER_AGENT = 'image-sort-demo/1.0 (local Decisions API experiment)'
const LICENSES = { cc0: 'CC0', 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA' }
const MAX_BYTES = 5_000_000
const CONCURRENCY = 6

// [label, scientific name, [[observation id, photo id], ...]]
const SPECIES = [
  ['Red Fox', 'Vulpes vulpes', [[327531235, 593398391], [402187737, 738292839], [256126734, 459151238], [391324915, 717114864]]],
  ['Brown Bear', 'Ursus arctos', [[7383584, 9581603], [341909940, 622529310], [233025196, 474060144], [87006625, 143431038]]],
  ['Lion', 'Panthera leo', [[173202924, 300761357], [167180005, 289580771], [232752709, 413545038], [198038785, 348945460]]],
  ['African Elephant', 'Loxodonta africana', [[168473708, 291978089], [9007458, 12142906], [81255880, 133261867], [263054828, 472504104]]],
  ['Giraffe', 'Giraffa camelopardalis', [[135250760, 230653911], [330772102, 599886814], [103096805, 172476625], [323129116, 584655415]]],
  ['Plains Zebra', 'Equus quagga', [[149930971, 258420669], [263431074, 473246789], [329861775, 598019998], [40541314, 64247864]]],
  ['Raccoon', 'Procyon lotor', [[92187738, 152599960], [20268994, 31287367], [71083736, 115673384], [382432010, 699857811]]],
  ['European Hedgehog', 'Erinaceus europaeus', [[75452190, 123442029], [108408844, 182510741], [92774302, 153867116], [139510169, 238629199]]],
  ['Harbor Seal', 'Phoca vitulina', [[256033124, 458950602], [6009752, 7517869], [138882789, 237436448], [247424184, 441905584]]],
  ['Atlantic Puffin', 'Fratercula arctica', [[289718369, 521111435], [369082417, 674153269], [68675589, 111264146], [134736229, 229711100]]],
  ['Mallard', 'Anas platyrhynchos', [[105737491, 177479326], [77299726, 126405965], [102309744, 170994987], [386587253, 707837603]]],
  ['Bald Eagle', 'Haliaeetus leucocephalus', [[335312498, 609117510], [340586345, 619825586], [138673200, 237064888], [242913275, 433087982]]],
  ['Snowy Owl', 'Bubo scandiacus', [[149963344, 258497308], [335138164, 608770258], [145403722, 249744250], [349173164, 636925064]]],
  ['Greater Flamingo', 'Phoenicopterus roseus', [[394274362, 722790411], [333175868, 604817941], [194434248, 341772675], [40071777, 63643138]]],
  ['Gentoo Penguin', 'Pygoscelis papua', [[328339621, 594952616], [330641776, 599617902], [107779876, 181340774], [331042688, 600445805]]],
  ['Green Sea Turtle', 'Chelonia mydas', [[344728191, 628142457], [174049806, 302330911], [171899441, 298340064], [101710521, 169882479]]],
  ['American Alligator', 'Alligator mississippiensis', [[64144514, 103077585], [192978716, 338897013], [164465843, 286583752], [314451567, 567942962]]],
  ['Red-eyed Tree Frog', 'Agalychnis callidryas', [[25105320, 38855688], [34514515, 54328519], [338092905, 614762736], [128252755, 217833049]]],
  ['Western Diamondback Rattlesnake', 'Crotalus atrox', [[207984725, 367941864], [131264240, 223352064], [247247939, 441550574], [396258749, 726683522]]],
  ['Clownfish', 'Amphiprion ocellaris', [[1531121, 1896976], [302589833, 545328431], [205426436, 363228268], [186386610, 325718858]]],
  ['Common Octopus', 'Octopus vulgaris', [[390869532, 716139824], [180420305, 314274588], [178998163, 311559730], [289308645, 520346293]]],
  ['Monarch Butterfly', 'Danaus plexippus', [[28901993, 45078365], [95204643, 158023996], [32099392, 50313084], [101410048, 169360078]]],
  ['Honey Bee', 'Apis mellifera', [[301604008, 543495083], [240243997, 427994325], [76894506, 125759166], [267774084, 481248861]]],
  ['Garden Spider', 'Araneus diadematus', [[313988012, 567070727], [313153217, 565480914], [94571031, 156895100], [135775005, 231629787]]],
]

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function lookupObservations(ids) {
  const params = new URLSearchParams({ id: ids.join(','), per_page: '200' })
  const res = await fetch(`${API}?${params}`, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`iNaturalist lookup failed: HTTP ${res.status}`)
  const { results } = await res.json()
  return new Map(results.map(observation => [observation.id, observation]))
}

async function download(url) {
  let bytes
  for (let attempt = 1; !bytes; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      bytes = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt === 3) throw err
      await new Promise(resolve => setTimeout(resolve, attempt * 2000))
    }
  }
  if (bytes.length > MAX_BYTES) throw new Error(`Too large: ${url}`)
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { bytes, ext: '.jpg' }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { bytes, ext: '.png' }
  throw new Error(`Not a JPEG or PNG: ${url}`)
}

async function mapPool(items, limit, fn) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
}

async function main() {
  // Interleave species so the unsorted grid starts out mixed.
  const queue = []
  const rounds = Math.max(...SPECIES.map(([, , photos]) => photos.length))
  for (let round = 0; round < rounds; round++) {
    for (const [label, species, photos] of SPECIES) {
      if (!photos[round]) continue
      const [observationId, photoId] = photos[round]
      queue.push({ label, species, observationId, photoId, name: `${slug(label)}-${round + 1}` })
    }
  }

  const observations = new Map()
  for (let i = 0; i < queue.length; i += 200) {
    const ids = queue.slice(i, i + 200).map(entry => entry.observationId)
    for (const [id, observation] of await lookupObservations(ids)) observations.set(id, observation)
  }

  await rm(STAGING_DIR, { recursive: true, force: true })
  await mkdir(join(STAGING_DIR, 'thumbs'), { recursive: true })

  const images = new Array(queue.length).fill(null)
  await mapPool(queue, CONCURRENCY, async ({ label, species, observationId, photoId, name }, index) => {
    const observation = observations.get(observationId)
    const photo = observation?.photos.find(candidate => candidate.id === photoId)
    if (!photo) return console.warn(`Skipped ${name}: photo ${photoId} is no longer on iNaturalist`)
    if (!LICENSES[photo.license_code]) return console.warn(`Skipped ${name}: license is now ${photo.license_code || 'all rights reserved'}`)
    let file, thumb
    try {
      // The model gets the 1024px "large" size; the page shows the 500px "medium" size.
      const [large, medium] = await Promise.all([
        download(photo.url.replace('/square.', '/large.')),
        download(photo.url.replace('/square.', '/medium.')),
      ])
      file = name + large.ext
      thumb = `thumbs/${name}${medium.ext}`
      await writeFile(join(STAGING_DIR, file), large.bytes)
      await writeFile(join(STAGING_DIR, thumb), medium.bytes)
    } catch (err) {
      return console.warn(`Skipped ${name}: ${err.message}`)
    }
    images[index] = {
      file,
      thumb,
      label,
      species,
      license: LICENSES[photo.license_code],
      author: observation.user.name || observation.user.login,
      attribution: photo.attribution,
      source: `https://www.inaturalist.org/observations/${observationId}`,
    }
    process.stdout.write('.')
  })

  const manifest = {
    dataset: {
      name: 'iNaturalist',
      url: 'https://www.inaturalist.org',
      license: 'CC0, CC BY and CC BY-SA photos, credited in data/animals/manifest.json',
    },
    images: images.filter(Boolean),
  }
  await writeFile(join(STAGING_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await rm(OUT_DIR, { recursive: true, force: true })
  await rename(STAGING_DIR, OUT_DIR)
  console.log(`\nSaved ${manifest.images.length} of ${queue.length} images to data/animals/`)
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
