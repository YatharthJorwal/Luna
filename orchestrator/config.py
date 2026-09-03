"""
Loads config.yaml into a typed Config object. Every model/engine choice
lives in that one file (see CLAUDE.md's working agreement) -- nothing
downstream of this module should hardcode an endpoint, model name, or
engine.
"""

from __future__ import annotations

import pathlib
from dataclasses import dataclass
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
class SessionConfig:
    max_history_turns: int


@dataclass(frozen=True)
class Config:
    llm: LLMConfig
    tts: TTSConfig
    session: SessionConfig


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

    return Config(
        llm=LLMConfig(**raw["llm"]),
        tts=TTSConfig(**raw_tts),
        session=SessionConfig(**raw["session"]),
    )


# Loaded once at import time -- restart the orchestrator to pick up edits
# to config.yaml (no hot-reload; not worth the complexity for a single-user
# local app).
CONFIG = load_config()
