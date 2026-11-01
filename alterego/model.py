"""Pro serve model learned from measured reference footage.

Training data: one feature vector per pro serve (from alterego.features), many
serves per pro across several videos. The model is a per-pro Gaussian with a
learned diagonal metric:

- each pro's profile is the mean of their measured serves;
- spread is the pooled within-pro standard deviation (how much one player
  varies serve to serve);
- each feature's weight is its Fisher ratio (between-pro variance over
  within-pro variance), so features that actually separate players count more
  and noisy ones fade out.

Evaluated with leave-one-video-out, so serves from the same clip never sit on
both sides of the split.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from statistics import mean, pstdev

DATA = Path(__file__).resolve().parent / "data"
VIEWS = ("side", "back")


def model_path(view: str) -> Path:
    return DATA / f"serve_{view}_model.json"


MIN_SERVES = 3
Z_CAP = 3.0

FEATURES = {
    "knee_flex": {"label": "Knee bend", "unit": "°", "fmt": "{:.0f}"},
    "leg_drive": {"label": "Leg drive", "unit": " torso", "fmt": "{:.2f}"},
    "shoulder_turn": {"label": "Shoulder turn", "unit": "°", "fmt": "{:.0f}"},
    "separation": {"label": "Hip-shoulder separation", "unit": "°", "fmt": "{:.0f}"},
    "contact_height": {"label": "Reach at contact", "unit": " torso", "fmt": "{:.2f}"},
    "arm_extension": {"label": "Arm extension", "unit": "°", "fmt": "{:.0f}"},
    "trunk_lean": {"label": "Trunk lean", "unit": "°", "fmt": "{:.0f}"},
    "off_arm_height": {"label": "Toss-arm height", "unit": " torso", "fmt": "{:.2f}"},
    "stance_width": {"label": "Stance width", "unit": " torso", "fmt": "{:.2f}"},
    # tempo_ratio (windup vs follow-through) is excluded: it depends on where the clip ends.
    "trophy_share": {"label": "Trophy timing", "unit": "", "fmt": "{:.2f}"},
}
# Radar axes shown in the UI (subset of FEATURES).
AXES = ["knee_flex", "leg_drive", "shoulder_turn", "contact_height", "arm_extension", "off_arm_height", "trunk_lean"]


def fmt(feature: str, value: float) -> str:
    meta = FEATURES[feature]
    return meta["fmt"].format(value) + meta["unit"]


def train(samples: list[dict], evaluate: bool = True, view: str = "side") -> dict:
    """samples: [{"pro_id", "video_id", "features": {...}}]"""
    by_pro: dict[str, list[dict]] = {}
    for s in samples:
        by_pro.setdefault(s["pro_id"], []).append(s)
    by_pro = {p: ss for p, ss in by_pro.items() if len(ss) >= MIN_SERVES}
    if len(by_pro) < 2:
        raise ValueError("Need at least 2 pros with 3+ serves each to train.")

    feats = list(FEATURES)
    all_x = [s["features"] for ss in by_pro.values() for s in ss]
    pop = {f: (mean(x[f] for x in all_x), pstdev(x[f] for x in all_x) or 1.0) for f in feats}

    pros, within_ss, n_total = {}, {f: 0.0 for f in feats}, 0
    for pro_id, ss in by_pro.items():
        mu = {f: mean(s["features"][f] for s in ss) for f in feats}
        for s in ss:
            for f in feats:
                within_ss[f] += (s["features"][f] - mu[f]) ** 2
        n_total += len(ss)
        curves = {}
        for k in ss[0]["features"].get("curves", {}):
            rows = [s["features"]["curves"][k] for s in ss if k in s["features"].get("curves", {})]
            curves[k] = [round(mean(col), 2) for col in zip(*rows)]
        pros[pro_id] = {
            "mean": {f: round(v, 4) for f, v in mu.items()},
            "n_serves": len(ss),
            "n_videos": len({s["video_id"] for s in ss}),
            "curves": curves,
        }

    dof = max(1, n_total - len(pros))
    within = {f: max(math.sqrt(within_ss[f] / dof), 0.15 * pop[f][1], 1e-6) for f in feats}
    between = {f: pstdev(p["mean"][f] for p in pros.values()) for f in feats}
    fisher = {f: (between[f] / within[f]) ** 2 for f in feats}
    avg = mean(fisher.values()) or 1.0
    weights = {f: round(min(max(fisher[f] / avg, 0.05), 4.0), 4) for f in feats}

    model = {
        "stroke": "serve",
        "view": view,
        "features": feats,
        "axes": AXES,
        "population": {f: {"mean": round(m, 4), "std": round(s, 4)} for f, (m, s) in pop.items()},
        "within_std": {f: round(v, 4) for f, v in within.items()},
        "weights": weights,
        "pros": pros,
        "n_samples": n_total,
    }
    if evaluate:
        model["evaluation"] = leave_one_video_out(samples)
    return model


def leave_one_video_out(samples: list[dict]) -> dict:
    videos = sorted({(s["pro_id"], s["video_id"]) for s in samples})
    hits1 = hits3 = total = 0
    for pro_id, vid in videos:
        train_set = [s for s in samples if s["video_id"] != vid]
        test = [s for s in samples if s["video_id"] == vid]
        try:
            m = train(train_set, evaluate=False)
        except ValueError:
            continue
        if pro_id not in m["pros"]:
            continue  # this pro has no other video to learn from
        for s in test:
            ranked = [r["pro_id"] for r in rank(m, s["features"])]
            total += 1
            hits1 += ranked[0] == pro_id
            hits3 += pro_id in ranked[:3]
    return {
        "method": "leave-one-video-out",
        "n_test": total,
        "top1": round(hits1 / total, 3) if total else None,
        "top3": round(hits3 / total, 3) if total else None,
    }


def distance2(model: dict, x: dict, pro_id: str) -> tuple[float, dict]:
    pro = model["pros"][pro_id]["mean"]
    w = model["weights"]
    z = {f: (x[f] - pro[f]) / model["within_std"][f] for f in model["features"]}
    # Cap each feature's contribution: one glitchy measurement (e.g. a motion-blurred
    # arm at contact on phone footage) shouldn't wipe out an otherwise close match.
    d2 = sum(w[f] * min(z[f] ** 2, Z_CAP ** 2) for f in z) / sum(w.values())
    return d2, z


def score_one(model: dict, x: dict, pro_id: str) -> dict:
    d2, z = distance2(model, x, pro_id)
    pro = model["pros"][pro_id]["mean"]
    w = model["weights"]
    # Biggest gaps are the ones that matter most for this player: weighted |z|.
    ranked = sorted(z, key=lambda f: w[f] * z[f] ** 2, reverse=True)
    return {
        "pro_id": pro_id,
        "similarity": max(1, min(99, round(100 * math.exp(-d2 / 4)))),
        "distance": round(d2, 3),
        "gaps": {f: round(pro[f] - x[f], 3) for f in z},
        "z": {f: round(v, 2) for f, v in z.items()},
        "biggest_gaps": ranked[:3],
        "closest_traits": [f for f in sorted(z, key=lambda f: abs(z[f])) if w[f] >= 0.5][:2],
        "pro_axes": axes_for(model, pro),
        "pro_curves": model["pros"][pro_id]["curves"],
        "measured": {"n_serves": model["pros"][pro_id]["n_serves"], "n_videos": model["pros"][pro_id]["n_videos"]},
    }


def rank(model: dict, x: dict) -> list[dict]:
    return sorted((score_one(model, x, p) for p in model["pros"]), key=lambda r: r["distance"])


def axes_for(model: dict, x: dict) -> dict:
    """0-100 per radar axis; 50 = average across all measured pro serves."""
    out = {}
    for f in model["axes"]:
        pop = model["population"][f]
        out[f] = round(max(0, min(100, 50 + 25 * (x[f] - pop["mean"]) / pop["std"])))
    return out


def axis_labels(model: dict) -> dict:
    return {f: FEATURES[f]["label"] for f in model["axes"]}


_cache: dict[str, dict] = {}


def load(view: str = "side") -> dict | None:
    if view not in _cache and model_path(view).exists():
        _cache[view] = json.loads(model_path(view).read_text())
    return _cache.get(view)
