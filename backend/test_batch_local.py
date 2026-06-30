# Offline smoke test for the /score-batch pipeline -- scores the real 160-site
# Kern County file via the sentiment heuristic fallback (no GPU / no deploy).
# run with: uv run test_batch_local.py
import asyncio
import json


async def main():
    from endpoints import score_batch

    with open("data/parcels_raw.json", encoding="utf-8") as f:
        raw = json.load(f)

    result = await score_batch(raw)

    sites = result["sites"]
    ranked = result["ranked_ids"]
    meta = result["metadata"]

    # --- structural contract ---
    assert result["count"] == len(raw["parcels"]) == 160, "all sites scored"
    assert set(sites) == set(p["id"] for p in raw["parcels"]), "keyed by candidate id"
    assert len(ranked) == 160 and len(set(ranked)) == 160, "every id ranked once"

    required = {"id", "lat", "lon", "score", "rank", "confidence", "factor_scores",
               "sentiment_summary", "similarity_to_proven_sites", "warnings", "verdict"}
    sample = sites[ranked[0]]
    assert required <= set(sample), f"missing fields: {required - set(sample)}"

    factor_keys = {"normalized", "raw", "weight", "source", "confidence", "explanation"}
    for fk, fv in sample["factor_scores"].items():
        assert factor_keys <= set(fv), f"factor {fk} missing {factor_keys - set(fv)}"

    # --- behavioral contract from the P1 handoff ---
    assert meta["land_cost_excluded"] is True
    assert "land_cost" in {*meta["excluded_constant_factors"], "land_cost"}
    assert all(sites[i]["factor_scores"]["land_cost"]["weight"] == 0 for i in ranked), \
        "constant land cost must not affect ranking"
    assert all(sites[i]["factor_scores"]["slope"]["weight"] == 0 for i in ranked), \
        "estimated/constant slope must not affect ranking"

    # ranks are dense + sorted best-first by score
    scores = [sites[i]["score"] for i in ranked]
    assert scores == sorted(scores, reverse=True), "ranked best-first"
    assert [sites[i]["rank"] for i in ranked] == list(range(1, 161))

    # sentiment: only Bakersfield/Wasco usable; others -> insufficient_data (not neutral)
    towns = meta_town_status(result)
    assert towns.get("Bakersfield") == "ok" and towns.get("Wasco") == "ok"
    for dead in ("Shafter", "McFarland", "Delano"):
        if dead in towns:
            assert towns[dead] == "insufficient_data", f"{dead} should be insufficient_data"
    insufficient = [i for i in ranked if "sentiment_insufficient_data" in sites[i]["warnings"]]
    assert insufficient, "some sites lack sentiment evidence"
    assert all(sites[i]["factor_scores"]["sentiment"]["weight"] == 0 for i in insufficient), \
        "insufficient sentiment must carry no weight (not scored as neutral)"

    best, worst = sites[ranked[0]], sites[ranked[-1]]
    print(f"scored {result['count']} candidate sites across {meta.get('county')}\n")
    print("ranking factors:", meta["ranking_factors"])
    print("excluded (constant):", meta["excluded_constant_factors"])
    print("\nSTRONGEST:", result["summary"]["strongest"]["explanation"])
    print("\nWEAKEST:  ", result["summary"]["weakest"]["explanation"])
    print("\nTop 5:")
    print(f"  {'rank':>4}  {'id':<14}  {'score':>5}  {'conf':>4}  verdict")
    for i in ranked[:5]:
        s = sites[i]
        print(f"  {s['rank']:>4}  {s['id']:<14}  {s['score']:>5}  "
              f"{s['confidence']['score']:>4}  {s['verdict']['label']}")

    print("\nBatch smoke test passed.")


def meta_town_status(result) -> dict:
    return {t: v["status"] for t, v in result["summary"]["town_sentiment"].items()}


if __name__ == "__main__":
    asyncio.run(main())
