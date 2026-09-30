import {
  FilesetResolver,
  GestureRecognizer,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

// --- Tunables ---------------------------------------------------------------

const HOLD_MS = 3000;          // how long a gesture must be held to count
const MIN_SCORE = 0.6;         // minimum model confidence for a thumb gesture
const GRACE_MS = 250;          // tolerate brief detection drop-outs while holding
const RESULT_MS = 4000;        // how long the result card is shown
const HAND_GONE_MS = 1000;     // hand must be out of view this long before the next vote
const POLL_MS = 3000;          // how often to check for a new statement
const STAR_HIT_PADDING = 40;   // px around each star that still counts as pointing at it
const SMOOTHING = 0.5;         // 0 = raw fingertip, closer to 1 = steadier but laggier cursor

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

const GESTURES = {
  Thumb_Up: { answer: "agree", emoji: "👍", label: "Agree" },
  Thumb_Down: { answer: "disagree", emoji: "👎", label: "Disagree" },
};

// Hand landmark indices (https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
const WRIST = 0;
const INDEX_PIP = 6;
const INDEX_TIP = 8;

const STAR_PATH =
  "M12 2.6l2.83 5.9 6.47.78-4.77 4.46 1.23 6.43L12 17.02l-5.76 3.15 1.23-6.43L2.7 9.28l6.47-.78z";

// --- Elements ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("overlay");
const ctx = canvas.getContext("2d");
const drawing = new DrawingUtils(ctx);
const els = {
  eyebrow: $("eyebrow"),
  statement: $("statement"),
  status: $("status"),
  camera: $("camera"),
  notice: $("notice"),
  noticeText: $("noticeText"),
  startBtn: $("startBtn"),
  ringWrap: $("ringWrap"),
  ringFill: $("ringFill"),
  ringEmoji: $("ringEmoji"),
  ringCount: $("ringCount"),
  stars: $("stars"),
  starRow: $("starRow"),
  starLabel: $("starLabel"),
  cursor: $("cursor"),
  cursorFill: $("cursorFill"),
  cursorCount: $("cursorCount"),
  result: $("result"),
  resultTitle: $("resultTitle"),
  resultAverage: $("resultAverage"),
  resultBars: $("resultBars"),
  resultTotal: $("resultTotal"),
};

const RING_LENGTH = 2 * Math.PI * 52;
const CURSOR_LENGTH = 2 * Math.PI * 24;
els.ringFill.style.strokeDasharray = RING_LENGTH;
els.cursorFill.style.strokeDasharray = CURSOR_LENGTH;

const starEls = [1, 2, 3, 4, 5].map((n) => {
  const el = document.createElement("div");
  el.className = "star";
  el.dataset.value = n;
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;
  els.starRow.append(el);
  return el;
});

// --- State ------------------------------------------------------------------

let recognizer;
let statement = null;           // { id, text, mode }
let state = "idle";             // idle | holding | saving | result | cooldown
let holdKey = null;             // what is being held: a gesture name or a star number
let holdStart = 0;
let lastKeySeen = 0;
let lastHandSeen = 0;
let lastVideoTime = -1;
let cursorPos = null;           // smoothed fingertip position in camera-box pixels

// --- Variants ---------------------------------------------------------------
//
// Both variants share the same hold → save → result → cooldown flow. A variant
// only decides what the student is "holding" in a frame (read), how to show
// the hold (render/clear), and what to send to the server (payload).

const variants = {
  thumbs: {
    eyebrow: "Do you agree?",
    idleText: "Show 👍 to agree or 👎 to disagree, and hold it for 3 seconds",

    read(result) {
      const top = result.gestures[0]?.[0];
      return top && GESTURES[top.categoryName] && top.score >= MIN_SCORE ? top.categoryName : null;
    },

    render(key, progress) {
      const g = GESTURES[key];
      els.ringWrap.hidden = false;
      els.ringWrap.dataset.answer = g.answer;
      els.ringEmoji.textContent = g.emoji;
      els.ringFill.style.strokeDashoffset = RING_LENGTH * (1 - progress);
      els.ringCount.textContent = secondsLeft(progress);
      setStatus(`Hold ${g.emoji} to ${g.label.toLowerCase()}…`);
    },

    clear() {
      els.ringWrap.hidden = true;
    },

    payload: (key) => ({ answer: GESTURES[key].answer }),
  },

  stars: {
    eyebrow: "How would you rate this?",
    idleText: "Point your index finger at a star and hold it for 3 seconds",

    read(result) {
      const hand = result.landmarks[0];
      if (!hand || !indexExtended(hand)) {
        cursorPos = null;
        els.cursor.hidden = true;
        return null;
      }
      const raw = toCameraBox(hand[INDEX_TIP]);
      cursorPos = cursorPos
        ? { x: cursorPos.x + (raw.x - cursorPos.x) * (1 - SMOOTHING), y: cursorPos.y + (raw.y - cursorPos.y) * (1 - SMOOTHING) }
        : raw;
      if (state === "idle" || state === "holding") {
        els.cursor.hidden = false;
        els.cursor.style.transform = `translate(${cursorPos.x}px, ${cursorPos.y}px)`;
      }
      return starAt(cursorPos);
    },

    render(key, progress) {
      paintStars(key);
      els.cursor.classList.add("active");
      els.cursorFill.style.strokeDashoffset = CURSOR_LENGTH * (1 - progress);
      els.cursorCount.textContent = secondsLeft(progress);
      els.starLabel.textContent = `${key} of 5 stars`;
      setStatus(`Hold to give ${key} ${key === 1 ? "star" : "stars"}…`);
    },

    clear() {
      paintStars(0);
      els.cursor.classList.remove("active");
      els.cursorFill.style.strokeDashoffset = CURSOR_LENGTH;
      els.cursorCount.textContent = "";
      els.starLabel.textContent = "Point at a star";
    },

    payload: (key) => ({ rating: key }),
  },
};

const variant = () => variants[statement?.mode] ?? variants.thumbs;

function applyMode() {
  const mode = statement?.mode === "stars" ? "stars" : "thumbs";
  document.body.dataset.mode = mode;
  els.stars.hidden = mode !== "stars";
  els.cursor.hidden = true;
  els.eyebrow.textContent = variant().eyebrow;
  variants.thumbs.clear();
  variants.stars.clear();
}

// --- Stars helpers ----------------------------------------------------------

/** Index finger counts as pointing when its tip is farther from the wrist than its middle joint. */
function indexExtended(hand) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return d(hand[INDEX_TIP], hand[WRIST]) > d(hand[INDEX_PIP], hand[WRIST]) * 1.1;
}

/**
 * Convert a normalized landmark to pixels inside the camera box, taking the
 * mirrored, object-fit: cover video into account so it lines up with the image.
 */
function toCameraBox(lm) {
  const box = els.camera.getBoundingClientRect();
  const scale = Math.max(box.width / video.videoWidth, box.height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  return {
    x: (1 - lm.x) * w - (w - box.width) / 2,
    y: lm.y * h - (h - box.height) / 2,
  };
}

function starAt(pos) {
  const box = els.camera.getBoundingClientRect();
  for (const el of starEls) {
    const r = el.getBoundingClientRect();
    const left = r.left - box.left - STAR_HIT_PADDING;
    const right = r.right - box.left + STAR_HIT_PADDING;
    const top = r.top - box.top - STAR_HIT_PADDING;
    const bottom = r.bottom - box.top + STAR_HIT_PADDING;
    if (pos.x >= left && pos.x <= right && pos.y >= top && pos.y <= bottom) {
      return Number(el.dataset.value);
    }
  }
  return null;
}

function paintStars(value) {
  starEls.forEach((el, i) => {
    el.classList.toggle("filled", i < value);
    el.classList.toggle("target", i === value - 1);
  });
}

// --- Statement --------------------------------------------------------------

async function loadStatement() {
  try {
    const res = await fetch("/api/statement", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    const next = await res.json();
    if (!statement || next.id !== statement.id) {
      const modeChanged = next.mode !== statement?.mode;
      statement = next;
      els.statement.textContent = next.text;
      if (modeChanged) applyMode();
      // A new statement mid-hold should not inherit the old gesture.
      if (state === "holding" || state === "idle") resetToIdle();
    }
  } catch (err) {
    console.warn("Could not load statement:", err);
    if (!statement) els.statement.textContent = "Cannot reach the server…";
  }
}

// --- Camera & model ---------------------------------------------------------

async function initRecognizer() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
  });
  try {
    return await GestureRecognizer.createFromOptions(fileset, opts("GPU"));
  } catch (err) {
    console.warn("GPU delegate failed, falling back to CPU:", err);
    return await GestureRecognizer.createFromOptions(fileset, opts("CPU"));
  }
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

function showNotice(text, { button = false } = {}) {
  els.noticeText.textContent = text;
  els.startBtn.hidden = !button;
  els.notice.hidden = false;
}

async function boot() {
  await loadStatement();
  setInterval(loadStatement, POLL_MS);

  if (!navigator.mediaDevices?.getUserMedia) {
    showNotice("This browser cannot access the camera. Open the page via http://localhost or HTTPS.");
    return;
  }

  try {
    showNotice("Loading hand tracking…");
    recognizer = await initRecognizer();
  } catch (err) {
    console.error(err);
    showNotice("Could not load hand tracking. Check the internet connection and reload.");
    return;
  }

  try {
    showNotice("Starting camera…");
    await startCamera();
  } catch (err) {
    console.error(err);
    // Some browsers require a user gesture before the camera may start.
    showNotice("Camera access is needed to give feedback.", { button: true });
    return;
  }

  els.notice.hidden = true;
  requestAnimationFrame(loop);
}

els.startBtn.addEventListener("click", async () => {
  try {
    await startCamera();
    els.notice.hidden = true;
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    showNotice("Camera access was denied. Allow it in the browser settings and reload.", { button: true });
  }
});

// --- Main loop --------------------------------------------------------------

function loop() {
  requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const now = performance.now();
  const result = recognizer.recognizeForVideo(video, now);

  drawHand(result);

  const handVisible = result.landmarks.length > 0;
  if (handVisible) lastHandSeen = now;

  tick(variant().read(result), handVisible, now);
}

function drawHand(result) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const landmarks of result.landmarks) {
    drawing.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, {
      color: "rgba(255,255,255,0.85)",
      lineWidth: 4,
    });
    drawing.drawLandmarks(landmarks, { color: "#6d5efc", lineWidth: 2, radius: 4 });
  }
}

function tick(key, handVisible, now) {
  switch (state) {
    case "idle":
      if (key) startHold(key, now);
      break;

    case "holding": {
      if (key === holdKey) {
        lastKeySeen = now;
      } else if (key) {
        // Switched thumbs or moved to another star: start over.
        startHold(key, now);
        return;
      } else if (now - lastKeySeen > GRACE_MS) {
        resetToIdle();
        return;
      }
      const progress = Math.min((now - holdStart) / HOLD_MS, 1);
      variant().render(holdKey, progress);
      if (progress >= 1) submitVote(variant().payload(holdKey));
      break;
    }

    case "cooldown":
      if (!handVisible && now - lastHandSeen > HAND_GONE_MS) resetToIdle();
      break;

    // "saving" and "result" are driven by timers, not frames.
  }
}

function startHold(key, now) {
  state = "holding";
  holdKey = key;
  holdStart = now;
  lastKeySeen = now;
  variant().render(key, 0);
}

function secondsLeft(progress) {
  return Math.max(1, Math.ceil((HOLD_MS * (1 - progress)) / 1000));
}

function resetToIdle() {
  state = "idle";
  holdKey = null;
  variant().clear();
  els.result.hidden = true;
  els.camera.classList.remove("dimmed");
  setStatus(variant().idleText);
}

function setStatus(text) {
  if (els.status.textContent !== text) els.status.textContent = text;
}

// --- Voting -----------------------------------------------------------------

async function submitVote(payload) {
  state = "saving";
  els.ringWrap.hidden = true;
  els.cursor.hidden = true;
  setStatus("Saving…");

  let results;
  try {
    const res = await fetch("/api/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statementId: statement?.id, ...payload }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    results = await res.json();
  } catch (err) {
    console.error("Vote failed:", err);
    variant().clear();
    setStatus("⚠️ Your answer could not be saved. Lower your hand and try again.");
    state = "cooldown";
    return;
  }

  showResult(payload, results);
  state = "result";
  setTimeout(() => {
    els.result.hidden = true;
    els.camera.classList.remove("dimmed");
    variant().clear();
    state = "cooldown";
    setStatus("Please lower your hand so the next student can answer");
  }, RESULT_MS);
}

function showResult(payload, r) {
  let rows;
  if (r.mode === "stars") {
    els.result.dataset.answer = "stars";
    els.resultTitle.textContent = `${"★".repeat(payload.rating)}${"☆".repeat(5 - payload.rating)} recorded ✓`;
    els.resultAverage.hidden = false;
    els.resultAverage.textContent = `Average ${r.average.toFixed(1)} ★`;
    rows = [5, 4, 3, 2, 1].map((n) => ({ label: `${n} ★`, pct: r.pct[n], cls: "star" }));
  } else {
    els.result.dataset.answer = payload.answer;
    els.resultTitle.textContent = payload.answer === "agree" ? "👍 Agree recorded ✓" : "👎 Disagree recorded ✓";
    els.resultAverage.hidden = true;
    rows = [
      { label: "👍 Agree", pct: r.agreePct, cls: "agree" },
      { label: "👎 Disagree", pct: r.disagreePct, cls: "disagree" },
    ];
  }

  const rowEls = rows.map(({ label, pct, cls }) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `<span class="bar-label"></span><div class="bar"><div class="bar-fill ${cls}"></div></div><span class="bar-pct"></span>`;
    row.querySelector(".bar-label").textContent = label;
    row.querySelector(".bar-pct").textContent = `${pct}%`;
    return row;
  });
  els.resultBars.replaceChildren(...rowEls);
  const fills = rowEls.map((row, i) => [row.querySelector(".bar-fill"), rows[i].pct]);

  els.resultTotal.textContent = `${r.total} ${r.total === 1 ? "response" : "responses"} so far`;
  els.result.hidden = false;
  els.camera.classList.add("dimmed");
  // Bars start at 0 and animate to their value on the next frame.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => fills.forEach(([fill, pct]) => (fill.style.width = `${pct}%`)))
  );
  setStatus("Thank you for your feedback!");
}

boot();
