import * as core from "./core.js";

const $ = (id) => document.getElementById(id);
const MODEL = "lite"; // faster on phones; good enough for one swing
const REC_SECONDS = 6;
const COUNTDOWN = 5;
const BODY = [11, 12, 23, 24, 27, 28];

const choice = { sport: "tennis", stroke: "serve", hand: "auto", view: "side" };
let config = null;
let analysis = null;
let frames = [];
let contactShot = null;
let source = null; // "live" | "file"
let liveThumbs = [];
let liveSize = { w: 0, h: 0 };

// ---------- navigation ----------

const TABS = { home: null, progress: renderProgress, plan: renderPlan, coach: renderCoach };

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("hidden", s.id !== id));
  const tabbed = id in TABS;
  $("tabs").classList.toggle("hidden", !tabbed);
  if (tabbed) {
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === id));
    TABS[id]?.();
  }
}

document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));

document.querySelectorAll(".seg[data-name]").forEach((group) => {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    group.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    choice[group.dataset.name] = btn.dataset.value;
    $("view-chips").classList.toggle("hidden", !(choice.sport === "tennis" && choice.stroke === "serve"));
  });
});

core.loadConfig().then((c) => {
  config = c;
  $("mode").innerHTML = c.mode === "render-workflow" ? "Running on Render Workflows" : "Running locally";
});
// Warm up the model while the player picks options.
core.getLandmarker(MODEL).catch(() => {});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// ---------- camera ----------

const live = $("live");
const liveCtx = $("live-overlay").getContext("2d");
let stream = null;
let facing = "environment";
let looping = false;
let lastVideoTime = -1;
let countdownTimer = null;
let recording = null; // {start, frames, thumbs}
const thumbCanvas = document.createElement("canvas");

$("open-camera").addEventListener("click", openCamera);
$("close-camera").addEventListener("click", () => { stopCamera(); show("home"); });
$("flip").addEventListener("click", async () => {
  facing = facing === "environment" ? "user" : "environment";
  await startStream().catch(cameraError);
});
$("rec").addEventListener("click", onRecordButton);

async function openCamera() {
  show("camera");
  resetRecordUI();
  try {
    await startStream();
  } catch (e) {
    return cameraError(e);
  }
  const lmk = await core.getLandmarker(MODEL);
  looping = true;
  const tick = () => {
    if (!looping) return;
    if (live.readyState >= 2 && live.currentTime !== lastVideoTime) {
      lastVideoTime = live.currentTime;
      const lm = core.detect(lmk, live);
      core.drawPose(liveCtx, lm, 5);
      updateFrameHint(lm);
      if (recording) capture(lm);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function startStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  live.srcObject = stream;
  await live.play();
  liveCtx.canvas.width = live.videoWidth;
  liveCtx.canvas.height = live.videoHeight;
  $("camera").classList.toggle("mirror", facing === "user");
}

function stopCamera() {
  looping = false;
  clearInterval(countdownTimer);
  countdownTimer = null;
  recording = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function cameraError(e) {
  console.error(e);
  stopCamera();
  show("home");
  alert("Couldn't open the camera (it needs HTTPS and permission). You can upload a clip from your camera roll instead.");
}

function updateFrameHint(lm) {
  const hint = $("frame-hint");
  if (recording || countdownTimer) return;
  const ok = lm && BODY.every((i) => lm[i].visibility > 0.5 && lm[i].y > 0.02 && lm[i].y < 0.98);
  hint.classList.toggle("ok", !!ok);
  hint.textContent = !lm ? "Step into frame" : ok ? "Whole body in frame ✓" : "Step back until your whole body fits";
}

function resetRecordUI() {
  $("rec").classList.remove("on");
  $("countdown").classList.add("hidden");
  $("timer").textContent =
    choice.stroke !== "serve"
      ? `Prop your phone up · ${COUNTDOWN}s countdown`
      : choice.view === "side"
        ? `Film from the side fence, level with your baseline · ${COUNTDOWN}s countdown`
        : `Film from behind the baseline, facing the net · ${COUNTDOWN}s countdown`;
}

function onRecordButton() {
  if (recording) return finishRecording();
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
    return resetRecordUI();
  }
  let n = COUNTDOWN;
  $("countdown").textContent = n;
  $("countdown").classList.remove("hidden");
  $("timer").textContent = "Get in position… tap to cancel";
  navigator.vibrate?.(40);
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n > 0) {
      $("countdown").textContent = n;
      navigator.vibrate?.(40);
      return;
    }
    clearInterval(countdownTimer);
    countdownTimer = null;
    $("countdown").classList.add("hidden");
    navigator.vibrate?.([80, 40, 80]);
    $("rec").classList.add("on");
    $("frame-hint").textContent = "Swing!";
    recording = { start: performance.now(), frames: [], thumbs: [] };
  }, 1000);
}

function capture(lm) {
  const t = (performance.now() - recording.start) / 1000;
  if (lm) recording.frames.push(core.packFrame(t, lm));
  // Keep small JPEG thumbnails so we can show the contact frame later.
  thumbCanvas.width = 270;
  thumbCanvas.height = Math.round((270 * live.videoHeight) / live.videoWidth);
  thumbCanvas.getContext("2d").drawImage(live, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const rec = recording;
  thumbCanvas.toBlob((b) => b && rec.thumbs.push({ t, b }), "image/jpeg", 0.7);
  $("timer").textContent = `● ${t.toFixed(1)}s / ${REC_SECONDS}s · tap to stop`;
  if (t >= REC_SECONDS) finishRecording();
}

function finishRecording() {
  const rec = recording;
  liveSize = { w: live.videoWidth, h: live.videoHeight };
  stopCamera();
  frames = rec.frames;
  liveThumbs = rec.thumbs;
  source = "live";
  runAnalysis().catch(showError);
}

// ---------- upload ----------

$("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  source = "file";
  startWorking();
  setStep("pose", "active");
  core
    .trackFile(file, $("clip"), $("clip-overlay"), (p) => ($("bar").style.width = `${Math.min(100, p * 100)}%`), MODEL)
    .then((f) => {
      frames = f;
      return runAnalysis();
    })
    .catch(showError);
});

// ---------- analysis ----------

function setStep(name, state) {
  const li = document.querySelector(`#steps li[data-step="${name}"]`);
  li.classList.remove("active", "done");
  if (state) li.classList.add(state);
}

function startWorking() {
  show("working");
  document.querySelectorAll("#steps li").forEach((li) => li.classList.remove("active", "done"));
  $("error").classList.add("hidden");
  $("retry").classList.add("hidden");
  $("bar").style.width = "0%";
  // Live recordings have no video to show, so the skeleton canvas stands alone.
  $("clip").classList.toggle("hidden", source !== "file");
  $("clip-overlay").style.position = source !== "file" ? "static" : "";
}

let replayTimer = null;
function replaySkeleton() {
  // For live recordings, loop the captured skeleton while the workflow runs.
  const canvas = $("clip-overlay");
  canvas.width = liveSize.w;
  canvas.height = liveSize.h;
  const ctx = canvas.getContext("2d");
  let i = 0;
  clearInterval(replayTimer);
  replayTimer = setInterval(() => {
    if (!frames.length) return;
    core.drawPose(ctx, core.unpack(frames[i % frames.length].lm), 6);
    i += 1;
  }, 1000 / core.FPS);
}

async function runAnalysis() {
  if (source === "live") {
    startWorking();
    if (frames.length < core.MIN_FRAMES) throw new Error("Didn't catch your whole body. Step back and try again.");
    replaySkeleton();
  }
  setStep("pose", "done");
  $("bar").style.width = "100%";
  setStep("extract", "active");

  const size = source === "live" ? liveSize : { w: $("clip").videoWidth, h: $("clip").videoHeight };
  analysis = await core.analyze({ ...choice, width: size.w, height: size.h, frames }, (i) => {
    if (i === 1) { setStep("extract", "done"); setStep("score", "active"); }
    if (i === 3) { setStep("score", "done"); setStep("coach", "active"); }
  });
  ["extract", "score", "coach"].forEach((s) => setStep(s, "done"));
  clearInterval(replayTimer);

  contactShot = await makeContactShot(analysis.features.contact_time).catch(() => null);
  await afterAnalysis({ save: true });
}

/** Shared tail of every analysis: aim coaching at the goal pro, record progress, show results. */
async function afterAnalysis({ save }) {
  const goal = core.getGoal();
  if (goal && goal.pro_id !== analysis.target && analysis.candidates?.includes(goal.pro_id)) {
    await core.become(analysis, goal.pro_id).catch(() => {});
  }
  analysisSaved = save;
  if (save) {
    previous = core.comparableSessions(analysis).at(-1) || null;
    core.saveSession(analysis);
    core.saveLast(analysis);
    core.savePlan(core.buildPlan(analysis));
  } else {
    previous = null;
  }
  renderResults();
  showResultPane("compare");
  show("results");
}

function showResultPane(name) {
  document.querySelectorAll("#result-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.pane === name));
  $("r-compare").classList.toggle("hidden", name !== "compare");
  $("r-improve").classList.toggle("hidden", name !== "improve");
  document.querySelector(".results-body").scrollTop = 0;
}

$("result-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) showResultPane(b.dataset.pane);
});

async function makeContactShot(t) {
  if (source === "file") return core.snapshotFromVideo($("clip"), frames, t);
  if (!liveThumbs.length) return null;
  const thumb = liveThumbs.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const bmp = await createImageBitmap(thumb.b);
  return core.composeSnapshot(bmp, bmp.width, bmp.height, core.nearestFrame(frames, t));
}

function showError(err) {
  console.error(err);
  clearInterval(replayTimer);
  show("working");
  $("error").textContent = err.message || String(err);
  $("error").classList.remove("hidden");
  $("retry").classList.remove("hidden");
  document.querySelectorAll("#steps li.active").forEach((li) => li.classList.remove("active"));
}

$("retry").addEventListener("click", () => show("home"));

/** Analyze a bundled pro serve (pose data only) so people can explore without a clip. */
async function runSample() {
  const sample = await fetch("/static/sample_serve.json").then((r) => r.json());
  source = "sample";
  frames = sample.frames;
  liveSize = { w: sample.width, h: sample.height };
  startWorking();
  replaySkeleton();
  setStep("pose", "done");
  $("bar").style.width = "100%";
  setStep("extract", "active");
  analysis = await core.analyze({ ...choice, sport: "tennis", stroke: "serve", view: "side", width: sample.width, height: sample.height, frames }, (i) => {
    if (i === 1) { setStep("extract", "done"); setStep("score", "active"); }
    if (i === 3) { setStep("score", "done"); setStep("coach", "active"); }
  });
  clearInterval(replayTimer);
  contactShot = null;
  // The sample is a pro's serve, so it isn't saved to your progress.
  await afterAnalysis({ save: false });
}
$("sample").addEventListener("click", () => runSample().catch(showError));
if (new URLSearchParams(location.search).has("sample")) runSample().catch(showError);
$("restart").addEventListener("click", () => show(core.loadSessions().length ? "progress" : "home"));

// ---------- results ----------

const esc = core.esc;
let previous = null; // last comparable session, for "since last time"
let analysisSaved = false; // false for the bundled sample serve
const proById = (id) =>
  analysis?.matches?.find((m) => m.pro_id === id)?.pro || config.pros.find((p) => p.id === id);

function sinceLast(pro) {
  const before = previous?.similarity?.[pro.id];
  const now = analysis.matches.find((m) => m.pro_id === pro.id)?.similarity;
  if (before == null || now == null) return "";
  const d = now - before;
  const cls = d > 0 ? "up" : d < 0 ? "down" : "";
  return `<div class="since delta ${cls}">${d > 0 ? "+" : ""}${d} since your last session</div>`;
}

function renderResults() {
  const pro = proById(analysis.target);
  const match = analysis.matches.find((m) => m.pro_id === pro.id);
  const rep = analysis.report;
  const isTop = analysis.matches[0].pro_id === pro.id;

  const note = analysis.low_confidence
    ? "Low match to every pro. Check that the camera angle setting matches how you filmed."
    : match.measured ? `Measured from ${match.measured.n_serves} real serves` : "Estimated profile";
  $("card").innerHTML = `
    <div class="match-photo">${contactShot ? `<img src="${contactShot}" alt="Your contact point">` : `<div class="photo-empty">Sample serve</div>`}</div>
    <div class="eyebrow">${isTop ? "Closest match" : "Coaching you toward"}</div>
    <div class="match-name">${esc(pro.name)}</div>
    <div class="match-nick">${esc(pro.nickname)}</div>
    <div class="match-score"><span class="pct">${match.similarity}%</span><span class="pct-label">style match</span></div>
    <p class="match-sig">${esc(pro.signature)}</p>
    <blockquote class="walkout">${esc(rep.walkout_line)}</blockquote>
    ${sinceLast(pro)}
    <p class="source ${analysis.low_confidence ? "warn" : ""}">${esc(note)}</p>
    ${core.getGoal()?.pro_id === pro.id
      ? `<span class="chip goal-badge">Your goal pro</span>`
      : `<button class="btn goal-btn" id="set-goal">Make ${esc(pro.name.split(" ")[0])} my goal</button>`}
    <button class="text-btn" id="to-improve">See how to improve</button>`;
  $("to-improve").addEventListener("click", () => showResultPane("improve"));
  $("set-goal")?.addEventListener("click", () => {
    core.setGoal(pro.id, pro.name);
    // Re-aim the week's plan at the new goal, but only for the player's own serve.
    if (analysisSaved) core.savePlan(core.buildPlan(analysis));
    renderResults();
  });

  $("headline").textContent = rep.headline;
  $("story").textContent = rep.alter_ego_story;
  $("traits").innerHTML = rep.shared_traits.map((t) => `<span>${esc(t)}</span>`).join("");
  $("radar").innerHTML = core.radarSVG(analysis.axis_labels, analysis.axes, match.pro_axes || pro.axes);
  $("phases").innerHTML = core.phaseCharts(analysis, match);
  $("them-label").textContent = pro.name;

  $("fixes").innerHTML = rep.fixes
    .map((f) => `<li class="fix">
      <div class="axis">${esc(analysis.labels[f.axis] || f.axis)}</div>
      <div class="cmp">You ${esc(f.you)} · ${esc(pro.name.split(" ")[0])} ${esc(f.them)}</div>
      <div class="cue">${esc(f.cue)}</div></li>`)
    .join("");
  $("drills").innerHTML = rep.drills
    .map((d) => `<div class="drill"><b>${esc(d.name)}</b><span>${esc(d.how)}</span><em>${esc(d.reps)}</em></div>`)
    .join("");
  $("watch").innerHTML = rep.watch
    .map((q) => `<a target="_blank" rel="noopener" href="${core.youtube(q)}">${esc(q)}</a>`)
    .join("");
  $("nums").innerHTML = core.featureRows(analysis).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

  $("board").innerHTML = analysis.matches
    .map((m) => {
      const p = proById(m.pro_id);
      return `<li data-id="${p.id}" class="${p.id === pro.id ? "target" : ""}">
        <span class="who">${esc(p.name)}<small>${esc(p.nickname)}${m.measured ? ` · ${m.measured.n_serves} serves measured` : ""} · ${esc(p.signature)}</small></span>
        <span class="val">${m.similarity}%</span>
        <span class="meter"><div style="width:${m.similarity}%"></div></span></li>`;
    })
    .join("");
}



// ---------- switch pro from the Compare list ----------

$("board").addEventListener("click", async (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  if (li.dataset.id === analysis.target) return;
  li.classList.add("loading");
  try {
    await core.become(analysis, li.dataset.id);
    renderResults();
    document.querySelector(".results-body").scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    alert(err.message);
  } finally {
    li.classList.remove("loading");
  }
});

// ---------- share card ----------

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

async function renderShareCard() {
  // Light card: contact photo on top, result below. Matches the app's palette.
  const pro = proById(analysis.target);
  const match = analysis.matches.find((m) => m.pro_id === pro.id);
  const W = 1080, H = 1350, P = 72;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  await document.fonts.load("600 40px Inter").catch(() => {});

  x.fillStyle = "#f5f6f4";
  x.fillRect(0, 0, W, H);
  const photoH = 700;
  x.save();
  x.beginPath();
  x.roundRect(P / 2, P / 2, W - P, photoH, 36);
  x.clip();
  x.fillStyle = "#e2e5e0";
  x.fillRect(0, 0, W, H);
  if (contactShot) {
    const img = await loadImage(contactShot);
    const s = Math.max((W - P) / img.width, photoH / img.height);
    x.drawImage(img, (W - img.width * s) / 2, P / 2 + (photoH - img.height * s) / 2, img.width * s, img.height * s);
  }
  x.restore();

  let y = P / 2 + photoH + 80;
  x.fillStyle = "#69736d";
  x.font = "500 32px Inter";
  x.fillText("My closest pro match", P, y);
  y += 78;
  x.fillStyle = "#1d2420";
  x.font = "600 68px Inter";
  x.fillText(pro.name, P, y, W - 2 * P - 260);
  x.fillStyle = "#2f7a5b";
  x.font = "600 96px Inter";
  x.textAlign = "right";
  x.fillText(`${match.similarity}%`, W - P, y);
  x.textAlign = "left";
  y += 52;
  x.fillStyle = "#69736d";
  x.font = "400 34px Inter";
  x.fillText(pro.nickname, P, y);
  y += 70;
  x.fillStyle = "#b8774f";
  x.fillRect(P, y - 34, 6, 96);
  x.fillStyle = "#1d2420";
  x.font = "italic 400 32px Inter";
  for (const line of wrap(x, analysis.report.walkout_line, W - 2 * P - 30).slice(0, 2)) {
    x.fillText(line, P + 28, y);
    y += 44;
  }
  x.fillStyle = "#69736d";
  x.font = "400 26px Inter";
  x.fillText("Alter Ego · find the pro in your serve", P, H - 56);
  return new Promise((res) => c.toBlob(res, "image/png"));
}

$("share").addEventListener("click", async () => {
  const pro = proById(analysis.target);
  const match = analysis.matches.find((m) => m.pro_id === pro.id);
  const blob = await renderShareCard();
  const file = new File([blob], "alter-ego.png", { type: "image/png" });
  const text = `I'm ${match.similarity}% ${pro.name}. Who's your alter ego?`;
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "My alter ego", text });
      return;
    }
  } catch (e) {
    if (e.name === "AbortError") return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "alter-ego.png";
  a.click();
});

// ---------- progress ----------

function renderProgress() {
  const sessions = core.loadSessions();
  const goal = core.getGoal();
  const n = core.streak();
  $("streak").textContent = n ? `${n}-day streak` : "";
  if (!sessions.length) {
    $("progress-body").innerHTML = `<div class="empty">Analyze your first serve to start tracking your progress.
      <button class="btn primary" data-go="home">Analyze a serve</button></div>`;
    return;
  }
  const last = sessions.at(-1);
  const comparable = sessions.filter((s) => s.sport === last.sport && s.stroke === last.stroke && s.view === last.view);
  let html = "";
  if (goal) {
    const series = comparable.map((s) => s.similarity[goal.pro_id]).filter((v) => v != null);
    const first = series[0], latest = series.at(-1);
    const d = latest != null && first != null ? latest - first : 0;
    html += `<div class="panel">
      <div class="eyebrow">Goal pro</div>
      <div class="goal-row"><h2>${esc(goal.name)}</h2><span class="big">${latest ?? "–"}%</span></div>
      ${series.length > 1 ? `<div class="delta ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d} since your first session</div>` : `<div class="hint">Analyze again to see your trend.</div>`}
      ${core.sparkSVG(series, { label: "Match to goal pro over time" })}
    </div>`;
  } else {
    html += `<div class="panel"><h2>Pick a goal pro</h2>
      <p class="hint">Open a result and tap "Make … my goal" to track how close you're getting.</p></div>`;
  }
  const labels = last.labels || {};
  const keys = ["leg_drive", "knee_flex", "contact_height", "separation"].filter((k) => k in last.features);
  html += `<div class="panel"><h2>Key measurements</h2>${keys.map((k) => {
    const series = comparable.map((s) => s.features[k]).filter((v) => v != null);
    const d = series.length > 1 ? series.at(-1) - series[0] : null;
    return `<div class="metric"><span class="name">${esc(labels[k] || k)}</span><span class="val">${fmt(series.at(-1))}</span>
      <span class="sub">${d == null ? "First measurement" : `${d >= 0 ? "+" : ""}${fmt(d)} since first session`}</span></div>`;
  }).join("")}</div>`;
  html += `<div class="panel"><h2>Sessions</h2><ul class="history">${sessions.slice().reverse().slice(0, 10).map((s) => {
    const top = Object.entries(s.similarity).sort((a, b) => b[1] - a[1])[0];
    const g = goal && s.similarity[goal.pro_id] != null ? `Goal ${s.similarity[goal.pro_id]}%` : "";
    return `<li><span>${new Date(s.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}<br><small>${esc(s.stroke)} · ${s.view === "back" ? "behind" : "side"}</small></span>
      <span style="text-align:right">${esc(s.names[top[0]] || top[0])} ${top[1]}%<br><small>${g}</small></span></li>`;
  }).join("")}</ul></div>`;
  $("progress-body").innerHTML = html;
}

const fmt = (v) => (v == null ? "–" : Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(2));

// ---------- plan ----------

function renderPlan() {
  const plan = core.loadPlan();
  if (!plan) {
    $("plan-count").textContent = "";
    $("plan-body").innerHTML = `<div class="empty">Your weekly plan is built from your latest analysis.
      <button class="btn primary" data-go="home">Analyze a serve</button></div>`;
    return;
  }
  const { done, total } = core.planProgress(plan);
  $("plan-count").textContent = `${done}/${total} drills`;
  $("plan-body").innerHTML = `
    <p class="plan-head">Training toward ${esc(plan.goal)} · built ${new Date(plan.created).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
    <div class="meter"><div style="width:${total ? (100 * done) / total : 0}%"></div></div>
    ${plan.sessions.map((s, si) => `<div class="panel"><h2>${esc(s.title)}</h2>
      ${s.drills.map((d, di) => `<label class="check ${d.done ? "done" : ""}">
        <input type="checkbox" data-s="${si}" data-d="${di}" ${d.done ? "checked" : ""}>
        <div><b>${esc(d.name)}</b><span>${esc(d.how)}${d.reps ? ` · ${esc(d.reps)}` : ""}</span></div></label>`).join("")}
    </div>`).join("")}
    <div class="panel"><h2>Re-test</h2><p class="hint">${esc(plan.retest)}</p>
      <button class="btn primary" data-go="home">Film a re-test</button></div>`;
}

$("plan-body").addEventListener("change", (e) => {
  const box = e.target.closest("input[type=checkbox]");
  if (!box) return;
  core.toggleDrill(core.loadPlan(), +box.dataset.s, +box.dataset.d);
  navigator.vibrate?.(15);
  renderPlan();
});

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) show(go.dataset.go);
});

// ---------- coach chat ----------

const SUGGESTIONS = [
  "What should I practice today?",
  "How do I get more leg drive?",
  "Why am I not matching my goal pro?",
  "Give me a 10-minute warm-up",
];

function renderCoach() {
  const last = core.loadLast();
  const msgs = core.loadChat();
  const intro = last
    ? "Hi! I've seen your latest serve. Ask me anything about your technique, your plan, or your goal pro."
    : "Analyze a serve first, then I can coach you on your real numbers.";
  $("chat").innerHTML = [{ role: "assistant", content: intro }, ...msgs]
    .map((m) => `<div class="msg ${m.role}${m.pending ? " pending" : ""}">${esc(m.content)}</div>`)
    .join("");
  $("chat").scrollTop = $("chat").scrollHeight;
  $("suggest").innerHTML = last ? SUGGESTIONS.map((q) => `<button type="button">${esc(q)}</button>`).join("") : "";
}

async function sendQuestion(q) {
  const last = core.loadLast();
  if (!q || !last) return;
  const history = core.loadChat();
  core.saveChat([...history, { role: "user", content: q }]);
  $("question").value = "";
  renderCoach();
  $("chat").insertAdjacentHTML("beforeend", `<div class="msg assistant pending">Thinking…</div>`);
  $("chat").scrollTop = $("chat").scrollHeight;
  try {
    const { answer } = await core.ask(q, last, history);
    core.saveChat([...core.loadChat(), { role: "assistant", content: answer }]);
  } catch (err) {
    core.saveChat([...core.loadChat(), { role: "assistant", content: `Sorry, I couldn't answer that (${err.message}).` }]);
  }
  renderCoach();
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendQuestion($("question").value.trim());
});
$("suggest").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) sendQuestion(b.textContent);
});

show("home");
