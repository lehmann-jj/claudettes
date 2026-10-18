# Fixie · tech help on a video call

**One line:** A video call with a patient AI helper who can *see* your broken printer through your phone camera and talk you through fixing it, like calling your grandchild.

## Audience, problem, demo
1. **Who:** Older adults (and anyone not confident with tech) who are stuck with a device at home: a printer, laptop, router or TV.
2. **Their problem with AI today:** Chatbots expect you to type and to describe the problem in technical words. That's the hard part when you don't know what a "USB-C port" or "model number" is.
3. **What our demo lets them do:** Press one green button, point the phone at the device and just talk. Claude watches the live video, finds the model, looks up the manual and guides them one step at a time, out loud.

## What it does
- Looks and feels like a normal video call: your camera fills the screen, the helper sits in a small tile.
- **Live video:** the camera streams continuously. While you talk, the app keeps the last few seconds of frames and sends them with what you said, so Claude sees what you're pointing at, including movement.
- **Voice in, voice out:** speech recognition and speech synthesis built into the browser. No typing needed. A text box is there as a backup.
- **Looks things up:** once it knows the brand and model, Claude can search the web for the manual or known fixes.
- Short, kind, one-step-at-a-time answers. Safety reminders (unplug first, go to a repair shop if it's risky).
- English and German.

## How Claude is used
- **Model:** `claude-opus-5-5` with low effort for fast replies (change with `FIXIE_MODEL` in `.env`).
- **Input:** what the caller said (speech-to-text) plus 3 recent JPEG frames from the live camera stream.
- **Tools:** Anthropic's server-side **web search** to find manuals and fixes.
- **Output:** 1 to 3 spoken sentences, read aloud by the browser.
- The personality and rules are in [`prompts/system.md`](prompts/system.md). Edit that file to change how Fixie behaves.

## How to run it
```bash
cp .env.example .env              # paste your ANTHROPIC_API_KEY into .env
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --reload --host 0.0.0.0 --port 8000
```
Open **http://localhost:8000** in **Chrome** and press *Call Fixie*.

**On an Android phone (the main way to use it):** browsers only allow the camera on `https://` (or localhost). Expose your laptop with a tunnel, then open the https link in Chrome on the phone:
```bash
npx localtunnel --port 8000        # or: cloudflared tunnel --url http://localhost:8000  /  ngrok http 8000
```
In Chrome's menu tap **Install app** (or *Add to Home screen*). Fixie then gets its own icon and opens full-screen like a normal calling app. The screen stays on during the call.

*Why a web app and not native Kotlin?* With one day, an installable web app gives the same experience on Android (camera, mic, full-screen, home-screen icon) without an app store or build tools, and also runs on any laptop for judges.

## How it works
```
 Browser (static/)                                       Server (server.py)            Claude
 ┌─────────────────────────────────────────────┐
 │ camera stream ──▶ frame buffer (1/sec)       │
 │ mic ──▶ SpeechRecognition ──▶ pause 1.3 s ──┼──▶ POST /api/turn ──────────▶ messages API
 │                         text + last 3 frames │      keeps the call history     (vision + web search)
 │ speechSynthesis ◀── reply text ◀─────────────┼──◀──────────────────────────◀
 └─────────────────────────────────────────────┘
```

| File | What it is | Who usually edits it |
|---|---|---|
| `static/index.html`, `static/style.css` | The call screen | product / design |
| `static/app.js` | Camera, voice, call loop | builder |
| `server.py` | Talks to Claude | builder |
| `prompts/system.md` | Fixie's personality and rules | domain expert, anyone |
| `README.md` | This file | founder |

## Screenshots / demo
**Pitch deck:** [`pitch/fixie-pitch-deck.html`](pitch/fixie-pitch-deck.html) (download and open in a browser).

<Add a screenshot and the 2-minute demo video link here.>

## Team
| Name | Role / background |
|---|---|
| [Yuliia Ivanova](https://github.com/juliaivanova) | Domain expert |
| [Mariel Breuer](https://github.com/marielbreuer) | Product / design |
| [Danial Darabi](https://github.com/drdanial97) | Builder |
| [Eva-Valérie Gfrerer](https://de.linkedin.com/in/eva-gfrerer) | Founder |
| [JJ Lehmann](https://github.com/lehmann-jj) | Builder |

## Credits
- [Anthropic Claude API](https://docs.claude.com) (vision + web search)
- [FastAPI](https://fastapi.tiangolo.com/), [Uvicorn](https://www.uvicorn.org/), [python-dotenv](https://github.com/theskumar/python-dotenv)
- Browser Web Speech API (SpeechRecognition + speechSynthesis) and getUserMedia
