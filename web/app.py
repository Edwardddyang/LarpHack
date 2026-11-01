"""Web service: serves the UI and kicks off analysis runs.

With WORKFLOW_SLUG set, runs go to the Render Workflow (RENDER_API_KEY, or
RENDER_USE_LOCAL_DEV=true against `render workflows dev`). Without it, the same
pipeline runs in-process so the app works with zero setup.
"""

import asyncio
import os
import sys
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from alterego import pipeline, pros  # noqa: E402
from alterego.style import AXES  # noqa: E402

WORKFLOW_SLUG = os.environ.get("WORKFLOW_SLUG")
USE_WORKFLOW = bool(WORKFLOW_SLUG) and bool(
    os.environ.get("RENDER_API_KEY") or os.environ.get("RENDER_USE_LOCAL_DEV") == "true"
)
MAX_FRAMES = 400

app = FastAPI(title="Alter Ego")
local_runs: dict[str, dict] = {}
_render = None


def render_client():
    global _render
    if _render is None:
        from render import RenderAsync
        _render = RenderAsync()
    return _render


async def start(task: str, args: list, local_coro_factory) -> str:
    if USE_WORKFLOW:
        run = await render_client().workflows.start_task(f"{WORKFLOW_SLUG}/{task}", args)
        return run.id
    run_id = f"local-{uuid.uuid4().hex[:12]}"
    local_runs[run_id] = {"status": "running"}

    async def go():
        try:
            local_runs[run_id] = {"status": "completed", "result": await local_coro_factory()}
        except Exception as e:  # surface failures to the poller
            local_runs[run_id] = {"status": "failed", "error": str(e)}

    asyncio.create_task(go())
    return run_id


@app.get("/api/config")
async def config():
    return {
        "mode": "render-workflow" if USE_WORKFLOW else "local",
        "axes": AXES,
        "pros": pros.PROS,
    }


@app.post("/api/analyze")
async def analyze(payload: dict):
    if len(payload.get("frames", [])) > MAX_FRAMES:
        raise HTTPException(413, "Clip too long; trim to a single stroke (under ~10s).")
    run_id = await start("analyze_swing", [payload], lambda: pipeline.analyze(payload, pipeline.call_local))
    return {"run_id": run_id}


@app.post("/api/become")
async def become(body: dict):
    extracted, pro_id = body.get("extracted"), body.get("pro_id")
    if not extracted or pro_id not in pros.BY_ID:
        raise HTTPException(400, "Need an analyzed swing and a valid pro_id.")
    run_id = await start(
        "become", [extracted, pro_id], lambda: pipeline.become(extracted, pro_id, pipeline.call_local)
    )
    return {"run_id": run_id}


@app.get("/api/runs/{run_id}")
async def run_status(run_id: str):
    if run_id.startswith("local-"):
        if run_id not in local_runs:
            raise HTTPException(404, "Unknown run")
        return local_runs[run_id]
    details = await render_client().workflows.get_task_run(run_id)
    status = str(getattr(details.status, "value", details.status))
    out = {"status": status}
    if status == "completed":
        out["result"] = details.results[0] if details.results else None
    elif status in ("failed", "canceled"):
        out["error"] = details.error if isinstance(details.error, str) else "Workflow run failed"
    return out


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


MOBILE_UA = ("iphone", "android", "ipad", "mobile")


@app.get("/")
async def index(request: Request):
    ua = request.headers.get("user-agent", "").lower()
    if "desktop" not in request.query_params and any(k in ua for k in MOBILE_UA):
        return FileResponse(ROOT / "static" / "mobile.html")
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/m")
async def mobile():
    return FileResponse(ROOT / "static" / "mobile.html")


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(ROOT / "static" / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js")
async def service_worker():
    # Served from the root so its scope covers the whole app.
    return FileResponse(ROOT / "static" / "sw.js", media_type="text/javascript")
