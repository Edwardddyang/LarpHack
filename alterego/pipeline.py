"""Analysis steps and their orchestration.

The steps are plain functions. `analyze` and `become` take a `call(step, *args)`
coroutine so the same orchestration runs as chained Render Workflow task runs
(workflow/main.py) or in-process for local development (web/app.py).

Tennis serves are scored against the model trained on measured pro footage
(alterego/model.py). Other strokes fall back to hand-written style archetypes
and are labeled as estimates.
"""

from __future__ import annotations

import asyncio

from . import coach, features as feat, model, pros, style


def _measured_model(sport: str, stroke: str):
    return model.load() if sport == "tennis" and stroke == "serve" else None


def extract(payload: dict) -> dict:
    sport = payload.get("sport", "tennis")
    stroke = payload.get("stroke", "serve")
    try:
        f = feat.extract_features(payload)
    except feat.SwingError as e:
        return {"error": str(e)}
    m = _measured_model(sport, stroke)
    if m:
        return {
            "sport": sport, "stroke": stroke, "features": f,
            "profile_source": "measured",
            "axes": model.axes_for(m, f),
            "axis_labels": model.axis_labels(m),
            "labels": {k: v["label"] for k, v in model.FEATURES.items()},
            "candidates": list(m["pros"]),
            "evaluation": m.get("evaluation"),
        }
    return {
        "sport": sport, "stroke": stroke, "features": f,
        "profile_source": "archetype",
        "axes": style.to_axes(f, sport, stroke),
        "axis_labels": style.AXES,
        "labels": style.AXES,
        "candidates": [p["id"] for p in pros.pros_for(sport)],
    }


def score_pro(extracted: dict, pro_id: str) -> dict:
    if extracted["profile_source"] == "measured":
        return model.score_one(_measured_model("tennis", "serve"), extracted["features"], pro_id)
    return style.compare(extracted["axes"], pros.BY_ID[pro_id])


def write_coaching(extracted: dict, match: dict) -> dict:
    return coach.coach(extracted, pros.BY_ID[match["pro_id"]], match)


async def analyze(payload: dict, call) -> dict:
    extracted = await call("extract", payload)
    if "error" in extracted:
        return extracted
    # Fan out: every pro is scored in its own task run.
    matches = await asyncio.gather(*(call("score_pro", extracted, p) for p in extracted["candidates"]))
    matches = sorted(matches, key=lambda m: m["similarity"], reverse=True)
    target = payload.get("target") if payload.get("target") in extracted["candidates"] else matches[0]["pro_id"]
    match = next(m for m in matches if m["pro_id"] == target)
    report = await call("write_coaching", extracted, match)
    return {**extracted, "matches": matches, "target": target, "report": report}


async def become(extracted: dict, pro_id: str, call) -> dict:
    """Re-coach an analyzed swing toward a pro the player picks."""
    match = await call("score_pro", extracted, pro_id)
    report = await call("write_coaching", extracted, match)
    return {"target": pro_id, "match": match, "report": report}


STEPS = {"extract": extract, "score_pro": score_pro, "write_coaching": write_coaching}


async def call_local(step: str, *args):
    return await asyncio.to_thread(STEPS[step], *args)
