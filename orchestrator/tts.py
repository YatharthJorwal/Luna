"""
TTS backends. `synthesize(text) -> bytes` (WAV) is the only thing app.py
calls, regardless of which engine is active -- picked by config.yaml's
tts.engine, same pattern as the LLM's config-driven backend choice.

- "pyttsx3": Phase 1's placeholder. Drives whatever TTS engine the OS
  already has (SAPI5 on Windows) -- no model download, works immediately,
  sounds robotic. Also used as an automatic fallback if the configured
  engine is "gpt_sovits" but its API server can't be reached, so a
  turn never goes silent just because that server isn't running --
  see _synthesize_gpt_sovits's caller in synthesize() below.
- "gpt_sovits": real cloned voice, via GPT-SoVITS's own API server
  (https://github.com/RVC-Boss/GPT-SoVITS) running as a separate local
  process -- not embedded here. Request/response shape confirmed by
  reading a real reference implementation (rayenfeng/riko_project) rather
  than assumed: POST {api_url} with
  {text, text_lang, ref_audio_path, prompt_text, prompt_lang}, raw WAV
  bytes back. ref_audio_path/prompt_text point at your reference clip and
  its exact transcript -- fill those into config.yaml's tts.gpt_sovits
  block once you have a clip you're happy with (see docs/MODELS.md).
"""

import asyncio
import os
import tempfile

import httpx
import pyttsx3

from config import CONFIG


class TTSUnreachableError(Exception):
    """The configured TTS backend's server couldn't be reached or errored
    out. synthesize() catches this itself for the gpt_sovits engine and
    falls back to pyttsx3 rather than letting a turn go silent -- callers
    in app.py don't need to handle this directly."""


def _synthesize_pyttsx3_sync(text: str) -> bytes:
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


async def _synthesize_gpt_sovits(text: str) -> bytes:
    cfg = CONFIG.tts.gpt_sovits
    payload = {
        "text": text,
        "text_lang": cfg.text_lang,
        "ref_audio_path": cfg.ref_audio_path,
        "prompt_text": cfg.prompt_text,
        "prompt_lang": cfg.prompt_lang,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0)) as client:
            response = await client.post(cfg.api_url, json=payload)
            if response.status_code >= 400:
                raise TTSUnreachableError(
                    f"{response.status_code} from {cfg.api_url}: {response.text[:300]!r}"
                )
            return response.content
    except httpx.RequestError as exc:
        raise TTSUnreachableError(f"couldn't reach {cfg.api_url}: {exc}") from exc


async def synthesize(text: str) -> bytes:
    """Returns WAV bytes for `text` from whichever engine config.yaml's
    tts.engine selects. Runs pyttsx3's blocking engine in a thread so it
    doesn't stall the websocket event loop."""
    if CONFIG.tts.engine == "gpt_sovits":
        try:
            return await _synthesize_gpt_sovits(text)
        except TTSUnreachableError:
            # Fall back to pyttsx3 for this one line rather than letting the
            # turn go silent -- she still says the actual reply, just in the
            # placeholder voice for that line. Not logged specially here;
            # a real logging pass is a Phase 6 perf-pass concern, not this.
            pass

    return await asyncio.to_thread(_synthesize_pyttsx3_sync, text)
