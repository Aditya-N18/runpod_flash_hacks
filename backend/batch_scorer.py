"""Batch suitability scoring for Person 1's Kern County candidate-site file.

These are *screening locations* (regularly spaced candidate points), NOT legal
parcels -- the frontend labels them "candidate sites".

The raw file (`data/parcels_raw.json`) nests every factor under `factors_raw` and
ships 160 synchronized sites. Several factors are constant across all 160 (land
cost, slope, maintenance, kV, habitat distance) or low-confidence estimates. This
module:

  * detects which factors carry *meaningful geographic variation* and ranks only on
    those -- constant / fallback factors are reported for transparency but get zero
    ranking weight so they cannot move the relative order;
  * re-weights per site: a factor with no usable data at a site (e.g. sentiment in a
    town with no articles) is dropped and its weight redistributed -- missing
    sentiment is treated as `insufficient_data`, never as neutral;
  * returns, per site, the normalized score, the underlying raw value, the weight
    used, the source, a 0-1 confidence and a plain-English explanation for every
    factor -- plus a final score, confidence, similarity to proven sites, warnings
    and a plain-English verdict.

Sentiment itself is classified upstream (sentiment.classify_town_corpus, LLM on
Flash GPU); this module just consumes the per-town result. Output is keyed by the
existing candidate `id` so the frontend can join it directly to
`parcels_raw.geojson`.
"""
from __future__ import annotations

import math
from collections import defaultdict
from statistics import mean, pstdev

from scorer import _locality_score, _normalize

# Towns with documented, real solar deployment + sentiment evidence in the corpus.
# Used as the reference set for `similarity_to_proven_sites`.
PROVEN_TOWNS = ("Bakersfield", "Wasco")

# Base ranking weights -- only factors that vary geographically AND carry usable
# signal. These are renormalized per site over whatever factors are usable there.
# (solar is near-constant here, land_cost is constant, slope/maintenance are
# fallbacks -> none of them get ranking weight; see EXCLUDED_FROM_RANKING.)
BASE_WEIGHTS = {
    "grid": 0.40,        # km to substation -- strongest geographic driver
    "sentiment": 0.30,   # community support (town-level LLM read)
    "locality": 0.20,    # km to nearest town -- access vs. nuisance sweet spot
    "land_use": 0.10,    # NLCD land-cover conflict (cropland vs. disturbed land)
}

# Land-cover suitability for utility-scale solar (NLCD class -> 0-100).
# Already-disturbed / open land is ideal; productive irrigated cropland is a
# food-vs-energy conflict and is penalized.
LAND_USE_SCORE = {
    "developed_open_space": 90.0,
    "shrubland": 75.0,
    "irrigated_cropland": 35.0,
}
LAND_USE_DEFAULT = 60.0

# Per-source confidence (0-1) for the deterministic factors.
SOURCE_CONFIDENCE = {
    "hifld_or_seed": 0.85,
    "county_meta": 0.90,
    "padus_heuristic": 0.60,
    "brightdata_listings": 0.70,
    "latitude_estimate": 0.40,
    "fast_mode_estimate": 0.30,
    "fallback": 0.20,
}

# A numeric factor counts as "varying geographically" only if its spread is real.
# coefficient of variation (stdev/mean); below this it's treated as constant.
_CV_THRESHOLD = 0.01


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _confidence_label(value: float) -> str:
    return "high" if value >= 0.75 else "medium" if value >= 0.5 else "low"


def _is_constant(values: list[float]) -> bool:
    """True if a numeric factor has no meaningful geographic variation."""
    nums = [v for v in values if isinstance(v, (int, float))]
    if len(nums) < 2:
        return True
    m = mean(nums)
    if m == 0:
        return pstdev(nums) == 0
    return (pstdev(nums) / abs(m)) < _CV_THRESHOLD


def _town_anchors(parcels: list[dict]) -> dict[str, tuple[float, float]]:
    """Approximate each town's centroid as the mean coords of sites nearest it."""
    acc: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for p in parcels:
        town = p["factors_raw"]["locality"].get("nearest_town")
        if town:
            acc[town].append((p["lat"], p["lon"]))
    return {t: (mean(la for la, _ in pts), mean(lo for _, lo in pts)) for t, pts in acc.items()}


def _factor(normalized, raw, weight, source, confidence, explanation) -> dict:
    return {
        "normalized": round(float(normalized), 1),
        "raw": raw,
        "weight": round(float(weight), 3),
        "source": source,
        "confidence": round(float(confidence), 2),
        "explanation": explanation,
    }


def score_candidate_sites(raw: dict, town_sentiment: dict[str, dict]) -> dict:
    """Score, rank and explain every candidate site.

    Args:
        raw: the parsed `parcels_raw.json` ({metadata, sentiment_corpus, parcels}).
        town_sentiment: town -> classification, from sentiment.classify_town_corpus.
            Each entry: {status, score?, confidence, n_articles, label?, evidence?,
            summary?}. status == "insufficient_data" for towns with no usable text.

    Returns a dict keyed by candidate id plus ranking + summary metadata.
    """
    parcels = raw["parcels"]
    fr = lambda p: p["factors_raw"]  # noqa: E731

    # --- decide which factors actually vary geographically (rank only on those) ---
    grid_constant = _is_constant([fr(p)["grid"]["dist_km_substation"] for p in parcels])
    locality_constant = _is_constant([fr(p)["locality"]["dist_km_nearest_town"] for p in parcels])
    solar_constant = _is_constant([fr(p)["solar_irradiance"]["ghi_annual_kwh_m2"] for p in parcels])
    land_use_classes = {fr(p)["wildlife"]["nlcd_class"] for p in parcels}
    land_use_varies = len(land_use_classes) > 1

    factor_active = {
        "grid": not grid_constant,
        "locality": not locality_constant,
        "land_use": land_use_varies,
        "sentiment": True,  # per-site availability handled below
    }
    excluded_constant = [k for k in ("grid", "locality") if not factor_active[k]]
    if solar_constant:
        excluded_constant.append("solar")
    if not land_use_varies:
        excluded_constant.append("land_use")

    # weight a fully-covered site would carry -- used to penalize confidence when a
    # desired factor (e.g. sentiment) is missing at a given site.
    full_coverage_weight = sum(
        BASE_WEIGHTS[k] for k in ("grid", "locality", "land_use") if factor_active[k]
    ) + BASE_WEIGHTS["sentiment"]

    anchors = _town_anchors(parcels)
    proven_anchors = {t: anchors[t] for t in PROVEN_TOWNS if t in anchors}

    # proven-site reference profile (mean normalized grid/locality of proven towns)
    proven_grid_norm, proven_loc_norm = _proven_profile(parcels, fr)

    scored: dict[str, dict] = {}
    rows = []  # (id, score) for ranking

    for p in parcels:
        pid, lat, lon = p["id"], p["lat"], p["lon"]
        f = fr(p)

        factors, used_weights, conf_terms, warnings = _score_one(
            f, factor_active, town_sentiment
        )

        # weighted final score over the per-site usable factors (weights sum to 1)
        total_w = sum(used_weights.values()) or 1.0
        score = sum(used_weights[k] * factors[k]["normalized"] for k in used_weights) / total_w
        # confidence = quality of the used factors, scaled down by how much desired
        # weight is missing at this site (e.g. no sentiment -> coverage < 1).
        coverage = min(1.0, total_w / full_coverage_weight)
        confidence = coverage * sum(
            conf_terms[k] * (used_weights[k] / total_w) for k in used_weights
        )

        # store the renormalized weight actually used back onto each factor
        for k in factors:
            factors[k]["weight"] = round(used_weights.get(k, 0.0) / total_w, 3)

        sim = _similarity(
            lat, lon, proven_anchors, proven_grid_norm, proven_loc_norm,
            factors["grid"]["normalized"], factors["locality"]["normalized"],
        )

        scored[pid] = {
            "id": pid,
            "lat": lat,
            "lon": lon,
            "score": round(score, 1),
            "rank": None,  # filled after sort
            "confidence": {"score": round(confidence, 2), "label": _confidence_label(confidence)},
            "factor_scores": factors,
            "sentiment_summary": _site_sentiment(f, town_sentiment),
            "similarity_to_proven_sites": sim,
            "warnings": warnings,
            "verdict": None,  # filled after rank known
        }
        rows.append((pid, score))

    # --- rank best-first and finalize verdict + plain-English summary ---
    rows.sort(key=lambda r: r[1], reverse=True)
    ranked_ids = [pid for pid, _ in rows]
    for rank, pid in enumerate(ranked_ids, start=1):
        scored[pid]["rank"] = rank
        scored[pid]["verdict"] = _verdict(scored[pid], rank, len(ranked_ids))

    summary = _build_summary(scored, ranked_ids, town_sentiment, excluded_constant)

    meta = dict(raw.get("metadata", {}))
    meta.update(
        {
            "scored_count": len(scored),
            "ranking_factors": [k for k, on in factor_active.items() if on],
            "excluded_constant_factors": excluded_constant,
            "land_cost_excluded": True,  # constant across all sites, per P1 handoff
            "proven_towns": list(proven_anchors.keys()),
            "weighting_note": (
                "Ranked only on factors with real geographic variation; weights are "
                "renormalized per site, and towns without sentiment evidence are scored "
                "as insufficient_data (not neutral)."
            ),
        }
    )

    return {
        "metadata": meta,
        "sites": scored,        # keyed by candidate id -> joins to parcels_raw.geojson
        "ranked_ids": ranked_ids,
        "count": len(scored),
        "summary": summary,
    }


def _proven_profile(parcels, fr):
    """Mean normalized grid/locality score across sites in proven towns."""
    g, l = [], []
    for p in parcels:
        if fr(p)["locality"].get("nearest_town") in PROVEN_TOWNS:
            g.append(_normalize(fr(p)["grid"]["dist_km_substation"], 0.0, 20.0, invert=True))
            l.append(_locality_score(fr(p)["locality"]["dist_km_nearest_town"], low=2, high=15,
                                     low_zero=0, high_zero=30))
    return (mean(g) if g else 70.0), (mean(l) if l else 80.0)


def _score_one(f, factor_active, town_sentiment):
    """Build the full factor_scores dict for one site + the weights/confidences used."""
    factors: dict[str, dict] = {}
    used_weights: dict[str, float] = {}
    conf_terms: dict[str, float] = {}
    warnings: list[str] = []

    # --- grid (closer = better) ---
    grid_km = f["grid"]["dist_km_substation"]
    grid_src = f["grid"].get("source", "unknown")
    grid_norm = _normalize(grid_km, 0.0, 20.0, invert=True)
    grid_conf = SOURCE_CONFIDENCE.get(grid_src, 0.5)
    factors["grid"] = _factor(
        grid_norm, grid_km, BASE_WEIGHTS["grid"], grid_src, grid_conf,
        f"{grid_km:.1f} km to the {f['grid'].get('nearest_kv')} kV "
        f"{f['grid'].get('nearest_name')} substation — "
        + ("excellent interconnection proximity." if grid_norm >= 70 else
           "moderate interconnection distance." if grid_norm >= 40 else
           "far from the grid; interconnection cost is a real risk."),
    )
    if factor_active["grid"]:
        used_weights["grid"] = BASE_WEIGHTS["grid"]
        conf_terms["grid"] = grid_conf

    # --- locality (sweet spot: accessible but not on top of town) ---
    loc_km = f["locality"]["dist_km_nearest_town"]
    loc_src = f["locality"].get("source", "unknown")
    loc_norm = _locality_score(loc_km, low=2, high=15, low_zero=0, high_zero=30)
    loc_conf = SOURCE_CONFIDENCE.get(loc_src, 0.5)
    factors["locality"] = _factor(
        loc_norm, loc_km, BASE_WEIGHTS["locality"], loc_src, loc_conf,
        f"{loc_km:.1f} km from {f['locality'].get('nearest_town')} — "
        + ("good balance of access and distance from residents." if loc_norm >= 70 else
           "very close to town (nuisance/opposition risk)." if loc_km < 2 else
           "somewhat remote from population."),
    )
    if factor_active["locality"]:
        used_weights["locality"] = BASE_WEIGHTS["locality"]
        conf_terms["locality"] = loc_conf

    # --- land use (NLCD land-cover conflict) ---
    nlcd = f["wildlife"].get("nlcd_class")
    lu_src = f["wildlife"].get("source", "unknown")
    lu_norm = LAND_USE_SCORE.get(nlcd, LAND_USE_DEFAULT)
    lu_conf = SOURCE_CONFIDENCE.get(lu_src, 0.5)
    factors["land_use"] = _factor(
        lu_norm, nlcd, BASE_WEIGHTS["land_use"], lu_src, lu_conf,
        {
            "developed_open_space": "already-disturbed open land — ideal for solar.",
            "shrubland": "shrubland — low land-use conflict.",
            "irrigated_cropland": "productive irrigated cropland — food-vs-energy conflict.",
        }.get(nlcd, f"land cover '{nlcd}'."),
    )
    if factor_active["land_use"]:
        used_weights["land_use"] = BASE_WEIGHTS["land_use"]
        conf_terms["land_use"] = lu_conf
    if nlcd == "irrigated_cropland":
        warnings.append("irrigated_cropland_land_use_conflict")

    # --- sentiment (town-level LLM read; insufficient_data is NOT neutral) ---
    town = f["sentiment"].get("town_key") or f["locality"].get("nearest_town")
    ts = town_sentiment.get(town, {"status": "insufficient_data", "n_articles": 0, "confidence": 0.0})
    if ts.get("status") == "ok":
        s_norm = ts["score"]
        s_conf = ts["confidence"]
        factors["sentiment"] = _factor(
            s_norm, f"{ts.get('n_articles', 0)} articles ({town})",
            BASE_WEIGHTS["sentiment"], "llm_classifier", s_conf,
            f"{ts.get('label', 'mixed')} community sentiment in {town} "
            f"(from {ts.get('n_articles', 0)} local articles).",
        )
        used_weights["sentiment"] = BASE_WEIGHTS["sentiment"]
        conf_terms["sentiment"] = s_conf
    else:
        factors["sentiment"] = _factor(
            0.0, f"insufficient_data ({town})", 0.0, "llm_classifier", 0.0,
            f"No usable sentiment evidence for {town}; not scored "
            "(treated as insufficient_data, not neutral).",
        )
        warnings.append("sentiment_insufficient_data")

    # --- transparency-only factors: reported but never affect ranking ---
    _add_informational_factors(f, factors, warnings)

    if not used_weights:  # safety: never divide by zero
        used_weights["grid"] = BASE_WEIGHTS["grid"]
        conf_terms["grid"] = grid_conf

    return factors, used_weights, conf_terms, warnings


def _add_informational_factors(f, factors, warnings):
    """Constant / low-confidence factors: shown for transparency, weight 0."""
    ghi = f["solar_irradiance"]["ghi_annual_kwh_m2"]
    factors["solar"] = _factor(
        _normalize(ghi / 365.0, 3.0, 7.0), ghi, 0.0,
        f["solar_irradiance"].get("source", "unknown"),
        SOURCE_CONFIDENCE.get(f["solar_irradiance"].get("source"), 0.4),
        f"{ghi:.0f} kWh/m²/yr — excellent but essentially uniform across the county, "
        "so it does not differentiate sites (not ranked).",
    )

    slope = f["slope"]["degrees"]
    factors["slope"] = _factor(
        _normalize(slope, 0.0, 15.0, invert=True), slope, 0.0,
        f["slope"].get("source", "unknown"),
        SOURCE_CONFIDENCE.get(f["slope"].get("source"), 0.3),
        f"{slope:.1f}° estimated slope — low-confidence fallback and constant; not ranked.",
    )

    road = f["maintenance"].get("dist_km_paved_road")
    factors["maintenance"] = _factor(
        _normalize(road, 0.0, 20.0, invert=True) if road is not None else 0.0,
        f["maintenance"], 0.0, f["maintenance"].get("source", "unknown"),
        SOURCE_CONFIDENCE.get(f["maintenance"].get("source"), 0.2),
        "maintenance/road metrics are fallback estimates and constant; not ranked.",
    )

    price = f["land"]["price_per_acre_est"]
    factors["land_cost"] = _factor(
        0.0, price, 0.0, f["land"].get("source", "unknown"), 0.3,
        f"${price:,.0f}/acre — identical across all sites (no variation), so excluded "
        "from ranking per the data handoff.",
    )

    protected = f["wildlife"].get("in_protected_area", False)
    factors["wildlife_protected"] = _factor(
        0.0 if protected else 100.0, protected, 0.0,
        f["wildlife"].get("source", "unknown"),
        SOURCE_CONFIDENCE.get(f["wildlife"].get("source"), 0.6),
        "inside a protected area — excluded." if protected
        else "not in a protected area.",
    )
    if protected:
        warnings.append("protected_area_excluded")


def _similarity(lat, lon, proven_anchors, proven_grid_norm, proven_loc_norm,
                grid_norm, loc_norm):
    """How much this site resembles the proven (operational-solar) towns: 0-1."""
    if not proven_anchors:
        return {"score": 0.0, "nearest_proven_town": None, "distance_km": None,
                "basis": "no proven reference towns available"}

    nearest_town, nearest_km = None, float("inf")
    for town, (alat, alon) in proven_anchors.items():
        d = _haversine_km(lat, lon, alat, alon)
        if d < nearest_km:
            nearest_town, nearest_km = town, d

    geo_sim = max(0.0, 1.0 - nearest_km / 40.0)  # within ~40 km of a proven town
    profile_dist = math.hypot(grid_norm - proven_grid_norm, loc_norm - proven_loc_norm)
    profile_sim = max(0.0, 1.0 - profile_dist / 141.4)  # 141 = max euclidean on 0-100^2
    score = round(0.6 * geo_sim + 0.4 * profile_sim, 2)

    return {
        "score": score,
        "nearest_proven_town": nearest_town,
        "distance_km": round(nearest_km, 1),
        "basis": (
            f"{nearest_km:.0f} km from {nearest_town} (proven solar town) with a "
            f"{'similar' if profile_sim >= 0.7 else 'partially matching'} grid/locality profile."
        ),
    }


def _site_sentiment(f, town_sentiment) -> dict:
    town = f["sentiment"].get("town_key") or f["locality"].get("nearest_town")
    ts = town_sentiment.get(town, {"status": "insufficient_data", "n_articles": 0})
    if ts.get("status") == "ok":
        return {
            "town": town,
            "status": "ok",
            "score": ts["score"],
            "label": ts.get("label"),
            "confidence": ts.get("confidence"),
            "n_articles": ts.get("n_articles", 0),
            "evidence": ts.get("evidence", []),
            "summary": ts.get("summary", ""),
        }
    return {
        "town": town,
        "status": "insufficient_data",
        "n_articles": ts.get("n_articles", 0),
        "summary": f"No usable local sentiment evidence for {town}.",
    }


def _verdict(site, rank, total) -> dict:
    score = site["score"]
    conf = site["confidence"]["score"]
    has_sentiment = "sentiment_insufficient_data" not in site["warnings"]

    if "protected_area_excluded" in site["warnings"]:
        label = "excluded"
    elif score >= 70 and conf >= 0.55:
        label = "strong_candidate"
    elif score >= 55:
        label = "promising"
    elif score >= 40:
        label = "marginal"
    else:
        label = "weak"

    fs = site["factor_scores"]
    driver = max(("grid", "locality", "land_use"), key=lambda k: fs[k]["normalized"])
    weak = min(("grid", "locality", "land_use"), key=lambda k: fs[k]["normalized"])

    bits = [f"Ranked #{rank} of {total} (score {score}/100, {site['confidence']['label']} confidence)."]
    bits.append(f"Strongest factor: {driver} ({fs[driver]['normalized']}).")
    if fs[weak]["normalized"] < 50:
        bits.append(f"Held back by {weak} ({fs[weak]['normalized']}).")
    if not has_sentiment:
        bits.append("Community sentiment is insufficient_data here, lowering confidence.")
    return {"label": label, "summary": " ".join(bits)}


def _build_summary(scored, ranked_ids, town_sentiment, excluded_constant) -> dict:
    best = scored[ranked_ids[0]]
    worst = scored[ranked_ids[-1]]

    def explain(site, superlative):
        fs = site["factor_scores"]
        return (
            f"{site['id']} is the {superlative} candidate (score {site['score']}/100, "
            f"{site['confidence']['label']} confidence). "
            f"{site['verdict']['summary']} "
            f"Grid {fs['grid']['normalized']}, locality {fs['locality']['normalized']}, "
            f"land-use {fs['land_use']['normalized']}, "
            f"sentiment {fs['sentiment']['raw']}."
        )

    towns = {
        t: {
            "status": v.get("status"),
            "score": v.get("score"),
            "label": v.get("label"),
            "n_articles": v.get("n_articles", 0),
        }
        for t, v in town_sentiment.items()
    }

    return {
        "strongest": {"id": best["id"], "explanation": explain(best, "strongest")},
        "weakest": {"id": worst["id"], "explanation": explain(worst, "weakest")},
        "town_sentiment": towns,
        "notes": [
            "Land cost excluded from ranking — identical across all 160 sites.",
            f"Constant / non-varying factors excluded from ranking: {', '.join(excluded_constant) or 'none'}.",
            "Slope and maintenance are estimates/fallbacks — reported but unweighted.",
            "Towns without local articles return insufficient_data, not neutral sentiment.",
        ],
    }
