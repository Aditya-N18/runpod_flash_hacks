# One-off generator for demo_data.json -- the live-demo fallback if Flash is unreachable.
# Builds synthetic parcels spanning the full score range, scores them locally
# (sentiment uses hand-picked plausible values instead of a live LLM call so this
# runs without an API key), and writes ranked output matching EvaluateResponse.
# run with: uv run generate_demo_data.py
import json
import random

from schemas import ParcelInput
from scorer import compute_deterministic_factors, weighted_final_score

random.seed(42)

SENTIMENT_SAMPLES = [
    (90.0, "Town hall meeting drew strong support; residents excited about jobs and tax revenue."),
    (75.0, "Local paper ran a favorable piece on the proposed solar development."),
    (50.0, ""),
    (50.0, "Coverage was largely factual with no strong opinions expressed either way."),
    (30.0, "A few residents raised concerns about truck traffic during construction."),
    (15.0, "Hundreds signed a petition opposing the project, citing habitat and noise concerns."),
    (10.0, "County board meeting turned contentious; opposition group vows to fight the proposal."),
]

CENTER_LAT, CENTER_LON = 34.55, -116.90


def _rand_parcel(i: int) -> ParcelInput:
    sentiment_score, sentiment_text = random.choice(SENTIMENT_SAMPLES)
    parcel = ParcelInput(
        parcel_id=f"APN-{i:03d}",
        lat=round(CENTER_LAT + random.uniform(-0.3, 0.3), 5),
        lon=round(CENTER_LON + random.uniform(-0.3, 0.3), 5),
        ghi_kwh_m2_day=round(random.uniform(3.5, 7.0), 2),
        slope_degrees=round(random.uniform(0.0, 14.0), 1),
        grid_distance_km=round(random.uniform(0.5, 48.0), 1),
        land_price_per_acre=round(random.uniform(500, 4800), 0),
        road_distance_km=round(random.uniform(0.2, 18.0), 1),
        locality_distance_km=round(random.uniform(1.0, 55.0), 1),
        sentiment_text=sentiment_text,
        is_protected_land=random.random() < 0.1,
        habitat_sensitivity=round(random.uniform(0.0, 1.0), 2),
    )
    return parcel, sentiment_score


def main():
    scored = []
    for i in range(1, 26):
        parcel, sentiment_score = _rand_parcel(i)
        factors = compute_deterministic_factors(parcel)
        factors["sentiment"] = sentiment_score
        scored.append(
            {
                "parcel_id": parcel.parcel_id,
                "lat": parcel.lat,
                "lon": parcel.lon,
                "final_score": weighted_final_score(factors),
                "factors": factors,
            }
        )

    ranked = sorted(scored, key=lambda r: r["final_score"], reverse=True)
    for rank, r in enumerate(ranked, start=1):
        r["rank"] = rank

    output = {"ranked": ranked, "count": len(ranked)}
    with open("demo_data.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote demo_data.json with {len(ranked)} parcels "
          f"(scores {ranked[-1]['final_score']}-{ranked[0]['final_score']}).")


if __name__ == "__main__":
    main()
