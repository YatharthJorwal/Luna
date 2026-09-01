"""
Thin async client for an OpenAI-compatible /chat/completions endpoint --
Ollama and llama.cpp server both speak this, so swapping between them (or
any other local server that speaks the same protocol) is a config.yaml
edit, not a code change (see CLAUDE.md's working agreement).
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
    """Streams content-delta strings from the configured chat-completions
    endpoint as they arrive. Raises LLMUnreachableError if the server can't
    be reached or errors out."""
    url = f"{CONFIG.llm.base_url.rstrip('/')}/chat/completions"
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
                    chunk = _parse_chunk(data)
                    delta = _extract_delta(chunk)
                    if delta:
                        yield delta
    except httpx.RequestError as exc:
        # Covers connection refused, DNS failure, timeout, etc. -- anything
        # that means we never got a usable response at all.
        raise LLMUnreachableError(f"couldn't reach {url}: {exc}") from exc


def _parse_chunk(data: str) -> dict[str, Any] | None:
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def _extract_delta(chunk: dict[str, Any] | None) -> str:
    if not chunk:
        return ""
    try:
        return chunk["choices"][0]["delta"].get("content") or ""
    except (KeyError, IndexError, TypeError):
        return ""
