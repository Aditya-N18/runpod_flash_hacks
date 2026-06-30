# Local smoke test -- exercises the scoring pipeline without `flash dev` or a deploy.
# LB route handlers are unwrapped plain async functions, so they're directly callable.
# run with: uv run test_local.py
import asyncio
import json

SAMPLE_PARCELS = [
    {
        "parcel_id": "APN-001-GOOD",
        "lat": 34.52,
        "lon": -116.88,
        "ghi_kwh_m2_day": 6.2,
        "slope_degrees": 2.0,
        "grid_distance_km": 3.5,
        "land_price_per_acre": 900,
        "road_distance_km": 1.0,
        "locality_distance_km": 15.0,
        "sentiment_text": "Residents welcomed the proposed solar project, citing new jobs and tax revenue.",
        "is_protected_land": False,
        "habitat_sensitivity": 0.1,
    },
    {
        "parcel_id": "APN-002-FAR-GRID",
        "lat": 34.60,
        "lon": -116.95,
        "ghi_kwh_m2_day": 6.8,
        "slope_degrees": 1.5,
        "grid_distance_km": 45.0,
        "land_price_per_acre": 700,
        "road_distance_km": 5.0,
        "locality_distance_km": 40.0,
        "sentiment_text": "",
        "is_protected_land": False,
        "habitat_sensitivity": 0.2,
    },
    {
        "parcel_id": "APN-003-OPPOSED",
        "lat": 34.55,
        "lon": -116.80,
        "ghi_kwh_m2_day": 6.0,
        "slope_degrees": 3.0,
        "grid_distance_km": 8.0,
        "land_price_per_acre": 1100,
        "road_distance_km": 2.0,
        "locality_distance_km": 12.0,
        "sentiment_text": "Hundreds signed a petition opposing the solar farm, citing noise and habitat loss concerns.",
        "is_protected_land": False,
        "habitat_sensitivity": 0.3,
    },
    {
        "parcel_id": "APN-004-PROTECTED",
        "lat": 34.48,
        "lon": -116.90,
        "ghi_kwh_m2_day": 6.5,
        "slope_degrees": 2.5,
        "grid_distance_km": 6.0,
        "land_price_per_acre": 800,
        "road_distance_km": 1.5,
        "locality_distance_km": 20.0,
        "sentiment_text": "",
        "is_protected_land": True,
        "habitat_sensitivity": 0.9,
    },
]


async def main():
    from endpoints import evaluate

    result = await evaluate({"parcels": SAMPLE_PARCELS})
    print(json.dumps(result, indent=2))

    assert result["count"] == len(SAMPLE_PARCELS)
    assert result["ranked"][0]["parcel_id"] == "APN-001-GOOD", "best parcel should rank #1"
    assert result["ranked"][-1]["parcel_id"] in ("APN-004-PROTECTED", "APN-002-FAR-GRID"), (
        "protected land or far-grid parcel should rank last"
    )
    print("\nSmoke test passed.")


if __name__ == "__main__":
    asyncio.run(main())
