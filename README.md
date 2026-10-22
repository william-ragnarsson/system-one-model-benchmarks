# Image sort

Sort a folder of animal photos by any prompt with the OpenAI [Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`gpt-6-luna`), and see how fast and how cheap it was.

No dependencies: a ~300-line Node server and a static page.

## Run it

```bash
cp .env.example .env          # then paste your key after OPENAI_API_KEY=
npm run fetch-images          # downloads the animal photos into data/animals/
npm start                     # http://localhost:3000
```

Requires Node 22.9 or later.

## How it works

Each image is sent as its own `POST /v1/decisions` request, with up to `CONCURRENCY` (default 8) requests in flight. The image goes in as a base64 data URL and your prompt becomes a single question:

| Mode | Question sent | Sorted by |
| --- | --- | --- |
| Predicate | `Does this image match the description: "<prompt>"?` | `probability` (0–1) |
| Score | `How well does this image match the description: "<prompt>"?` with levels Not at all → Extremely | `score` (0–4) |

If your prompt ends with `?` it is sent as-is, so you can ask things like `How dangerous is this animal?`.

Results stream back to the page as they arrive. When all images have answered, the grid reorders itself, strongest match first.

## What is measured

| Metric | Meaning |
| --- | --- |
| Wall time | From the first request leaving the server until the last answer arrived. |
| Latency p50 / p95 | Per-request round trip from the local server to the API, including image upload. Retries are counted separately and not included. |
| Input tokens | Sum of `usage.input_tokens` from every response. |
| Cost | `input_tokens × $0.10 / 1M`. gpt-6-luna on `/v1/decisions` bills input tokens only, with no output or cache charges. Regional-processing premiums and long-context multipliers are not modelled. |

Every completed run is appended to `runs.jsonl` (prompt, settings, per-run latency, tokens, cost) and listed under **Runs** on the page. Hover a card for that image's probability, latency, tokens and cost.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required. Stays on the server. |
| `PORT` | `3000` | |
| `CONCURRENCY` | `8` | Parallel requests per run. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Point at a proxy or mock. |

The **Detail** selector maps to the image part's `detail` field (`auto`, `low`, `high`). `low` is the quickest way to cut tokens per image.

## Images

`npm run fetch-images` downloads 96 photos (24 species × 4) from [iNaturalist](https://www.inaturalist.org): research-grade observations of wild animals, hand-checked to be clear photos of a live adult. The photo IDs are fixed in `scripts/fetch-images.js`, so every run benchmarks the same set. The model gets the 1024px "large" size of each photo; the page shows the 500px "medium" size so the grid loads quickly.

Every photo is CC0, CC BY or CC BY-SA. The script checks the license again at download time and skips any photo whose license has changed. Credits (photographer, license, observation link) are written to `data/animals/manifest.json`, shown when you hover a card, and clicking a card opens its observation. Please keep the credits if you share the images.

To use your own images, put them in `data/animals/` and list them in `manifest.json` as `{ "images": [{ "file": "cat.jpg", "label": "Cat" }] }`.
