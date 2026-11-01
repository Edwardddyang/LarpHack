"""Pose-track every downloaded clip and cache its detected serves (data/cache/<id>.json).

    python scripts/process_local.py [--workers 4]

Then label views with scripts/serve_grid.py before training.
"""

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from alterego import ingest  # noqa: E402

CACHE = ROOT / "data" / "cache"


def run(clip):
    out = CACHE / f"{clip['id']}.json"
    if out.exists():
        return clip, json.loads(out.read_text())
    result = ingest.process_clip(clip)
    if not result.get("error"):
        out.write_text(json.dumps(result))
    return clip, result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    clips = [
        c for c in json.loads((ROOT / "data" / "pro_clips.json").read_text())["clips"]
        if (ingest.VIDEOS / c["pro_id"] / f"{c['id']}.mp4").exists()
    ]
    with ProcessPoolExecutor(args.workers) as pool:
        for clip, r in pool.map(run, clips):
            print(f"{clip['pro_id']:<9} {clip['id']}  serves={len(r['samples'])}" + (f"  ERROR {r['error']}" if r.get("error") else ""))


if __name__ == "__main__":
    main()
