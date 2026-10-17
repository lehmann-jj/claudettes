"""Make a LiveKit Meet join link + QR code for a fresh room (Fixie auto-joins new rooms).

Run:  .venv/bin/python join_link.py   -> prints the link, writes join_qr.svg and opens it
"""
import datetime
import os
import subprocess
import urllib.parse
import uuid
from pathlib import Path

import qrcode
import qrcode.image.svg
from dotenv import load_dotenv
from livekit import api

load_dotenv(Path(__file__).parent.parent / ".env")

room = "fixie-" + uuid.uuid4().hex[:6]
token = (
    api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
    .with_identity("caller-" + uuid.uuid4().hex[:4])
    .with_name("Caller")
    .with_grants(api.VideoGrants(room_join=True, room=room))
    .with_ttl(datetime.timedelta(hours=2))
    .to_jwt()
)
url = "https://meet.livekit.io/custom?" + urllib.parse.urlencode({"liveKitUrl": os.environ["LIVEKIT_URL"], "token": token})
qr = Path(__file__).parent / "join_qr.svg"
qrcode.make(url, image_factory=qrcode.image.svg.SvgPathFillImage).save(qr)
print(f"Room: {room}\nLink (valid 2h): {url}\nQR code: {qr}")
subprocess.Popen(["xdg-open", str(qr)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
