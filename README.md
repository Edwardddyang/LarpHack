# Alter Ego 🎾🏓

**Film one swing. Meet the pro you secretly are. Then become them.**

Alter Ego lets tennis and pickleball players LARP as a pro. Upload or record a single serve, forehand or backhand. Pose tracking reads your biomechanics, and the app tells you which pro you play like (*"You're 78% Novak Djokovic"*). Then pick *any* pro you'd rather be, and you get a personalized plan to move your game toward theirs: a side-by-side style radar, the three biggest gaps with swing cues, drills, and slow-motion footage to study.

Built for **LarpHacks**: Sportiner Challenge (tennis and pickleball innovation) and Best Use of Render.

## Training loop: why you'd keep using it

- **Goal pro:** pick who you want to play like. Every later analysis coaches you toward them and shows your change since last time.
- **Progress:** each analysis is saved on your device, with your match % to your goal pro over time, trends in key measurements, and a daily streak.
- **Weekly plan:** three practice sessions built from your three biggest gaps, as check-off drills ending in a re-test that feeds the next analysis.
- **Ask the coach:** a chat (Claude, with rule-based fallback) that knows your numbers, your goal pro and your plan.

### Accounts

Analyzing is open to everyone. Progress tracking and the weekly plan need an account (email and password), so your goal pro, sessions, plan and coach chat follow you across devices. Anything you did as a guest moves into the account when you sign up.

- Passwords are hashed with scrypt. Sessions are random tokens in an HttpOnly cookie, and only their SHA-256 hashes are stored.
- Storage is Render Postgres (`alter-ego-db` in `render.yaml`, wired to the web service as `DATABASE_URL`), or a local SQLite file (`data/app.db`) in development.
- Not built yet: password reset, email verification and rate limiting on sign-in.

## 📱 Mobile app

Open the site on a phone (or go to `/m`) to get the mobile app. It's a PWA, so **Add to Home Screen** installs it.

- **Live recording:** prop your phone up and tap record. A 5-second countdown gives you time to get in position. Pose tracking runs live on the camera feed, with a full-body framing check, and recording auto-stops after 6 seconds.
- **Camera-roll upload** works too.
- **Swipeable results:** alter ego card → radar + story → gaps and cues → drills and tape → your numbers.
- **"Be someone else":** a bottom sheet that re-coaches you toward any pro.
- **Share card:** a 1080×1350 image of your contact frame plus your match, shared through the native share sheet.

Camera access needs HTTPS (Render provides it) or `localhost`.

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

## Where the pro data comes from (tennis serve, side view)

Pro serve profiles are **measured from real footage** using the same pose pipeline users go through:

1. **Clips:** public slow-motion practice videos, listed in [data/pro_clips.json](data/pro_clips.json). They're downloaded locally for analysis only and never committed or re-hosted.
2. **Pose and segmentation:** MediaPipe tracks 33 body points. `segment_serves` finds each serve inside a long clip, and a Viterbi pass fixes the left/right limb swaps that are common side-on.
3. **Human view labels:** every detected serve's contact frame was checked by eye and labeled side, back or skip ([data/serve_labels.json](data/serve_labels.json)). Many "court level" clips are actually filmed from behind the baseline or switch angles mid-video.
4. **Model** ([alterego/model.py](alterego/model.py)): one profile per pro, averaged over their measured serves. Each feature's weight is learned from the data: how much it varies between pros relative to how much one pro varies serve to serve. Profiles are built only from timing-free features (angles, heights, ratios), so slow-motion and real-time clips compare fairly.

Current models (leave-one-video-out, so serves from a held-out video are never in training):

| View | Serves | Pros | Top-1 | Top-3 |
|---|---|---|---|---|
| **Side fence** | 83 | 9: Djokovic 15, Serena 12, Swiatek 11, Sinner 10, Alcaraz 9, Kyrgios 9, Nadal 7, Zverev 7, Federer 3 | 19% (chance 11%) | 62% (chance 33%) |
| Behind baseline | 51 | 5: Nadal 20, Federer 13, Kyrgios 7, Zverev 6, Sinner 5 | 65% (chance 20%) | 91% (chance 60%) |

Only videos with at least one other video of the same pro can be tested. The back model's test set (34 serves) is dominated by Nadal and Federer.

**Footage rule learned the hard way:** use continuous practice or match footage only. Breakdown edits with freeze-frames, and warm-up videos where the player deliberately changes technique, corrupt the measurements. Both kinds were found by eye and excluded (see `_note` in `data/serve_labels.json`).

That's real but modest signal. More footage per pro is the main lever, especially for Federer, Djokovic and Zverev.

Rebuild it:

```bash
uv pip install -r requirements-ingest.txt
python scripts/fetch_clips.py          # download approved clips (needs ffmpeg; imageio-ffmpeg is bundled)
python scripts/process_local.py        # pose-track + segment serves (cached)
python scripts/serve_grid.py           # contact-frame grids for labeling views
python scripts/train.py                # train + evaluate -> alterego/data/serve_side_model.json
python scripts/train.py --render       # or run the same pipeline as the ingest_pros Render Workflow
```

## Honest caveats

- Only **tennis serves filmed side-on** use measured profiles. Users should film from the side fence, level with the baseline, so they face the camera at setup. Forehands, backhands and pickleball still use hand-tuned **style archetypes**, and the UI labels them as estimates.
- Measurements come from 2D monocular video, so treat them as directional, not lab-grade.
- With 3 serves each, the Federer and Djokovic profiles are thin.
- Film from the same angle as the model you pick. A three-quarter or front-on clip won't match either model well, and the app warns when even the best match is poor.
