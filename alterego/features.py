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

CORE = (L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_WRIST, R_WRIST)
MIN_FRAMES = 8


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
    return frames


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

    sp_l, sp_r = speeds(L_WRIST), speeds(R_WRIST)
    hand = payload.get("hand", "auto")
    if hand not in ("left", "right"):
        hand = "right" if max(sp_r) >= max(sp_l) else "left"
    # MediaPipe labels are from the subject's point of view.
    wrist, elbow, shoulder = (R_WRIST, R_ELBOW, R_SHOULDER) if hand == "right" else (L_WRIST, L_ELBOW, L_SHOULDER)
    off_wrist = L_WRIST if hand == "right" else R_WRIST
    sp = sp_r if hand == "right" else sp_l

    peak = max(range(len(sp)), key=sp.__getitem__)
    peak_speed = sp[peak]
    thresh = 0.25 * peak_speed
    start = peak
    while start > 0 and sp[start - 1] > thresh:
        start -= 1
    end = peak
    while end < len(sp) - 1 and sp[end + 1] > thresh:
        end += 1
    # Include the loading phase before the arm accelerates.
    load_start = max(0, start - max(3, (peak - start)))

    window = range(load_start, end + 1)
    loading = range(load_start, peak + 1)

    def knee_angle(p):
        return (_angle(p[L_HIP], p[L_KNEE], p[L_ANKLE]) + _angle(p[R_HIP], p[R_KNEE], p[R_ANKLE])) / 2

    knee_flex = 180 - min(knee_angle(pts[i]) for i in loading)

    hip_y = [_mid(p[L_HIP], p[R_HIP])[1] for p in pts]
    lowest = max(loading, key=lambda i: hip_y[i])
    rise = max(0.0, hip_y[lowest] - min(hip_y[i] for i in range(lowest, end + 1)))
    leg_drive = rise / scale

    sw = [_dist(pts[i][L_SHOULDER], pts[i][R_SHOULDER]) for i in window]
    hw = [_dist(pts[i][L_HIP], pts[i][R_HIP]) for i in window]
    sw_max, hw_max = max(sw) or 1, max(hw) or 1

    def turn(width, wmax):
        return math.degrees(math.acos(max(0.0, min(1.0, width / wmax))))

    shoulder_turn = max(turn(w, sw_max) for w in sw)
    separation = max(turn(s, sw_max) - turn(h, hw_max) for s, h in zip(sw, hw))

    # Serve contact is at full reach (highest hand); groundstroke contact ~ peak hand speed.
    contact = peak
    if payload.get("stroke") == "serve":
        contact = min(range(start, end + 1), key=lambda i: pts[i][wrist][1])

    pk = pts[contact]
    mid_sh = _mid(pk[L_SHOULDER], pk[R_SHOULDER])
    mid_hip = _mid(pk[L_HIP], pk[R_HIP])
    contact_height = (mid_sh[1] - pk[wrist][1]) / scale
    arm_extension = _angle(pk[shoulder], pk[elbow], pk[wrist])
    trunk_lean = math.degrees(math.atan2(abs(mid_sh[0] - mid_hip[0]), abs(mid_hip[1] - mid_sh[1]) or 1e-6))

    stance_width = max(_dist(pts[i][L_ANKLE], pts[i][R_ANKLE]) for i in window) / scale
    off_arm_height = max(
        (_mid(pts[i][L_SHOULDER], pts[i][R_SHOULDER])[1] - pts[i][off_wrist][1]) / scale for i in loading
    )

    nose = [pts[i][NOSE] for i in window]
    head_sway = (pstdev([p[0] for p in nose]) + pstdev([p[1] for p in nose])) / scale if len(nose) > 1 else 0.0

    return {
        "hand": hand,
        "frames_used": len(frames),
        "contact_time": round(times[contact], 3),
        "peak_speed": round(peak_speed, 2),
        "prep_time": round(times[peak] - times[load_start], 3),
        "follow_time": round(times[end] - times[peak], 3),
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
    }
