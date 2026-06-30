"""Data contracts between Person 1 (data scraping), Person 2 (scoring), and Person 3 (map)."""
from pydantic import BaseModel


class ParcelInput(BaseModel):
    """One candidate parcel, as delivered by Person 1's scrape/cache step."""

    parcel_id: str
    lat: float
    lon: float

    ghi_kwh_m2_day: float  # solar irradiance (NREL NSRDB)
    slope_degrees: float  # terrain (USGS elevation)
    grid_distance_km: float  # nearest substation/transmission (HIFLD)
    land_price_per_acre: float  # parcel/real-estate listing (Bright Data)
    road_distance_km: float  # access/maintenance burden
    locality_distance_km: float  # nearest town/population center (Census/OSM)
    sentiment_text: str = ""  # scraped local news/forum text (Bright Data); may be empty
    is_protected_land: bool = False  # PAD-US / USFWS protected status
    habitat_sensitivity: float = 0.0  # 0-1, from NLCD/USFWS habitat data


class ScoredParcel(BaseModel):
    """One parcel after scoring, ranked and broken down by factor for the map UI."""

    parcel_id: str
    lat: float
    lon: float
    rank: int
    final_score: float
    factors: dict[str, float]


class EvaluateRequest(BaseModel):
    parcels: list[ParcelInput]


class EvaluateResponse(BaseModel):
    ranked: list[ScoredParcel]
    count: int


# --- Batch (Person 1 raw-file) contract: POST /score-batch ---------------------
# Person 1 ships `parcels_raw.json` (metadata + sentiment_corpus + nested
# factors_raw per candidate site). The response is keyed by candidate `id` so the
# frontend joins it directly to `parcels_raw.geojson`. The shapes below document the
# frozen contract; the endpoint builds plain dicts matching them.


class FactorScore(BaseModel):
    """One factor for one site, with the evidence behind the number."""

    normalized: float          # 0-100
    raw: object                # underlying raw value (number / class / note)
    weight: float              # ranking weight actually used at this site (0 = not ranked)
    source: str                # provenance of the raw value
    confidence: float          # 0-1
    explanation: str           # short plain-English rationale


class SentimentSummary(BaseModel):
    town: str
    status: str                # "ok" | "insufficient_data"
    score: float | None = None
    label: str | None = None
    confidence: float | None = None
    n_articles: int = 0
    evidence: list[str] = []   # headline titles backing the read
    summary: str = ""


class SimilarityToProvenSites(BaseModel):
    score: float               # 0-1
    nearest_proven_town: str | None = None
    distance_km: float | None = None
    basis: str = ""


class Verdict(BaseModel):
    label: str                 # excluded|weak|marginal|promising|strong_candidate
    summary: str               # plain-English "why"


class ScoredSite(BaseModel):
    """One scored candidate site -- the per-`id` value in the response `sites` map."""

    id: str
    lat: float
    lon: float
    score: float               # 0-100 final suitability
    rank: int
    confidence: dict           # {"score": 0-1, "label": "high|medium|low"}
    factor_scores: dict[str, FactorScore]
    sentiment_summary: SentimentSummary
    similarity_to_proven_sites: SimilarityToProvenSites
    warnings: list[str]
    verdict: Verdict


class ScoreBatchResponse(BaseModel):
    metadata: dict
    sites: dict[str, ScoredSite]   # keyed by candidate id
    ranked_ids: list[str]          # best-first
    count: int
    summary: dict
