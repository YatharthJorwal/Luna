"""
Luna's orchestrator -- Phase 2.

Real LLM conversation now: user text is appended to a per-connection
session history (system prompt from persona.py + prior turns), sent to the
configured OpenAI-compatible chat endpoint (config.yaml / llm.py), and the
reply streams back token-by-token. Tokens are chunked into sentence-ish
pieces (chunking.py) so TTS/lipsync can start on the first sentence
instead of waiting for the whole reply -- each chunk goes to the shell as
its own `speak` message (src/main.ts queues and plays them back to back,
not overlapping).

Memory is session-only: history lives in a plain Python list tied to the
websocket connection and is gone when it disconnects. Durable memory
across restarts is Phase 3 -- no tools yet either, that's Phase 4.

Binds to 127.0.0.1 only, on purpose -- never expose this beyond localhost,
per the project's local-only, non-negotiable constraint (see CLAUDE.md).
"""

import base64

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import llm
from chunking import extract_ready_chunks, flush
from config import CONFIG
from persona import SYSTEM_PROMPT, apply_persona_pass
from tts import synthesize

app = FastAPI()

HOST = "127.0.0.1"
PORT = 8765

# Said if the configured LLM server can't be reached at all -- most likely
# it just isn't running yet. In character on purpose so a first-run miss
# (forgot to start Ollama) feels like her, not a crash.
LLM_UNREACHABLE_LINE = (
    "H-hey -- I can't reach my own brain right now. Is the model server "
    "even running? Check the orchestrator terminal and try again."
)


async def _send_speak(websocket: WebSocket, text: str) -> None:
    audio_bytes = await synthesize(text)
    await websocket.send_json(
        {
            "type": "speak",
            "text": text,
            "audio_b64": base64.b64encode(audio_bytes).decode("ascii"),
            "mime": "audio/wav",
        }
    )


def _trim_history(history: list[dict[str, str]]) -> None:
    """Keeps the system prompt plus the last N (user, assistant) turns.
    Session memory only (Phase 3 adds durable memory), but still needs a
    cap so a long session doesn't grow the LLM's context unbounded."""
    system, turns = history[0], history[1:]
    max_messages = CONFIG.session.max_history_turns * 2
    if len(turns) > max_messages:
        turns = turns[-max_messages:]
    history[:] = [system] + turns


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    history: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]

    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") != "user_text":
                continue
            user_text = (data.get("text") or "").strip()
            if not user_text:
                continue

            history.append({"role": "user", "content": user_text})

            buffer = ""
            reply_parts: list[str] = []
            try:
                async for delta in llm.stream_reply(history):
                    buffer += delta
                    chunks, buffer = extract_ready_chunks(buffer)
                    for chunk in chunks:
                        reply_parts.append(chunk)
                        await _send_speak(websocket, apply_persona_pass(chunk))
                for chunk in flush(buffer):
                    reply_parts.append(chunk)
                    await _send_speak(websocket, apply_persona_pass(chunk))
            except llm.LLMUnreachableError:
                await _send_speak(websocket, LLM_UNREACHABLE_LINE)

            if reply_parts:
                history.append({"role": "assistant", "content": " ".join(reply_parts)})
            else:
                # Nothing usable came back (LLM unreachable, or a genuinely
                # empty response) -- drop the dangling user turn rather than
                # leave a one-sided exchange in context for next time.
                history.pop()

            _trim_history(history)
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
