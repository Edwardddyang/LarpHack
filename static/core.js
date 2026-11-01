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
const MAX_FRAMES_SENT = 440;

// Skeleton drawn over video: soft white bones, green joints, readable on any footage.
const SKELETON = "rgba(255, 255, 255, 0.85)";
const JOINT = "#6fb995";

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
  du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: SKELETON, lineWidth });
  du.drawLandmarks(lm, { color: JOINT, radius: lineWidth - 1 });
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

  // Sample densely (contact lasts a few frames; 20fps can skip the full-reach instant),
  // but stay under the server's per-request frame limit for long clips.
  const fps = Math.max(FPS, Math.min(30, Math.floor(MAX_FRAMES_SENT / duration)));
  const frames = [];
  for (let t = 0; t <= duration; t += 1 / fps) {
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
    du.drawConnectors(unpack(frame.lm), PoseLandmarker.POSE_CONNECTIONS, { color: SKELETON, lineWidth: 5 });
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
  // Colors come from CSS (.you / .them / .grid-line) so charts follow the theme.
  const poly = (vals, cls) =>
    `<polygon class="${cls}" points="${keys.map((k, i) => pt(i, vals[k]).join(",")).join(" ")}"/>`;
  let svg = "";
  for (const lvl of [25, 50, 75, 100])
    svg += `<polygon class="grid-line" points="${keys.map((_, i) => pt(i, lvl).join(",")).join(" ")}"/>`;
  keys.forEach((k, i) => {
    const [x, y] = pt(i, 100);
    const [lx, ly] = pt(i, 122);
    svg += `<line class="grid-line" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`;
    // Anchor side labels away from the chart so long names don't overlap or clip.
    const anchor = lx < cx - 10 ? "end" : lx > cx + 10 ? "start" : "middle";
    svg += `<text x="${lx}" y="${ly}" text-anchor="${anchor}" dominant-baseline="middle">${axes[k]}</text>`;
  });
  return svg + poly(them, "them") + poly(you, "you");
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
  const line = (vals, cls) =>
    `<polyline class="${cls}" points="${vals.map((v, i) => `${x(i, vals.length)},${y(v)}`).join(" ")}"/>`;
  const fmtv = (v) => (Math.abs(hi - lo) > 10 ? Math.round(v) : v.toFixed(1)) + unit;
  return `
    <text x="${L}" y="9" class="ttl">${label}</text>
    <line class="grid-line" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>
    <text x="${L - 4}" y="${y(hi)}" text-anchor="end" dominant-baseline="middle">${fmtv(hi)}</text>
    <text x="${L - 4}" y="${y(lo)}" text-anchor="end" dominant-baseline="middle">${fmtv(lo)}</text>
    <text x="${L}" y="${H - 6}">start</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end">finish</text>
    ${pro ? line(pro, "them") : ""}
    ${line(you, "you")}`;
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

// ---------- training loop: sessions, goal pro, weekly plan, coach chat ----------
// Stored on this device only (localStorage); every access is guarded so the app
// still works in private mode or when storage is blocked.

const KEYS = { sessions: "alterego.sessions", goal: "alterego.goal", plan: "alterego.plan", chat: "alterego.chat" };

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: features degrade to this session only */
  }
}

export const loadSessions = () => readJSON(KEYS.sessions, []);
export const getGoal = () => readJSON(KEYS.goal, null);
export const setGoal = (proId, proName) => writeJSON(KEYS.goal, { pro_id: proId, name: proName, since: Date.now() });

/** Save a compact record of an analysis; returns the stored session. */
export function saveSession(analysis) {
  const sessions = loadSessions();
  const session = {
    id: `${Date.now()}`,
    at: Date.now(),
    sport: analysis.sport,
    stroke: analysis.stroke,
    view: analysis.view,
    target: analysis.target,
    similarity: Object.fromEntries(analysis.matches.map((m) => [m.pro_id, m.similarity])),
    names: Object.fromEntries(analysis.matches.map((m) => [m.pro_id, m.pro?.name || m.pro_id])),
    features: Object.fromEntries(
      Object.entries(analysis.features).filter(([k, v]) => typeof v === "number" && k !== "frames_used"),
    ),
    labels: analysis.labels,
  };
  sessions.push(session);
  writeJSON(KEYS.sessions, sessions.slice(-60));
  return session;
}

/** Sessions comparable to this analysis (same sport/stroke/camera), oldest first. */
export function comparableSessions(analysis) {
  return loadSessions().filter((s) => s.sport === analysis.sport && s.stroke === analysis.stroke && s.view === analysis.view);
}

/** Days in a row (ending today or yesterday) with at least one analysis or plan check-off. */
export function streak() {
  const days = new Set(loadSessions().map((s) => new Date(s.at).toDateString()));
  for (const s of loadPlan()?.sessions || []) for (const d of s.drills) if (d.doneAt) days.add(new Date(d.doneAt).toDateString());
  let n = 0;
  const day = new Date();
  if (!days.has(day.toDateString())) day.setDate(day.getDate() - 1);
  while (days.has(day.toDateString())) {
    n += 1;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

export const loadPlan = () => readJSON(KEYS.plan, null);
export const savePlan = (plan) => writeJSON(KEYS.plan, plan);

/** Three practice sessions for the week from the three biggest gaps, then a re-test. */
export function buildPlan(analysis) {
  const rep = analysis.report;
  const pro = analysis.matches.find((m) => m.pro_id === analysis.target)?.pro;
  const fixes = rep.fixes.slice(0, 3);
  const drills = rep.drills.slice(0, 3);
  const label = (f) => analysis.labels?.[f.axis] || f.axis;
  // Distinct drills (the template can repeat one across gaps), cycled across sessions.
  const unique = [...new Map(drills.map((d) => [d.name, d])).values()];
  const pick = (i) => unique[i % unique.length];
  const serveSet = (f) => ({
    name: `20 ${analysis.stroke}s: ${label(f).toLowerCase()}`,
    how: `Think only about this cue: "${f.cue}"`,
    reps: "20 reps",
  });
  const sessions = fixes.map((f, i) => ({
    title: `Session ${i + 1}: ${label(f)}`,
    drills: [...new Map([pick(i), pick(i + 1), serveSet(f)].filter(Boolean).map((d) => [d.name, d])).values()]
      .map((d) => ({ ...d, done: false })),
  }));
  return {
    created: Date.now(),
    goal: pro?.name || analysis.target,
    target: analysis.target,
    sessions,
    retest: `Film one ${analysis.stroke} from the same angle to measure your progress.`,
  };
}

export function toggleDrill(plan, s, d) {
  const drill = plan.sessions[s].drills[d];
  drill.done = !drill.done;
  drill.doneAt = drill.done ? Date.now() : null;
  savePlan(plan);
  return plan;
}

export function planProgress(plan) {
  const all = plan?.sessions.flatMap((s) => s.drills) || [];
  return { done: all.filter((d) => d.done).length, total: all.length };
}

export const loadChat = () => readJSON(KEYS.chat, []);
export const saveChat = (msgs) => writeJSON(KEYS.chat, msgs.slice(-30));

/** Ask the coach about the latest analysis. */
export async function ask(question, analysis, history) {
  return post("/api/ask", { question, analysis: { ...analysis, plan: loadPlan() }, history });
}

/** Small line chart for a series of numbers (e.g. match % over sessions). */
export function sparkSVG(values, { width = 300, height = 80, label = "" } = {}) {
  if (values.length < 2) return "";
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i) => 8 + (i / (values.length - 1)) * (width - 16);
  const y = (v) => height - 14 - ((v - lo) / span) * (height - 30);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const last = values.length - 1;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">
    <polyline class="you" points="${pts}"/>
    <circle class="dot" cx="${x(last)}" cy="${y(values[last])}" r="4"/>
    <text x="8" y="${height - 2}">${values.length} sessions</text>
    <text x="${width - 8}" y="${height - 2}" text-anchor="end">${Math.round(values[last])}</text>
  </svg>`;
}

const LAST = "alterego.last";
/** Keep the latest full analysis so Progress/Plan/Coach work after a reload. */
export const saveLast = (analysis) => writeJSON(LAST, analysis);
export const loadLast = () => readJSON(LAST, null);
