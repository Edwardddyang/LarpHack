"""Render Workflow: each analysis step runs as its own task run.

analyze_swing
  -> extract            (pose landmarks -> biomechanics + style axes)
  -> score_pro x N      (parallel fan-out, one run per pro)
  -> write_coaching     (Claude, retried with backoff)

ingest_pros             (builds the pro model from reference footage)
  -> process_clip x N   (parallel fan-out: download, pose-track, segment serves)
  -> train_model        (learned per-pro profiles + feature weights)
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from render import Retry, TaskContext, Workflows  # noqa: E402

from alterego import ingest, pipeline  # noqa: E402

app = Workflows(
    default_retry=Retry(max_retries=2, wait_duration_ms=1000),
    default_timeout=300,
)


@app.task
def extract(ctx: TaskContext, payload: dict) -> dict:
    return pipeline.extract(payload)


@app.task(timeout_seconds=60)
def score_pro(ctx: TaskContext, extracted: dict, pro_id: str) -> dict:
    return pipeline.score_pro(extracted, pro_id)


@app.task(retry=Retry(max_retries=3, wait_duration_ms=2000, backoff_scaling=2.0), timeout_seconds=240)
def write_coaching(ctx: TaskContext, extracted: dict, match: dict) -> dict:
    return pipeline.write_coaching(extracted, match)


@app.task(timeout_seconds=1800, plan="2c-4g")
def process_clip(ctx: TaskContext, clip: dict) -> dict:
    return ingest.process_clip(clip)


@app.task(timeout_seconds=300)
def train_model(ctx: TaskContext, samples: list, view: str = "side") -> dict:
    return ingest.train_model(samples, view)


TASKS = {
    "extract": extract,
    "score_pro": score_pro,
    "write_coaching": write_coaching,
    "process_clip": process_clip,
    "train_model": train_model,
}


def _caller(ctx: TaskContext):
    async def call(step, *args):
        return await ctx.run(TASKS[step], *args)
    return call


@app.task(timeout_seconds=600)
async def analyze_swing(ctx: TaskContext, payload: dict) -> dict:
    return await pipeline.analyze(payload, _caller(ctx))


@app.task(timeout_seconds=600)
async def become(ctx: TaskContext, extracted: dict, pro_id: str) -> dict:
    return await pipeline.become(extracted, pro_id, _caller(ctx))


@app.task(timeout_seconds=3600)
async def ingest_pros(ctx: TaskContext, clips: list, view: str = "side") -> dict:
    return await ingest.ingest(clips, _caller(ctx), view)


if __name__ == "__main__":
    app.start()
