# Alter Ego 🎾🏓

**Film one swing. Meet the pro you secretly are. Then become them.**

Alter Ego lets tennis and pickleball players LARP as a pro. Upload or record a single serve, forehand or backhand. Pose tracking reads your biomechanics, and the app tells you which pro you play like (*"You're 78% Novak Djokovic"*). Then pick *any* pro you'd rather be, and you get a personalized plan to move your game toward theirs: a side-by-side style radar, the three biggest gaps with swing cues, drills, and slow-motion footage to study.

Built for **LarpHacks**: Sportiner Challenge (tennis and pickleball innovation) and Best Use of Render.

## How it works

```
Browser (MediaPipe PoseLandmarker, on-device)
  └─ 33 body landmarks × ~20 fps  ──POST──▶  Web service (FastAPI on Render)
                                               └─ start_task("alter-ego-workflow/analyze_swing")
Render Workflow: analyze_swing
  ├─ extract            landmarks → biomechanics (knee bend, leg drive, shoulder turn,
  │                     hip-shoulder separation, contact height, hand speed, tempo…)
  │                     → 7 style axes (power, legs, coil, reach, quickness, stillness, finish)
  ├─ score_pro × N      fan-out: every pro scored in its own parallel task run
  └─ write_coaching     Claude writes the "become them" plan (structured output, retried w/ backoff)
Render Workflow: become   re-score + re-coach toward any pro the player taps
```

- **Privacy-friendly and cheap:** the video never leaves the device. Only ~100 KB of landmark numbers are uploaded.
- **Render Workflows:** each step is its own task with its own retry and timeout policy. Pro scoring fans out in parallel with `asyncio.gather(ctx.run(...))`, and the LLM step gets exponential-backoff retries.
- **Works without keys:** with no `WORKFLOW_SLUG` the web service runs the same pipeline in-process. With no `ANTHROPIC_API_KEY`, coaching falls back to a rule-based template.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn web.app:app --reload --port 8000
# open http://localhost:8000
```

Optional: `export ANTHROPIC_API_KEY=...` for Claude-written coaching.

To run against a local Render Workflows task server (Render CLI ≥ 2.12):

```bash
render workflows dev -- python workflow/main.py          # terminal 1
RENDER_USE_LOCAL_DEV=true WORKFLOW_SLUG=alter-ego-workflow \
  .venv/bin/uvicorn web.app:app --port 8000               # terminal 2
```

## Deploy to Render

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, then pick the repo. `render.yaml` creates the web service and the workflow.
3. Fill in the secrets when prompted: `RENDER_API_KEY` (web service; Account Settings → API Keys) and `ANTHROPIC_API_KEY` (workflow).
4. `WORKFLOW_SLUG` is wired automatically from the workflow service.

## Filming tips

Side-on or from behind, whole body in frame, one stroke per clip, phone propped at about waist height.

## Honest caveats

Pro profiles are hand-tuned **style archetypes** based on publicly described playing styles, not measured motion-capture data. Measurements come from 2D monocular video, so treat them as directional, not lab-grade.
