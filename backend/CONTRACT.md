# SolarSiteIQ — Backend Integration Contract (FROZEN)

This is the locked interface between the three pieces. **Do not change field names after this point** — Person 1 writes to the request shape, Person 3 reads the response shape.

- **Person 1 (data):** produce JSON matching the **Request** below.
- **Person 2 (this backend):** `POST /evaluate` scores + ranks.
- **Person 3 (map):** render the **Response** below.

---

## Endpoint

```
POST https://<ENDPOINT_ID>.api.runpod.ai/evaluate
Authorization: Bearer <RUNPOD_API_KEY>
Content-Type: application/json
```

Health check: `GET https://<ENDPOINT_ID>.api.runpod.ai/health` → `{"status": "healthy"}`

> The live `<ENDPOINT_ID>` is printed by `uv run flash deploy` and shared in the team channel.

---

## Request — Person 1's output spec

```json
{
  "parcels": [
    {
      "parcel_id": "APN-001",
      "lat": 34.52,
      "lon": -116.88,
      "ghi_kwh_m2_day": 6.2,
      "slope_degrees": 2.0,
      "grid_distance_km": 3.5,
      "land_price_per_acre": 900,
      "road_distance_km": 1.0,
      "locality_distance_km": 15.0,
      "sentiment_text": "Residents welcomed the project...",
      "is_protected_land": false,
      "habitat_sensitivity": 0.1
    }
  ]
}
```

| Field | Type | Required | Meaning / source |
|---|---|---|---|
| `parcel_id` | string | ✅ | unique parcel/APN id |
| `lat`, `lon` | float | ✅ | centroid coords (map placement) |
| `ghi_kwh_m2_day` | float | ✅ | solar irradiance, NSRDB (already includes cloud/fog) |
| `slope_degrees` | float | ✅ | terrain slope, USGS elevation |
| `grid_distance_km` | float | ✅ | km to nearest substation/transmission, HIFLD |
| `land_price_per_acre` | float | ✅ | scraped listing price, Bright Data |
| `road_distance_km` | float | ✅ | km to nearest road (access/maintenance) |
| `locality_distance_km` | float | ✅ | km to nearest town, Census/OSM |
| `sentiment_text` | string | ⬜ (default `""`) | scraped local news/forum text, Bright Data |
| `is_protected_land` | bool | ⬜ (default `false`) | PAD-US/USFWS protected status |
| `habitat_sensitivity` | float 0–1 | ⬜ (default `0.0`) | NLCD/USFWS habitat sensitivity |

Empty `sentiment_text` → sentiment defaults to neutral (50). Optional fields can be omitted.

---

## Response — Person 3's input spec

```json
{
  "count": 4,
  "ranked": [
    {
      "parcel_id": "APN-001",
      "lat": 34.52,
      "lon": -116.88,
      "rank": 1,
      "final_score": 89.3,
      "factors": {
        "solar": 80.0,
        "grid": 93.0,
        "wildlife": 90.0,
        "land_cost": 91.1,
        "terrain": 86.7,
        "sentiment": 100.0,
        "locality": 100.0,
        "maintenance": 95.0
      }
    }
  ]
}
```

- `ranked` is sorted **best-first** (`rank` 1 = best). `final_score` and every `factors` value are 0–100.
- `factors` always has these 8 keys: `solar, grid, wildlife, land_cost, terrain, sentiment, locality, maintenance`.

### Factor weights (for the "why this scored X" panel)

| Factor | Weight |
|---|---|
| solar | 25% |
| grid | 20% |
| wildlife | 15% |
| land_cost | 15% |
| terrain | 10% |
| sentiment | 8% |
| locality | 4% |
| maintenance | 3% |

`final_score = Σ(weight × factor)`. Source of truth: `WEIGHTS` in `scorer.py`.

---

## Batch endpoint — `POST /score-batch` (Person 1 raw file → map)

For the Kern County screening run, Person 1 ships the raw file directly (`parcels_raw.json`)
and Person 2 does the normalization, weighting and sentiment classification. **These are
candidate / screening locations, not legal parcels.**

```
POST https://<ENDPOINT_ID>.api.runpod.ai/score-batch
Authorization: Bearer <RUNPOD_API_KEY>
Content-Type: application/json
body: <contents of parcels_raw.json verbatim>
```

### Request — Person 1's raw file

`parcels_raw.json` as-is: `{ "metadata": {...,"bbox":{...}}, "sentiment_corpus": { "<Town>": {"articles":[...]} }, "parcels": [ {"id","lat","lon","factors_raw":{...}} ] }`.
Every factor is nested under `factors_raw`; sites are keyed by `id` (same `id` as `parcels_raw.geojson`).

### Response — Person 3's input spec

Keyed by candidate `id` so the map joins it straight to `parcels_raw.geojson`:

```json
{
  "metadata": { "county": "Kern County, CA", "bbox": {...}, "ranking_factors": ["grid","locality","land_use","sentiment"],
                "excluded_constant_factors": ["solar"], "land_cost_excluded": true, "proven_towns": ["Bakersfield","Wasco"] },
  "ranked_ids": ["06029_005_010", "..."],
  "count": 160,
  "sites": {
    "06029_005_010": {
      "id": "06029_005_010", "lat": 35.45, "lon": -119.25,
      "score": 97.8, "rank": 1,
      "confidence": { "score": 0.58, "label": "medium" },
      "factor_scores": {
        "grid":     { "normalized": 98.6, "raw": 0.3, "weight": 0.57, "source": "hifld_or_seed", "confidence": 0.85, "explanation": "..." },
        "locality": { "normalized": 100.0, "raw": 8.1, "weight": 0.29, "source": "county_meta", "confidence": 0.9, "explanation": "..." },
        "land_use": { "normalized": 90.0, "raw": "developed_open_space", "weight": 0.14, "source": "padus_heuristic", "confidence": 0.6, "explanation": "..." },
        "sentiment":{ "normalized": 0.0, "raw": "insufficient_data (McFarland)", "weight": 0.0, "source": "llm_classifier", "confidence": 0.0, "explanation": "..." },
        "solar": { "...": "informational, weight 0" }, "slope": {"...":"weight 0"}, "maintenance": {"...":"weight 0"},
        "land_cost": {"...":"weight 0"}, "wildlife_protected": {"...":"weight 0"}
      },
      "sentiment_summary": { "town": "McFarland", "status": "insufficient_data", "n_articles": 0, "summary": "..." },
      "similarity_to_proven_sites": { "score": 0.82, "nearest_proven_town": "Bakersfield", "distance_km": 9.0, "basis": "..." },
      "warnings": ["sentiment_insufficient_data"],
      "verdict": { "label": "strong_candidate", "summary": "Ranked #1 of 160 ..." }
    }
  },
  "summary": { "strongest": {"id":"...","explanation":"..."}, "weakest": {"id":"...","explanation":"..."},
               "town_sentiment": {"Bakersfield":{"status":"ok","score":62.1,...}, "Shafter":{"status":"insufficient_data",...}}, "notes": ["..."] }
}
```

**Scoring rules baked into the contract (from the P1 handoff):**

- Ranks **only** factors with real geographic variation. `land_cost` (identical across all 160 sites) and any other constant factor get **weight 0** and never move the order. `solar` is near-uniform here, so it's reported but unranked.
- Weights are **renormalized per site**. A town with no articles → sentiment `status: insufficient_data`, weight 0 — **never scored as neutral 50** — and the site's `confidence` is reduced to reflect the missing factor.
- Slope and maintenance are estimates/fallbacks → reported with **low confidence** and weight 0.
- `is_protected_land` sites are penalized/excluded (`verdict.label: "excluded"`).
- Every factor carries `normalized / raw / weight / source / confidence / explanation` so the UI can show *why*, not just the number.

`score`, every `factor_scores[*].normalized` are 0–100; `confidence.score`, `similarity_to_proven_sites.score` and per-factor `confidence` are 0–1.

---

## Demo fallback

If Flash is unreachable live, Person 4 serves `demo_data.json` directly — it has the **exact same** `{"ranked": [...], "count": N}` shape, so Person 3's render code is identical. Regenerate with `uv run generate_demo_data.py`.
