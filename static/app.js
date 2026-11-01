import * as core from "./core.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");

const choice = { sport: "tennis", stroke: "serve", hand: "auto", view: "side" };
let config = null;
let frames = [];
let analysis = null; // {sport, stroke, features, axes, matches, target, report}
let contactShot = null;

// ---------- setup ----------

document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    choice[seg.dataset.name] = btn.dataset.value;
    updateFilmTip();
  });
});

// Measured pro models exist per camera angle for tennis serves only.
function updateFilmTip() {
  const serve = choice.sport === "tennis" && choice.stroke === "serve";
  $("view-field").classList.toggle("hidden", !serve);
  $("film-tip").textContent = !serve
    ? "One stroke, whole body in frame, up to 20 seconds."
    : choice.view === "side"
      ? "Film from beside the court, level with the baseline, so you face the camera at setup. Keep your whole body and racket in frame."
      : "Film from behind the baseline, looking toward the net. Keep your whole body and racket in frame.";
}
updateFilmTip();

$("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) run(file).catch(showError);
  e.target.value = "";
});

$("sample").addEventListener("click", () => runSample().catch(showError));
if (new URLSearchParams(location.search).has("sample")) runSample().catch(showError);

/** Analyze a bundled pro serve (pose data only) so people can explore without a clip. */
async function runSample() {
  const sample = await fetch("/static/sample_serve.json").then((r) => r.json());
  $("drop").classList.add("hidden");
  $("sample").parentElement.classList.add("hidden");
  $("results").classList.add("hidden");
  $("stage").classList.remove("hidden");
  $("stage").querySelector(".viewer").classList.add("hidden");
  resetSteps();
  setStep("pose", "done");
  frames = sample.frames;
  setStep("extract", "active");
  analysis = await core.analyze({ ...choice, sport: "tennis", stroke: "serve", view: "side", width: sample.width, height: sample.height, frames }, (i) => {
    if (i === 1) { setStep("extract", "done"); setStep("score", "active"); }
    if (i === 3) { setStep("score", "done"); setStep("coach", "active"); }
  });
  contactShot = null;
  renderResults();
}

$("again").addEventListener("click", () => {
  $("results").classList.add("hidden");
  $("stage").classList.add("hidden");
  $("drop").classList.remove("hidden");
  $("sample").parentElement.classList.remove("hidden");
  $("stage").querySelector(".viewer").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

core.loadConfig().then((c) => {
  config = c;
  $("mode").innerHTML =
    c.mode === "render-workflow"
      ? "Running on Render Workflows"
      : "Running locally";
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

async function run(file) {
  $("drop").classList.add("hidden");
  $("sample").parentElement.classList.add("hidden");
  $("stage").querySelector(".viewer").classList.remove("hidden");
  $("results").classList.add("hidden");
  $("stage").classList.remove("hidden");
  resetSteps();

  setStep("pose", "active");
  frames = await core.trackFile(file, video, overlay, (p) => ($("bar").style.width = `${Math.min(100, p * 100)}%`));
  setStep("pose", "done");

  setStep("extract", "active");
  // The workflow runs as one chained job; advance the checklist while we wait.
  const result = await core.analyze(
    { ...choice, width: video.videoWidth, height: video.videoHeight, frames },
    (i) => {
      if (i === 1) { setStep("extract", "done"); setStep("score", "active"); }
      if (i === 3) { setStep("score", "done"); setStep("coach", "active"); }
    },
  );
  ["extract", "score", "coach"].forEach((s) => setStep(s, "done"));

  analysis = result;
  contactShot = await core.snapshotFromVideo(video, frames, result.features.contact_time);
  core.drawPose(overlay.getContext("2d"), core.unpack(core.nearestFrame(frames, result.features.contact_time).lm));
  renderResults();
}

// ---------- become another pro ----------

async function become(proId, li) {
  if (proId === analysis.target) return;
  li.classList.add("loading");
  try {
    await core.become(analysis, proId);
    renderResults();
    $("card").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    alert(e.message);
  } finally {
    li.classList.remove("loading");
  }
}

// ---------- render ----------

const esc = core.esc;
const proById = (id) =>
  analysis?.matches?.find((m) => m.pro_id === id)?.pro || config.pros.find((p) => p.id === id);

function sourceNote(match) {
  if (!match.measured) return "Estimated profile (no measured footage for this stroke yet)";
  const ev = analysis.evaluation;
  const acc = ev?.top3 != null ? ` · model picks the right pro in its top 3 ${Math.round(ev.top3 * 100)}% of the time` : "";
  return `Measured from ${match.measured.n_serves} real serves in ${match.measured.n_videos} videos${acc}`;
}

function renderResults() {
  const pro = proById(analysis.target);
  const match = analysis.matches.find((m) => m.pro_id === pro.id);
  const rep = analysis.report;
  const isTop = analysis.matches[0].pro_id === pro.id;

  const note = analysis.low_confidence
    ? "Low match to every pro. Check that the camera angle setting matches how you filmed."
    : sourceNote(match);
  $("card").innerHTML = `
    <div class="match-photo">${contactShot ? `<img src="${contactShot}" alt="Your contact point">` : `<div class="photo-empty">Sample serve</div>`}</div>
    <div>
      <div class="eyebrow">${isTop ? "Closest match" : "Coaching you toward"}</div>
      <div class="match-name">${esc(pro.name)}</div>
      <div class="match-nick">${esc(pro.nickname)}</div>
      <div class="match-score"><span class="pct">${match.similarity}%</span><span class="pct-label">style match</span></div>
      <p class="match-sig">${esc(pro.signature)}</p>
      <blockquote class="walkout">${esc(rep.walkout_line)}</blockquote>
      <p class="source ${analysis.low_confidence ? "warn" : ""}">${esc(note)}</p>
    </div>`;

  $("radar-name").textContent = pro.name;
  $("radar").innerHTML = core.radarSVG(analysis.axis_labels, analysis.axes, match.pro_axes || pro.axes);
  $("phases").innerHTML = core.phaseCharts(analysis, match);
  $("phases-panel").classList.toggle("hidden", !$("phases").innerHTML);

  $("story").innerHTML = `
    <h2>${esc(rep.headline)}</h2>
    <p>${esc(rep.alter_ego_story)}</p>
    <div class="traits">${rep.shared_traits.map((t) => `<span>${esc(t)}</span>`).join("")}</div>`;

  $("board").innerHTML = analysis.matches
    .map((m) => {
      const p = proById(m.pro_id);
      return `<li data-id="${p.id}" class="${p.id === pro.id ? "target" : ""}">
        <span class="who">${esc(p.name)} <small>${esc(p.nickname)}${m.measured ? ` · ${m.measured.n_serves} serves measured` : ""}</small></span>
        <span class="val">${m.similarity}%</span>
        <span class="meter"><div style="width:${m.similarity}%"></div></span></li>`;
    })
    .join("");
  $("board").querySelectorAll("li").forEach((li) => li.addEventListener("click", () => become(li.dataset.id, li)));

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

  $("stage").classList.add("hidden");
  $("results").classList.remove("hidden");
}
