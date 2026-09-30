const $ = (id) => document.getElementById(id);
const REFRESH_MS = 3000;

let password = null;
let refreshTimer = null;

try { password = sessionStorage.getItem("adminPassword"); } catch {}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "x-admin-password": password ?? "", ...options.headers },
    cache: "no-store",
  });
  if (res.status === 401) {
    logout("Wrong password.");
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res;
}

function setMsg(el, text, kind = "") {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

// --- Auth -------------------------------------------------------------------

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  password = $("password").value;
  try {
    await api("/api/history"); // cheap auth check
    try { sessionStorage.setItem("adminPassword", password); } catch {}
    showDashboard();
  } catch (err) {
    if (err.message !== "unauthorized") setMsg($("loginMsg"), err.message, "error");
  }
});

$("logoutBtn").addEventListener("click", () => logout());

function logout(message = "") {
  password = null;
  try { sessionStorage.removeItem("adminPassword"); } catch {}
  clearInterval(refreshTimer);
  $("dashboard").hidden = true;
  $("loginCard").hidden = false;
  $("password").value = "";
  setMsg($("loginMsg"), message, message ? "error" : "");
}

function showDashboard() {
  $("loginCard").hidden = true;
  $("dashboard").hidden = false;
  refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

// --- Data -------------------------------------------------------------------

const MODE_LABELS = { thumbs: "👍👎 Agree / disagree", stars: "⭐ 1–5 stars", fingers: "✋ 1–5 fingers" };
const isRating = (mode) => mode === "stars" || mode === "fingers";

let current = null; // current statement, used by the switch button

async function refresh() {
  try {
    const [statement, results, history] = await Promise.all([
      api("/api/statement").then((r) => r.json()),
      api("/api/results").then((r) => r.json()),
      api("/api/history").then((r) => r.json()),
    ]);
    current = statement;
    renderCurrent(statement, results);
    renderHistory(history);
  } catch (err) {
    if (err.message !== "unauthorized") console.error(err);
  }
}

function renderCurrent(statement, r) {
  const rating = isRating(statement.mode);
  const unit = statement.mode === "fingers" ? "✋" : "★";
  $("currentText").textContent = `“${statement.text}”`;
  $("currentMode").textContent = MODE_LABELS[statement.mode];
  document.querySelectorAll(".switch-btn").forEach((btn) => (btn.hidden = btn.dataset.mode === statement.mode));
  $("thumbsResults").hidden = rating;
  $("starsResults").hidden = !rating;

  if (rating) {
    $("avgVal").textContent = r.total ? `${r.average.toFixed(1)} / 5` : "–";
    $("ratingsVal").textContent = r.total;
    $("dist").replaceChildren(
      ...[5, 4, 3, 2, 1].map((n) => {
        const row = document.createElement("div");
        row.className = "dist-row";
        row.innerHTML = `<span>${n} ${unit}</span><div class="bar"><div class="bar-fill star"></div></div><span></span>`;
        row.querySelector(".bar-fill").style.width = `${r.pct[n]}%`;
        row.lastElementChild.textContent = `${r.counts[n]} · ${r.pct[n]}%`;
        return row;
      })
    );
    $("pctText").textContent = r.total ? "" : "No ratings yet.";
    return;
  }

  $("agreeVal").textContent = r.agree;
  $("disagreeVal").textContent = r.disagree;
  $("totalVal").textContent = r.total;
  $("agreeSplit").style.width = `${r.total ? r.agreePct : 0}%`;
  $("disagreeSplit").style.width = `${r.total ? r.disagreePct : 0}%`;
  $("pctText").textContent = r.total
    ? `${r.agreePct}% agree · ${r.disagreePct}% disagree`
    : "No responses yet.";
}

function summary({ results: r }) {
  if (!r.total) return "–";
  return isRating(r.mode) ? `${r.average.toFixed(1)} / 5 avg` : `${r.agreePct}% agree`;
}

function renderHistory(rows) {
  const body = $("historyBody");
  body.replaceChildren(
    ...rows.map((s) => {
      const tr = document.createElement("tr");
      const cells = [s.text, MODE_LABELS[s.mode], s.created_at, s.results.total, summary(s)];
      cells.forEach((value, i) => {
        const td = document.createElement("td");
        td.textContent = value;
        if (i >= 3) td.className = "num";
        tr.append(td);
      });
      return tr;
    })
  );
}

async function publish(text, mode) {
  const created = await (await api("/api/statement", { method: "POST", body: JSON.stringify({ text, mode }) })).json();
  refresh();
  // An older server ignores `mode` and silently creates a thumbs statement.
  if (created.mode !== mode) {
    throw new Error("The server did not apply the variant. It is probably running an old version: restart it.");
  }
}

// --- Actions ----------------------------------------------------------------

$("statementForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("newStatement").value.trim();
  if (!text) return;
  try {
    await publish(text, document.querySelector('input[name="mode"]:checked').value);
    $("newStatement").value = "";
    setMsg($("statementMsg"), "Published ✓", "ok");
  } catch (err) {
    if (err.message !== "unauthorized") setMsg($("statementMsg"), err.message, "error");
  }
});

document.querySelectorAll(".switch-btn").forEach((btn) =>
  btn.addEventListener("click", async () => {
    if (!current) return;
    try {
      await publish(current.text, btn.dataset.mode);
    } catch (err) {
      if (err.message !== "unauthorized") alert(`Switch failed: ${err.message}`);
    }
  })
);

$("exportBtn").addEventListener("click", async () => {
  try {
    const blob = await (await api("/api/export.csv")).blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: "feedback-export.csv" });
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    if (err.message !== "unauthorized") alert(`Export failed: ${err.message}`);
  }
});

if (password) showDashboard();
