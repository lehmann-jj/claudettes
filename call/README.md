# Fixie as a real video call (LiveKit) · experimental branch

The main app (repo root) does the call in the browser. This version makes it a **real WebRTC video call**:
Fixie joins a LiveKit room as a participant, hears you, watches your camera and talks back.

```
phone/laptop (camera + mic) ──WebRTC──▶ LiveKit Cloud ◀──▶ agent.py
                                                           speech-to-text (Deepgram, via LiveKit Inference)
                                                           Claude claude-opus-5-5 + latest video frame each turn
                                                           text-to-speech (Cartesia, via LiveKit Inference)
```

## Run it
1. Free LiveKit Cloud account (no credit card): https://cloud.livekit.io → create a project →
   Settings → API Keys. Add to the repo's `.env`:
   ```
   LIVEKIT_URL=wss://<your-project>.livekit.cloud
   LIVEKIT_API_KEY=...
   LIVEKIT_API_SECRET=...
   ```
   (`ANTHROPIC_API_KEY` is already there.) Speech-to-text and text-to-speech come with LiveKit's free credits.
2. Start the agent:
   ```bash
   cd call
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   .venv/bin/python agent.py download-files   # once: voice activity model
   .venv/bin/python agent.py dev
   ```
3. Call it: open https://agents-playground.livekit.io (works in Chrome on Android too), connect to your
   project, turn on camera and mic. Fixie joins and greets you.

## Credits
[LiveKit Agents](https://github.com/livekit/agents) (Apache 2.0), Silero VAD, Deepgram and Cartesia via LiveKit Inference, Anthropic Claude.
