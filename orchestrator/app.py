"""
Luna's orchestrator -- Phase 1 scope only.

No LLM yet (that's Phase 2). This just proves the pipe works: the shell
sends what you typed, this replies with a canned line synthesized through
the placeholder TTS in tts.py, and the shell plays it back with lipsync.

Binds to 127.0.0.1 only, on purpose -- never expose this beyond localhost,
per the project's local-only, non-negotiable constraint (see CLAUDE.md).
"""

import base64
import random

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from tts import synthesize

app = FastAPI()

HOST = "127.0.0.1"
PORT = 8765

# Stand-ins until Phase 2 wires up a real model. Written in Luna's voice
# already so the persona work in Phase 6 has a reference point.
CANNED_REPLIES = [
    "H-hmph. About time you got the shell working. Not that I was waiting or anything.",
    "Oh, you actually got this far? ...Fine, I'm a little impressed.",
    "Don't get used to me talking this much -- I'm still just a placeholder brain in here.",
    "Testing, testing. Once you wire up a real model I'll actually be worth listening to.",
]


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") != "user_text":
                continue

            reply_text = random.choice(CANNED_REPLIES)
            audio_bytes = await synthesize(reply_text)

            await websocket.send_json(
                {
                    "type": "speak",
                    "text": reply_text,
                    "audio_b64": base64.b64encode(audio_bytes).decode("ascii"),
                    "mime": "audio/wav",
                }
            )
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
