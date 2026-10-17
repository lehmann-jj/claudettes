"""Fixie as a real video call (LiveKit).

Fixie joins a LiveKit room as a participant. It hears the caller (speech-to-text),
watches their camera (latest video frame goes to Claude with every turn),
and talks back (text-to-speech).

Run:  .venv/bin/python agent.py dev
Then join the room from https://agents-playground.livekit.io (camera + mic on).
"""
import asyncio
from pathlib import Path

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import Agent, AgentServer, AgentSession, room_io
from livekit.agents.llm import ChatContext, ChatMessage, ImageContent
from livekit.plugins import anthropic, silero

ROOT = Path(__file__).parent.parent
load_dotenv(ROOT / ".env")

PROMPT = (ROOT / "prompts" / "system.md").read_text() + """
This is a real-time video call. With each thing the caller says, you get the latest frame of their live video.
You cannot search the web on this call, so rely on what you know about the device and what you see.
"""


class FastClaude(anthropic.LLM):
    """Claude with low effort: on a call, a quick answer matters more than a deep one."""

    def chat(self, *args, extra_kwargs=None, **kwargs):
        extra = dict(extra_kwargs or {})
        extra.setdefault("output_config", {"effort": "low"})
        return super().chat(*args, extra_kwargs=extra, **kwargs)


class Fixie(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=PROMPT)
        self.latest_frame: rtc.VideoFrame | None = None
        self._video_task: asyncio.Task | None = None

    async def on_enter(self) -> None:
        room = self.session.room_io.room

        def watch(track: rtc.Track) -> None:
            if track.kind != rtc.TrackKind.KIND_VIDEO:
                return
            if self._video_task:
                self._video_task.cancel()
            self._video_task = asyncio.create_task(self._keep_latest_frame(track))

        # Camera may already be on, or turn on later.
        for p in room.remote_participants.values():
            for pub in p.track_publications.values():
                if pub.track:
                    watch(pub.track)
        room.on("track_subscribed", lambda track, pub, participant: watch(track))

        await self.session.generate_reply(
            instructions="Greet the caller warmly as Fixie, say in a few words that you are an AI helper, and ask what isn't working. Keep it short."
        )

    async def _keep_latest_frame(self, track: rtc.Track) -> None:
        async for event in rtc.VideoStream(track):
            self.latest_frame = event.frame

    async def on_user_turn_completed(self, turn_ctx: ChatContext, new_message: ChatMessage) -> None:
        # Attach what the camera shows right now to what the caller just said.
        if self.latest_frame is not None:
            new_message.content.append(ImageContent(image=self.latest_frame))


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: agents.JobContext) -> None:
    session = AgentSession(
        stt="deepgram/nova-3:multi",  # LiveKit Inference: no extra API key needed
        llm=FastClaude(model="claude-opus-5-5"),
        tts="cartesia/sonic-3",
        vad=silero.VAD.load(),
    )
    await session.start(
        agent=Fixie(),
        room=ctx.room,
        room_options=room_io.RoomOptions(video_input=True),
    )


if __name__ == "__main__":
    agents.cli.run_app(server)
