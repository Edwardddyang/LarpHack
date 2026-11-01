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
export const MAX_SECONDS = 10;
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
  const extracted = { sport: analysis.sport, stroke: analysis.stroke, features: analysis.features, axes: analysis.axes };
  const { run_id } = await post("/api/become", { extracted, pro_id: proId });
  const res = await poll(run_id);
  analysis.target = res.target;
  analysis.report = res.report;
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
