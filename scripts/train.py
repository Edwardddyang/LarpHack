"""Build the pro serve model from labeled pro clips.

    python scripts/train.py                 # in-process (uses data/cache/ from process_local.py)
    python scripts/train.py --render        # run the ingest_pros Render Workflow, save its result
    python scripts/train.py --retrain-only  # retrain from saved samples (no video processing)

Clips come from data/pro_clips.json; per-serve camera-view labels from
data/serve_labels.json. Writes alterego/data/serve_<view>_model.json (+ samples).
    Pass --view back for the behind-the-baseline model.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from alterego import ingest, model  # noqa: E402

CACHE = ROOT / "data" / "cache"


def labeled_clips():
    manifest = json.loads((ROOT / "data" / "pro_clips.json").read_text())
    labels = json.loads((ROOT / "data" / "serve_labels.json").read_text())
    return [{**c, "labels": labels[c["id"]]} for c in manifest["clips"] if c["id"] in labels]


async def call_cached(step, *args):
    """Like ingest.call_local, but reuse pose tracking cached by process_local.py."""
    if step == "process_clip":
        cached = CACHE / f"{args[0]['id']}.json"
        if cached.exists():
            return json.loads(cached.read_text())
    return await ingest.call_local(step, *args)


def save(result, view):
    model.DATA.mkdir(parents=True, exist_ok=True)
    ingest.samples_path(view).write_text(json.dumps(result["samples"]))
    model.model_path(view).write_text(json.dumps(result["model"], indent=1))


def summarize(result):
    for r in result.get("report", []):
        print(f"  {r['pro_id']:<9} {r['video_id']}  detected={r['detected']} used={r['serves']}"
              + (f"  ERROR {r['error']}" if r["error"] else ""))
    m = result["model"]
    print("\npros:", {p: (v["n_serves"], v["n_videos"]) for p, v in m["pros"].items()})
    print("weights:", dict(sorted(m["weights"].items(), key=lambda kv: -kv[1])))
    print("evaluation:", m.get("evaluation"))


async def run_render(clips, view):
    from render import RenderAsync

    slug = os.environ.get("WORKFLOW_SLUG", "alter-ego-workflow")
    client = RenderAsync()
    run = await client.workflows.start_task(f"{slug}/ingest_pros", [clips, view])
    print("started", run.id)
    details = await run
    return details.results[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--retrain-only", action="store_true")
    ap.add_argument("--view", choices=model.VIEWS, default="side")
    args = ap.parse_args()

    if args.retrain_only:
        samples = json.loads(ingest.samples_path(args.view).read_text())
        result = {"samples": samples, "model": model.train(samples, view=args.view)}
    else:
        clips = labeled_clips()
        print(f"{len(clips)} labeled clips")
        coro = run_render(clips, args.view) if args.render else ingest.ingest(clips, call_cached, args.view)
        result = asyncio.run(coro)
    save(result, args.view)
    summarize(result)


if __name__ == "__main__":
    main()
