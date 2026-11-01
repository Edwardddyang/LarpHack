"""Coaching report: how to play more like your chosen pro.

Uses Claude when ANTHROPIC_API_KEY is set, otherwise a rule-based template so
the app still works offline.
"""

from __future__ import annotations

import json
import os

from pydantic import BaseModel

from .style import AXES

MODEL = "claude-opus-5-5"


class Fix(BaseModel):
    axis: str
    you: str
    them: str
    cue: str


class Drill(BaseModel):
    name: str
    how: str
    reps: str


class CoachingReport(BaseModel):
    headline: str
    alter_ego_story: str
    shared_traits: list[str]
    fixes: list[Fix]
    drills: list[Drill]
    watch: list[str]
    walkout_line: str


SYSTEM = """You are a world-class tennis and pickleball coach with a flair for theater. \
Players film one stroke, we measure their biomechanics from pose tracking, and match them to a pro \
whose style they want to LARP as. Your job: make them feel like that pro for a moment, then give \
them concrete, safe, practical steps to genuinely move toward that pro's style.

Rules:
- Axes are 0-100 style scores: power, legs (knee bend + upward drive), coil (shoulder turn and \
hip-shoulder separation), reach (contact height for serves, arm extension for groundstrokes), \
quickness (short prep time), stability (quiet head), finish (follow-through length).
- Pro axis values are style archetypes from public descriptions, not measured data. Never claim \
precise stats about the pro.
- Cues must be one short sentence a player can think mid-swing.
- Drills must be doable alone or with a partner on a normal court in under 10 minutes.
- watch: 2-3 YouTube search queries (not URLs) for slow-motion footage of the pro's relevant stroke.
- alter_ego_story: 2-3 vivid second-person sentences putting the player in the pro's shoes on a big court.
- walkout_line: one stadium-announcer style introduction for the player under a pro-inspired nickname.
- fixes: exactly the 3 biggest gaps given, in order."""


def _prompt(features, user_axes, pro, match, sport, stroke):
    return json.dumps({
        "sport": sport,
        "stroke": stroke,
        "pro": {k: pro[k] for k in ("name", "nickname", "signature", "axes")},
        "similarity_percent": match["similarity"],
        "player_axes": user_axes,
        "gaps_pro_minus_player": match["gaps"],
        "biggest_gaps": match["biggest_gaps"],
        "closest_traits": match["closest_traits"],
        "raw_features": features,
    }, indent=1)


def coach_with_claude(features, user_axes, pro, match, sport, stroke) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    response = client.beta.messages.parse(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "low"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(features, user_axes, pro, match, sport, stroke)}],
        output_format=CoachingReport,
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise RuntimeError(f"Claude returned no report (stop_reason={response.stop_reason})")
    return response.parsed_output.model_dump()


CUES = {
    "power": ("Accelerate through contact, not at the start.", "Shadow swings: slow back, fast through, 3 sets of 10."),
    "legs": ("Sit into your legs, then push the ground away.", "Load-and-explode: 10 bounces in your loaded stance, then swing."),
    "coil": ("Show your back to the net before you swing.", "Hold a racket across your chest and turn shoulders past hips, 15 reps."),
    "reach": ("Hit up and out, as tall as you can be.", "Contact-point holds: freeze at contact for 2 seconds, 10 reps."),
    "quickness": ("Shorter takeback, same speed through.", "Rapid-fire feeds: partner feeds every 2 seconds, 20 balls."),
    "stability": ("Keep your eyes on the contact point after the ball leaves.", "Head-still hits: hold your head still until the ball crosses the net, 15 balls."),
    "finish": ("Let the racket finish over your shoulder.", "Freeze-finish: hold every follow-through for a 2-count, 15 balls."),
}


def coach_template(features, user_axes, pro, match, sport, stroke) -> dict:
    fixes, drills = [], []
    for axis in match["biggest_gaps"]:
        gap = match["gaps"][axis]
        direction = "more" if gap > 0 else "less"
        cue, drill = CUES[axis]
        if gap < 0:
            cue = f"Dial back the {AXES[axis].lower()}: aim for control over flash."
        fixes.append({
            "axis": axis,
            "you": f"{AXES[axis]} score {user_axes[axis]}",
            "them": f"{pro['name']} plays with {direction} {AXES[axis].lower()} (~{pro['axes'][axis]})",
            "cue": cue,
        })
        name, _, rest = drill.partition(":")
        drills.append({"name": name, "how": rest.strip(), "reps": "Every practice session"})
    first = pro["name"].split()[0]
    return {
        "headline": f"You're {match['similarity']}% {pro['name']}",
        "alter_ego_story": (
            f"The crowd hushes as you step up like {pro['name']}. "
            f"{pro['signature']} Now make it yours."
        ),
        "shared_traits": [f"{AXES[a]} like {first}" for a in match["closest_traits"]],
        "fixes": fixes,
        "drills": drills,
        "watch": [f"{pro['name']} {stroke} slow motion", f"{pro['name']} {stroke} technique breakdown"],
        "walkout_line": f"Introducing... the next {pro['nickname']}!",
    }


def coach(features, user_axes, pro, match, sport, stroke) -> dict:
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            report = coach_with_claude(features, user_axes, pro, match, sport, stroke)
            report["source"] = "claude"
            return report
        except Exception as e:  # never lose a finished analysis to a coaching hiccup
            print(f"Claude coaching failed, using template: {e!r}")
    report = coach_template(features, user_axes, pro, match, sport, stroke)
    report["source"] = "template"
    return report
