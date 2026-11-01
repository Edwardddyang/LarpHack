"""Render each detected serve's load / contact / finish frames with the skeleton, for eyeballing.

    python scripts/debug_serves.py data/videos/federer/F4UZtKFLHyQ.mp4 [landmarks.json]
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from alterego import features, video  # noqa: E402

BONES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24),
         (23, 25), (25, 27), (24, 26), (26, 28)]


def frame_at(cap, t):
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, img = cap.read()
    return img if ok else None


def draw(img, lm, hand):
    h, w = img.shape[:2]
    pt = lambda i: (int(lm[i][0] * w), int(lm[i][1] * h))  # noqa: E731
    for a, b in BONES:
        cv2.line(img, pt(a), pt(b), (58, 255, 215), 2)
    hit = 16 if hand == "right" else 15
    cv2.circle(img, pt(hit), 7, (61, 107, 255), -1)
    return img


def main():
    path = sys.argv[1]
    payload = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else video.landmarks_from_video(path)
    cap = cv2.VideoCapture(path)
    out_dir = Path("data/sheets/debug")
    out_dir.mkdir(parents=True, exist_ok=True)
    for n, serve in enumerate(features.segment_serves(payload)):
        f = features.extract_features(serve)
        # Re-run cleaning to get the swap-corrected landmarks for drawing.
        cleaned = features._clean_frames(serve)
        w, h = serve["width"], serve["height"]
        times = [t for t, _ in cleaned]
        picks = [times[0] + 0.25 * (f["contact_time"] - times[0]), f["contact_time"],
                 f["contact_time"] + 0.5 * (times[-1] - f["contact_time"])]
        tiles = []
        for t in picks:
            img = frame_at(cap, t)
            i = min(range(len(times)), key=lambda k: abs(times[k] - t))
            lm = [(x / w, y / h) for x, y in cleaned[i][1]]
            tiles.append(cv2.resize(draw(img, lm, f["hand"]), (360, int(360 * h / w))))
        out = out_dir / f"{Path(path).stem}_serve{n}.jpg"
        cv2.imwrite(str(out), np.hstack(tiles))
        print(out, {k: f[k] for k in ("hand", "contact_time", "knee_flex", "contact_height", "arm_extension", "tempo_ratio")})


if __name__ == "__main__":
    main()
