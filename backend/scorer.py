"""Deterministic 8-factor parcel scoring: normalize raw values to 0-100, then weighted sum.

Sentiment is the one factor NOT computed here -- it comes from the LLM classifier
in sentiment.py and is merged into the factors dict by endpoints.py.
"""
import numpy as np

from schemas import ParcelInput

WEIGHTS = {
    "solar": 0.25,
    "grid": 0.20,
    "wildlife": 0.15,
    "land_cost": 0.15,
    "terrain": 0.10,
    "sentiment": 0.08,
    "locality": 0.04,
    "maintenance": 0.03,
}


def _normalize(value: float, low: float, high: float, invert: bool = False) -> float:
    """Linearly map value in [low, high] to [0, 100], clamped at the edges."""
    span = high - low
    pct = (value - low) / span if span else 0.0
    pct = float(np.clip(pct, 0.0, 1.0))
    if invert:
        pct = 1.0 - pct
    return pct * 100.0


def _locality_score(km: float, low: float = 5, high: float = 30, low_zero: float = 0, high_zero: float = 60) -> float:
    """Bell-shaped sweet spot: too close (complaints) or too far (no local benefit) both score low."""
    if low <= km <= high:
        return 100.0
    if km < low:
        return _normalize(km, low_zero, low)
    return 100.0 - _normalize(km, high, high_zero)


def compute_deterministic_factors(parcel: ParcelInput) -> dict[str, float]:
    """All factors except sentiment, which requires the async LLM call."""
    wildlife = 0.0 if parcel.is_protected_land else _normalize(parcel.habitat_sensitivity, 0.0, 1.0, invert=True)
    return {
        "solar": round(_normalize(parcel.ghi_kwh_m2_day, 3.0, 7.0), 1),
        "terrain": round(_normalize(parcel.slope_degrees, 0.0, 15.0, invert=True), 1),
        "grid": round(_normalize(parcel.grid_distance_km, 0.0, 50.0, invert=True), 1),
        "land_cost": round(_normalize(parcel.land_price_per_acre, 500.0, 5000.0, invert=True), 1),
        "maintenance": round(_normalize(parcel.road_distance_km, 0.0, 20.0, invert=True), 1),
        "locality": round(_locality_score(parcel.locality_distance_km), 1),
        "wildlife": round(wildlife, 1),
    }


def weighted_final_score(factors: dict[str, float]) -> float:
    return round(sum(WEIGHTS[k] * v for k, v in factors.items()), 1)
