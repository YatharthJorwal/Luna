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

Phase 2.5 adds voice input: a `user_audio` message (base64 WAV/WebM bytes
from the frontend's MediaRecorder) is transcribed via faster-whisper
(stt.py) and fed into the exact same turn-handling path as `user_text` --
see `_run_turn()` below, shared by both message types.

Binds to 127.0.0.1 only, on purpose -- never expose this beyond localhost,
per the project's local-only, non-negotiable constraint (see CLAUDE.md).
"""

import base64
import sys

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import llm
import stt
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

# Said if STT itself throws -- most likely stt.device: "cuda" in
# config.yaml but the CUDA cuBLAS/cuDNN DLLs aren't on PATH (see README's
# troubleshooting section), or a corrupted first-time model download.
# Without this, a failure here used to kill the websocket connection
# outright with nothing visible on the user's side at all -- see
# stt.STTError's docstring.
STT_UNREACHABLE_LINE = (
    "I-I can't hear anything right now, something's wrong with my ears. "
    "Check the orchestrator terminal?"
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


async def _run_turn(
    websocket: WebSocket, history: list[dict[str, str]], user_text: str
) -> None:
    """The actual agent turn: append user_text to history, stream the LLM
    reply, speak each sentence chunk as it's ready, commit (or roll back)
    history. Shared by both `user_text` (typed) and `user_audio`
    (transcribed) messages -- by the time this runs, there's no difference
    between the two."""
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


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    history: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "user_text":
                user_text = (data.get("text") or "").strip()
                if not user_text:
                    continue
                await _run_turn(websocket, history, user_text)

            elif msg_type == "user_audio":
                audio_b64 = data.get("audio_b64") or ""
                if not audio_b64:
                    continue
                try:
                    audio_bytes = base64.b64decode(audio_b64)
                except ValueError:
                    # Malformed base64 -- nothing recoverable, drop it.
                    continue

                try:
                    user_text = (await stt.transcribe(audio_bytes)).strip()
                except stt.STTError as exc:
                    print(f"[luna] STT failed: {exc}", file=sys.stderr)
                    await websocket.send_json({"type": "transcript", "text": ""})
                    await _send_speak(websocket, apply_persona_pass(STT_UNREACHABLE_LINE))
                    continue

                # Always echo the transcript back, even empty, so the
                # frontend can clear its "listening" indicator either way.
                await websocket.send_json({"type": "transcript", "text": user_text})
                if not user_text:
                    # Silence, noise, or nothing intelligible -- nothing to
                    # reply to, and nothing worth adding to history.
                    continue
                await _run_turn(websocket, history, user_text)
            else:
                continue
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
