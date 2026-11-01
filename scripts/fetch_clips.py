"""Download the pro clips listed in data/pro_clips.json (first few minutes, <=720p).

Videos land in data/videos/<pro_id>/<video_id>.mp4 and are gitignored: they are
used only to measure pose, never re-hosted.

    python scripts/fetch_clips.py [--max-seconds 180] [--only federer,nadal]
"""

import argparse
import json
import shutil
from pathlib import Path

import imageio_ffmpeg
import yt_dlp

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "data" / "pro_clips.json"
VIDEOS = ROOT / "data" / "videos"
# yt-dlp looks for a binary literally named "ffmpeg"; link the bundled one if needed.
FFMPEG = shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()


def fetch(clip, max_seconds):
    out = VIDEOS / clip["pro_id"] / f"{clip['id']}.mp4"
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    opts = {
        # Video only: pose analysis doesn't need audio.
        "format": "bv*[height<=720][ext=mp4]/b[height<=720][ext=mp4]/b[height<=720]",
        "outtmpl": str(out.with_suffix(".%(ext)s")),
        "ffmpeg_location": FFMPEG,
        "download_ranges": yt_dlp.utils.download_range_func(None, [(0, max_seconds)]),
        "force_keyframes_at_cuts": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([clip["url"]])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-seconds", type=int, default=180)
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    only = set(filter(None, args.only.split(",")))

    for clip in json.loads(MANIFEST.read_text())["clips"]:
        if only and clip["pro_id"] not in only:
            continue
        try:
            path = fetch(clip, args.max_seconds)
            print(f"ok    {clip['pro_id']:<9} {clip['id']}  {path.stat().st_size / 1e6:.1f} MB")
        except Exception as e:
            print(f"FAIL  {clip['pro_id']:<9} {clip['id']}  {str(e)[:120]}")


if __name__ == "__main__":
    main()
