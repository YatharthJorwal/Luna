"""
Phase 1 placeholder TTS: pyttsx3, which drives whatever TTS engine the OS
already has (SAPI5 on Windows -- no model download, works immediately).

This is deliberately NOT the final voice. CLAUDE.md's plan is GPT-SoVITS
(few-shot voice cloning) for the real Luna voice -- swap `synthesize()`'s
implementation for that server call once you're past proving the shell/audio
pipeline works. Keep the function signature the same and nothing upstream
(app.py, the frontend) needs to change.
"""

import asyncio
import os
import tempfile

import pyttsx3


def _synthesize_sync(text: str) -> bytes:
    # Re-initializing per call is a little wasteful but far more reliable
    # than reusing one pyttsx3 engine across calls, which is known to hang
    # on some SAPI5 setups after the first use.
    engine = pyttsx3.init()
    engine.setProperty("rate", 175)

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        engine.save_to_file(text, path)
        engine.runAndWait()
        with open(path, "rb") as f:
            return f.read()
    finally:
        engine.stop()
        try:
            os.remove(path)
        except OSError:
            pass


async def synthesize(text: str) -> bytes:
    """Returns WAV bytes for `text`. Runs the blocking engine in a thread
    so it doesn't stall the websocket event loop."""
    return await asyncio.to_thread(_synthesize_sync, text)
