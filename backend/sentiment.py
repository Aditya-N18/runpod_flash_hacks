"""Sentiment factor client: route a batch of scraped texts to the Flash GPU LLM
endpoint, falling back to a local keyword heuristic when that endpoint is
unreachable (e.g. running locally via `uv run` without a deployed Flash env)."""


def _extract_scores(result) -> list | None:
    """Pull the scores list out of the worker's response, tolerating either a raw
    {"scores": [...]} return or a wrapped {"result"/"output": {"scores": [...]}}."""
    if not isinstance(result, dict):
        return None
    if isinstance(result.get("scores"), list):
        return result["scores"]
    for key in ("result", "output"):
        inner = result.get(key)
        if isinstance(inner, dict) and isinstance(inner.get("scores"), list):
            return inner["scores"]
    return None


async def get_sentiment_scores(texts: list[str]) -> list[float]:
    """Returns one 0-100 score per input text (higher = more community support)."""
    if not texts:
        return []

    from sentiment_llm import classify_batch, score_texts_heuristic

    try:
        result = await classify_batch(texts=texts)
        scores = _extract_scores(result)
        if scores is not None and len(scores) == len(texts):
            return scores
    except Exception:
        pass
    return score_texts_heuristic(texts)


# A town needs at least this many usable articles before we trust an aggregate
# read; below it the corpus is too thin and we return insufficient_data.
_MIN_ARTICLES = 1


def _label(score: float) -> str:
    if score >= 65:
        return "supportive"
    if score >= 55:
        return "leaning supportive"
    if score > 45:
        return "mixed"
    if score > 35:
        return "leaning opposed"
    return "opposed"


async def classify_town_corpus(sentiment_corpus: dict) -> dict[str, dict]:
    """Classify each town's article corpus into one aggregate sentiment read.

    Towns with no usable articles return ``{"status": "insufficient_data"}`` --
    never a neutral 50 -- so the scorer can drop sentiment for those sites rather
    than rewarding them for missing data.

    Returns town -> {status, score?, label?, confidence, n_articles, evidence?, summary?}.
    """
    out: dict[str, dict] = {}

    for town, payload in sentiment_corpus.items():
        articles = payload.get("articles", []) or []
        usable = [a for a in articles if (a.get("body_markdown") or "").strip()]

        if len(usable) < _MIN_ARTICLES:
            out[town] = {
                "status": "insufficient_data",
                "n_articles": len(usable),
                "confidence": 0.0,
            }
            continue

        scores = await get_sentiment_scores([a["body_markdown"] for a in usable])
        agg = round(sum(scores) / len(scores), 1)
        # confidence grows with corpus size (1 article -> ~0.5, 8+ -> ~0.9), capped.
        confidence = round(min(0.9, 0.45 + 0.07 * len(usable)), 2)
        out[town] = {
            "status": "ok",
            "score": agg,
            "label": _label(agg),
            "confidence": confidence,
            "n_articles": len(usable),
            "evidence": [a.get("title", "") for a in usable[:5]],
            "summary": (
                f"{_label(agg).capitalize()} ({agg}/100) across {len(usable)} local "
                f"article(s) about solar development near {town}."
            ),
        }

    return out
