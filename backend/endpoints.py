# CPU load-balanced endpoint: scores parcels and returns a ranked list.
# Sentiment is delegated to the GPU vLLM endpoint (sentiment_llm.classify_batch),
# batched into a single call so the model sees every parcel's text at once.
# run with: flash dev   |   deploy with: flash deploy
from runpod_flash import Endpoint

import sentiment_llm  # noqa: F401  -- registers the GPU sentiment endpoint for deploy

api = Endpoint(
    name="solarsiteiq-scorer",
    cpu="cpu3c-2-4",
    workers=(1, 3),  # LB endpoints handle request concurrency via uvicorn, not max_concurrency
    dependencies=["numpy", "pydantic"],
)


@api.post("/evaluate")
async def evaluate(input_data: dict) -> dict:
    """Score every parcel and return them ranked best-first with a factor breakdown."""
    from schemas import ParcelInput
    from scorer import compute_deterministic_factors, weighted_final_score
    from sentiment import get_sentiment_scores

    parcels = [ParcelInput(**p) for p in input_data["parcels"]]

    # Batch all non-empty sentiment texts into ONE GPU call; empties default to neutral.
    with_text = [i for i, p in enumerate(parcels) if p.sentiment_text.strip()]
    texts = [parcels[i].sentiment_text for i in with_text]
    sentiment_scores = await get_sentiment_scores(texts)
    sentiment_by_idx = dict(zip(with_text, sentiment_scores))

    results = []
    for i, parcel in enumerate(parcels):
        factors = compute_deterministic_factors(parcel)
        factors["sentiment"] = round(sentiment_by_idx.get(i, 50.0), 1)
        results.append(
            {
                "parcel_id": parcel.parcel_id,
                "lat": parcel.lat,
                "lon": parcel.lon,
                "final_score": weighted_final_score(factors),
                "factors": factors,
            }
        )

    ranked = sorted(results, key=lambda r: r["final_score"], reverse=True)
    for rank, r in enumerate(ranked, start=1):
        r["rank"] = rank

    return {"ranked": ranked, "count": len(ranked)}


@api.post("/score-batch")
async def score_batch(input_data: dict) -> dict:
    """Score Person 1's raw Kern County candidate-site file.

    Input is `parcels_raw.json` verbatim: {metadata, sentiment_corpus, parcels[]}
    with every factor nested under `factors_raw`. We classify each town's sentiment
    corpus once on the GPU LLM (towns with no articles -> insufficient_data), then
    rank every site on only the geographically-varying factors. The response is
    keyed by candidate `id` so the map can join it straight to parcels_raw.geojson.
    """
    from batch_scorer import score_candidate_sites
    from sentiment import classify_town_corpus

    town_sentiment = await classify_town_corpus(input_data.get("sentiment_corpus", {}))
    return score_candidate_sites(input_data, town_sentiment)


@api.get("/health")
async def health() -> dict:
    return {"status": "healthy"}
