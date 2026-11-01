"""Map raw features onto 0-100 style axes and compare against pro archetypes."""

from __future__ import annotations

import math

AXES = {
    "power": "Power",
    "legs": "Leg drive",
    "coil": "Coil",
    "reach": "Reach",
    "quickness": "Quick tempo",
    "stability": "Stillness",
    "finish": "Finish",
}

# (low, high) raw values mapped to 0 and 100. Rough calibration from 30fps phone video.
RANGES = {
    "serve": {
        "peak_speed": (5, 26), "knee_flex": (8, 55), "leg_drive": (0.0, 0.45),
        "shoulder_turn": (10, 70), "separation": (0, 30), "contact_height": (0.6, 2.2),
        "prep_time": (1.6, 0.4), "head_sway": (0.25, 0.03), "follow_time": (0.1, 0.7),
    },
    "groundstroke": {
        "peak_speed": (4, 20), "knee_flex": (10, 50), "leg_drive": (0.0, 0.25),
        "shoulder_turn": (15, 75), "separation": (0, 35), "arm_extension": (95, 175),
        "prep_time": (1.2, 0.3), "head_sway": (0.2, 0.02), "follow_time": (0.1, 0.6),
    },
}
# Pickleball strokes are more compact, so speed/turn scales shrink.
PICKLEBALL_SCALE = {"peak_speed": 0.6, "shoulder_turn": 0.75, "leg_drive": 0.7}


def _norm(value, lo, hi):
    if hi == lo:
        return 50.0
    return max(0.0, min(100.0, (value - lo) / (hi - lo) * 100))


def to_axes(features: dict, sport: str, stroke: str) -> dict:
    kind = "serve" if stroke == "serve" else "groundstroke"
    r = dict(RANGES[kind])
    if sport == "pickleball":
        for key, factor in PICKLEBALL_SCALE.items():
            lo, hi = r[key]
            r[key] = (lo * factor, hi * factor)

    def n(key):
        return _norm(features[key], *r[key])

    reach = n("contact_height") if kind == "serve" else n("arm_extension")
    return {
        "power": round(n("peak_speed")),
        "legs": round(0.6 * n("knee_flex") + 0.4 * n("leg_drive")),
        "coil": round(0.65 * n("shoulder_turn") + 0.35 * n("separation")),
        "reach": round(reach),
        "quickness": round(n("prep_time")),
        "stability": round(n("head_sway")),
        "finish": round(n("follow_time")),
    }


def compare(user_axes: dict, pro: dict) -> dict:
    """Similarity (0-100) between a user and one pro, plus per-axis gaps."""
    target = pro["axes"]
    gaps = {k: target[k] - user_axes[k] for k in AXES}
    rms = math.sqrt(sum(g * g for g in gaps.values()) / len(gaps))
    similarity = max(0, min(99, round(100 - rms * 1.15)))
    ranked = sorted(gaps.items(), key=lambda kv: abs(kv[1]), reverse=True)
    return {
        "pro_id": pro["id"],
        "similarity": similarity,
        "gaps": gaps,
        "biggest_gaps": [k for k, _ in ranked[:3]],
        "closest_traits": [k for k, _ in ranked[-2:]],
    }
