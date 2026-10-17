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
let buffer = "";
let silenceTimer = null;
let firstTurn = true;
let callStart = 0;
let wakeLock = null;
// Rolling buffer of recent frames from the live stream (1 per second, last few kept).
const FRAME_EVERY_MS = 1000;
const FRAMES_SENT = 3;
let recentFrames = [];

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
async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  $("cam").srcObject = stream;
  $("cam").style.transform = facing === "user" ? "scaleX(-1)" : "";
}

setInterval(() => {
  if (!callStart) return;
  const f = grabFrame(768);
  if (f) recentFrames = [...recentFrames, f].slice(-FRAMES_SENT);
}, FRAME_EVERY_MS);

function grabFrame(maxSide = 1024) {
  const v = $("cam");
  if (!v.videoWidth) return null;
  const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const c = $("grab");
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.75).split(",")[1];
}

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
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) buffer += r[0].transcript + " ";
      else interim += r[0].transcript;
    }
    $("youSaid").textContent = (buffer + interim).trim();
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const text = (buffer + interim).trim();
      if (text) sendTurn(text);
    }, SILENCE_MS);
  };
  // Chrome stops recognition after a while; restart while we're supposed to be listening.
  recog.onend = () => { if (state === "listening" && !muted) try { recog.start(); } catch (_) {} };
  recog.onerror = (e) => { if (e.error === "not-allowed") $("state").textContent = "mic blocked"; };
}

// ---------- Talking to Claude ----------
async function sendTurn(text) {
  clearTimeout(silenceTimer);
  buffer = "";
  stopListening();
  setState("thinking");
  $("youSaid").textContent = text;

  // Recent motion from the stream + a sharp frame right now.
  const now = grabFrame();
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

  let reply;
  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, text: payloadText, images_b64: images }),
    });
    const data = await res.json();
    sessionId = data.session_id;
    reply = data.reply;
    if (data.error) console.warn("API error:", data.error);
  } catch (err) {
    console.error(err);
    reply = "Sorry, I lost the connection for a second. Could you say that again?";
  }
  clearTimeout(fillerTimer);
  if (fillerSpoken) await fillerSpoken;

  $("fixieSaid").textContent = reply;
  setState("speaking");
  await speak(reply);
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
    alert("I couldn't open the camera. Please allow camera access and try again.\n\n" + err.message);
    return;
  }
  $("lobby").hidden = true;
  $("call").hidden = false;
  callStart = Date.now();
  // Keep the phone screen on during the call.
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
  setupRecognition();

  $("fixieSaid").textContent = GREETING[lang];
  setState("speaking");
  await speak(GREETING[lang]);
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
  facing = facing === "environment" ? "user" : "environment";
  try { await startCamera(); } catch (_) {}
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
