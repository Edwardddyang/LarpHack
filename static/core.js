// Shared logic for the desktop and mobile UIs: pose tracking, API calls, rendering helpers.
import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODELS = {
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
};
export const FPS = 20;
export const MAX_SECONDS = 20; // slow-motion serves often run past 10s
export const MIN_FRAMES = 8;

let landmarker = null;
let lastTs = 0;

export async function getLandmarker(model = "full") {
  if (!landmarker) {
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS[model], delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  }
  return landmarker;
}

// MediaPipe VIDEO mode needs strictly increasing timestamps across every call.
export function detect(lmk, video) {
  lastTs = Math.max(lastTs + 1, Math.round(performance.now()));
  return lmk.detectForVideo(video, lastTs).landmarks[0];
}

const r = (v, d) => Math.round(v * d) / d;
export const packFrame = (t, lm) => ({
  t: r(t, 1000),
  lm: lm.map((p) => [r(p.x, 1e4), r(p.y, 1e4), r(p.visibility ?? 1, 100)]),
});
export const unpack = (lm) => lm.map(([x, y, v]) => ({ x, y, z: 0, visibility: v }));

export function drawPose(ctx, lm, lineWidth = 4) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!lm) return;
  const du = new DrawingUtils(ctx);
  du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#d7ff3a", lineWidth });
  du.drawLandmarks(lm, { color: "#ff6b3d", radius: lineWidth - 1 });
}

export function once(el, ev) {
  return new Promise((res) => el.addEventListener(ev, res, { once: true }));
}

/** Seek through an uploaded clip frame by frame and collect landmarks. */
export async function trackFile(file, video, overlay, onProgress, model) {
  video.src = URL.createObjectURL(file);
  await once(video, "loadedmetadata");
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  const ctx = overlay.getContext("2d");
  const lmk = await getLandmarker(model);
  const duration = Math.min(video.duration || 0, MAX_SECONDS);
  if (!duration || !isFinite(duration)) throw new Error("Couldn't read that video. Try an MP4 or MOV.");

  const frames = [];
  for (let t = 0; t <= duration; t += 1 / FPS) {
    video.currentTime = t;
    await once(video, "seeked");
    const lm = detect(lmk, video);
    drawPose(ctx, lm);
    if (lm) frames.push(packFrame(t, lm));
    onProgress?.(t / duration);
  }
  if (frames.length < MIN_FRAMES) throw new Error("No player detected. Make sure your whole body is visible.");
  return frames;
}

/** Draw the clip's contact frame with the skeleton on top; returns a JPEG data URL. */
export async function snapshotFromVideo(video, frames, t) {
  video.currentTime = t;
  await once(video, "seeked");
  return composeSnapshot(video, video.videoWidth, video.videoHeight, nearestFrame(frames, t));
}

export function nearestFrame(frames, t) {
  return frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), frames[0]);
}

export function composeSnapshot(source, w, h, frame) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d");
  cx.drawImage(source, 0, 0, w, h);
  if (frame) {
    const du = new DrawingUtils(cx);
    du.drawConnectors(unpack(frame.lm), PoseLandmarker.POSE_CONNECTIONS, { color: "#d7ff3a", lineWidth: 5 });
  }
  return c.toDataURL("image/jpeg", 0.8);
}

// ---------- API ----------

export async function loadConfig() {
  return fetch("/api/config").then((r) => r.json());
}

export async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.detail || "Request failed");
  return data;
}

export async function poll(runId, onTick) {
  for (let i = 0; ; i++) {
    const r = await fetch(`/api/runs/${runId}`).then((r) => r.json());
    if (r.status === "completed") return r.result;
    if (r.status === "failed" || r.status === "canceled") throw new Error(r.error || "Analysis failed");
    onTick?.(i);
    await new Promise((res) => setTimeout(res, 900));
  }
}

/** Run the full analysis workflow. onTick(i) fires on each poll while it runs. */
export async function analyze(payload, onTick) {
  const { run_id } = await post("/api/analyze", payload);
  const result = await poll(run_id, onTick);
  if (result.error) throw new Error(result.error);
  return result;
}

/** Re-coach an analysis toward another pro; mutates and returns analysis. */
export async function become(analysis, proId) {
  // Send everything extract produced (view, profile source, ...) minus the results.
  const { matches, target, report, low_confidence, ...extracted } = analysis;
  const { run_id } = await post("/api/become", { extracted, pro_id: proId });
  const res = await poll(run_id);
  analysis.target = res.target;
  analysis.report = res.report;
  analysis.matches = matches.map((m) => (m.pro_id === res.target ? res.match : m));
  return analysis;
}

// ---------- rendering helpers ----------

export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const youtube = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

export function radarSVG(axes, you, them) {
  const keys = Object.keys(axes);
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
    svg += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle">${axes[k]}</text>`;
  });
  return svg + poly(them, "#ff6b3d") + poly(you, "#d7ff3a");
}

export function featureRows(analysis) {
  const f = analysis.features;
  const serve = analysis.stroke === "serve";
  return [
    ["Hitting hand", f.hand],
    ["Peak hand speed", `${f.peak_speed} torso-lengths/s`],
    ["Max knee bend", `${f.knee_flex}°`],
    ["Shoulder turn", `${f.shoulder_turn}°`],
    ["Hip-shoulder separation", `${f.separation}°`],
    [serve ? "Contact above shoulders" : "Arm extension at contact", serve ? `${f.contact_height}× torso` : `${f.arm_extension}°`],
    ["Prep time", `${f.prep_time}s`],
    ["Follow-through", `${f.follow_time}s`],
  ];
}

/** Phase-by-phase line chart: the player's time-normalized curve vs the pro's average. */
export function curveSVG(you, pro, { label, unit = "", invert = false } = {}) {
  const W = 320, H = 150, L = 34, R = 8, T = 12, B = 22;
  const all = [...you, ...(pro || [])];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const x = (i, n) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => {
    const f = (v - lo) / (hi - lo);
    return T + (invert ? f : 1 - f) * (H - T - B);
  };
  const line = (vals, color, dash = "") =>
    `<polyline fill="none" stroke="${color}" stroke-width="2.5" ${dash} points="${vals.map((v, i) => `${x(i, vals.length)},${y(v)}`).join(" ")}"/>`;
  const fmtv = (v) => (Math.abs(hi - lo) > 10 ? Math.round(v) : v.toFixed(1)) + unit;
  return `
    <text x="${L}" y="9" class="ttl">${label}</text>
    <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#26302a"/>
    <text x="${L - 4}" y="${y(hi)}" text-anchor="end" dominant-baseline="middle">${fmtv(hi)}</text>
    <text x="${L - 4}" y="${y(lo)}" text-anchor="end" dominant-baseline="middle">${fmtv(lo)}</text>
    <text x="${L}" y="${H - 6}">start</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end">finish</text>
    ${pro ? line(pro, "#ff6b3d", 'stroke-dasharray="5 4"') : ""}
    ${line(you, "#d7ff3a")}`;
}

export const CURVES = [
  ["knee", "Knee bend through the serve", "°", true],
  ["wrist_height", "Hitting hand height", "", false],
];

export function phaseCharts(analysis, match) {
  const you = analysis.features.curves;
  const pro = match?.pro_curves;
  if (!you || !pro) return "";
  // Knee angle: smaller angle = more bend, so flip it to read "up = more bend".
  return CURVES.filter(([k]) => you[k] && pro[k])
    .map(([k, label, unit, invert]) => `<svg class="curve" viewBox="0 0 320 150" role="img" aria-label="${label}">${curveSVG(you[k], pro[k], { label, unit, invert })}</svg>`)
    .join("");
}
