# API Endpoints

Sample inputs and outputs for each endpoint defined in [endpoints.py](endpoints.py).

> Numeric scores below (e.g. `81.4`, `58.7`, `0.41`) are illustrative — the exact
> values are computed by [scorer.py](scorer.py) and [batch_scorer.py](batch_scorer.py)
> plus the LLM sentiment read. The **field shapes** are exact.

---

## `POST /evaluate`

Scores a list of individual parcels and returns them ranked best-first. Sentiment
text is classified per-parcel on the GPU.

### Sample input
```json
{
  "parcels": [
    {
      "parcel_id": "APN-001-GOOD",
      "lat": 34.52, "lon": -116.88,
      "ghi_kwh_m2_day": 6.2, "slope_degrees": 2.0,
      "grid_distance_km": 3.5, "land_price_per_acre": 900,
      "road_distance_km": 1.0, "locality_distance_km": 15.0,
      "sentiment_text": "Residents welcomed the proposed solar project, citing new jobs and tax revenue.",
      "is_protected_land": false, "habitat_sensitivity": 0.1
    },
    {
      "parcel_id": "APN-002-FAR-GRID",
      "lat": 34.6, "lon": -116.95,
      "ghi_kwh_m2_day": 6.8, "slope_degrees": 1.5,
      "grid_distance_km": 45.0, "land_price_per_acre": 700,
      "road_distance_km": 5.0, "locality_distance_km": 40.0,
      "sentiment_text": "",
      "is_protected_land": false, "habitat_sensitivity": 0.2
    }
  ]
}
```

> Only `parcel_id`, `lat`, `lon` and the factor fields are required; `sentiment_text`
> (default `""`), `is_protected_land` (default `false`) and `habitat_sensitivity`
> (default `0.0`) are optional. Empty sentiment text defaults to a neutral 50.0.

### Sample output
```json
{
  "ranked": [
    {
      "parcel_id": "APN-001-GOOD",
      "lat": 34.52, "lon": -116.88,
      "final_score": 81.4,
      "factors": {
        "solar": 80.0,
        "slope": 86.7,
        "grid": 82.5,
        "locality": 86.7,
        "land_price": 91.0,
        "road": 95.0,
        "habitat": 90.0,
        "sentiment": 88.0
      },
      "rank": 1
    },
    {
      "parcel_id": "APN-002-FAR-GRID",
      "lat": 34.6, "lon": -116.95,
      "final_score": 58.9,
      "factors": {
        "solar": 95.0,
        "slope": 90.0,
        "grid": 0.0,
        "locality": 0.0,
        "land_price": 93.0,
        "road": 75.0,
        "habitat": 80.0,
        "sentiment": 50.0
      },
      "rank": 2
    }
  ],
  "count": 2
}
```

> The exact factor keys/values come from [scorer.py](scorer.py)
> `compute_deterministic_factors`; the `sentiment` value is the GPU read (88.0 for the
> supportive text, 50.0 neutral default for the empty one).

---

## `POST /score-batch`

Consumes Person 1's `parcels_raw.json` verbatim (`{metadata, sentiment_corpus,
parcels[]}`, each parcel's factors nested under `factors_raw`). Returns a result keyed
by candidate `id` so the frontend joins it straight to `parcels_raw.geojson`.

### Sample input (one parcel shown; real file ships 160)
```json
{
  "metadata": { "county": "Kern County, CA", "fips": "06029", "parcel_count": 160 },
  "sentiment_corpus": {
    "Wasco": { "articles": [ { "url": "https://…", "title": "PCI begins construction on 1.8MW solar array…", "body_markdown": "…" } ] },
    "McFarland": { "articles": [] }
  },
  "parcels": [
    {
      "id": "06029_000_000",
      "lat": 35.35, "lon": -119.35,
      "factors_raw": {
        "solar_irradiance": { "ghi_annual_kwh_m2": 2191.2, "source": "latitude_estimate" },
        "slope": { "degrees": 1.5, "elevation_m": 120.0, "source": "fast_mode_estimate" },
        "locality": { "dist_km_nearest_town": 14.33, "nearest_town": "McFarland", "population": 15000, "source": "county_meta" },
        "grid": { "dist_km_substation": 12.19, "nearest_kv": 230, "nearest_name": "Buttonwillow", "source": "hifld_or_seed" },
        "wildlife": { "in_protected_area": false, "nlcd_class": "shrubland", "dist_km_critical_habitat": 8.0, "source": "padus_heuristic" },
        "land": { "price_per_acre_est": 958381.0, "listings_within_5km": 9, "source": "brightdata_listings" },
        "maintenance": { "dust_risk": 0.85, "dist_km_paved_road": 5.0, "source": "fallback" },
        "sentiment": { "town_key": "McFarland" }
      }
    }
  ]
}
```

### Sample output
```json
{
  "metadata": {
    "county": "Kern County, CA", "fips": "06029", "parcel_count": 160,
    "scored_count": 160,
    "ranking_factors": ["grid", "locality", "sentiment"],
    "excluded_constant_factors": ["land_use", "solar"],
    "land_cost_excluded": true,
    "proven_towns": ["Bakersfield", "Wasco"],
    "weighting_note": "Ranked only on factors with real geographic variation; weights are renormalized per site, and towns without sentiment evidence are scored as insufficient_data (not neutral)."
  },
  "sites": {
    "06029_000_000": {
      "id": "06029_000_000",
      "lat": 35.35, "lon": -119.35,
      "score": 58.7,
      "rank": 42,
      "confidence": { "score": 0.49, "label": "low" },
      "factor_scores": {
        "grid": { "normalized": 39.1, "raw": 12.19, "weight": 0.571, "source": "hifld_or_seed", "confidence": 0.85, "explanation": "12.2 km to the 230 kV Buttonwillow substation — moderate interconnection distance." },
        "locality": { "normalized": 88.4, "raw": 14.33, "weight": 0.286, "source": "county_meta", "confidence": 0.9, "explanation": "14.3 km from McFarland — good balance of access and distance from residents." },
        "land_use": { "normalized": 75.0, "raw": "shrubland", "weight": 0.0, "source": "padus_heuristic", "confidence": 0.6, "explanation": "shrubland — low land-use conflict." },
        "sentiment": { "normalized": 0.0, "raw": "insufficient_data (McFarland)", "weight": 0.0, "source": "llm_classifier", "confidence": 0.0, "explanation": "No usable sentiment evidence for McFarland; not scored (treated as insufficient_data, not neutral)." },
        "solar": { "normalized": 75.1, "raw": 2191.2, "weight": 0.0, "source": "latitude_estimate", "confidence": 0.4, "explanation": "2191 kWh/m²/yr — excellent but essentially uniform across the county…" },
        "land_cost": { "normalized": 0.0, "raw": 958381.0, "weight": 0.0, "source": "brightdata_listings", "confidence": 0.3, "explanation": "$958,381/acre — identical across all sites…" },
        "wildlife_protected": { "normalized": 100.0, "raw": false, "weight": 0.0, "source": "padus_heuristic", "confidence": 0.6, "explanation": "not in a protected area." }
      },
      "sentiment_summary": {
        "town": "McFarland", "status": "insufficient_data",
        "n_articles": 0, "summary": "No usable local sentiment evidence for McFarland."
      },
      "similarity_to_proven_sites": {
        "score": 0.41, "nearest_proven_town": "Wasco", "distance_km": 18.2,
        "basis": "18 km from Wasco (proven solar town) with a partially matching grid/locality profile."
      },
      "warnings": ["sentiment_insufficient_data"],
      "verdict": {
        "label": "promising",
        "summary": "Ranked #42 of 160 (score 58.7/100, low confidence). Strongest factor: locality (88.4). Held back by grid (39.1). Community sentiment is insufficient_data here, lowering confidence."
      }
    }
  },
  "ranked_ids": ["06029_087_012", "06029_044_003", "…"],
  "count": 160,
  "summary": {
    "strongest": { "id": "06029_087_012", "explanation": "06029_087_012 is the strongest candidate (score 78.2/100, high confidence)…" },
    "weakest":   { "id": "06029_119_007", "explanation": "06029_119_007 is the weakest candidate (score 31.0/100, low confidence)…" },
    "town_sentiment": {
      "Wasco": { "status": "ok", "score": 82.0, "label": "supportive", "n_articles": 5 },
      "McFarland": { "status": "insufficient_data", "score": null, "label": null, "n_articles": 0 }
    },
    "notes": [
      "Land cost excluded from ranking — identical across all 160 sites.",
      "Constant / non-varying factors excluded from ranking: land_use, solar.",
      "Slope and maintenance are estimates/fallbacks — reported but unweighted.",
      "Towns without local articles return insufficient_data, not neutral sentiment."
    ]
  }
}
```

---

## `GET /health`

No input.

### Sample output
```json
{ "status": "healthy" }
```
