const $ = (id) => document.getElementById(id);
const REFRESH_MS = 3000;

const VARIANTS = {
  thumbs: { icon: "👍👎", label: "Agree / disagree" },
  stars: { icon: "⭐", label: "1–5 stars" },
  fingers: { icon: "✋", label: "1–5 fingers" },
};
const isRating = (variant) => variant === "stars" || variant === "fingers";
const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

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

function report(err, el) {
  if (err.message === "unauthorized") return;
  if (el) setMsg(el, err.message, "error");
  else alert(err.message);
}

// --- Auth -------------------------------------------------------------------

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  password = $("password").value;
  try {
    await api("/api/questions"); // auth check
    try { sessionStorage.setItem("adminPassword", password); } catch {}
    showDashboard();
  } catch (err) {
    report(err, $("loginMsg"));
  }
});

$("logoutBtn").addEventListener("click", () => logout());

function logout(message = "") {
  password = null;
  try { sessionStorage.removeItem("adminPassword"); } catch {}
  clearInterval(refreshTimer);
  $("dashboard").hidden = true;
  $("logoutBtn").hidden = true;
  $("loginCard").hidden = false;
  $("password").value = "";
  setMsg($("loginMsg"), message, message ? "error" : "");
}

function showDashboard() {
  $("loginCard").hidden = true;
  $("dashboard").hidden = false;
  $("logoutBtn").hidden = false;
  refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

// --- Data -------------------------------------------------------------------

let activeVariant = null;
let questions = [];          // [{ id, text, variants, created_at, results: { [variant]: results } }]
let refreshSeq = 0;          // a newer refresh or a variant switch makes older responses stale
const editing = new Set();   // question ids with an open edit form; refreshes leave those alone
const expanded = new Set();  // question ids whose answers are shown
const answers = new Map();   // question id → { total, rows } for expanded questions
const rendered = new Map();  // question id → { el, key, total }, so unchanged questions keep their element

const totalOf = (q) => Object.values(q.results).reduce((n, r) => n + r.total, 0);

async function refresh() {
  const seq = ++refreshSeq;
  try {
    const [{ variant }, list] = await Promise.all([
      api("/api/variant").then((r) => r.json()),
      api("/api/questions").then((r) => r.json()),
    ]);
    // Only refetch the answer lists that have new answers.
    await Promise.all(
      list.filter((q) => expanded.has(q.id) && answers.get(q.id)?.total !== totalOf(q)).map(loadAnswers)
    );
    if (seq !== refreshSeq) return;
    const firstLoad = activeVariant === null;
    activeVariant = variant;
    questions = list;
    // New questions start out in the variant the kiosk is running.
    if (firstLoad) $("newVariants").replaceChildren(variantPicker([variant]));
    render();
  } catch (err) {
    if (err.message !== "unauthorized") console.error(err);
  }
}

async function loadAnswers(q) {
  const rows = await (await api(`/api/questions/${q.id}/answers`)).json();
  answers.set(q.id, { total: totalOf(q), rows });
}

// --- Rendering --------------------------------------------------------------

function render() {
  renderSwitch();
  renderQuestions();
}

function renderSwitch() {
  const count = (variant) => questions.filter((q) => q.variants.includes(variant)).length;
  document.querySelectorAll("#variantSwitch button").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.variant === activeVariant);
    btn.querySelector(".v-count").textContent = plural(count(btn.dataset.variant), "question");
  });

  const n = count(activeVariant);
  const { icon, label } = VARIANTS[activeVariant];
  if (n) {
    setMsg(
      $("variantMsg"),
      n === 1
        ? `The kiosk asks the one question marked “On kiosk” below, with ${icon} ${label}.`
        : `The kiosk asks the ${n} questions marked “On kiosk” below with ${icon} ${label}, one at a time in random order.`
    );
  } else {
    setMsg($("variantMsg"), `No question is assigned to ${icon} ${label}, so the kiosk has nothing to ask. Tick ${icon} on a question below.`, "error");
  }
}

function renderQuestions() {
  $("questionCount").textContent = questions.length || "";
  $("emptyMsg").hidden = questions.length > 0;

  const ids = new Set(questions.map((q) => q.id));
  for (const id of rendered.keys()) {
    if (!ids.has(id)) [rendered, editing, expanded, answers].forEach((m) => m.delete(id));
  }

  const els = questions.map((q) => {
    const edit = editing.has(q.id);
    const key = edit ? "edit" : JSON.stringify([q, activeVariant, expanded.has(q.id) && answers.get(q.id)?.rows]);
    const prev = rendered.get(q.id);
    if (prev?.key === key) return prev.el;

    const total = totalOf(q);
    const el = edit ? editEl(q) : questionEl(q);
    if (!edit && prev && total > prev.total) el.classList.add("flash"); // a new answer came in
    rendered.set(q.id, { el, key, total });
    return el;
  });
  placeChildren($("questionList"), els);
}

/** Put `els` in `parent` in order, moving only what has to move, so an open edit form keeps its focus. */
function placeChildren(parent, els) {
  const keep = new Set(els);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  els.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
}

function questionEl(q) {
  const li = document.createElement("li");
  li.className = "question";
  li.dataset.id = q.id;
  li.innerHTML = `
    <div class="q-top">
      <p class="q-text"></p>
      <div class="q-actions">
        <button type="button" class="secondary small" data-action="edit">Edit</button>
        <button type="button" class="danger small" data-action="delete">Delete</button>
      </div>
    </div>
    <p class="q-meta"></p>
    <div class="q-results"></div>`;
  li.querySelector(".q-text").textContent = q.text;

  const live = q.variants.includes(activeVariant);
  li.classList.toggle("live", live);
  const meta = li.querySelector(".q-meta");
  const added = new Date(q.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (live) meta.append(Object.assign(document.createElement("span"), { className: "live-tag", textContent: "On kiosk" }));
  meta.append(
    q.variants.length ? `Added ${added}` : `Added ${added} · Not assigned to a variant, so the kiosk never shows it`
  );

  li.querySelector(".q-results").append(
    ...Object.entries(q.results).map(([variant, r]) => resultRow(variant, r, q.variants.includes(variant)))
  );

  const total = totalOf(q);
  if (!total) return li;
  const open = expanded.has(q.id);
  const toggle = Object.assign(document.createElement("button"), {
    type: "button",
    className: "link",
    textContent: `${open ? "Hide" : "Show"} ${plural(total, "answer")}`,
  });
  toggle.dataset.action = "toggle";
  toggle.setAttribute("aria-expanded", open);
  li.append(toggle);
  if (open) li.append(answersEl(q));
  return li;
}

/** One line per variant: a bar and the headline number. */
function resultRow(variant, r, assigned) {
  const row = document.createElement("div");
  row.className = "q-result";
  if (!assigned) {
    row.classList.add("off");
    row.title = "No longer asked with this variant. Its answers are kept.";
  }
  const { icon, label } = VARIANTS[variant];
  row.innerHTML = isRating(variant)
    ? `<span class="q-icon"></span><div class="bar"><div class="bar-fill star"></div></div><span class="q-num"></span>`
    : `<span class="q-icon"></span><div class="split-bar"><div class="agree"></div><div class="disagree"></div></div><span class="q-num"></span>`;
  row.querySelector(".q-icon").textContent = icon;
  row.querySelector(".q-icon").title = label;

  let text;
  if (isRating(variant)) {
    row.querySelector(".bar-fill").style.width = `${(r.average / 5) * 100}%`;
    text = r.total ? `${r.average.toFixed(1)} / 5 avg · ${plural(r.total, "answer")}` : "No answers yet";
  } else {
    row.querySelector(".agree").style.width = `${r.agreePct}%`;
    row.querySelector(".disagree").style.width = `${r.total ? r.disagreePct : 0}%`;
    text = r.total ? `${r.agreePct}% agree · ${plural(r.total, "answer")}` : "No answers yet";
  }
  row.querySelector(".q-num").textContent = assigned ? text : `${text} (not asked anymore)`;
  return row;
}

/** The breakdown per variant and every single answer, newest first. */
function answersEl(q) {
  const box = document.createElement("div");
  box.className = "q-answers";

  const dists = document.createElement("div");
  dists.className = "q-dists";
  for (const [variant, r] of Object.entries(q.results)) {
    if (!r.total) continue;
    const rows = isRating(variant)
      ? [5, 4, 3, 2, 1].map((n) => [`${n} ${variant === "fingers" ? "✋" : "★"}`, r.counts[n], r.pct[n], "star"])
      : [["👍 Agree", r.agree, r.agreePct, "agree"], ["👎 Disagree", r.disagree, r.disagreePct, "disagree"]];
    const block = document.createElement("div");
    const title = Object.assign(document.createElement("h3"), { textContent: `${VARIANTS[variant].icon} ${VARIANTS[variant].label}` });
    const dist = document.createElement("div");
    dist.className = "dist";
    dist.append(
      ...rows.map(([label, n, pct, cls]) => {
        const row = document.createElement("div");
        row.className = "dist-row";
        row.innerHTML = `<span></span><div class="bar"><div class="bar-fill ${cls}"></div></div><span></span>`;
        row.firstElementChild.textContent = label;
        row.querySelector(".bar-fill").style.width = `${pct}%`;
        row.lastElementChild.textContent = `${n} · ${pct}%`;
        return row;
      })
    );
    block.append(title, dist);
    dists.append(block);
  }

  const list = document.createElement("ol");
  list.className = "answer-list";
  list.append(
    ...(answers.get(q.id)?.rows ?? []).map((a) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="a-value"></span><time></time>`;
      li.querySelector(".a-value").textContent = answerText(a);
      li.title = VARIANTS[a.variant].label;
      const time = li.querySelector("time");
      time.dateTime = a.created_at;
      time.textContent = new Date(a.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      return li;
    })
  );

  box.append(dists, list);
  return box;
}

function answerText(a) {
  if (a.variant === "thumbs") return a.answer === "agree" ? "👍 Agree" : "👎 Disagree";
  if (a.variant === "stars") return `${"★".repeat(a.rating)}${"☆".repeat(5 - a.rating)}  ${a.rating} of 5 stars`;
  return `✋ ${a.rating} of 5 fingers`;
}

function editEl(q) {
  const li = document.createElement("li");
  li.className = "question editing";
  li.dataset.id = q.id;
  li.innerHTML = `
    <form class="q-form">
      <textarea maxlength="300" required aria-label="Question"></textarea>
      <div class="q-form-foot">
        <div class="q-picks"></div>
        <div class="row">
          <button type="button" class="secondary" data-action="cancel">Cancel</button>
          <button type="submit">Save</button>
        </div>
      </div>
      <p class="msg">Answers stay with the question when you change it.</p>
    </form>`;
  li.querySelector("textarea").value = q.text;
  li.querySelector(".q-picks").append(variantPicker(q.variants));
  return li;
}

let pickerCount = 0;

/** Checkboxes for the variants a question is asked in. */
function variantPicker(selected) {
  const box = document.createElement("div");
  box.className = "variant-picks";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Variants");
  for (const [variant, { icon, label }] of Object.entries(VARIANTS)) {
    const id = `pick${++pickerCount}`;
    const input = Object.assign(document.createElement("input"), {
      type: "checkbox", id, value: variant, checked: selected.includes(variant),
    });
    const lab = Object.assign(document.createElement("label"), { htmlFor: id, textContent: `${icon} ${label}` });
    box.append(input, lab);
  }
  return box;
}

const pickedVariants = (root) => [...root.querySelectorAll(".variant-picks input:checked")].map((i) => i.value);

// --- Actions ----------------------------------------------------------------

document.querySelectorAll("#variantSwitch button").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const variant = btn.dataset.variant;
    if (!activeVariant || variant === activeVariant) return;
    const previous = activeVariant;
    refreshSeq++; // ignore a refresh that is still on its way with the old variant
    activeVariant = variant;
    render();
    try {
      await api("/api/variant", { method: "PUT", body: JSON.stringify({ variant }) });
    } catch (err) {
      activeVariant = previous;
      render();
      report(err, $("variantMsg"));
    }
  })
);

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("newText").value.trim();
  if (!text) return;
  const variants = pickedVariants($("addForm"));
  try {
    await api("/api/questions", { method: "POST", body: JSON.stringify({ text, variants }) });
    $("newText").value = "";
    setMsg($("addMsg"), variants.length ? "Added ✓" : "Added ✓ Tick a variant on it to put it on the kiosk.", "ok");
    refresh();
  } catch (err) {
    report(err, $("addMsg"));
  }
});

// ⌘/Ctrl + Enter saves a question.
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.closest(".q-form")) {
    e.preventDefault();
    e.target.closest("form").requestSubmit();
  }
});

$("questionList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.closest(".question").dataset.id);
  const q = questions.find((q) => q.id === id);
  if (!q) return;

  switch (btn.dataset.action) {
    case "edit": {
      editing.add(id);
      render();
      const textarea = rendered.get(id).el.querySelector("textarea");
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      break;
    }

    case "cancel":
      editing.delete(id);
      render();
      rendered.get(id)?.el.querySelector('[data-action="edit"]').focus();
      break;

    case "delete": {
      const total = totalOf(q);
      const lost = total ? ` and its ${plural(total, "answer")}` : "";
      if (!confirm(`Delete “${q.text}”${lost}? This cannot be undone.`)) return;
      try {
        await api(`/api/questions/${id}`, { method: "DELETE" });
        questions = questions.filter((other) => other.id !== id);
        render();
        refresh();
      } catch (err) {
        report(err);
      }
      break;
    }

    case "toggle":
      if (expanded.has(id)) {
        expanded.delete(id);
      } else {
        try {
          await loadAnswers(q);
          expanded.add(id);
        } catch (err) {
          return report(err);
        }
      }
      render();
      rendered.get(id)?.el.querySelector('[data-action="toggle"]').focus();
      break;
  }
});

$("questionList").addEventListener("submit", async (e) => {
  e.preventDefault();
  const li = e.target.closest(".question");
  const id = Number(li.dataset.id);
  const text = li.querySelector("textarea").value.trim();
  if (!text) return;
  const msg = li.querySelector(".msg");
  try {
    const saved = await (
      await api(`/api/questions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ text, variants: pickedVariants(li) }),
      })
    ).json();
    questions = questions.map((q) => (q.id === id ? saved : q));
    editing.delete(id);
    render();
    refresh();
  } catch (err) {
    report(err, msg);
  }
});

$("exportBtn").addEventListener("click", async () => {
  try {
    const blob = await (await api("/api/export.csv")).blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: "feedback-export.csv" });
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    report(err);
  }
});

if (password) showDashboard();
