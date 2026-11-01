"""Analysis steps and their orchestration.

The steps are plain functions. `analyze` and `become` take a `call(step, *args)`
coroutine so the same orchestration runs as chained Render Workflow task runs
(workflow/main.py) or in-process for local development (web/app.py).
"""

from __future__ import annotations

import asyncio

from . import coach, features as feat, pros, style


def extract(payload: dict) -> dict:
    sport = payload.get("sport", "tennis")
    stroke = payload.get("stroke", "serve")
    try:
        f = feat.extract_features(payload)
    except feat.SwingError as e:
        return {"error": str(e)}
    return {"sport": sport, "stroke": stroke, "features": f, "axes": style.to_axes(f, sport, stroke)}


def score_pro(user_axes: dict, pro_id: str) -> dict:
    return style.compare(user_axes, pros.BY_ID[pro_id])


def write_coaching(extracted: dict, match: dict) -> dict:
    pro = pros.BY_ID[match["pro_id"]]
    return coach.coach(
        extracted["features"], extracted["axes"], pro, match, extracted["sport"], extracted["stroke"]
    )


async def analyze(payload: dict, call) -> dict:
    extracted = await call("extract", payload)
    if "error" in extracted:
        return extracted
    candidates = pros.pros_for(extracted["sport"])
    # Fan out: every pro is scored in its own task run.
    matches = await asyncio.gather(*(call("score_pro", extracted["axes"], p["id"]) for p in candidates))
    matches = sorted(matches, key=lambda m: m["similarity"], reverse=True)
    target = payload.get("target") or matches[0]["pro_id"]
    match = next(m for m in matches if m["pro_id"] == target)
    report = await call("write_coaching", extracted, match)
    return {**extracted, "matches": matches, "target": target, "report": report}


async def become(extracted: dict, pro_id: str, call) -> dict:
    """Re-coach an analyzed swing toward a pro the player picks."""
    match = await call("score_pro", extracted["axes"], pro_id)
    report = await call("write_coaching", extracted, match)
    return {"target": pro_id, "match": match, "report": report}


STEPS = {"extract": extract, "score_pro": score_pro, "write_coaching": write_coaching}


async def call_local(step: str, *args):
    return await asyncio.to_thread(STEPS[step], *args)
