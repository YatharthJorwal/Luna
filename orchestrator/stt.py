"""
Speech-to-text via faster-whisper. `transcribe(audio_bytes) -> str` is the
only thing app.py calls -- mirrors tts.py's `synthesize()` shape: one
function, config-driven, doesn't leak the underlying library upward.

API shape (model_size/device/compute_type, `.transcribe()` returning
segments to join) confirmed against a real reference implementation, not
assumed -- see docs/DECISIONS.md and docs/MODELS.md's STT section.

Model loading is lazy (first call to transcribe(), not import time like
config.py's CONFIG) -- WhisperModel() pulls weights from Hugging Face on
first-ever run and takes a real moment to load onto CPU/GPU after that, and
unlike the LLM/TTS configs there's no reason to pay that cost at orchestrator
startup for a feature the user might not use in a given session.
"""

from __future__ import annotations

import asyncio
import io

from faster_whisper import WhisperModel

from config import CONFIG

_model: WhisperModel | None = None


class STTError(Exception):
    """Wraps any failure from model construction or transcription -- a
    missing CUDA DLL (cuBLAS/cuDNN), a corrupted/incomplete first-time
    model download, or anything else faster-whisper/CTranslate2 can throw.
    One exception type for app.py to catch, same pattern llm.py's
    LLMUnreachableError and tts.py's TTSUnreachableError already use.
    Without this, an exception here was propagating all the way up through
    the websocket's receive loop in app.py and killing the connection
    outright -- silently, from the user's side: the mic would record fine,
    nothing would come back, and there was no error anywhere they'd
    actually see it."""


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        cfg = CONFIG.stt
        _model = WhisperModel(cfg.model_size, device=cfg.device, compute_type=cfg.compute_type)
    return _model


def _transcribe_sync(audio_bytes: bytes) -> str:
    model = _get_model()
    # A file-like object is enough -- faster-whisper decodes whatever
    # container/codec it's given (via PyAV, which bundles its own ffmpeg)
    # and resamples to the 16kHz mono its feature extractor wants, so the
    # WebM/Opus blob MediaRecorder produces in the frontend doesn't need any
    # conversion on this end. No temp file needed either.
    segments, _info = model.transcribe(
        io.BytesIO(audio_bytes),
        language=CONFIG.stt.language,
    )
    # segments is a generator; each segment's .text already has its own
    # leading space from faster-whisper's tokenizer, so join without adding
    # more, then collapse the whole thing's outer whitespace once.
    return "".join(segment.text for segment in segments).strip()


async def transcribe(audio_bytes: bytes) -> str:
    """Runs faster-whisper's blocking transcribe() in a thread so it doesn't
    stall the websocket event loop -- same pattern as tts.py's pyttsx3
    path. Returns "" (not an error) for silence/unintelligible audio --
    there's nothing wrong, just nothing to reply to. Raises STTError (not
    the raw underlying exception) for anything that actually went wrong,
    e.g. the model failing to load at all."""
    try:
        return await asyncio.to_thread(_transcribe_sync, audio_bytes)
    except Exception as exc:
        raise STTError(str(exc)) from exc
