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

document.querySelectorAll(".seg[data-name]").forEach((seg) => {
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
  // The sample is a pro's serve, so it isn't saved to your progress.
  await afterAnalysis({ save: false });
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
  await afterAnalysis({ save: true });
}

let previous = null; // last comparable session, for "since last time"
let analysisSaved = false; // false for the bundled sample serve

/** Aim coaching at the goal pro, record progress and refresh the plan, then show results. */
async function afterAnalysis({ save }) {
  const goal = core.getGoal();
  if (goal && goal.pro_id !== analysis.target && analysis.candidates?.includes(goal.pro_id)) {
    await core.become(analysis, goal.pro_id).catch(() => {});
  }
  analysisSaved = save;
  previous = save ? core.comparableSessions(analysis).at(-1) || null : null;
  if (save) {
    core.saveSession(analysis);
    core.saveLast(analysis);
    core.savePlan(core.buildPlan(analysis));
  }
  renderResults();
  showResultPane("compare");
  renderProgressCard();
}

function showResultPane(name) {
  document.querySelectorAll("#result-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.pane === name));
  $("r-compare").classList.toggle("hidden", name !== "compare");
  $("r-improve").classList.toggle("hidden", name !== "improve");
}

$("result-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) showResultPane(b.dataset.pane);
});

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

function sinceLast(pro) {
  const before = previous?.similarity?.[pro.id];
  const now = analysis.matches.find((m) => m.pro_id === pro.id)?.similarity;
  if (before == null || now == null) return "";
  const d = now - before;
  return `<div class="delta ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d} since your last session</div>`;
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
      ${sinceLast(pro)}
      <p class="source ${analysis.low_confidence ? "warn" : ""}">${esc(note)}</p>
      ${core.getGoal()?.pro_id === pro.id
        ? `<span class="chip">Your goal pro</span>`
        : `<button class="btn goal-btn" id="set-goal">Make ${esc(pro.name.split(" ")[0])} my goal</button>`}
    </div>`;
  $("set-goal")?.addEventListener("click", () => {
    core.setGoal(pro.id, pro.name);
    if (analysisSaved) core.savePlan(core.buildPlan(analysis));
    renderResults();
    renderProgressCard();
  });
  renderPlan();
  renderCoach();

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

// ---------- progress, plan, coach ----------

const fmt = (v) => (v == null ? "–" : Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(2));

function signInGate(what) {
  const n = core.loadSessions().length;
  return `<div class="gate"><h2>Sign in to ${what}</h2>
    <p class="hint">Your account keeps your sessions, goal pro and weekly plan on any device.${n ? ` The ${n} session${n > 1 ? "s" : ""} in this browser will be saved to it.` : ""}</p>
    <button class="btn primary" data-auth="signup">Create account</button>
    <button class="btn" data-auth="login">Sign in</button></div>`;
}

function renderProgressCard() {
  const sessions = core.loadSessions();
  const card = $("progress-card");
  card.classList.toggle("hidden", !sessions.length);
  if (!sessions.length) return;
  if (!core.account.user) {
    card.innerHTML = signInGate("track your progress");
    return;
  }
  const goal = core.getGoal();
  const last = sessions.at(-1);
  const comparable = sessions.filter((s) => s.sport === last.sport && s.stroke === last.stroke && s.view === last.view);
  const n = core.streak();
  let left = `<h2>Your progress</h2><p class="hint">${sessions.length} session${sessions.length > 1 ? "s" : ""}${n ? ` · ${n}-day streak` : ""}</p>`;
  if (goal) {
    const series = comparable.map((s) => s.similarity[goal.pro_id]).filter((v) => v != null);
    const d = series.length > 1 ? series.at(-1) - series[0] : null;
    left += `<div class="goal-row"><div><div class="eyebrow">Goal pro</div><strong>${esc(goal.name)}</strong></div>
      <span class="big">${series.at(-1) ?? "–"}%</span></div>
      ${d == null ? `<p class="hint">Analyze again to see your trend.</p>` : `<div class="delta ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d} since your first session</div>`}
      ${core.sparkSVG(series, { label: "Match to goal pro over time" })}`;
  } else {
    left += `<p class="hint">Pick a goal pro from a result to track how close you're getting.</p>`;
  }
  const labels = last.labels || {};
  const keys = ["leg_drive", "knee_flex", "contact_height", "separation"].filter((k) => k in last.features);
  const right = `<div>${keys.map((k) => {
    const series = comparable.map((s) => s.features[k]).filter((v) => v != null);
    const d = series.length > 1 ? series.at(-1) - series[0] : null;
    return `<div class="metric"><span>${esc(labels[k] || k)}</span><span class="val">${fmt(series.at(-1))}</span>
      <span class="sub">${d == null ? "First measurement" : `${d >= 0 ? "+" : ""}${fmt(d)} since first session`}</span></div>`;
  }).join("")}</div>`;
  card.innerHTML = `<div class="progress-grid"><div>${left}</div>${right}</div>`;
}

function renderPlan() {
  if (!core.account.user) {
    $("plan-count").textContent = "";
    $("plan-body").innerHTML = signInGate("get a weekly plan");
    return;
  }
  const plan = analysisSaved ? core.loadPlan() : null;
  if (!plan) {
    $("plan-count").textContent = "";
    $("plan-body").innerHTML = `<p class="hint">Analyze your own clip to get a weekly plan built from your biggest gaps.</p>`;
    return;
  }
  const { done, total } = core.planProgress(plan);
  $("plan-count").textContent = `${done}/${total} done`;
  $("plan-body").innerHTML = `
    <p class="hint">Training toward ${esc(plan.goal)}. Three sessions, then film a re-test.</p>
    <div class="meter"><div style="width:${total ? (100 * done) / total : 0}%"></div></div>
    ${plan.sessions.map((s, si) => `<div class="plan-session"><h3>${esc(s.title)}</h3>
      ${s.drills.map((d, di) => `<label class="check ${d.done ? "done" : ""}">
        <input type="checkbox" data-s="${si}" data-d="${di}" ${d.done ? "checked" : ""}>
        <div><b>${esc(d.name)}</b><span>${esc(d.how)}</span></div></label>`).join("")}</div>`).join("")}
    <p class="hint" style="margin-top:12px">${esc(plan.retest)}</p>`;
}

$("plan-body").addEventListener("change", (e) => {
  const box = e.target.closest("input[type=checkbox]");
  if (!box) return;
  core.toggleDrill(core.loadPlan(), +box.dataset.s, +box.dataset.d);
  renderPlan();
  renderProgressCard();
});

const SUGGESTIONS = ["What should I practice today?", "How do I get more leg drive?", "Why am I not matching my goal pro?"];

function renderCoach() {
  const msgs = core.loadChat();
  $("chat").innerHTML = [{ role: "assistant", content: "I've seen this serve. What would you like to work on?" }, ...msgs]
    .map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join("");
  $("chat").scrollTop = $("chat").scrollHeight;
  $("suggest").innerHTML = SUGGESTIONS.map((q) => `<button type="button">${esc(q)}</button>`).join("");
}

async function sendQuestion(q) {
  if (!q || !analysis) return;
  const history = core.loadChat();
  core.saveChat([...history, { role: "user", content: q }]);
  $("question").value = "";
  renderCoach();
  $("chat").insertAdjacentHTML("beforeend", `<div class="msg assistant pending">Thinking…</div>`);
  $("chat").scrollTop = $("chat").scrollHeight;
  try {
    const { answer } = await core.ask(q, analysis, history);
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

// ---------- account ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

let authMode = "login";

function updateAccountButton() {
  const u = core.account.user;
  const b = $("account-btn");
  b.textContent = u ? (u.name || u.email)[0].toUpperCase() : "Sign in";
  b.classList.toggle("avatar", !!u);
  b.title = u ? `${u.name} (${u.email})` : "Sign in";
}

function openAuth(mode) {
  if (mode) authMode = mode;
  const u = core.account.user;
  if (u) {
    $("auth-body").innerHTML = `<h2>${esc(u.name)}</h2><p class="hint">${esc(u.email)} · ${plural(core.loadSessions().length, "session")} saved</p>
      <div class="row"><button class="btn" id="sign-out">Sign out</button><button class="text-btn" id="auth-close">Close</button></div>`;
    $("sign-out").addEventListener("click", async () => {
      await core.signOut();
      $("auth-dialog").close();
      refreshAccountViews();
    });
  } else {
    const signup = authMode === "signup";
    $("auth-body").innerHTML = `<h2>${signup ? "Create your account" : "Sign in"}</h2>
      <p class="hint">${signup ? "Save every session, track your goal pro and keep your plan on any device." : "Pick up where you left off."}</p>
      <form id="auth-form">
        ${signup ? `<label>Name<input name="name" autocomplete="name" required></label>` : ""}
        <label>Email<input name="email" type="email" autocomplete="email" required></label>
        <label>Password<input name="password" type="password" minlength="8" autocomplete="${signup ? "new-password" : "current-password"}" required></label>
        <p class="err" id="auth-err"></p>
        <button class="btn primary" type="submit">${signup ? "Create account" : "Sign in"}</button>
      </form>
      <div class="row"><span>${signup ? "Have an account?" : "New here?"}
        <button class="text-btn" id="switch-mode">${signup ? "Sign in" : "Create one"}</button></span>
        <button class="text-btn" id="auth-close">Close</button></div>`;
    $("switch-mode").addEventListener("click", () => openAuth(signup ? "login" : "signup"));
    $("auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await core.signIn(authMode, Object.fromEntries(new FormData(e.target)));
        $("auth-dialog").close();
        refreshAccountViews();
      } catch (err) {
        $("auth-err").textContent = err.message;
        btn.disabled = false;
      }
    });
  }
  $("auth-close").addEventListener("click", () => $("auth-dialog").close());
  if (!$("auth-dialog").open) $("auth-dialog").showModal();
}

function refreshAccountViews() {
  updateAccountButton();
  renderProgressCard();
  if (analysis) {
    renderPlan();
    renderResults();
  }
}

$("account-btn").addEventListener("click", () => openAuth());
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-auth]");
  if (b) openAuth(b.dataset.auth);
});

renderProgressCard();
core.initAccount().then(refreshAccountViews);
