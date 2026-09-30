import {
  FilesetResolver,
  GestureRecognizer,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

// --- Tunables ---------------------------------------------------------------

const HOLD_MS = 3000;          // how long a gesture must be held to count
const MIN_SCORE = 0.7;         // minimum model confidence for a thumb gesture
const GRACE_MS = 250;          // tolerate brief detection drop-outs while holding
const RESULT_MS = 4000;        // how long the result card is shown
const HAND_GONE_MS = 1000;     // hand must be out of view this long before the next vote
const POLL_MS = 5000;          // how often to check for a new statement

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

const GESTURES = {
  Thumb_Up: { answer: "agree", emoji: "👍", label: "Agree" },
  Thumb_Down: { answer: "disagree", emoji: "👎", label: "Disagree" },
};

// --- Elements ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("overlay");
const ctx = canvas.getContext("2d");
const drawing = new DrawingUtils(ctx);
const els = {
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
  result: $("result"),
  resultTitle: $("resultTitle"),
  resultTotal: $("resultTotal"),
  agreeBar: $("agreeBar"),
  disagreeBar: $("disagreeBar"),
  agreePct: $("agreePct"),
  disagreePct: $("disagreePct"),
};

const RING_LENGTH = 2 * Math.PI * 52;
els.ringFill.style.strokeDasharray = RING_LENGTH;

// --- State ------------------------------------------------------------------

let recognizer;
let statement = null;           // { id, text }
let state = "idle";             // idle | holding | saving | result | cooldown
let holdGesture = null;         // "Thumb_Up" | "Thumb_Down"
let holdStart = 0;
let lastGestureSeen = 0;
let lastHandSeen = 0;
let lastVideoTime = -1;

// --- Statement --------------------------------------------------------------

async function loadStatement() {
  try {
    const res = await fetch("/api/statement", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    const next = await res.json();
    if (!statement || next.id !== statement.id) {
      statement = next;
      els.statement.textContent = next.text;
      // A new statement mid-hold should not inherit the old gesture.
      if (state === "holding") resetToIdle();
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
  loadStatement();
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

  const top = result.gestures[0]?.[0];
  const gesture = top && GESTURES[top.categoryName] && top.score >= MIN_SCORE ? top.categoryName : null;

  tick(gesture, handVisible, now);
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

function tick(gesture, handVisible, now) {
  switch (state) {
    case "idle":
      if (gesture) startHold(gesture, now);
      break;

    case "holding": {
      if (gesture === holdGesture) {
        lastGestureSeen = now;
      } else if (gesture) {
        // Switched thumbs: start over with the new gesture.
        startHold(gesture, now);
        return;
      } else if (now - lastGestureSeen > GRACE_MS) {
        resetToIdle();
        return;
      }
      const progress = Math.min((now - holdStart) / HOLD_MS, 1);
      renderRing(progress);
      if (progress >= 1) submitVote(GESTURES[holdGesture].answer);
      break;
    }

    case "cooldown":
      if (!handVisible && now - lastHandSeen > HAND_GONE_MS) resetToIdle();
      break;

    // "saving" and "result" are driven by timers, not frames.
  }
}

function startHold(gesture, now) {
  state = "holding";
  holdGesture = gesture;
  holdStart = now;
  lastGestureSeen = now;
  const g = GESTURES[gesture];
  els.ringWrap.hidden = false;
  els.ringWrap.dataset.answer = g.answer;
  els.ringEmoji.textContent = g.emoji;
  setStatus(`Hold ${g.emoji} to ${g.label.toLowerCase()}…`);
  renderRing(0);
}

function renderRing(progress) {
  els.ringFill.style.strokeDashoffset = RING_LENGTH * (1 - progress);
  els.ringCount.textContent = Math.max(1, Math.ceil((HOLD_MS * (1 - progress)) / 1000));
}

function resetToIdle() {
  state = "idle";
  holdGesture = null;
  els.ringWrap.hidden = true;
  els.result.hidden = true;
  els.camera.classList.remove("dimmed");
  setStatus("Show 👍 to agree or 👎 to disagree, and hold it for 3 seconds");
}

function setStatus(text) {
  if (els.status.textContent !== text) els.status.textContent = text;
}

// --- Voting -----------------------------------------------------------------

async function submitVote(answer) {
  state = "saving";
  els.ringWrap.hidden = true;
  setStatus("Saving…");

  let results;
  try {
    const res = await fetch("/api/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statementId: statement?.id, answer }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    results = await res.json();
  } catch (err) {
    console.error("Vote failed:", err);
    setStatus("⚠️ Your answer could not be saved. Lower your hand and try again.");
    state = "cooldown";
    return;
  }

  showResult(answer, results);
  state = "result";
  setTimeout(() => {
    els.result.hidden = true;
    els.camera.classList.remove("dimmed");
    state = "cooldown";
    setStatus("Please lower your hand so the next student can answer");
  }, RESULT_MS);
}

function showResult(answer, r) {
  els.resultTitle.textContent = answer === "agree" ? "👍 Agree recorded ✓" : "👎 Disagree recorded ✓";
  els.result.dataset.answer = answer;
  els.agreePct.textContent = `${r.agreePct}%`;
  els.disagreePct.textContent = `${r.disagreePct}%`;
  els.resultTotal.textContent = `${r.total} ${r.total === 1 ? "response" : "responses"} so far`;
  // Start bars at 0 so they animate in.
  els.agreeBar.style.width = "0";
  els.disagreeBar.style.width = "0";
  els.result.hidden = false;
  els.camera.classList.add("dimmed");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      els.agreeBar.style.width = `${r.agreePct}%`;
      els.disagreeBar.style.width = `${r.disagreePct}%`;
    })
  );
  setStatus("Thank you for your feedback!");
}

boot();
