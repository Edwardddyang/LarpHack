"""Turn a sequence of MediaPipe pose landmarks into swing biomechanics.

Input frames come from the browser (MediaPipe PoseLandmarker, 33 landmarks,
normalized image coords). Everything here is plain Python so the workflow
image stays small.
"""

from __future__ import annotations

import math
from statistics import median, pstdev

NOSE = 0
L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW, R_ELBOW = 13, 14
L_WRIST, R_WRIST = 15, 16
L_HIP, R_HIP = 23, 24
L_KNEE, R_KNEE = 25, 26
L_ANKLE, R_ANKLE = 27, 28

# Torso must be visible; limbs may be occluded (e.g. off arm behind the body) and
# MediaPipe still predicts a usable position for them.
CORE = (L_SHOULDER, R_SHOULDER, L_HIP, R_HIP)
MIN_FRAMES = 8

# Left/right landmark pairs, grouped so a mislabeled limb can be swapped back as a unit.
ARM_PAIRS = [(11, 12), (13, 14), (15, 16), (17, 18), (19, 20), (21, 22)]
LEG_PAIRS = [(23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]


class SwingError(ValueError):
    """The clip can't be analyzed (no person found, too short, ...)."""


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _mid(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def _angle(a, b, c):
    """Interior angle at b, in degrees."""
    v1 = (a[0] - b[0], a[1] - b[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    n = math.hypot(*v1) * math.hypot(*v2)
    if n == 0:
        return 180.0
    cos = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / n))
    return math.degrees(math.acos(cos))


def _smooth(points, window=3):
    half = window // 2
    out = []
    for i in range(len(points)):
        chunk = points[max(0, i - half): i + half + 1]
        out.append((sum(p[0] for p in chunk) / len(chunk), sum(p[1] for p in chunk) / len(chunk)))
    return out


def _fix_swaps(frames):
    """Undo left/right label flips, common when the player is side-on.

    Per limb group, a two-state Viterbi pass (as labeled / flipped) picks the
    labeling with the least total joint motion, plus a small penalty per flip.
    """
    if len(frames) < 2:
        return frames
    for pairs, probe in ((ARM_PAIRS, (13, 14, 15, 16)), (LEG_PAIRS, (25, 26, 27, 28))):
        swap = {a: b for a, b in pairs} | {b: a for a, b in pairs}

        def pos(t, state, i):
            return frames[t][1][swap[i] if state else i]

        def step(t, a, b):
            return sum(_dist(pos(t, b, i), pos(t - 1, a, i)) for i in probe)

        scale = median(
            _dist(_mid(p[L_SHOULDER], p[R_SHOULDER]), _mid(p[L_HIP], p[R_HIP])) for _, p in frames
        ) or 1
        penalty = 0.3 * scale
        cost, back = [0.0, penalty], []
        for t in range(1, len(frames)):
            new, ptr = [], []
            for b in (0, 1):
                options = [cost[a] + step(t, a, b) + (penalty if a != b else 0) for a in (0, 1)]
                a = min((0, 1), key=options.__getitem__)
                new.append(options[a])
                ptr.append(a)
            cost = new
            back.append(ptr)
        state = min((0, 1), key=cost.__getitem__)
        states = [state]
        for ptr in reversed(back):
            state = ptr[state]
            states.append(state)
        # Viterbi only fixes consistency; trust MediaPipe's labels for the majority of frames.
        if sum(states) > len(states) / 2:
            states = [1 - s for s in states]
        for (_, p), s in zip(frames, reversed(states)):
            if s:
                for a, b in pairs:
                    p[a], p[b] = p[b], p[a]
    return frames


def _robust_max(values, q=0.9):
    """High percentile instead of max, so single-frame pose glitches don't dominate."""
    s = sorted(values)
    return s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))]


def _clean_frames(payload):
    w = float(payload.get("width") or 1)
    h = float(payload.get("height") or 1)
    frames = []
    for f in payload.get("frames", []):
        lm = f.get("lm")
        if not lm or len(lm) < 33:
            continue
        if min(lm[i][2] for i in CORE) < 0.3:
            continue
        frames.append((float(f["t"]), [(p[0] * w, p[1] * h) for p in lm]))
    frames.sort(key=lambda fr: fr[0])
    return _fix_swaps(frames)


def extract_features(payload: dict) -> dict:
    """Compute raw biomechanical features for the main stroke in the clip."""
    frames = _clean_frames(payload)
    if len(frames) < MIN_FRAMES:
        raise SwingError(
            "Couldn't see a full body in enough frames. Film from the side or "
            "behind, with your whole body in shot."
        )

    times = [t for t, _ in frames]
    pts = [p for _, p in frames]

    scale = median(_dist(_mid(p[L_SHOULDER], p[R_SHOULDER]), _mid(p[L_HIP], p[R_HIP])) for p in pts)
    if scale <= 0:
        raise SwingError("Body too small in frame. Move the camera closer.")

    def speeds(idx):
        track = _smooth([p[idx] for p in pts])
        out = [0.0]
        for i in range(1, len(track)):
            dt = max(times[i] - times[i - 1], 1e-3)
            out.append(_dist(track[i], track[i - 1]) / dt / scale)
        return out

    def height(i, idx):
        p = pts[i]
        return (_mid(p[L_SHOULDER], p[R_SHOULDER])[1] - p[idx][1]) / scale

    sp_l, sp_r = speeds(L_WRIST), speeds(R_WRIST)
    hand = payload.get("hand", "auto")
    if hand not in ("left", "right"):
        if payload.get("stroke") == "serve":
            # The toss arm peaks first; the hitting arm reaches its highest point later.
            top = {idx: max(range(len(pts)), key=lambda i: height(i, idx)) for idx in (L_WRIST, R_WRIST)}
            hand = "right" if top[R_WRIST] > top[L_WRIST] else "left"
        else:
            hand = "right" if max(sp_r) >= max(sp_l) else "left"
    # MediaPipe labels are from the subject's point of view.
    wrist, elbow, shoulder = (R_WRIST, R_ELBOW, R_SHOULDER) if hand == "right" else (L_WRIST, L_ELBOW, L_SHOULDER)
    off_wrist = L_WRIST if hand == "right" else R_WRIST
    sp = sp_r if hand == "right" else sp_l

    peak = max(range(len(sp)), key=sp.__getitem__)
    peak_speed = sp[peak]
    thresh = 0.25 * peak_speed

    if payload.get("stroke") == "serve":
        # Contact is full reach: the hitting hand's highest point. (Peak hand speed
        # is usually in the follow-through, after contact.) The motion starts when
        # either hand first rises above the shoulders (the toss).
        contact = max(range(len(pts)), key=lambda i: height(i, wrist))
        load_start = next(
            (i for i in range(contact) if max(height(i, L_WRIST), height(i, R_WRIST)) > 0.2), 0
        )
        end = contact
        thresh = 0.25 * max(sp[contact:])
    else:
        contact = peak
        start = peak
        while start > 0 and sp[start - 1] > thresh:
            start -= 1
        # Include the loading phase before the arm accelerates.
        load_start = max(0, start - max(3, (peak - start)))
        end = peak
    while end < len(sp) - 1 and sp[end + 1] > thresh:
        end += 1

    window = range(load_start, end + 1)
    loading = range(load_start, contact + 1)

    def knee_angle(p):
        return (_angle(p[L_HIP], p[L_KNEE], p[L_ANKLE]) + _angle(p[R_HIP], p[R_KNEE], p[R_ANKLE])) / 2

    knee_flex = _robust_max([180 - knee_angle(pts[i]) for i in loading])

    hip_y = [_mid(p[L_HIP], p[R_HIP])[1] for p in pts]
    lowest = max(loading, key=lambda i: hip_y[i])
    # Rise from the deepest crouch to the highest hips around contact. The window
    # after contact is a fixed share of the windup, not the follow-through end,
    # which varies with clip length and camera angle.
    drive_end_t = times[contact] + 0.25 * (times[contact] - times[load_start])
    drive_end = max(i for i in range(contact, len(pts)) if times[i] <= drive_end_t)
    rise = max(0.0, hip_y[lowest] - min(hip_y[i] for i in range(lowest, drive_end + 1)))
    leg_drive = rise / scale

    sw = [_dist(pts[i][L_SHOULDER], pts[i][R_SHOULDER]) for i in window]
    hw = [_dist(pts[i][L_HIP], pts[i][R_HIP]) for i in window]
    sw_max, hw_max = _robust_max(sw, 0.95) or 1, _robust_max(hw, 0.95) or 1

    def turn(width, wmax):
        return math.degrees(math.acos(max(0.0, min(1.0, width / wmax))))

    shoulder_turn = _robust_max([turn(w, sw_max) for w in sw])
    separation = _robust_max([turn(s, sw_max) - turn(h, hw_max) for s, h in zip(sw, hw)])

    pk = pts[contact]
    mid_sh = _mid(pk[L_SHOULDER], pk[R_SHOULDER])
    mid_hip = _mid(pk[L_HIP], pk[R_HIP])
    contact_height = (mid_sh[1] - pk[wrist][1]) / scale
    arm_extension = _angle(pk[shoulder], pk[elbow], pk[wrist])
    trunk_lean = math.degrees(math.atan2(abs(mid_sh[0] - mid_hip[0]), abs(mid_hip[1] - mid_sh[1]) or 1e-6))

    stance_width = _robust_max([_dist(pts[i][L_ANKLE], pts[i][R_ANKLE]) for i in window]) / scale
    off_arm_height = _robust_max([height(i, off_wrist) for i in loading])

    nose = [pts[i][NOSE] for i in window]
    head_sway = (pstdev([p[0] for p in nose]) + pstdev([p[1] for p in nose])) / scale if len(nose) > 1 else 0.0

    # Time-normalized curves over the stroke: comparable across slow-motion and real-time clips.
    curves = {
        "knee": _resample([knee_angle(pts[i]) for i in window]),
        "elbow": _resample([_angle(pts[i][shoulder], pts[i][elbow], pts[i][wrist]) for i in window]),
        "wrist_height": _resample([height(i, wrist) for i in window]),
    }
    prep, follow = times[contact] - times[load_start], times[end] - times[contact]

    return {
        "hand": hand,
        "frames_used": len(frames),
        "contact_time": round(times[contact], 3),
        "peak_speed": round(peak_speed, 2),
        "prep_time": round(prep, 3),
        "follow_time": round(follow, 3),
        "knee_flex": round(knee_flex, 1),
        "leg_drive": round(leg_drive, 3),
        "shoulder_turn": round(shoulder_turn, 1),
        "separation": round(max(0.0, separation), 1),
        "contact_height": round(contact_height, 2),
        "arm_extension": round(arm_extension, 1),
        "trunk_lean": round(trunk_lean, 1),
        "stance_width": round(stance_width, 2),
        "off_arm_height": round(off_arm_height, 2),
        "head_sway": round(head_sway, 3),
        "tempo_ratio": round(prep / (prep + follow), 3) if prep + follow > 0 else 0.5,
        "curves": curves,
    }


CURVE_POINTS = 30


def _resample(values, n=CURVE_POINTS):
    if len(values) == 1:
        return [round(values[0], 2)] * n
    out = []
    for k in range(n):
        x = k * (len(values) - 1) / (n - 1)
        i = min(int(x), len(values) - 2)
        out.append(round(values[i] + (values[i + 1] - values[i]) * (x - i), 2))
    return out


def segment_serves(payload: dict, min_frames: int = 12) -> list[dict]:
    """Split a long clip (e.g. a practice session) into one payload per serve.

    A serve is an interval where some hand is above the shoulders and one hand
    reaches well overhead; it ends when both hands drop. Padding is relative to
    the interval length, so slow-motion and real-time footage segment alike.
    """
    frames = [
        f for f in payload.get("frames", [])
        if len(f.get("lm", [])) >= 33 and min(f["lm"][i][2] for i in CORE) >= 0.3
    ]
    if len(frames) < min_frames:
        return []
    w, h = float(payload.get("width") or 1), float(payload.get("height") or 1)

    def body(f):
        p = [(x * w, y * h) for x, y, _ in f["lm"]]
        mid_sh = _mid(p[L_SHOULDER], p[R_SHOULDER])
        scale = _dist(mid_sh, _mid(p[L_HIP], p[R_HIP])) or 1
        hands = max(mid_sh[1] - p[L_WRIST][1], mid_sh[1] - p[R_WRIST][1]) / scale
        return mid_sh, scale, hands

    info = [body(f) for f in frames]

    # Continuous runs: break on detection gaps or camera cuts (body jumps).
    runs, cur = [], [0]
    for i in range(1, len(frames)):
        gap = frames[i]["t"] - frames[i - 1]["t"]
        jump = _dist(info[i][0], info[i - 1][0]) / info[i][1]
        if gap > 0.6 or jump > 0.8:
            runs.append(cur)
            cur = []
        cur.append(i)
    runs.append(cur)

    serves = []
    for run in runs:
        active = [i for i in run if info[i][2] > 0.2]
        # Group active frames into intervals, merging short dips (racket drop).
        groups = []
        for i in active:
            if groups and frames[i]["t"] - frames[groups[-1][-1]]["t"] <= max(
                0.3 * (frames[groups[-1][-1]]["t"] - frames[groups[-1][0]]["t"]), 0.25
            ):
                groups[-1].append(i)
            else:
                groups.append([i])
        for g in groups:
            if max(info[i][2] for i in g) < 1.1:
                continue  # never reached overhead: not a serve
            t0, t1 = frames[g[0]]["t"], frames[g[-1]]["t"]
            pad = 0.5 * (t1 - t0)
            window = [frames[i] for i in run if t0 - pad <= frames[i]["t"] <= t1 + pad]
            ankles_ok = sum(min(f["lm"][L_ANKLE][2], f["lm"][R_ANKLE][2]) > 0.3 for f in window)
            if len(window) >= min_frames and ankles_ok >= 0.7 * len(window):
                serves.append({**payload, "frames": window, "stroke": "serve"})
    return serves
