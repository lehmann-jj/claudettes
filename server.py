"""Fixie backend: one endpoint that takes what the caller said + a camera frame,
asks Claude, and returns what the helper should say back.

Run:  .venv/bin/uvicorn server:app --reload --port 8000
"""
import os
import re
import uuid
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

ROOT = Path(__file__).parent
SYSTEM_PROMPT = (ROOT / "prompts" / "system.md").read_text()
MODEL = os.getenv("FIXIE_MODEL", "claude-opus-5-5")

client = anthropic.Anthropic()
app = FastAPI()

# Conversation history per call, kept server-side and append-only
# (we never edit earlier turns, so thinking blocks stay valid).
SESSIONS: dict[str, list] = {}

# Claude can mark a spot in the latest camera frame: [[point x=520 y=310 label="power button"]]
POINT_RE = re.compile(r'\[\[point\s+x=(\d+)\s+y=(\d+)(?:\s+label="([^"]*)")?\s*\]\]')


def extract_point(reply: str) -> tuple[str, dict | None]:
    m = POINT_RE.search(reply)
    if not m:
        return reply, None
    x, y = min(int(m[1]), 1000) / 1000, min(int(m[2]), 1000) / 1000
    return POINT_RE.sub("", reply).strip(), {"x": x, "y": y, "label": m[3] or ""}


class Turn(BaseModel):
    session_id: str | None = None
    text: str
    images_b64: list[str] = []  # recent camera frames from the live stream, oldest first (JPEG, no data: prefix)


@app.post("/api/turn")
def turn(t: Turn):
    sid = t.session_id or str(uuid.uuid4())
    messages = SESSIONS.setdefault(sid, [])
    start = len(messages)

    frames = t.images_b64[-4:]
    content = []
    for i, img in enumerate(frames):
        label = "Live camera now:" if i == len(frames) - 1 else f"Camera, {len(frames) - 1 - i}s earlier:"
        content.append({"type": "text", "text": label})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img}})
    content.append({"type": "text", "text": t.text or "(caller is silent, just showing the camera)"})
    messages.append({"role": "user", "content": content})

    try:
        # Loop only for pause_turn (long web searches); normally runs once.
        for _ in range(3):
            resp = client.beta.messages.create(
                model=MODEL,
                max_tokens=2000,
                system=SYSTEM_PROMPT,
                messages=messages,
                tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 2}],
                output_config={"effort": "low"},  # low latency matters more than depth on a call
                betas=["server-side-fallback-2026-07-01"],
                extra_body={"fallbacks": "default", "cache_control": {"type": "ephemeral"}},
            )
            messages.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason != "pause_turn":
                break
    except anthropic.APIError as e:
        del messages[start:]  # roll back this turn so history stays valid
        print("Claude API error:", repr(e))
        return JSONResponse(
            {"session_id": sid, "reply": "Sorry, the line is a bit crackly. Could you say that again?", "error": str(e)},
            status_code=200,
        )

    if resp.stop_reason == "refusal":
        reply = "Hmm, I can't help with that one. Shall we try something else?"
    else:
        reply = " ".join(b.text for b in resp.content if b.type == "text").strip()
    reply, point = extract_point(reply)
    searched = any(b.type == "server_tool_use" for b in resp.content)
    return {"session_id": sid, "reply": reply or "Mm-hm, go on.", "point": point, "searched": searched}


@app.post("/api/hangup")
def hangup(t: Turn):
    SESSIONS.pop(t.session_id or "", None)
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


# Served from the root so the installed Android app covers the whole site.
@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(ROOT / "static" / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(ROOT / "static" / "sw.js", media_type="text/javascript")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
