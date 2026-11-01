"""Server-side pose extraction for reference footage (needs mediapipe + opencv).

Produces the same landmark payload shape the browser sends, so pro clips and
user clips go through identical feature code.
"""

from __future__ import annotations

import os
import urllib.request
from pathlib import Path

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_full/float16/1/pose_landmarker_full.task"
)
MODEL_PATH = Path(os.environ.get("POSE_MODEL_PATH", Path(__file__).resolve().parent.parent / "models" / "pose_landmarker_full.task"))


def _model_path() -> str:
    if not MODEL_PATH.exists():
        MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    return str(MODEL_PATH)


def landmarks_from_video(path: str, fps: float = 20, max_seconds: float | None = None) -> dict:
    """Sample a video at `fps` (in video time) and run pose detection on each frame."""
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    cap = cv2.VideoCapture(str(path))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, round(src_fps / fps))

    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=_model_path()),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
    )
    frames = []
    with vision.PoseLandmarker.create_from_options(opts) as landmarker:
        idx = 0
        while True:
            ok = cap.grab()
            if not ok:
                break
            t = idx / src_fps
            if max_seconds and t > max_seconds:
                break
            if idx % step == 0:
                ok, bgr = cap.retrieve()
                if ok:
                    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
                    res = landmarker.detect_for_video(img, int(t * 1000))
                    if res.pose_landmarks:
                        lm = res.pose_landmarks[0]
                        frames.append({
                            "t": round(t, 3),
                            "lm": [[round(p.x, 4), round(p.y, 4), round(p.visibility or 0, 2)] for p in lm],
                        })
            idx += 1
    cap.release()
    return {"width": width, "height": height, "frames": frames}
