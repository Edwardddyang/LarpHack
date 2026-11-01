import * as core from "./core.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");

const choice = { sport: "tennis", stroke: "serve", hand: "auto" };
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

core.loadConfig().then((c) => {
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

async function run(file) {
  $("drop").classList.add("hidden");
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
  $("radar").innerHTML = core.radarSVG(config.axes, analysis.axes, pro.axes);

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
    .map((q) => `<a target="_blank" rel="noopener" href="${core.youtube(q)}">${esc(q)}</a>`)
    .join("");

  $("nums").innerHTML = core.featureRows(analysis).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

  $("stage").classList.add("hidden");
  $("results").classList.remove("hidden");
}
