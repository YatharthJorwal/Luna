"""
Loads config.yaml into a typed Config object. Every model/engine choice
lives in that one file (see CLAUDE.md's working agreement) -- nothing
downstream of this module should hardcode an endpoint, model name, or
engine.
"""

from __future__ import annotations

import pathlib
from dataclasses import dataclass, field
from typing import Any

import yaml

_CONFIG_PATH = pathlib.Path(__file__).parent / "config.yaml"


@dataclass(frozen=True)
class LLMConfig:
    base_url: str
    model: str
    api_key: str
    temperature: float
    max_tokens: int
    api_style: str  # "ollama_native" | "openai"
    think: bool | None
    # The context window (in tokens) sent to Ollama as options.num_ctx on
    # EVERY call to the model -- chat, tool-calling, vision and the small
    # background classifiers alike. It must be the same value everywhere:
    # Ollama reloads the model whenever consecutive requests disagree on
    # it. Defaulted (not required) so an older config.yaml without the key
    # keeps loading; None means "don't send it, use the server's default"
    # (which is how replies were silently cut off with done_reason
    # 'length' once the history outgrew an unknown default -- see
    # docs/DECISIONS.md). Only honored with api_style: ollama_native.
    num_ctx: int | None = 8192
    # Optional separate model for everything that looks at an image (screen
    # looks, Continuous OCR, Task Guide, camera, uploads). None = use `model`
    # (the single-model setup). Needed when `model` is a text-only build, e.g.
    # a community GGUF without the vision projector. Keep it small enough to
    # stay in VRAM next to `model` and GPT-SoVITS: if the two don't fit
    # together, Ollama swaps them per request and every look pays a reload.
    vision_model: str | None = None
    # Load the chat model into VRAM when the orchestrator starts, so the first
    # message isn't a multi-second (or, for a big quant, request-timing-out)
    # cold load. Defaulted so an older config.yaml keeps loading.
    warm_up_on_start: bool = True


@dataclass(frozen=True)
class GPTSoVITSConfig:
    api_url: str
    ref_audio_path: str
    prompt_text: str
    prompt_lang: str
    text_lang: str


@dataclass(frozen=True)
class TTSConfig:
    engine: str
    gpt_sovits: GPTSoVITSConfig


@dataclass(frozen=True)
class STTConfig:
    model_size: str
    device: str
    compute_type: str
    language: str | None


@dataclass(frozen=True)
class SessionConfig:
    max_history_turns: int
    user_name: str
    # How many unprompted comments (Task Guide chides + Continuous OCR
    # remarks -- assistant turns with no user turn before them) are kept
    # in history at once; older ones are dropped. They carry little
    # information, flood the context, and stacked together they make the
    # model invent a dialogue partner. Defaulted so old configs still load.
    max_unprompted_in_history: int = 3


@dataclass(frozen=True)
class EmbeddingConfig:
    base_url: str
    model: str
    dimension: int


@dataclass(frozen=True)
class MemoryConfig:
    db_path: str
    recall_top_k: int
    embedding: EmbeddingConfig


@dataclass(frozen=True)
class TaskGuideConfig:
    # Phase 4 Round 2 -- how often (while a task is actively tracked,
    # see task_guide.py) the scheduled loop captures the screen and
    # compares it against the tracked step. ARCHITECTURE.md's Task Guide
    # Mode section suggests starting conservative (60-120s).
    capture_interval_seconds: int
    # If no real user turn happens for this long while a task is
    # tracked, the task is silently dropped (no chide) rather than kept
    # active forever nagging someone who has stepped away.
    idle_timeout_seconds: int


@dataclass(frozen=True)
class OCRWatchConfig:
    # Quick-action menu's Continuous OCR toggle (ocr_watch.py) -- how
    # often, in seconds, the orchestrator glances at the screen while
    # watching is on. Deliberately much longer than task_guide's own
    # capture_interval_seconds -- this is ambient commentary, not
    # goal-directed drift-checking, and should be rare by design. 240 =
    # 4 minutes; tune up if it ever feels naggy (the more likely
    # direction to need tuning, given the user's own "low stakes" framing
    # for this feature), down if genuinely interesting moments are being
    # missed.
    comment_interval_seconds: int
    # Hard floor between two SPOKEN comments, enforced in code. The model
    # was observed saying "worth a comment" on 12 of 15 checks, five times
    # in a row about an unchanged screen, so the prompt alone can't be
    # trusted to keep her quiet. All three keys below are defaulted so an
    # older config.yaml keeps loading.
    min_comment_gap_seconds: int = 120
    # Two consecutive screen summaries whose content words overlap at least
    # this much (Jaccard, 0-1) count as "the same screen" -> no comment.
    same_screen_similarity: float = 0.6
    # Skip ambient checks entirely while a Task Guide task is active: Task
    # Guide already watches the screen, and both commenting on the same
    # screen within a minute is redundant (and doubles the vision calls).
    pause_during_task: bool = True


@dataclass(frozen=True)
class VisionConfig:
    """How big a screenshot is when the model sees it. Image cost grows with
    pixel count (a 1080p PNG is ~2.6k image tokens and a slow encode); the
    original code sent every capture at full resolution as PNG, which made
    Continuous OCR and Task Guide slow. All defaulted so an older config.yaml
    keeps loading."""

    # Longest side, in pixels, for background glances (Continuous OCR, Task
    # Guide) -- enough to tell what app and roughly what is on screen.
    ambient_max_long_edge: int = 1024
    # Longest side for an explicit "look at my screen" -- sharper, so small
    # text is more readable. 0 = never downscale.
    look_max_long_edge: int = 1600
    jpeg_quality: int = 85


@dataclass(frozen=True)
class Config:
    llm: LLMConfig
    tts: TTSConfig
    stt: STTConfig
    session: SessionConfig
    memory: MemoryConfig
    task_guide: TaskGuideConfig
    ocr_watch: OCRWatchConfig
    # Last and defaulted: a config.yaml written before this section existed
    # must keep loading.
    vision: VisionConfig = field(default_factory=VisionConfig)


def load_config(path: pathlib.Path = _CONFIG_PATH) -> Config:
    with open(path, "r", encoding="utf-8") as f:
        raw_text = f.read()

    try:
        raw: dict[str, Any] = yaml.safe_load(raw_text)
    except yaml.YAMLError as exc:
        # The single most likely cause by far: a Windows path pasted into a
        # double-quoted YAML string. YAML double-quotes treat backslashes as
        # C-style escapes (\U, \D, etc. all mean something), so
        # "C:\Users\..." silently isn't the literal string it looks like --
        # PyYAML errors trying to parse \U as a hex escape. Single-quoted
        # strings don't have this problem at all (no escape processing), so
        # that's the fix: change any "C:\..." path in this file to
        # 'C:\...' (single quotes) instead. Surfacing that here rather than
        # just letting the ScannerError trace speak for itself, since this
        # exact mistake reproduced on the very first real config edit.
        raise RuntimeError(
            f"{path} failed to parse as YAML: {exc}\n\n"
            "If this mentions an 'escape sequence' and you have a Windows "
            "path (like C:\\Users\\...) in this file: double-quoted YAML "
            "strings treat backslashes as escape codes, so that path isn't "
            "literal. Switch it to single quotes instead -- "
            "'C:\\Users\\...' -- which don't have this problem, or use "
            "forward slashes."
        ) from exc

    raw_tts = dict(raw["tts"])
    raw_tts["gpt_sovits"] = GPTSoVITSConfig(**raw_tts["gpt_sovits"])

    raw_memory = dict(raw["memory"])
    raw_memory["embedding"] = EmbeddingConfig(**raw_memory["embedding"])

    return Config(
        llm=LLMConfig(**raw["llm"]),
        tts=TTSConfig(**raw_tts),
        stt=STTConfig(**raw["stt"]),
        session=SessionConfig(**raw["session"]),
        memory=MemoryConfig(**raw_memory),
        task_guide=TaskGuideConfig(**raw["task_guide"]),
        ocr_watch=OCRWatchConfig(**raw["ocr_watch"]),
        vision=VisionConfig(**(raw.get("vision") or {})),
    )


# Loaded once at import time -- restart the orchestrator to pick up edits
# to config.yaml (no hot-reload; not worth the complexity for a single-user
# local app).
CONFIG = load_config()
