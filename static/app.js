import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const FPS = 20;
const MAX_SECONDS = 10;

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");

const choice = { sport: "tennis", stroke: "serve", hand: "auto" };
let config = null;
let landmarker = null;
let tsBase = 0;
let frames = [];
let analysis = null; // {sport, stroke, features, axes, matches, target, report}

// ---------- setup ----------

document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    choice[seg.dataset.name] = btn.dataset.value;
  });
});

$("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) run(file).catch(showError);
  e.target.value = "";
});

$("again").addEventListener("click", () => {
  $("results").classList.add("hidden");
  $("stage").classList.add("hidden");
  $("drop").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    config = c;
    $("mode").innerHTML =
      c.mode === "render-workflow"
        ? "Analysis pipeline: <b>Render Workflows</b> (each step runs as its own task)"
        : "Analysis pipeline: <b>local</b> (set WORKFLOW_SLUG to run on Render Workflows)";
  });

// ---------- pipeline ----------

function setStep(name, state) {
  const li = document.querySelector(`#steps li[data-step="${name}"]`);
  li.classList.remove("active", "done");
  if (state) li.classList.add(state);
}

function resetSteps() {
  document.querySelectorAll("#steps li").forEach((li) => li.classList.remove("active", "done"));
  $("error").classList.add("hidden");
  $("bar").style.width = "0%";
}

function showError(err) {
  console.error(err);
  $("error").textContent = err.message || String(err);
  $("error").classList.remove("hidden");
  $("drop").classList.remove("hidden");
  document.querySelectorAll("#steps li.active").forEach((li) => li.classList.remove("active"));
}

async function getLandmarker() {
  if (!landmarker) {
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  }
  return landmarker;
}

function once(el, ev) {
  return new Promise((res) => el.addEventListener(ev, res, { once: true }));
}

function drawPose(lm) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lm) return;
  const du = new DrawingUtils(ctx);
  du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#d7ff3a", lineWidth: 4 });
  du.drawLandmarks(lm, { color: "#ff6b3d", radius: 3 });
}

async function trackPose(file) {
  video.src = URL.createObjectURL(file);
  await once(video, "loadedmetadata");
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  const lmk = await getLandmarker();
  const duration = Math.min(video.duration || 0, MAX_SECONDS);
  if (!duration) throw new Error("Couldn't read that video. Try an MP4 or MOV.");

  frames = [];
  const r = (v, d) => Math.round(v * d) / d;
  for (let t = 0; t <= duration; t += 1 / FPS) {
    video.currentTime = t;
    await once(video, "seeked");
    const res = lmk.detectForVideo(video, tsBase + Math.round(t * 1000));
    const lm = res.landmarks[0];
    drawPose(lm);
    if (lm) frames.push({ t: r(t, 1000), lm: lm.map((p) => [r(p.x, 1e4), r(p.y, 1e4), r(p.visibility ?? 1, 100)]) });
    $("bar").style.width = `${Math.min(100, (t / duration) * 100)}%`;
  }
  tsBase += Math.round(duration * 1000) + 1000;
  if (frames.length < 8) throw new Error("No player detected. Make sure your whole body is visible.");
}

async function poll(runId, onTick) {
  for (let i = 0; ; i++) {
    const r = await fetch(`/api/runs/${runId}`).then((r) => r.json());
    if (r.status === "completed") return r.result;
    if (r.status === "failed" || r.status === "canceled") throw new Error(r.error || "Analysis failed");
    onTick?.(i);
    await new Promise((res) => setTimeout(res, 900));
  }
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.detail || "Request failed");
  return data;
}

async function run(file) {
  $("drop").classList.add("hidden");
  $("results").classList.add("hidden");
  $("stage").classList.remove("hidden");
  resetSteps();

  setStep("pose", "active");
  await trackPose(file);
  setStep("pose", "done");

  setStep("extract", "active");
  const { run_id } = await post("/api/analyze", {
    ...choice,
    width: video.videoWidth,
    height: video.videoHeight,
    frames,
  });
  // The workflow runs as one chained job; advance the checklist while we wait.
  const result = await poll(run_id, (i) => {
    if (i === 1) { setStep("extract", "done"); setStep("score", "active"); }
    if (i === 3) { setStep("score", "done"); setStep("coach", "active"); }
  });
  if (result.error) throw new Error(result.error);
  ["extract", "score", "coach"].forEach((s) => setStep(s, "done"));

  analysis = result;
  await snapshotContact(result.features.contact_time);
  renderResults();
}

let contactShot = null;
async function snapshotContact(t) {
  video.currentTime = t;
  await once(video, "seeked");
  const near = frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), frames[0]);
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const cx = c.getContext("2d");
  cx.drawImage(video, 0, 0);
  const du = new DrawingUtils(cx);
  const lm = near.lm.map(([x, y, v]) => ({ x, y, z: 0, visibility: v }));
  du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#d7ff3a", lineWidth: 5 });
  contactShot = c.toDataURL("image/jpeg", 0.8);
  drawPose(lm);
}

// ---------- become another pro ----------

async function become(proId, li) {
  if (proId === analysis.target) return;
  li.classList.add("loading");
  try {
    const extracted = { sport: analysis.sport, stroke: analysis.stroke, features: analysis.features, axes: analysis.axes };
    const { run_id } = await post("/api/become", { extracted, pro_id: proId });
    const res = await poll(run_id);
    analysis.target = res.target;
    analysis.report = res.report;
    renderResults();
    $("card").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    alert(e.message);
  } finally {
    li.classList.remove("loading");
  }
}

// ---------- render ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const proById = (id) => config.pros.find((p) => p.id === id);

function renderResults() {
  const pro = proById(analysis.target);
  const match = analysis.matches.find((m) => m.pro_id === pro.id);
  const rep = analysis.report;
  const isTop = analysis.matches[0].pro_id === pro.id;

  $("card").innerHTML = `
    <div class="label">${isTop ? "Your alter ego" : "Now LARPing as"}</div>
    <div class="pct">${match.similarity}<small>%</small></div>
    <div class="name">${esc(pro.name)}</div>
    <div class="nick">"${esc(pro.nickname)}"</div>
    <p class="sig">${esc(pro.signature)}</p>
    <div class="walkout">🎙️ ${esc(rep.walkout_line)}</div>
    ${contactShot ? `<img src="${contactShot}" alt="Your contact point">` : ""}`;

  $("radar-name").textContent = pro.name.split(" ").slice(-1)[0];
  drawRadar(analysis.axes, pro.axes);

  $("story").innerHTML = `
    <h3>${esc(rep.headline)}</h3>
    <p>${esc(rep.alter_ego_story)}</p>
    <div class="traits">${rep.shared_traits.map((t) => `<span>${esc(t)}</span>`).join("")}</div>`;

  $("board").innerHTML = analysis.matches
    .map((m) => {
      const p = proById(m.pro_id);
      return `<li data-id="${p.id}" class="${p.id === pro.id ? "target" : ""}">
        <span class="who">${esc(p.name)} <small>${esc(p.nickname)}</small></span>
        <span class="val">${m.similarity}%</span>
        <span class="meter"><div style="width:${m.similarity}%"></div></span></li>`;
    })
    .join("");
  $("board").querySelectorAll("li").forEach((li) => li.addEventListener("click", () => become(li.dataset.id, li)));

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
    .map((q) => `<a target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${encodeURIComponent(q)}">${esc(q)}</a>`)
    .join("");

  const f = analysis.features;
  const nums = [
    ["Hitting hand", f.hand],
    ["Peak hand speed", `${f.peak_speed} torso-lengths/s`],
    ["Max knee bend", `${f.knee_flex}°`],
    ["Shoulder turn", `${f.shoulder_turn}°`],
    ["Hip-shoulder separation", `${f.separation}°`],
    [analysis.stroke === "serve" ? "Contact above shoulders" : "Arm extension at contact",
      analysis.stroke === "serve" ? `${f.contact_height}× torso` : `${f.arm_extension}°`],
    ["Prep time", `${f.prep_time}s`],
    ["Follow-through", `${f.follow_time}s`],
  ];
  $("nums").innerHTML = nums.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

  $("stage").classList.add("hidden");
  $("results").classList.remove("hidden");
}

function drawRadar(you, them) {
  const keys = Object.keys(config.axes);
  const cx = 160, cy = 150, R = 105;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / keys.length;
    return [cx + Math.cos(a) * R * (v / 100), cy + Math.sin(a) * R * (v / 100)];
  };
  const poly = (vals, color) =>
    `<polygon points="${keys.map((k, i) => pt(i, vals[k]).join(",")).join(" ")}" fill="${color}" fill-opacity=".22" stroke="${color}" stroke-width="2"/>`;
  let svg = "";
  for (const lvl of [25, 50, 75, 100])
    svg += `<polygon points="${keys.map((_, i) => pt(i, lvl).join(",")).join(" ")}" fill="none" stroke="#26302a"/>`;
  keys.forEach((k, i) => {
    const [x, y] = pt(i, 100);
    const [lx, ly] = pt(i, 122);
    svg += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#26302a"/>`;
    svg += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle">${config.axes[k]}</text>`;
  });
  svg += poly(them, "#ff6b3d") + poly(you, "#d7ff3a");
  $("radar").innerHTML = svg;
}
