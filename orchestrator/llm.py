"""
Async streaming client for the configured local LLM server. Supports two
wire protocols, picked by config.yaml's llm.api_style:

- "openai": the generic OpenAI-compatible /v1/chat/completions shape --
  SSE `data: {...}` lines, `[DONE]` sentinel. Works against Ollama or a
  llama.cpp server, since both speak it.
- "ollama_native": Ollama's own /api/chat -- NDJSON (one JSON object per
  line, no `data:` prefix), a `"done": true` flag on the final line
  instead of a sentinel. Ollama-only.

Why bother with two: Ollama's /v1 endpoint unreliably forwards the
"disable thinking" flag for hybrid-thinking models (confirmed via several
open Ollama issues as of mid-2026 -- see docs/DECISIONS.md), where the
native /api/chat is confirmed to honor it. config.yaml's llm.think is only
sent -- and only reliably honored -- in "ollama_native" mode.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import httpx

from config import CONFIG


class LLMUnreachableError(Exception):
    """The configured LLM server couldn't be reached or returned an error
    response -- most likely it just isn't running yet. Kept distinct from
    other exceptions so app.py can give an in-character, specific reply
    instead of the connection crashing silently."""


async def stream_reply(messages: list[dict[str, str]]) -> AsyncIterator[str]:
    """Streams content-delta strings from the configured LLM server as they
    arrive. Raises LLMUnreachableError if the server can't be reached or
    errors out."""
    if CONFIG.llm.api_style == "ollama_native":
        gen = _stream_ollama_native(messages)
    else:
        gen = _stream_openai(messages)

    async for delta in gen:
        yield delta


async def _stream_openai(messages: list[dict[str, str]]) -> AsyncIterator[str]:
    url = f"{CONFIG.llm.base_url.rstrip('/')}/v1/chat/completions"
    payload = {
        "model": CONFIG.llm.model,
        "messages": messages,
        "temperature": CONFIG.llm.temperature,
        "max_tokens": CONFIG.llm.max_tokens,
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {CONFIG.llm.api_key}"}

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0)) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as response:
                if response.status_code >= 400:
                    body = await response.aread()
                    raise LLMUnreachableError(
                        f"{response.status_code} from {url}: {body[:300]!r}"
                    )
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[len("data: "):].strip()
                    if data == "[DONE]":
                        break
                    chunk = _parse_json(data)
                    delta = _extract_openai_delta(chunk)
                    if delta:
                        yield delta
    except httpx.RequestError as exc:
        raise LLMUnreachableError(f"couldn't reach {url}: {exc}") from exc


async def _stream_ollama_native(messages: list[dict[str, str]]) -> AsyncIterator[str]:
    url = f"{CONFIG.llm.base_url.rstrip('/')}/api/chat"
    payload: dict[str, Any] = {
        "model": CONFIG.llm.model,
        "messages": messages,
        "stream": True,
        "options": {
            "temperature": CONFIG.llm.temperature,
            "num_predict": CONFIG.llm.max_tokens,
        },
    }
    if CONFIG.llm.think is not None:
        payload["think"] = CONFIG.llm.think

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0)) as client:
            async with client.stream("POST", url, json=payload) as response:
                if response.status_code >= 400:
                    body = await response.aread()
                    raise LLMUnreachableError(
                        f"{response.status_code} from {url}: {body[:300]!r}"
                    )
                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    chunk = _parse_json(line)
                    if chunk is None:
                        continue
                    delta = _extract_ollama_native_delta(chunk)
                    if delta:
                        yield delta
                    if chunk.get("done"):
                        break
    except httpx.RequestError as exc:
        raise LLMUnreachableError(f"couldn't reach {url}: {exc}") from exc


def _parse_json(data: str) -> dict[str, Any] | None:
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def _extract_openai_delta(chunk: dict[str, Any] | None) -> str:
    if not chunk:
        return ""
    try:
        return chunk["choices"][0]["delta"].get("content") or ""
    except (KeyError, IndexError, TypeError):
        return ""


def _extract_ollama_native_delta(chunk: dict[str, Any]) -> str:
    # Deliberately only "content", never "thinking" -- with think:false
    # this should be empty/absent anyway, but even if a model ignores the
    # setting, we never want to speak the reasoning phase aloud.
    message = chunk.get("message")
    if not isinstance(message, dict):
        return ""
    return message.get("content") or ""
