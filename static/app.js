// Fixie front end: camera + speech-to-text + text-to-speech, all in the browser.
// Loop: listen -> (pause in speech) -> grab camera frame -> POST /api/turn -> speak reply -> listen again.

const $ = (id) => document.getElementById(id);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const GREETING = {
  "en-US": "Hi, it's Fixie! I can see your camera. What isn't working today?",
  "de-DE": "Hallo, hier ist Fixie! Ich kann deine Kamera sehen. Was funktioniert denn nicht?",
};
const FILLER = {
  "en-US": ["Mm-hm, let me have a look.", "Okay, one second.", "Let me see."],
  "de-DE": ["Mhm, lass mich mal schauen.", "Okay, einen Moment.", "Mal sehen."],
};
const SILENCE_MS = 1300; // how long a pause ends the caller's sentence

let lang = "en-US";
let sessionId = null;
let stream = null;
let facing = "environment";
let recog = null;
let state = "idle"; // idle | listening | thinking | speaking
let muted = false;
let buffer = "";        // what the caller said in earlier recognition sessions of this turn
let sessionText = "";   // what the current recognition session heard so far
const CAPTION_MAX = 100; // characters of the caller's words shown on screen
const heard = () => `${buffer} ${sessionText}`.trim();

function showCaption(id, text) {
  $(id).textContent = text;
}
let silenceTimer = null;
let firstTurn = true;
let callStart = 0;
let wakeLock = null;
// Rolling buffer of recent frames from the live stream (1 per second, last few kept).
const FRAME_EVERY_MS = 1000;
const FRAMES_SENT = 3;
let recentFrames = [];
const WARMUP_MS = 1500; // camera needs ~1s to settle exposure after it opens
let cameraReadyAt = 0;
let darkFrames = 0; // consecutive black frames, to warn the caller

// ---------- UI helpers ----------
function setState(s, label) {
  state = s;
  $("state").textContent = label || { listening: "listening…", thinking: "looking…", speaking: "talking", idle: "" }[s];
  $("helperAvatar").classList.toggle("speaking", s === "speaking");
}
setInterval(() => {
  if (!callStart) return;
  const s = Math.floor((Date.now() - callStart) / 1000);
  $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}, 1000);

// ---------- Camera ----------
const IR_CAMERA = /\bIR\b|infrared/i; // laptop face-login cameras: black except when the IR light flashes

async function openStream(video) {
  return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...video }, audio: false });
}

async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await openStream({ facingMode: facing });
  let track = stream.getVideoTracks()[0];
  if (IR_CAMERA.test(track.label)) {
    // Labels are only visible after permission is granted, so check now and switch to a normal camera.
    const cams = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === "videoinput" && !IR_CAMERA.test(d.label));
    if (cams.length) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await openStream({ deviceId: { exact: cams[0].deviceId } });
      track = stream.getVideoTracks()[0];
    }
  }
  showStream();
}

// Put the (new) stream on screen and reset the frame buffer.
function showStream() {
  const track = stream.getVideoTracks()[0];
  console.log("Camera:", track.label, track.getSettings());
  facing = track.getSettings().facingMode === "user" ? "user" : "environment";
  $("cam").srcObject = stream;
  // Fresh stream: drop frames from the old camera and ignore the dark warm-up frames.
  recentFrames = [];
  darkFrames = 0;
  cameraReadyAt = Date.now() + WARMUP_MS;
  $("cam").style.transform = facing === "user" ? "scaleX(-1)" : "";
}

setInterval(() => {
  if (!callStart) return;
  const f = grabFrame(768);
  if (f) recentFrames = [...recentFrames, f].slice(-FRAMES_SENT);
  $("camWarn").hidden = darkFrames < 3;
}, FRAME_EVERY_MS);

// Average brightness 0-255 of the frame on the canvas, from a tiny thumbnail.
function brightness(canvas) {
  const t = $("thumb");
  t.width = t.height = 16;
  const ctx = t.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  return sum / (d.length / 4) / 3;
}

function grabFrame(maxSide = 1024) {
  const v = $("cam");
  if (!v.videoWidth || Date.now() < cameraReadyAt) return null;
  const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const c = $("grab");
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  // Never send black frames to Claude: it would just say "I can't see anything".
  if (brightness(c) < 12) { darkFrames++; return null; }
  darkFrames = 0;
  return c.toDataURL("image/jpeg", 0.75).split(",")[1];
}

// ---------- Pointing: ring on the live video, tracked as the camera moves ----------
// Claude marks a spot (x, y in 0..1) in the frame we sent. We cut a small patch around that spot
// from the sent frame, then keep finding the same patch in the live video and move the ring there.
const TRACK_W = 160;          // tracking works on a small grayscale copy of the video
const PATCH = 10;             // patch half-size in tracking pixels (21x21 patch)
const SEARCH = 12;            // how far the patch may move between two tracking steps
const LOST_SCORE = 28;        // mean pixel difference above this = we lost it
let markerTimer = null;
let sentGray = null;          // grayscale copy of the frame Claude saw: { data, w, h }
let track = null;             // { patch, x, y, lost } in tracking pixels

function grayOf(source, w, h) {
  const t = $("track");
  t.width = w; t.height = h;
  const ctx = t.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2];
  return { data: g, w, h };
}

function trackSize() {
  const v = $("cam");
  return [TRACK_W, Math.round((TRACK_W * v.videoHeight) / v.videoWidth)];
}

// Remember the frame we're sending to Claude, so the marker can be matched against it later.
function rememberSentFrame() {
  const v = $("cam");
  if (v.videoWidth) sentGray = grayOf(v, ...trackSize());
}

function cutPatch(img, cx, cy) {
  const n = 2 * PATCH + 1, p = new Float32Array(n * n);
  let sum = 0;
  for (let dy = -PATCH; dy <= PATCH; dy++)
    for (let dx = -PATCH; dx <= PATCH; dx++) {
      const x = Math.min(img.w - 1, Math.max(0, cx + dx)), y = Math.min(img.h - 1, Math.max(0, cy + dy));
      const val = img.data[y * img.w + x];
      p[(dy + PATCH) * n + dx + PATCH] = val; sum += val;
    }
  const mean = sum / p.length;
  for (let i = 0; i < p.length; i++) p[i] -= mean; // brightness-independent
  return p;
}

// Best place for the patch in img within the box around (cx, cy). Returns [x, y, score].
function findPatch(img, patch, cx, cy, radius) {
  let best = [cx, cy, Infinity, Infinity];
  const step = radius > 20 ? 2 : 1;
  for (let y = Math.max(PATCH, cy - radius); y <= Math.min(img.h - 1 - PATCH, cy + radius); y += step)
    for (let x = Math.max(PATCH, cx - radius); x <= Math.min(img.w - 1 - PATCH, cx + radius); x += step) {
      const c = cutPatch(img, x, y);
      let diff = 0;
      for (let i = 0; i < c.length; i++) diff += Math.abs(c[i] - patch[i]);
      diff /= c.length;
      // Prefer matches near the last known spot (look-alike buttons further away lose).
      const cost = diff + 0.15 * Math.hypot(x - cx, y - cy);
      if (cost < best[3]) best = [x, y, diff, cost];
    }
  // Coarse search skipped every other pixel: refine around the best spot.
  return step > 1 ? findPatch(img, patch, best[0], best[1], 2) : best;
}

// x, y are 0..1 in the camera frame. The video is shown with object-fit: cover (cropped), maybe mirrored.
function placeMarker(nx, ny) {
  const v = $("cam"), m = $("marker");
  const box = v.getBoundingClientRect();
  const scale = Math.max(box.width / v.videoWidth, box.height / v.videoHeight);
  const offX = (box.width - v.videoWidth * scale) / 2;
  const offY = (box.height - v.videoHeight * scale) / 2;
  const x = facing === "user" ? 1 - nx : nx;
  m.style.left = `${offX + x * v.videoWidth * scale}px`;
  m.style.top = `${offY + ny * v.videoHeight * scale}px`;
}

function showMarker(point) {
  const v = $("cam"), m = $("marker");
  if (!point || !v.videoWidth) return hideMarker();
  m.querySelector(".label").textContent = point.label || "";
  m.hidden = false;
  m.style.opacity = 1;
  placeMarker(point.x, point.y);
  if (sentGray) {
    const px = Math.round(point.x * sentGray.w), py = Math.round(point.y * sentGray.h);
    track = { patch: cutPatch(sentGray, px, py), x: px, y: py, lost: 0 };
    // The camera may have moved while Claude was thinking: search a wide area once.
    const [x, y] = findPatch(grayOf(v, sentGray.w, sentGray.h), track.patch, px, py, 50);
    track.x = x; track.y = y;
  }
  clearTimeout(markerTimer);
  markerTimer = setTimeout(hideMarker, 15000);
}

function hideMarker() {
  clearTimeout(markerTimer);
  track = null;
  $("marker").hidden = true;
}

setInterval(() => {
  if (!track || !sentGray) return;
  const img = grayOf($("cam"), sentGray.w, sentGray.h);
  const [x, y, score] = findPatch(img, track.patch, track.x, track.y, SEARCH);
  const m = $("marker");
  if (score > LOST_SCORE) {
    // Can't see it right now: fade out, and look a bit wider next time.
    track.lost++;
    m.style.opacity = track.lost > 3 ? 0 : 0.4;
    if (track.lost > 3) { const [wx, wy, ws] = findPatch(img, track.patch, track.x, track.y, 40); if (ws <= LOST_SCORE) { track.x = wx; track.y = wy; } }
    return;
  }
  track.lost = 0;
  track.x = x; track.y = y;
  m.style.opacity = 1;
  placeMarker(x / img.w, y / img.h);
}, 66);

// ---------- Text to speech ----------
function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith(lang.slice(0, 2)));
  return voices.find((v) => /natural|google|samantha|anna|female/i.test(v.name)) || voices[0];
}

function speak(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95; // a little slower, easier to follow
    const v = pickVoice();
    if (v) u.voice = v;
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

// Speak sentence by sentence, showing only the current sentence as the subtitle.
async function speakWithSubtitles(text) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    showCaption("fixieSaid", sentence.trim());
    await speak(sentence.trim());
  }
}

// ---------- Speech to text ----------
function startListening() {
  if (muted || state === "thinking" || state === "speaking") return;
  setState("listening");
  if (!SR) return; // no speech recognition: typing still works
  try { recog.start(); } catch (_) { /* already started */ }
}

function stopListening() {
  if (recog) try { recog.abort(); } catch (_) {}
}

function setupRecognition() {
  if (!SR) {
    $("state").textContent = "type below (no voice in this browser)";
    return;
  }
  recog = new SR();
  recog.lang = lang;
  recog.continuous = true;
  recog.interimResults = true;

  recog.onresult = (e) => {
    // Rebuild this session's text from all results. Android Chrome repeats earlier words inside
    // later results ("my", "my printer", "my printer is"), so keep only the longest version.
    const parts = [];
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.trim();
      const last = parts[parts.length - 1];
      if (!t) continue;
      if (last && t.toLowerCase().startsWith(last.toLowerCase())) parts[parts.length - 1] = t;
      else if (last && last.toLowerCase().startsWith(t.toLowerCase())) continue;
      else parts.push(t);
    }
    sessionText = parts.join(" ");
    const text = heard();
    showCaption("youSaid", text.length > CAPTION_MAX ? "…" + text.slice(-CAPTION_MAX) : text);
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const text = heard();
      if (text) sendTurn(text);
    }, SILENCE_MS);
  };
  // Chrome stops recognition after a while; keep what was heard and restart while we're listening.
  recog.onend = () => {
    buffer = heard();
    sessionText = "";
    if (state === "listening" && !muted) try { recog.start(); } catch (_) {}
  };
  recog.onerror = (e) => { if (e.error === "not-allowed") $("state").textContent = "mic blocked"; };
}

// ---------- Talking to Claude ----------
async function sendTurn(text) {
  clearTimeout(silenceTimer);
  buffer = "";
  sessionText = "";
  stopListening();
  setState("thinking");
  showCaption("youSaid", text.length > CAPTION_MAX ? "…" + text.slice(-CAPTION_MAX) : text);

  // Recent motion from the stream + a sharp frame right now.
  const now = grabFrame();
  rememberSentFrame();
  const images = [...recentFrames.slice(-(FRAMES_SENT - 1)), now].filter(Boolean);
  let payloadText = text;
  if (firstTurn) {
    payloadText = `(You already greeted the caller with: "${GREETING[lang]}". Reply in ${lang === "de-DE" ? "German" : "English"}.)\n\nCaller: ${text}`;
    firstTurn = false;
  }

  // If Claude takes a moment, say a filler line like a person would.
  let fillerSpoken = null;
  const fillerTimer = setTimeout(() => {
    const f = FILLER[lang];
    fillerSpoken = speak(f[Math.floor(Math.random() * f.length)]);
  }, 2500);

  let reply, point = null;
  hideMarker();
  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, text: payloadText, images_b64: images }),
    });
    const data = await res.json();
    sessionId = data.session_id;
    reply = data.reply;
    point = data.point;
    if (data.error) console.warn("API error:", data.error);
  } catch (err) {
    console.error(err);
    reply = "Sorry, I lost the connection for a second. Could you say that again?";
  }
  clearTimeout(fillerTimer);
  if (fillerSpoken) await fillerSpoken;

  showMarker(point);
  setState("speaking");
  await speakWithSubtitles(reply);
  setState("idle");
  $("youSaid").textContent = "";
  startListening();
}

// ---------- Call controls ----------
$("callBtn").onclick = async () => {
  lang = $("lang").value;
  // Unlock speech synthesis inside the click (needed on iOS/Safari).
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  try {
    await startCamera();
  } catch (err) {
    const why = {
      NotAllowedError: "Camera access was blocked. Please allow the camera (click the camera icon in the address bar) and try again.",
      NotFoundError: "I can't find a camera on this device. Is one plugged in? Try another device, like your phone.",
      NotReadableError: "The camera is busy or not responding. Close other apps that use the camera, or restart the device.",
    }[err.name] || "I couldn't open the camera.";
    alert(`${why}\n\n(${err.name}: ${err.message})`);
    return;
  }
  $("lobby").hidden = true;
  $("call").hidden = false;
  callStart = Date.now();
  // Keep the phone screen on during the call.
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
  setupRecognition();

  setState("speaking");
  await speakWithSubtitles(GREETING[lang]);
  setState("idle");
  startListening();
};

$("micBtn").onclick = () => {
  muted = !muted;
  $("micBtn").classList.toggle("off", muted);
  if (muted) { stopListening(); setState("idle", "you're muted"); }
  else startListening();
};

$("flipBtn").onclick = async () => {
  // Step through every camera (phone front/back, or laptop webcam/IR/USB).
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  const next = cams[(cams.findIndex((c) => c.deviceId === current) + 1) % cams.length];
  if (!next) return;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  try {
    stream = await openStream({ deviceId: { exact: next.deviceId } });
  } catch (_) { return startCamera(); }
  showStream();
};

$("hangBtn").onclick = async () => {
  stopListening();
  speechSynthesis.cancel();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (sessionId) fetch("/api/hangup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, text: "" }) });
  location.reload();
};

$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const text = $("typeInput").value.trim();
  if (!text || state === "thinking") return;
  $("typeInput").value = "";
  speechSynthesis.cancel();
  state = "idle";
  sendTurn(text);
};

speechSynthesis.onvoiceschanged = () => {}; // make Chrome load voices early

// Lets Android Chrome offer "Install app" so Fixie opens full-screen from the home screen.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
