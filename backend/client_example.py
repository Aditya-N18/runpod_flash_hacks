# Minimal client for the deployed scorer -- for Person 4's glue layer and as a
# repeatable live smoke test.
#
# Usage:
#   set the deployed scorer's endpoint id, then:
#   uv run client_example.py <ENDPOINT_ID>                         # /evaluate sample_parcels.json
#   uv run client_example.py <ENDPOINT_ID> my.json                 # /evaluate a custom payload
#   uv run client_example.py <ENDPOINT_ID> data/parcels_raw.json   # auto -> /score-batch (raw file)
#
# Auth is handled by the SDK from RUNPOD_API_KEY in .env.
#
# Raw-HTTP equivalent (e.g. for Person 3's JS frontend):
#   POST https://<ENDPOINT_ID>.api.runpod.ai/evaluate
#   headers: Authorization: Bearer <RUNPOD_API_KEY>, Content-Type: application/json
#   body:    {"parcels": [...]}
import asyncio
import json
import sys

from runpod_flash import Endpoint


async def main():
    if len(sys.argv) < 2:
        print("usage: uv run client_example.py <ENDPOINT_ID> [payload.json]")
        raise SystemExit(1)

    endpoint_id = sys.argv[1]
    payload_path = sys.argv[2] if len(sys.argv) > 2 else "sample_parcels.json"

    with open(payload_path, encoding="utf-8") as f:
        payload = json.load(f)

    scorer = Endpoint(id=endpoint_id)

    # Auto-detect Person 1's raw Kern County file (-> /score-batch) vs. the simple
    # {"parcels":[{lat,lon,ghi_...}]} shape (-> /evaluate).
    if "sentiment_corpus" in payload or "metadata" in payload:
        await _print_batch(await scorer.post("/score-batch", payload))
    else:
        _print_evaluate(await scorer.post("/evaluate", payload))


def _print_evaluate(result):
    ranked = result["ranked"]
    print(f"scored {result['count']} parcels\n")
    print(f"{'rank':>4}  {'parcel_id':<20}  {'score':>6}  best/worst factor")
    for r in ranked:
        factors = r["factors"]
        best = max(factors, key=factors.get)
        worst = min(factors, key=factors.get)
        print(
            f"{r['rank']:>4}  {r['parcel_id']:<20}  {r['final_score']:>6}  "
            f"+{best} {factors[best]} / -{worst} {factors[worst]}"
        )


async def _print_batch(result):
    sites, ranked = result["sites"], result["ranked_ids"]
    print(f"scored {result['count']} candidate sites — {result['metadata'].get('county')}\n")
    print("STRONGEST:", result["summary"]["strongest"]["explanation"], "\n")
    print(f"{'rank':>4}  {'id':<14}  {'score':>6}  {'conf':>5}  verdict")
    for i in ranked[:10]:
        s = sites[i]
        print(f"{s['rank']:>4}  {s['id']:<14}  {s['score']:>6}  "
              f"{s['confidence']['score']:>5}  {s['verdict']['label']}")


if __name__ == "__main__":
    asyncio.run(main())
