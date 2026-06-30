# SolarSiteIQ — Scoring Backend (Person 2)

A multi-factor solar-farm siting engine. This repo is the **scoring backend**: it takes
candidate land parcels with raw real-world data, scores each on 8 weighted factors
(including an LLM-based community-sentiment read running on a Flash GPU), and returns a
ranked list with a per-factor breakdown that the map UI renders.

> **Pipeline:** Person 1 scrapes/caches parcel data (Bright Data + gov sources) →
> **Person 2 (this repo)** scores + ranks on RunPod Flash → Person 3 renders the ranked map →
> Person 4 glues it together and drives the demo.

---

## What it does

`POST /evaluate` takes `{"parcels": [...]}` and returns parcels ranked best-first, each with
a `final_score` (0–100) and the 8 factor scores that produced it.

`POST /score-batch` takes Person 1's **raw Kern County file** (`data/parcels_raw.json` —
160 candidate *screening locations*, factors nested under `factors_raw`) and does the
normalization + sentiment classification itself. It returns a result **keyed by candidate
`id`** (joins straight to `parcels_raw.geojson`) where each site carries a `score`, `rank`,
`confidence`, per-factor evidence (`normalized / raw / weight / source / confidence /
explanation`), a `sentiment_summary`, `similarity_to_proven_sites`, `warnings` and a
plain-English `verdict`. See [CONTRACT.md](CONTRACT.md#batch-endpoint--post-score-batch-person-1-raw-file--map).

It only ranks on factors with **real geographic variation** — constant factors (land cost is
identical across all 160 sites) get zero weight, towns with no articles return
`insufficient_data` instead of a fake-neutral score, and slope/maintenance fallbacks are
reported but unweighted.

### The 8 factors (weighted)

| Factor | Weight | Raw signal | Direction |
|---|---|---|---|
| `solar` | 25% | GHI irradiance (NSRDB — already includes cloud/fog) | higher = better |
| `grid` | 20% | km to nearest substation/transmission (HIFLD) | closer = better |
| `wildlife` | 15% | protected-land flag + habitat sensitivity (PAD-US/NLCD) | less sensitive = better |
| `land_cost` | 15% | scraped price/acre (Bright Data) | cheaper = better |
| `terrain` | 10% | slope degrees (USGS) | flatter = better |
| `sentiment` | 8% | scraped local news/forum text → **LLM on Flash GPU** | more support = better |
| `locality` | 4% | km to nearest town (Census/OSM) | sweet-spot 5–30 km |
| `maintenance` | 3% | km to nearest road | closer = better |

`final_score = Σ(weight × factor)`. Source of truth: `WEIGHTS` in [scorer.py](scorer.py).

The model is **frozen at 8 factors** by design — it covers 7 of 8 real-world factor groups;
the one knowingly omitted is economic/policy (proximity-to-demand, incentives). See
[CONTRACT.md](CONTRACT.md) and the plan doc for the full coverage rationale.

---

## Architecture

```
Person 1 JSON (parcels + scraped text)
        │
        ▼
  POST /evaluate         ← solarsiteiq-scorer   (CPU load-balanced endpoint)
        │
        ├── compute_deterministic_factors()  → 7 math-based scores      (scorer.py)
        │
        └── get_sentiment_scores(texts)      → 1 LLM score, batched
                  │
                  ▼
            sentiment-llm   ← Qwen2.5-3B-Instruct on a Flash GPU (transformers)
                              all texts scored in batches on-GPU       (sentiment_llm.py)
        │
        ▼
  sort by final_score desc → ranked JSON → Person 3's map
```

Two Flash endpoints, deployed together:
- **`solarsiteiq-scorer`** — CPU, load-balanced, serves `POST /evaluate` + `GET /health`.
- **`sentiment-llm`** — GPU (RTX 4090), runs the sentiment model. The scorer calls it and
  Flash routes CPU→GPU automatically.

**Offline fallback:** if the GPU endpoint is unreachable (e.g. running locally without
Flash), sentiment falls back to a keyword heuristic (`score_texts_heuristic`) so the whole
pipeline stays testable with no GPU.

---

## Files

| File | Purpose |
|---|---|
| [schemas.py](schemas.py) | Pydantic `ParcelInput` / `ScoredParcel` + batch `ScoredSite` / `ScoreBatchResponse` — the frozen data contract |
| [scorer.py](scorer.py) | 7 deterministic factor normalizations + `WEIGHTS` + weighted sum |
| [batch_scorer.py](batch_scorer.py) | `/score-batch` engine: variation-aware ranking, per-site re-weighting, confidence, similarity, verdicts + plain-English explanations |
| [sentiment_llm.py](sentiment_llm.py) | GPU `@Endpoint` (Qwen2.5-3B via transformers) + heuristic fallback |
| [sentiment.py](sentiment.py) | Client wrapper: batch texts → GPU endpoint, fall back to heuristic |
| [endpoints.py](endpoints.py) | `solarsiteiq-scorer` LB endpoint: `POST /evaluate`, `GET /health` |
| [test_local.py](test_local.py) | Offline smoke test for `/evaluate` (no deploy / no GPU needed) |
| [test_batch_local.py](test_batch_local.py) | Offline smoke test for `/score-batch` against the real 160-site file |
| [sample_parcels.json](sample_parcels.json) | Canonical 4-parcel input (GOOD / FAR-GRID / OPPOSED / PROTECTED) |
| [generate_demo_data.py](generate_demo_data.py) | Regenerates the demo fallback dataset |
| [demo_data.json](demo_data.json) | 25 pre-scored parcels — live-demo fallback if Flash is down |
| [client_example.py](client_example.py) | Minimal live-endpoint caller (glue + repeatable smoke test) |
| [CONTRACT.md](CONTRACT.md) | **Frozen** request/response spec for Person 1 & Person 3 |

---

## Setup

Uses [`uv`](https://docs.astral.sh/uv/) for dependency management.

```bash
uv sync                       # install deps from pyproject.toml / uv.lock
cp .env.example .env          # then set RUNPOD_API_KEY
```

Sentiment runs on a Flash GPU, so **no external LLM API key is needed** — only `RUNPOD_API_KEY`.

---

## Run it

### 1. Local smoke test (no deploy, no GPU)
```bash
uv run test_local.py
```
Scores the 4 sample parcels via the heuristic fallback and asserts the ranking. This is the
fast inner-loop and a regression guard.

```bash
uv run test_batch_local.py
```
Runs the full `/score-batch` pipeline over the real `data/parcels_raw.json` (160 Kern County
candidate sites) offline, asserting the keyed-by-`id` contract, the variation-aware weighting,
and the `insufficient_data` sentiment handling.

### 2. Deploy to Flash
```bash
uv run flash deploy
```
Brings up both endpoints (`solarsiteiq-scorer` + `sentiment-llm`) and prints the live
endpoint id/URL. The scorer is reachable at `https://<ENDPOINT_ID>.api.runpod.ai`.

> **Windows note:** force UTF-8 first or the deploy CLI crashes printing unicode —
> `$env:PYTHONUTF8=1; $env:PYTHONIOENCODING="utf-8"` (PowerShell).

### 3. Call the live endpoint
```bash
uv run client_example.py <ENDPOINT_ID>            # scores sample_parcels.json
curl -X POST https://<ENDPOINT_ID>.api.runpod.ai/evaluate \
     -H "Authorization: Bearer $RUNPOD_API_KEY" \
     -H "Content-Type: application/json" \
     -d @sample_parcels.json
```

> **First call is slow** — the GPU worker cold-starts and loads Qwen2.5-3B (~1–2 min).
> Warm it before the demo.

---

## The demo "aha"

In `sample_parcels.json`:
- **APN-002-FAR-GRID** has the *best* solar (95) but ranks **last** — it's 45 km from the
  grid. Sun isn't everything; grid distance is the silent project-killer.
- **APN-003-OPPOSED** looks fine on paper but its scraped text ("petition opposing… noise…
  habitat loss") drives `sentiment` to ~0.

That contrast — finding sun vs. thinking like an expert — is the pitch.

---

## Status / build notes

- ✅ Scoring engine, schemas, sentiment endpoint, local test, demo fallback, integration
  contract — all done and passing the offline smoke test.
- 🔧 **vLLM → transformers:** the GPU worker originally used vLLM, but its wheel install
  exceeds Flash's hard 600s build-timeout. Switched to HuggingFace transformers (same model,
  same GPU, much smaller install).
- 🔧 **Windows deploy fix:** the Flash CLI crashes on cp1252 consoles when printing unicode;
  run deploys with `PYTHONUTF8=1`.
- ⏳ **Live deploy:** in progress / re-run with the transformers stack. Update
  `<ENDPOINT_ID>` in `CONTRACT.md` and share once it returns.
