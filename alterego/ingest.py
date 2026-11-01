"""Turn approved pro clips into training samples and a trained model.

Like pipeline.py, orchestration takes a `call(step, *args)` coroutine so it runs
as fan-out Render Workflow task runs or in-process.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from . import features, model

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "data" / "videos"


def samples_path(view: str) -> Path:
    return Path(__file__).resolve().parent / "data" / f"serve_{view}_samples.json"


def _video_path(clip: dict, workdir: Path) -> Path:
    local = VIDEOS / clip["pro_id"] / f"{clip['id']}.mp4"
    if local.exists():
        return local
    import yt_dlp

    out = workdir / f"{clip['id']}.mp4"
    opts = {
        "format": "bv*[height<=720][ext=mp4]/b[height<=720][ext=mp4]/b[height<=720]",
        "outtmpl": str(out),
        "download_ranges": yt_dlp.utils.download_range_func(None, [(0, 180)]),
        "quiet": True,
        "no_warnings": True,
    }
    try:
        import imageio_ffmpeg
        opts["ffmpeg_location"] = imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        pass
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([clip["url"]])
    return out


def process_clip(clip: dict) -> dict:
    """Pose-track one clip, split it into serves, and measure each serve."""
    from . import video

    with tempfile.TemporaryDirectory() as tmp:
        try:
            path = _video_path(clip, Path(tmp))
            payload = video.landmarks_from_video(str(path), fps=20)
        except Exception as e:
            return {"pro_id": clip["pro_id"], "video_id": clip["id"], "samples": [], "error": str(e)[:300]}

    samples = []
    for serve in features.segment_serves(payload):
        try:
            f = features.extract_features(serve)
        except features.SwingError:
            continue
        # Drop windows that aren't a clean serve: hand never got well overhead.
        if f["contact_height"] < 0.8:
            continue
        samples.append({
            "pro_id": clip["pro_id"],
            "video_id": clip["id"],
            "t": [serve["frames"][0]["t"], serve["frames"][-1]["t"]],
            "features": f,
        })
    return {"pro_id": clip["pro_id"], "video_id": clip["id"], "samples": samples, "frames": len(payload["frames"])}


def train_model(samples: list[dict], view: str = "side") -> dict:
    return model.train(samples, view=view)


def labeled_samples(clip: dict, result: dict, view: str) -> list[dict]:
    """Keep only serves a human labeled with this camera view.

    clip["labels"] maps serve index (as detected by segment_serves, which is
    deterministic) to "side" | "back" | "skip".
    """
    labels = clip.get("labels") or {}
    return [s for i, s in enumerate(result["samples"]) if labels.get(str(i)) == view]


async def ingest(clips: list[dict], call, view: str = "side") -> dict:
    # Fan out: every clip is pose-tracked in its own task run.
    results = await asyncio.gather(*(call("process_clip", c) for c in clips))
    kept = [labeled_samples(c, r, view) for c, r in zip(clips, results)]
    samples = [s for ks in kept for s in ks]
    trained = await call("train_model", samples, view)
    report = [
        {"pro_id": r["pro_id"], "video_id": r["video_id"], "detected": len(r["samples"]),
         "serves": len(ks), "error": r.get("error")}
        for r, ks in zip(results, kept)
    ]
    return {"model": trained, "samples": samples, "report": report}


STEPS = {"process_clip": process_clip, "train_model": train_model}


async def call_local(step: str, *args):
    return await asyncio.to_thread(STEPS[step], *args)
