# GPU worker: batch community-sentiment classification with Qwen2.5-3B-Instruct,
# served via HuggingFace transformers. (vLLM was the original plan but its wheel
# exceeds Flash's 600s build-install timeout; transformers installs well under it
# and runs the same model on the same GPU.) torch ships in the Flash GPU base image
# and is auto-excluded from the build.
#
# Offline callers (local `uv run`, no GPU) fall back to score_texts_heuristic so the
# pipeline stays fully testable without deploying.
from runpod_flash import Endpoint, GpuGroup

MODEL = "Qwen/Qwen2.5-3B-Instruct"
_BATCH = 16

_INSTRUCTION = (
    "Rate community sentiment toward solar farm development in the text below, "
    "from 0 (strong opposition) to 100 (strong support). 50 means neutral or mixed. "
    "Reply with ONLY the number, nothing else."
)


@Endpoint(
    name="sentiment-llm-v2",  # renamed to force RunPod to build a fresh endpoint (old one cached stale handler code)
    gpu=GpuGroup.ADA_24,  # RTX 4090 (24GB) -- ample for a 3B model in fp16
    workers=(0, 2),  # scale to zero when idle -> next call boots a fresh worker on latest code
    flashboot=False,  # no snapshot caching, so redeploys always pick up new handler code
    dependencies=["transformers==4.46.3", "accelerate"],  # pinned: supports Qwen2.5, predates models that break the Windows tar step
)
async def classify_batch(texts: list) -> dict:
    """Score a batch of texts 0-100 on GPU. Input body: {"texts": [...]}.

    Flash's QB handler unpacks the input dict as kwargs (`classify_batch(**input)`),
    so the parameter name must match the input key (`texts`).
    """
    import re

    if not texts:
        return {"scores": []}

    import torch

    tok, model = _get_model()
    prompts = [
        tok.apply_chat_template(
            [
                {"role": "system", "content": _INSTRUCTION},
                {"role": "user", "content": (t or "")[:2000]},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
        for t in texts
    ]

    scores: list[float] = []
    for start in range(0, len(prompts), _BATCH):
        chunk = prompts[start : start + _BATCH]
        enc = tok(
            chunk, return_tensors="pt", padding=True, truncation=True, max_length=1024
        ).to(model.device)
        with torch.no_grad():
            out = model.generate(
                **enc, max_new_tokens=8, do_sample=False, pad_token_id=tok.pad_token_id
            )
        generated = out[:, enc["input_ids"].shape[1] :]
        for text in tok.batch_decode(generated, skip_special_tokens=True):
            match = re.search(r"\d+(\.\d+)?", text)
            scores.append(max(0.0, min(100.0, float(match.group()))) if match else 50.0)

    return {"scores": scores}


_TOK = None
_MODEL = None


def _get_model():
    """Load tokenizer + model once per warm worker; reused across invocations."""
    global _TOK, _MODEL
    if _MODEL is None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        _TOK = AutoTokenizer.from_pretrained(MODEL)
        if _TOK.pad_token is None:
            _TOK.pad_token = _TOK.eos_token
        _TOK.padding_side = "left"  # decoder-only generation needs left padding
        _MODEL = AutoModelForCausalLM.from_pretrained(
            MODEL, torch_dtype=torch.float16, device_map="cuda"
        )
        _MODEL.eval()
    return _TOK, _MODEL


# -- offline fallback: keyword heuristic, no GPU and no model load --
_SUPPORT = (
    "support", "welcome", "job", "benefit", "favor", "approve",
    "excit", "tax revenue", "back the", "in favour", "in favor",
)
_OPPOSE = (
    "oppos", "petition", "against", "concern", "noise", "habitat",
    "fight", "contentious", "reject", "lawsuit", "block", "protest",
)


def score_texts_heuristic(texts: list[str]) -> list[float]:
    """Crude support-vs-opposition keyword balance. Used only when the GPU
    endpoint is unreachable; keeps local tests deterministic and offline."""
    scores = []
    for text in texts:
        low = (text or "").lower()
        pos = sum(low.count(w) for w in _SUPPORT)
        neg = sum(low.count(w) for w in _OPPOSE)
        if pos == 0 and neg == 0:
            scores.append(50.0)
        else:
            scores.append(round(50.0 + 50.0 * (pos - neg) / (pos + neg), 1))
    return scores
