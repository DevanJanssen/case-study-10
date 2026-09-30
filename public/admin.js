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

async function refresh() {
  try {
    const [statement, results, history] = await Promise.all([
      api("/api/statement").then((r) => r.json()),
      api("/api/results").then((r) => r.json()),
      api("/api/history").then((r) => r.json()),
    ]);
    renderCurrent(statement, results);
    renderHistory(history);
  } catch (err) {
    if (err.message !== "unauthorized") console.error(err);
  }
}

function renderCurrent(statement, r) {
  $("currentText").textContent = `“${statement.text}”`;
  $("agreeVal").textContent = r.agree;
  $("disagreeVal").textContent = r.disagree;
  $("totalVal").textContent = r.total;
  $("agreeSplit").style.width = `${r.total ? r.agreePct : 0}%`;
  $("disagreeSplit").style.width = `${r.total ? r.disagreePct : 0}%`;
  $("pctText").textContent = r.total
    ? `${r.agreePct}% agree · ${r.disagreePct}% disagree`
    : "No responses yet.";
}

function renderHistory(rows) {
  const body = $("historyBody");
  body.replaceChildren(
    ...rows.map((s) => {
      const total = s.agree + s.disagree;
      const tr = document.createElement("tr");
      const cells = [
        s.text,
        s.created_at,
        s.agree,
        s.disagree,
        total ? `${Math.round((s.agree / total) * 100)}%` : "–",
      ];
      cells.forEach((value, i) => {
        const td = document.createElement("td");
        td.textContent = value;
        if (i >= 2) td.className = "num";
        tr.append(td);
      });
      return tr;
    })
  );
}

// --- Actions ----------------------------------------------------------------

$("statementForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("newStatement").value.trim();
  if (!text) return;
  try {
    await api("/api/statement", { method: "POST", body: JSON.stringify({ text }) });
    $("newStatement").value = "";
    setMsg($("statementMsg"), "Published ✓", "ok");
    refresh();
  } catch (err) {
    if (err.message !== "unauthorized") setMsg($("statementMsg"), err.message, "error");
  }
});

$("exportBtn").addEventListener("click", async () => {
  try {
    const blob = await (await api("/api/export.csv")).blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: "feedback-votes.csv" });
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    if (err.message !== "unauthorized") alert(`Export failed: ${err.message}`);
  }
});

if (password) showDashboard();
