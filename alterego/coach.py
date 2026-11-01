"""Coaching report: how to play more like your chosen pro.

Uses Claude when ANTHROPIC_API_KEY is set, otherwise a rule-based template so
the app still works offline.
"""

from __future__ import annotations

import json
import os

from pydantic import BaseModel

from . import model

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
- If profile_source is "measured", the pro's numbers are averages measured from real slow-motion \
footage of their serve with the same pose pipeline (side view); you may quote them, and say they \
are measured from N serves. If "archetype", pro values are style estimates from public \
descriptions: never present them as measurements.
- fixes: exactly the 3 biggest gaps given, in order. Use the feature key as "axis"; "you" and \
"them" are short phrases with the values and units provided.
- Cues must be one short sentence a player can think mid-swing.
- Drills must be doable alone or with a partner on a normal court in under 10 minutes.
- watch: 2-3 YouTube search queries (not URLs) for slow-motion footage of the pro's relevant stroke.
- alter_ego_story: 2-3 vivid second-person sentences putting the player in the pro's shoes on a big court.
- walkout_line: one stadium-announcer style introduction for the player under a pro-inspired nickname."""


def _values(extracted, match):
    """Human-readable you/them values for the gaps, in the model's units when measured."""
    out = {}
    feats = extracted["features"]
    for key in match["gaps"]:
        if extracted["profile_source"] == "measured":
            you = feats[key]
            out[key] = {"label": model.FEATURES[key]["label"], "you": model.fmt(key, you),
                        "pro": model.fmt(key, you + match["gaps"][key])}
        else:
            you = extracted["axes"][key]
            out[key] = {"label": extracted["axis_labels"][key], "you": f"{you}/100",
                        "pro": f"{you + match['gaps'][key]}/100"}
    return out


def _prompt(extracted, pro, match):
    return json.dumps({
        "sport": extracted["sport"],
        "stroke": extracted["stroke"],
        "profile_source": extracted["profile_source"],
        "measured_from": match.get("measured"),
        "pro": {k: pro[k] for k in ("name", "nickname", "signature")},
        "similarity_percent": match["similarity"],
        "values": _values(extracted, match),
        "biggest_gaps": match["biggest_gaps"],
        "closest_traits": match["closest_traits"],
    }, indent=1)


def coach_with_claude(extracted, pro, match) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    response = client.beta.messages.parse(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "low"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(extracted, pro, match)}],
        output_format=CoachingReport,
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise RuntimeError(f"Claude returned no report (stop_reason={response.stop_reason})")
    return response.parsed_output.model_dump()


# (cue, drill) per gap. Keys cover both measured features and archetype axes.
CUES = {
    "power": ("Accelerate through contact, not at the start.", "Shadow swings: slow back, fast through, 3 sets of 10."),
    "legs": ("Sit into your legs, then push the ground away.", "Load-and-explode: 10 bounces in your loaded stance, then swing."),
    "knee_flex": ("Sit into your legs at the trophy position.", "Trophy squats: hold the trophy pose with bent knees for 3 seconds, 10 reps."),
    "leg_drive": ("Push the ground away and drive up into the ball.", "Jump serves: exaggerate driving up off the court, 15 serves."),
    "coil": ("Show your back to the net before you swing.", "Hold a racket across your chest and turn shoulders past hips, 15 reps."),
    "shoulder_turn": ("Turn your shoulders away so your back faces the target.", "Fence turns: stand side-on to a fence and turn until your hitting shoulder points at it, 15 reps."),
    "separation": ("Let your shoulders turn further than your hips.", "Hip-lock turns: keep hips still and coil shoulders, 3 sets of 10."),
    "reach": ("Hit up and out, as tall as you can be.", "Contact-point holds: freeze at contact for 2 seconds, 10 reps."),
    "contact_height": ("Reach up and hit at full stretch.", "High-target serves: toss higher and contact at full reach, 15 serves."),
    "arm_extension": ("Straighten your hitting arm at contact.", "Contact-point holds: freeze at contact with a straight arm, 10 reps."),
    "trunk_lean": ("Lean into the court as you swing up.", "Lean-in tosses: toss slightly into the court and let your body follow, 15 tosses."),
    "off_arm_height": ("Lift your tossing arm all the way up.", "Toss-and-hold: toss and keep the arm pointing up until the ball peaks, 15 tosses."),
    "stance_width": ("Set your feet the way your model does before tossing.", "Stance check: mark your foot spots with balls and serve from them, 10 serves."),
    "trophy_share": ("Match their rhythm: reach the trophy pose at the same point in the windup.", "Pause-at-trophy serves: toss, hold the trophy pose a beat, then swing, 15 serves."),
    "tempo_ratio": ("Match their rhythm: smooth windup, then explode.", "Count-it serves: say '1-2' on the windup and 'hit' on contact, 15 serves."),
    "quickness": ("Shorter takeback, same speed through.", "Rapid-fire feeds: partner feeds every 2 seconds, 20 balls."),
    "stability": ("Keep your eyes on the contact point after the ball leaves.", "Head-still hits: hold your head still until the ball crosses the net, 15 balls."),
    "head_sway": ("Keep your eyes on the contact point after the ball leaves.", "Head-still serves: look at the contact spot until the ball lands, 15 serves."),
    "finish": ("Let the racket finish over your shoulder.", "Freeze-finish: hold every follow-through for a 2-count, 15 balls."),
}


def coach_template(extracted, pro, match) -> dict:
    values = _values(extracted, match)
    first = pro["name"].split()[0]
    fixes, drills = [], []
    for key in match["biggest_gaps"]:
        v = values[key]
        cue, drill = CUES.get(key, ("Copy their shape at this phase.", "Shadow swings: 10 slow reps copying the pro."))
        if match["gaps"][key] < 0:
            # The pro does less of this than you: the stock cue would push the wrong way.
            cue = f"Dial back your {v['label'].lower()}: {first} uses less ({v['pro']} vs your {v['you']})."
            drill = f"Mirror reps: 10 slow shadow serves matching {first}'s {v['label'].lower()}, filmed to check."
        fixes.append({"axis": key, "you": v["you"], "them": v["pro"], "cue": cue})
        name, _, rest = drill.partition(":")
        drills.append({"name": name, "how": rest.strip(), "reps": "Every practice session"})
    measured = match.get("measured")
    source = f" (measured from {measured['n_serves']} of their serves)" if measured else ""
    return {
        "headline": f"You're {match['similarity']}% {pro['name']}{source}",
        "alter_ego_story": (
            f"The crowd hushes as you step up like {pro['name']}. "
            f"{pro['signature']} Now make it yours."
        ),
        "shared_traits": [f"{values[k]['label']} like {first}" for k in match["closest_traits"]],
        "fixes": fixes,
        "drills": drills,
        "watch": [f"{pro['name']} {extracted['stroke']} slow motion", f"{pro['name']} {extracted['stroke']} technique breakdown"],
        "walkout_line": f"Introducing... the next {pro['nickname']}!",
    }


def coach(extracted, pro, match) -> dict:
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            report = coach_with_claude(extracted, pro, match)
            report["source"] = "claude"
            return report
        except Exception as e:  # never lose a finished analysis to a coaching hiccup
            print(f"Claude coaching failed, using template: {e!r}")
    report = coach_template(extracted, pro, match)
    report["source"] = "template"
    return report
