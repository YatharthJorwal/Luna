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
class TTSConfig:
    engine: str


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
        raw: dict[str, Any] = yaml.safe_load(f)

    return Config(
        llm=LLMConfig(**raw["llm"]),
        tts=TTSConfig(**raw["tts"]),
        session=SessionConfig(**raw["session"]),
    )


# Loaded once at import time -- restart the orchestrator to pick up edits
# to config.yaml (no hot-reload; not worth the complexity for a single-user
# local app).
CONFIG = load_config()
