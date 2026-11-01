import * as core from "./core.js";

const $ = (id) => document.getElementById(id);
const MODEL = "lite"; // faster on phones; good enough for one swing
const REC_SECONDS = 6;
const COUNTDOWN = 5;
const BODY = [11, 12, 23, 24, 27, 28];

const choice = { sport: "tennis", stroke: "serve", hand: "auto" };
let config = null;
let analysis = null;
let frames = [];
let contactShot = null;
let source = null; // "live" | "file"
let liveThumbs = [];
let liveSize = { w: 0, h: 0 };

// ---------- navigation ----------

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("hidden", s.id !== id));
}

document.querySelectorAll(".chips").forEach((group) => {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    group.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    choice[group.dataset.name] = btn.dataset.value;
  });
});

core.loadConfig().then((c) => {
  config = c;
  $("mode").innerHTML = c.mode === "render-workflow" ? "Powered by <b>Render Workflows</b>" : "Running locally";
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
  $("timer").textContent = `Prop your phone up · ${COUNTDOWN}s countdown`;
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
  $("clip").classList.toggle("hidden", source === "live");
  $("clip-overlay").style.position = source === "live" ? "static" : "";
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
  renderResults();
  show("results");
  $("deck").scrollTo({ left: 0 });
}

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
$("restart").addEventListener("click", () => show("home"));

// ---------- results ----------

const esc = core.esc;
const proById = (id) => config.pros.find((p) => p.id === id);

function renderResults() {
  const pro = proById(analysis.target);
  const match = analysis.matches.find((m) => m.pro_id === pro.id);
  const rep = analysis.report;
  const isTop = analysis.matches[0].pro_id === pro.id;

  const card = $("card");
  card.style.backgroundImage = contactShot ? `url(${contactShot})` : "";
  card.innerHTML = `
    <div class="label">${isTop ? "Your alter ego" : "Now LARPing as"}</div>
    <div class="pct">${match.similarity}<small>%</small></div>
    <div class="name">${esc(pro.name)}</div>
    <div class="nick">"${esc(pro.nickname)}"</div>
    <p class="sig">${esc(pro.signature)}</p>
    <div class="walkout">🎙️ ${esc(rep.walkout_line)}</div>
    <div class="swipe">Swipe for your plan →</div>`;

  $("headline").textContent = rep.headline;
  $("story").textContent = rep.alter_ego_story;
  $("traits").innerHTML = rep.shared_traits.map((t) => `<span>${esc(t)}</span>`).join("");
  $("radar").innerHTML = core.radarSVG(config.axes, analysis.axes, pro.axes);
  $("them-label").textContent = pro.name.split(" ").slice(-1)[0];

  $("fixes").innerHTML = rep.fixes
    .map((f) => `<div class="fix">
      <div class="axis">${esc(config.axes[f.axis] || f.axis)}</div>
      <div class="cmp">You: ${esc(f.you)}<br>${esc(pro.name.split(" ")[0])}: ${esc(f.them)}</div>
      <div class="cue">${esc(f.cue)}</div></div>`)
    .join("");
  $("drills").innerHTML = rep.drills
    .map((d) => `<div class="drill"><b>${esc(d.name)}</b><span>${esc(d.how)}</span><br><em>${esc(d.reps)}</em></div>`)
    .join("");
  $("watch").innerHTML = rep.watch
    .map((q) => `<a target="_blank" rel="noopener" href="${core.youtube(q)}">${esc(q)}</a>`)
    .join("");
  $("nums").innerHTML = core.featureRows(analysis).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

  $("board").innerHTML = analysis.matches
    .map((m) => {
      const p = proById(m.pro_id);
      return `<li data-id="${p.id}" class="${p.id === pro.id ? "target" : ""}">
        <span class="who">${esc(p.name)}<small>${esc(p.nickname)} · ${esc(p.signature)}</small></span>
        <span class="val">${m.similarity}%</span>
        <span class="meter"><div style="width:${m.similarity}%"></div></span></li>`;
    })
    .join("");

  const slides = $("deck").children.length;
  $("dots").innerHTML = Array.from({ length: slides }, (_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("");
}

$("deck").addEventListener("scroll", () => {
  const deck = $("deck");
  const idx = Math.round(deck.scrollLeft / deck.clientWidth);
  [...$("dots").children].forEach((d, i) => d.classList.toggle("on", i === idx));
});

// ---------- pro picker sheet ----------

function openSheet(open) {
  $("sheet").classList.toggle("open", open);
  $("sheet").setAttribute("aria-hidden", String(!open));
  $("sheet-backdrop").classList.toggle("hidden", !open);
}
$("open-pros").addEventListener("click", () => openSheet(true));
$("sheet-backdrop").addEventListener("click", () => openSheet(false));

$("board").addEventListener("click", async (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  if (li.dataset.id === analysis.target) return openSheet(false);
  li.classList.add("loading");
  try {
    await core.become(analysis, li.dataset.id);
    renderResults();
    openSheet(false);
    $("deck").scrollTo({ left: 0, behavior: "smooth" });
  } catch (err) {
    alert(err.message);
  } finally {
    li.classList.remove("loading");
  }
});
