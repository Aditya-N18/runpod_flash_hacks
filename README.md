# SolarIQ

A multi-factor solar-farm siting engine that scores land parcels on real-world data — including local community sentiment — so developers can find the best places to build solar, faster.

## The problem

Choosing where to build a solar farm usually means juggling dozens of datasets, expensive consultants, and town-hall opinions. Good sun is not enough: a site can be far from the grid, on protected land, or opposed by the community. SolarIQ automates the analysis so the decision is transparent, data-driven, and community-aware.

## What it does

SolarIQ takes candidate land parcels and scores each on 8 factors:

- Solar irradiance (higher = better)
- Grid proximity (closer = better)
- Wildlife / protected-land sensitivity (less = better)
- Land cost (cheaper = better)
- Terrain slope (flatter = better)
- Community sentiment (more support = better)
- Locality — distance to nearest town (sweet spot)
- Maintenance access — road distance (closer = better)

The most novel factor is community sentiment. SolarIQ uses Bright Data to scrape local news and forum text about each town, then runs a Qwen2.5-3B-Instruct LLM on RunPod Flash to score community support from 0 to 100.

## Architecture

This repo is split into the same pipeline the team used:

- **Person 1 — Data scraping:** Bright Data scrapes parcel, land-price, and local-news data.
- **Person 2 — Scoring backend:** Python scoring engine running on RunPod Flash. See `backend/README.md` for the full technical details.
- **Person 3 — Map UI:** renders the ranked parcels and per-factor explanations.
- **Person 4 — Glue / demo:** wires the pieces together and drives the demo.

## Tech stack

- **RunPod Flash** — hosts the CPU scorer endpoint and the GPU sentiment-LLM endpoint.
- **Bright Data** — scrapes real-world land listings and local news/forum text.
- **Python + Pydantic** — scoring engine, schemas, and local tests.
- **Qwen2.5-3B-Instruct** — the LLM used for community-sentiment scoring.

## Backend API

The backend exposes three endpoints:

- `POST /evaluate` — scores a list of individual parcels.
- `POST /score-batch` — scores the raw 160-site Kern County screening file.
- `GET /health` — health check.

See `backend/README.md` and `backend/endpoints.md` for request/response shapes and setup instructions.

## Demo "aha"

A site with the best sun can still rank last if it is 45 km from the grid. A site that looks fine on paper can be sunk by local opposition. SolarIQ surfaces those project-killers before money is spent on permits and engineering.

## Run it

The backend lives in `backend/`. From there:

```bash
uv sync
uv run flash deploy
```

The first live call is slow while the GPU worker cold-starts and loads the model. See `backend/README.md` for local smoke tests and full setup.

## Status

- Backend scoring engine, schemas, sentiment endpoint, and local tests — implemented and passing.
- Live deployment to RunPod Flash — in progress.
