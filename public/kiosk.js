import {
  FilesetResolver,
  GestureRecognizer,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

// --- Tunables ---------------------------------------------------------------

// How long each variant's gesture must be held before it counts
const THUMBS_HOLD_MS = 3000;
const STARS_HOLD_MS = 1000;
const FINGERS_HOLD_MS = 3000;
const MIN_SCORE = 0.6;         // minimum model confidence for a thumb gesture
const GRACE_MS = 250;          // tolerate brief detection drop-outs while holding
const RESULT_MS = 4000;        // how long the result card is shown
const IDLE_AFTER_MS = 10000;   // back to the idle screen when no hand is seen this long while a question waits
const MAX_HANDS = 3;           // hands the model looks for; the kiosk follows the raised one (see followHand)
const HAND_MIN_SIZE = 0.35;    // a new hand smaller than this part of the biggest hand in view is further away, and ignored
const HAND_SWITCH = 1;         // another hand must be this many palm sizes higher than the followed hand to take over
const HAND_LOCK_MS = 400;      // a followed hand that is lost, blurred by moving fast, is waited for this long
const WAVE_SWINGS = 1;         // side-to-side swings of a raised, open hand that wake the kiosk: back, forth and back
const WAVE_SWING = 0.5;        // a swing must move the hand sideways at least this many palm lengths
const WAVE_MAX_TILT = 60;      // degrees the waving hand may lean away from fingers-up
const WAVE_MIN_SWING_MS = 100; // a swing faster than this is a jump in the tracking, not a hand
const WAVE_GAP_MS = 800;       // the wave starts over when the next swing takes longer than this
const POLL_MS = 3000;          // how often to check for a new variant or changed questions
const STAR_HIT_PADDING = 40;   // px around each star that still counts as pointing at it
const SMOOTHING = 0.5;         // 0 = raw fingertip, closer to 1 = steadier but laggier cursor
const FINGER_RATIO = 1.15;     // finger is "up" when tip-to-wrist > this × joint-to-wrist
const THUMB_RATIO = 1.2;       // thumb is "out" when tip-to-index-base > this × thumb-base-to-index-base
const STABLE_FRAMES = 5;       // finger count must be the same this many frames in a row before it counts
const BOX_PADDING = 0.15;      // extra room around the hand in the tracking square, as a fraction of its size
const BOX_SMOOTHING = 0.4;     // 0 = raw position, closer to 1 = steadier but laggier tracking square

// The cameras that can be picked on the admin page. `labels` find the device
// by name, in order of preference. `rotation` turns each sensor frame clockwise
// before it is mirrored and shown.
const CAMERAS = {
  // The built-in MacBook camera, for testing on a laptop: the landscape
  // picture as the sensor delivers it.
  macbook: {
    labels: [/facetime/i, /macbook/i, /built-in/i],
    size: { width: { ideal: 1920 }, height: { ideal: 1080 } },
    rotation: 0,
  },
  // The Logitech StreamCam, mounted upright next to the portrait display. Its
  // sensor image arrives turned 90° clockwise. Rotating it a further 270°
  // stands the picture up and, from a 1920×1080 frame, yields the 1080×1920
  // portrait image the vertical display needs.
  logitech: {
    labels: [/streamcam/i, /logitech/i],
    size: { width: { ideal: 1920 }, height: { ideal: 1080 } },
    rotation: 270,
  },
};
const DEFAULT_CAMERA = "logitech";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

const GESTURES = {
  Thumb_Up: { answer: "agree", emoji: "👍", label: "Agree" },
  Thumb_Down: { answer: "disagree", emoji: "👎", label: "Disagree" },
};

// Hand landmark indices (https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
const WRIST = 0;
const THUMB_MCP = 2;
const THUMB_IP = 3;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
const FINGERS = [ // [pip, tip] for index, middle, ring, pinky
  [6, 8], [10, 12], [14, 16], [18, 20],
];

const holdText = (ms) => `${ms / 1000} ${ms === 1000 ? "second" : "seconds"}`;

const STAR_PATH =
  "M12 2.6l2.83 5.9 6.47.78-4.77 4.46 1.23 6.43L12 17.02l-5.76 3.15 1.23-6.43L2.7 9.28l6.47-.78z";

// --- Elements ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const video = $("video");
const feedCanvas = $("feed");
const feedCtx = feedCanvas.getContext("2d");
const colorCanvas = $("colorFeed");
const colorCtx = colorCanvas.getContext("2d");
const frameCanvas = document.createElement("canvas");
const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
const canvas = $("overlay");
const ctx = canvas.getContext("2d");
const drawing = new DrawingUtils(ctx);
const els = {
  statement: $("statement"),
  status: $("status"),
  camera: $("camera"),
  handBox: $("handBox"),
  handColor: $("handColor"),
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
  fingers: $("fingers"),
  fingerRow: $("fingerRow"),
  fingerLabel: $("fingerLabel"),
  result: $("result"),
  resultTitle: $("resultTitle"),
  resultAverage: $("resultAverage"),
  resultBars: $("resultBars"),
  resultTotal: $("resultTotal"),
  idle: $("idle"),
  idleTitle: $("idleTitle"),
  idleHint: $("idleHint"),
  waveSteps: $("waveSteps"),
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

const fingerEls = [1, 2, 3, 4, 5].map((n) => {
  const el = document.createElement("div");
  el.className = "finger-chip";
  el.textContent = n;
  els.fingerRow.append(el);
  return el;
});

// One dot per swing on the idle screen, filled as the wave is counted
const waveDots = Array.from({ length: WAVE_SWINGS }, () => {
  const el = document.createElement("span");
  els.waveSteps.append(el);
  return el;
});

// --- State ------------------------------------------------------------------

let recognizer;
let mode = null;                // active variant, chosen on the admin page
let questions = [];             // [{ id, text }] assigned to the active variant
let question = null;            // { id, text } on screen, or null when there is nothing to ask
let queue = [];                 // ids of the questions still to ask in this round, in random order
let state = "idle";             // idle | ready | holding | saving | result
let followed = null;            // the hand being followed: { x, y, size, seen }, centre and palm size in frame pixels
let wave = null;                // the wave being counted on the idle screen: { low, high, dir, swings, lastSwing }
let wakeKey = null;             // the answer the waving hand already made, ignored until it changes
let holdKey = null;             // what is being held: a gesture name, star number or finger count
let holdStart = 0;
let lastKeySeen = 0;
let lastHandSeen = 0;
let lastVideoTime = -1;
let cursorPos = null;           // smoothed fingertip position in camera-box pixels
let handBox = null;             // smoothed tracking square { x, y, size } in camera-box pixels
let fingerCount = { stable: null, candidate: null, frames: 0 };
let cameraChoice = DEFAULT_CAMERA; // camera picked on the admin page, a key of CAMERAS
let cameraOpened = null;        // the CAMERAS key startCamera last opened, or is opening
let cameraStarted = false;      // after the first start, a new choice on the admin page switches right away
let cameraSeq = 0;              // a newer startCamera call makes an older one stale
let rotation = 0;               // clockwise turn of the open camera's frames

// --- Variants ---------------------------------------------------------------
//
// All variants share the same wave → hold → save → result flow. A variant
// only decides what the student is "holding" in a frame (read), how to show
// the hold (render/clear), and what to send to the server (payload).

const variants = {
  thumbs: {
    holdMs: THUMBS_HOLD_MS,
    readyText: `Show 👍 to agree or 👎 to disagree, and hold it for ${holdText(THUMBS_HOLD_MS)}`,

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
      els.ringCount.textContent = secondsLeft(progress, THUMBS_HOLD_MS);
      setStatus(`Hold ${g.emoji} to ${g.label.toLowerCase()}…`);
    },

    clear() {
      els.ringWrap.hidden = true;
    },

    payload: (key) => ({ answer: GESTURES[key].answer }),
  },

  stars: {
    holdMs: STARS_HOLD_MS,
    readyText: `Point your index finger at a star and hold it for ${holdText(STARS_HOLD_MS)}`,

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
      if (state === "ready" || state === "holding") {
        els.cursor.hidden = false;
        els.cursor.style.transform = `translate(${cursorPos.x}px, ${cursorPos.y}px)`;
      }
      return starAt(cursorPos);
    },

    render(key, progress) {
      paintStars(key);
      els.cursor.classList.add("active");
      els.cursorFill.style.strokeDashoffset = CURSOR_LENGTH * (1 - progress);
      els.cursorCount.textContent = secondsLeft(progress, STARS_HOLD_MS);
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

  fingers: {
    holdMs: FINGERS_HOLD_MS,
    readyText: `Hold up 1 to 5 fingers for ${holdText(FINGERS_HOLD_MS)} to give a rating`,

    read(result) {
      const hand = result.worldLandmarks[0];
      return stableCount(hand ? countFingers(hand) : 0);
    },

    render(key, progress) {
      paintFingers(key);
      els.ringWrap.hidden = false;
      els.ringWrap.dataset.answer = "fingers";
      els.ringEmoji.textContent = "✋";
      els.ringCount.textContent = key;
      els.ringFill.style.strokeDashoffset = RING_LENGTH * (1 - progress);
      els.fingerLabel.textContent = `${key} ${key === 1 ? "finger" : "fingers"} = ${key} of 5`;
      setStatus(`Keep holding up ${key} ${key === 1 ? "finger" : "fingers"}…`);
    },

    clear() {
      paintFingers(0);
      els.ringWrap.hidden = true;
      els.fingerLabel.textContent = "Hold up 1 to 5 fingers";
    },

    payload: (key) => ({ rating: key }),
  },
};

const variant = () => variants[mode] ?? variants.thumbs;

function applyMode() {
  const name = variants[mode] ? mode : "thumbs";
  document.body.dataset.mode = name;
  els.stars.hidden = name !== "stars";
  els.fingers.hidden = name !== "fingers";
  els.cursor.hidden = true;
  Object.values(variants).forEach((v) => v.clear());
}

// --- Fingers helpers --------------------------------------------------------

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Count raised fingers from 3D world landmarks (metres, so the result does not
 * depend on how far the hand is from the camera or the image aspect ratio).
 */
function countFingers(hand) {
  const wrist = hand[WRIST];
  let count = FINGERS.filter(([pip, tip]) => dist3(hand[tip], wrist) > dist3(hand[pip], wrist) * FINGER_RATIO).length;

  // The thumb bends sideways, so compare it against the base of the index finger
  // (a tucked thumb ends up near it) and the pinky base (an extended thumb points away from it).
  const thumbOut =
    dist3(hand[THUMB_TIP], hand[INDEX_MCP]) > dist3(hand[THUMB_MCP], hand[INDEX_MCP]) * THUMB_RATIO &&
    dist3(hand[THUMB_TIP], hand[PINKY_MCP]) > dist3(hand[THUMB_IP], hand[PINKY_MCP]);
  if (thumbOut) count++;

  return count;
}

/** Only change the reported count after it has been seen STABLE_FRAMES frames in a row. */
function stableCount(raw) {
  const value = raw >= 1 ? raw : null; // a fist (0) is not an answer
  if (value === fingerCount.candidate) {
    fingerCount.frames++;
  } else {
    fingerCount.candidate = value;
    fingerCount.frames = 1;
  }
  if (fingerCount.frames >= STABLE_FRAMES) fingerCount.stable = value;
  return fingerCount.stable;
}

function paintFingers(value) {
  fingerEls.forEach((el, i) => {
    el.classList.toggle("filled", i < value);
    el.classList.toggle("target", i === value - 1);
  });
}

// --- Wave helpers -----------------------------------------------------------

/** An open hand, as people hold it to wave: the model sees an open palm, or at least four fingers are up. */
function handOpen(result) {
  const world = result.worldLandmarks[0];
  return result.gestures[0]?.[0]?.categoryName === "Open_Palm" || (world && countFingers(world) >= 4);
}

/**
 * Count the side-to-side swings of a raised, open hand. A swing must move the
 * hand at least WAVE_SWING palm lengths before it turns back, so it doesn't
 * depend on how far the hand is from the camera. It must also go more sideways
 * than up or down and take between WAVE_MIN_SWING_MS and WAVE_GAP_MS. Anything
 * else, like raising the hand or moving it about, starts the count over.
 */
function countSwings(result, now) {
  if (wave && now - wave.lastSwing > WAVE_GAP_MS) wave = null;
  const hand = result.landmarks[0];
  if (!hand || !handOpen(result)) return wave?.swings ?? 0;

  // Measured in frame pixels: normalized x and y have different scales on a non-square frame.
  const { width, height } = frameCanvas;
  const x = (hand.reduce((sum, lm) => sum + lm.x, 0) / hand.length) * width;
  const y = (hand.reduce((sum, lm) => sum + lm.y, 0) / hand.length) * height;
  const palmX = (hand[MIDDLE_MCP].x - hand[WRIST].x) * width;
  const palmY = (hand[MIDDLE_MCP].y - hand[WRIST].y) * height;

  // Fingers up: the line from the wrist to the knuckles leans at most WAVE_MAX_TILT from vertical.
  const tilt = (Math.atan2(Math.abs(palmX), -palmY) * 180) / Math.PI;
  if (tilt > WAVE_MAX_TILT) return wave?.swings ?? 0;

  // `low` and `high` are the leftmost and rightmost points since the last swing.
  const start = (dir, swings) => ({ low: { x, y }, high: { x, y }, dir, swings, lastSwing: now });
  wave ??= start(0, 0);
  if (x < wave.low.x) wave.low = { x, y };
  if (x > wave.high.x) wave.high = { x, y };

  // A new swing: the hand came back far enough from the end it last reached, or, before the first swing, from either end.
  const swing = Math.hypot(palmX, palmY) * WAVE_SWING;
  const from =
    wave.dir <= 0 && x - wave.low.x >= swing ? wave.low : wave.dir >= 0 && wave.high.x - x >= swing ? wave.high : null;
  if (from) {
    const sideways = Math.abs(x - from.x) > Math.abs(y - from.y);
    const jump = now - wave.lastSwing < WAVE_MIN_SWING_MS;
    wave = sideways && !jump ? start(Math.sign(x - from.x), wave.swings + 1) : start(0, 0);
  }
  return wave.swings;
}

function paintWave(swings, handVisible) {
  waveDots.forEach((el, i) => el.classList.toggle("filled", i < swings));
  els.idle.classList.toggle("tracking", handVisible);
  setText(
    els.idleHint,
    swings ? "Keep waving…" : handVisible ? "Hold your open hand up and wave it from side to side" : "Raise your hand and wave at the camera"
  );
}

// --- Stars helpers ----------------------------------------------------------

/** Index finger counts as pointing when its tip is farther from the wrist than its middle joint. */
function indexExtended(hand) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return d(hand[INDEX_TIP], hand[WRIST]) > d(hand[INDEX_PIP], hand[WRIST]) * 1.1;
}

/**
 * Convert a normalized landmark to pixels inside the camera box. The upright
 * frame is already mirrored, and object-fit: cover may crop it.
 */
function toCameraBox(lm) {
  const box = els.camera.getBoundingClientRect();
  const scale = Math.max(box.width / frameCanvas.width, box.height / frameCanvas.height);
  const w = frameCanvas.width * scale;
  const h = frameCanvas.height * scale;
  return {
    x: lm.x * w - (w - box.width) / 2,
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

// --- Questions --------------------------------------------------------------

async function loadQuestions() {
  try {
    const res = await fetch("/api/kiosk", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    const next = await res.json();
    const known = new Set(questions.map((q) => q.id));
    questions = next.questions;

    cameraChoice = CAMERAS[next.camera] ? next.camera : DEFAULT_CAMERA;
    if (cameraStarted && cameraChoice !== cameraOpened) switchCamera();

    if (next.variant !== mode) {
      mode = next.variant;
      queue = [];
      applyMode();
      showQuestion(nextQuestion());
      return;
    }

    // Questions added on the admin page join this round at a random spot.
    for (const { id } of questions) {
      if (!known.has(id)) queue.splice(Math.floor(Math.random() * (queue.length + 1)), 0, id);
    }
    // The question on screen may have been edited, deleted or taken out of this variant.
    const current = questions.find((q) => q.id === question?.id);
    if (!current && (question || questions.length)) showQuestion(nextQuestion());
    else if (current && current.text !== question.text) showQuestion(current);
  } catch (err) {
    console.warn("Could not load questions:", err);
    if (!question) els.statement.textContent = "Cannot reach the server…";
  }
}

/**
 * Pick the next question at random. Every question in the variant is asked
 * once before any is repeated, and the same question never comes twice in a row.
 */
function nextQuestion() {
  queue = queue.filter((id) => questions.some((q) => q.id === id));
  if (!queue.length) {
    queue = shuffle(questions.map((q) => q.id));
    if (queue.length > 1 && queue[0] === question?.id) queue.push(queue.shift());
  }
  const id = queue.shift();
  return questions.find((q) => q.id === id) ?? null;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function showQuestion(next) {
  const changed = next?.id !== question?.id;
  question = next;
  els.statement.textContent = next ? next.text : "No question to answer right now";
  els.idleTitle.textContent = next ? "Wave to answer a question" : "No question to answer right now";
  document.body.classList.toggle("no-question", !next);
  // A new question mid-hold should not inherit the old gesture.
  if (changed && (state === "holding" || state === "ready")) resetToReady();
}

// --- Camera & model ---------------------------------------------------------

async function initRecognizer() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    // More than one, so the kiosk can tell the hand it follows apart from the others (see followHand).
    numHands: MAX_HANDS,
  });
  try {
    return await GestureRecognizer.createFromOptions(fileset, opts("GPU"));
  } catch (err) {
    console.warn("GPU delegate failed, falling back to CPU:", err);
    return await GestureRecognizer.createFromOptions(fileset, opts("CPU"));
  }
}

/** The first camera whose name matches one of `labels`, tried in order, or null. */
function pickCamera(devices, labels) {
  const cameras = devices.filter((device) => device.kind === "videoinput" && device.label);
  for (const label of labels) {
    const match = cameras.find((device) => label.test(device.label));
    if (match) return match;
  }
  return null;
}

async function openCamera(videoConstraints) {
  return navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
}

/** Open the camera picked on the admin page, replacing the one that is open. */
async function startCamera() {
  const name = cameraChoice;
  const { labels, size, rotation: turn } = CAMERAS[name];
  const seq = ++cameraSeq;
  cameraOpened = name;
  // Release the open camera first: some cameras can't be opened twice.
  video.srcObject?.getTracks().forEach((track) => track.stop());

  // Device names stay blank until camera permission is granted, so then open
  // any camera first, and switch to the chosen one when it is plugged in.
  let devices = await navigator.mediaDevices.enumerateDevices();
  let stream = null;
  if (!devices.some((device) => device.kind === "videoinput" && device.label)) {
    stream = await openCamera({ facingMode: "user", ...size });
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const preferred = pickCamera(devices, labels);
  const currentId = stream?.getVideoTracks()[0]?.getSettings().deviceId;

  if (preferred && preferred.deviceId !== currentId) {
    stream?.getTracks().forEach((track) => track.stop());
    try {
      stream = await openCamera({ deviceId: { exact: preferred.deviceId }, ...size });
    } catch (err) {
      console.warn(`Could not open ${preferred.label}, using the default camera:`, err);
      stream = await openCamera({ facingMode: "user", ...size });
    }
  } else if (!preferred) {
    console.warn(`No camera found for "${name}", using the default camera.`);
    stream ??= await openCamera({ facingMode: "user", ...size });
  }

  // The admin picked another camera while this one was opening.
  if (seq !== cameraSeq) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  const label = stream.getVideoTracks()[0]?.label || "unknown camera";
  console.info(`Using camera: ${label} (${name}, rotated ${turn}°)`);

  video.srcObject = stream;
  rotation = turn;
  handBox = null;
  cursorPos = null;
  await video.play();
}

async function switchCamera() {
  try {
    await startCamera();
    els.notice.hidden = true;
  } catch (err) {
    console.error(err);
    showNotice("Could not open the camera. Check that it is plugged in, then reload the page.");
  }
}

function showNotice(text, { button = false } = {}) {
  els.noticeText.textContent = text;
  els.startBtn.hidden = !button;
  els.notice.hidden = false;
}

async function boot() {
  await loadQuestions();
  setInterval(loadQuestions, POLL_MS);

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
    cameraStarted = true;
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
    cameraStarted = true;
    els.notice.hidden = true;
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    showNotice("Camera access was denied. Allow it in the browser settings and reload.", { button: true });
  }
});

// --- Main loop --------------------------------------------------------------

/**
 * Draw the sensor frame upright and mirrored: landscape for the MacBook camera,
 * portrait for the StreamCam. Hand tracking reads this same bitmap, so
 * gestures match what is on screen.
 */
function renderUprightFrame() {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH) return false;

  const turns = ((rotation % 360) + 360) % 360;
  const swap = turns % 180 !== 0;
  const width = swap ? srcH : srcW;
  const height = swap ? srcW : srcH;

  if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
    feedCanvas.width = width;
    feedCanvas.height = height;
    colorCanvas.width = width;
    colorCanvas.height = height;
    canvas.width = width;
    canvas.height = height;
    console.info(`Camera frame ${srcW}×${srcH}, shown upright as ${width}×${height}`);
  }

  frameCtx.save();
  frameCtx.translate(width / 2, height / 2);
  frameCtx.scale(-1, 1); // mirror in the upright picture, so it feels like a mirror
  frameCtx.rotate((turns * Math.PI) / 180);
  frameCtx.drawImage(video, -srcW / 2, -srcH / 2, srcW, srcH);
  frameCtx.restore();

  feedCtx.drawImage(frameCanvas, 0, 0);
  colorCtx.drawImage(frameCanvas, 0, 0);
  return true;
}

function loop() {
  requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  if (!renderUprightFrame()) return;

  const now = performance.now();
  const result = followHand(recognizer.recognizeForVideo(frameCanvas, now), now);

  drawHand(result, now);

  const handVisible = result.landmarks.length > 0;
  if (handVisible) lastHandSeen = now;

  // Read every frame, also on the idle screen, so the finger count is settled by the time someone wakes the kiosk.
  const key = variant().read(result);
  if (state === "idle") watchForWave(result, key, handVisible, now);
  else tick(key, now);
}

/**
 * Pick the one hand to follow among those the model sees, and return the
 * result with only that hand in it. The kiosk follows the raised hand, the
 * highest in the picture, so a hand resting at the bottom never takes over
 * from the hand that points, waves or makes the gesture. A new hand much
 * smaller than the biggest one belongs to someone further away and is
 * ignored. Another hand only takes over when it is clearly higher. A followed
 * hand that is lost for a moment, blurred by moving fast, is waited for
 * instead of jumping to a lower hand.
 */
function followHand(result, now) {
  const { width, height } = frameCanvas;
  const span = (a, b) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const hands = result.landmarks.map((hand, i) => ({
    i,
    x: (hand.reduce((sum, lm) => sum + lm.x, 0) / hand.length) * width,
    y: (hand.reduce((sum, lm) => sum + lm.y, 0) / hand.length) * height,
    // The palm keeps its size whether the fingers are curled or not.
    size: Math.max(span(hand[WRIST], hand[MIDDLE_MCP]), span(hand[INDEX_MCP], hand[PINKY_MCP])),
  }));
  const biggest = Math.max(0, ...hands.map((h) => h.size));
  const highest = hands
    .filter((h) => h.size >= biggest * HAND_MIN_SIZE)
    .reduce((best, h) => (!best || h.y < best.y ? h : best), null);
  const higher = (h, than) => h && h.y < than.y - than.size * HAND_SWITCH;

  // The followed hand in this frame: about the same size, not clearly lower, and the closest to where
  // it was. A waving hand that blurs mid-swing can turn up again at the other end, far to the side.
  const recent = followed && now - followed.seen < HAND_LOCK_MS ? followed : null;
  const away = (h) => Math.hypot(h.x - recent.x, h.y - recent.y);
  const same = recent && hands
    .filter((h) => h.size > recent.size / 2 && h.size < recent.size * 2 && !higher(recent, h))
    .reduce((best, h) => (!best || away(h) < away(best) ? h : best), null);

  let pick;
  if (same) pick = higher(highest, same) ? highest : same;
  else if (recent) pick = higher(highest, recent) ? highest : null; // lost for a moment: wait for it
  else pick = highest;

  if (pick && pick !== same) {
    // A different hand: don't carry over the smoothing or the wave of the previous one.
    handBox = cursorPos = wave = null;
  }
  if (pick) followed = { x: pick.x, y: pick.y, size: pick.size, seen: now };

  const only = (list) => (pick ? [list[pick.i]] : []);
  return { landmarks: only(result.landmarks), worldLandmarks: only(result.worldLandmarks), gestures: only(result.gestures) };
}

function drawHand(result, now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const landmarks of result.landmarks) {
    drawing.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, {
      color: "rgba(255,255,255,0.85)",
      lineWidth: 4,
    });
    drawing.drawLandmarks(landmarks, { color: "#6d5efc", lineWidth: 2, radius: 4 });
  }
  drawHandBox(result.landmarks[0], now);
}

/** Keep a square around the tracked hand, padded and centred on its landmarks. */
function drawHandBox(hand, now) {
  if (!hand) {
    // A hand lost for a moment, blurred by moving fast, keeps its square while it is waited for.
    if (followed && now - followed.seen < HAND_LOCK_MS) return;
    handBox = null;
    els.handBox.hidden = els.handColor.hidden = true;
    return;
  }
  const xs = hand.map((lm) => lm.x);
  const ys = hand.map((lm) => lm.y);
  // The two corners can come back swapped once they are mapped into the camera box
  const a = toCameraBox({ x: Math.min(...xs), y: Math.min(...ys) });
  const b = toCameraBox({ x: Math.max(...xs), y: Math.max(...ys) });
  const raw = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    size: Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * (1 + 2 * BOX_PADDING),
  };
  const k = 1 - BOX_SMOOTHING;
  handBox = handBox
    ? { x: handBox.x + (raw.x - handBox.x) * k, y: handBox.y + (raw.y - handBox.y) * k, size: handBox.size + (raw.size - handBox.size) * k }
    : raw;

  const { style } = els.camera;
  style.setProperty("--hand-x", `${handBox.x - handBox.size / 2}px`);
  style.setProperty("--hand-y", `${handBox.y - handBox.size / 2}px`);
  style.setProperty("--hand-size", `${handBox.size}px`);
  els.handBox.hidden = els.handColor.hidden = false;
}

/** On the idle screen: show how far along a wave is, and wake up when it is complete. */
function watchForWave(result, key, handVisible, now) {
  const swings = countSwings(result, now);
  paintWave(swings, handVisible);
  if (swings >= WAVE_SWINGS && question) {
    // A waving hand can already be an answer, like five fingers. It only counts once it changes.
    wakeKey = key;
    resetToReady();
  }
}

function tick(key, now) {
  switch (state) {
    case "ready":
      if (now - lastHandSeen > IDLE_AFTER_MS) {
        showIdle();
        break;
      }
      if (key !== wakeKey) wakeKey = null;
      if (key && question && !wakeKey) startHold(key, now);
      else if (question) setStatus(wakeKey ? `Lower your hand first. ${variant().readyText}` : variant().readyText);
      break;

    case "holding": {
      if (key === holdKey) {
        lastKeySeen = now;
      } else if (key) {
        // Switched thumbs or moved to another star: start over.
        startHold(key, now);
        return;
      } else if (now - lastKeySeen > GRACE_MS) {
        resetToReady();
        return;
      }
      const progress = Math.min((now - holdStart) / variant().holdMs, 1);
      variant().render(holdKey, progress);
      if (progress >= 1) submitVote(variant().payload(holdKey));
      break;
    }

    // "saving" and "result" are driven by timers, not frames.
  }
}

function startHold(key, now) {
  setState("holding");
  holdKey = key;
  holdStart = now;
  lastKeySeen = now;
  variant().render(key, 0);
}

function secondsLeft(progress, holdMs) {
  return Math.max(1, Math.ceil((holdMs * (1 - progress)) / 1000));
}

/** The state is mirrored on <body data-state>, which the stylesheet uses to switch the idle screen. */
function setState(next) {
  state = next;
  document.body.dataset.state = next;
}

/** Show the question and wait for an answer. */
function resetToReady() {
  setState("ready");
  holdKey = null;
  variant().clear();
  els.result.hidden = true;
  els.camera.classList.remove("dimmed");
  setStatus(question ? variant().readyText : "");
}

/** Hide the question until someone waves. */
function showIdle() {
  setState("idle");
  holdKey = null;
  wakeKey = null;
  wave = null;
  variant().clear();
  els.result.hidden = true;
  els.cursor.hidden = true;
  els.camera.classList.remove("dimmed");
  paintWave(0, false);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setStatus(text) {
  setText(els.status, text);
}

// --- Voting -----------------------------------------------------------------

async function submitVote(payload) {
  setState("saving");
  els.ringWrap.hidden = true;
  els.cursor.hidden = true;
  setStatus("Saving…");

  let results;
  try {
    const res = await fetch("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: question?.id, variant: mode, ...payload }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    results = await res.json();
  } catch (err) {
    console.error("Vote failed:", err);
  }

  setState("result");
  if (results) {
    showResult(payload, results);
  } else {
    variant().clear();
    setStatus("⚠️ Your answer could not be saved. Wave to try again.");
  }
  // Every answer ends on the idle screen, so whoever answers next starts with a wave.
  setTimeout(() => {
    if (results) showQuestion(nextQuestion()); // an answer that wasn't saved keeps its question
    showIdle();
  }, RESULT_MS);
}

function showResult(payload, r) {
  let rows;
  if (r.variant === "stars" || r.variant === "fingers") {
    const fingers = r.variant === "fingers";
    const unit = fingers ? "✋" : "★";
    els.result.dataset.answer = "stars";
    els.resultTitle.textContent = fingers
      ? `✋ ${payload.rating} of 5 recorded ✓`
      : `${"★".repeat(payload.rating)}${"☆".repeat(5 - payload.rating)} recorded ✓`;
    els.resultAverage.hidden = false;
    els.resultAverage.textContent = `Average ${r.average.toFixed(1)} / 5`;
    rows = [5, 4, 3, 2, 1].map((n) => ({ label: `${n} ${unit}`, pct: r.pct[n], cls: "star" }));
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
