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

Phase 4 added two more entry points, both ollama_native-only (see their
own docstrings for why): stream_reply_with_tools() for the main
conversation's tool-calling loop, and describe_image() for vision.py's
internal screenshot-to-text call. Neither touches stream_reply() above,
which consolidation.py/forget.py's background LLM calls still use
unchanged.

Context window: every native-Ollama request goes through _ollama_options(),
which stamps the same options.num_ctx (config.yaml's llm.num_ctx) on all of
them -- chat, tool-calling, vision, the background classifiers. Left unset,
the window is whatever the server defaults to, and once persona prompt +
tool schemas + memory block + history outgrew it, Ollama ended replies after
a handful of tokens with done_reason 'length' (docs/DECISIONS.md). Keeping
the value identical across calls also matters on its own: Ollama reloads the
model whenever two requests disagree on it. The OpenAI-compatible path has
no per-request way to set it (use OLLAMA_CONTEXT_LENGTH on the server).
"""

from __future__ import annotations

import json
import sys
from typing import Any, AsyncIterator

import httpx

from config import CONFIG


def _ollama_options(**overrides: Any) -> dict[str, Any]:
    """The `options` block for every native-Ollama request. `overrides` may
    change temperature/num_predict (the vision call wants its own), but
    never num_ctx: that one value must be identical across all calls."""
    options: dict[str, Any] = {
        "temperature": CONFIG.llm.temperature,
        "num_predict": CONFIG.llm.max_tokens,
    }
    options.update(overrides)
    if CONFIG.llm.num_ctx is not None:
        options["num_ctx"] = CONFIG.llm.num_ctx
    return options


def explain_length_stop(prompt_tokens: int | None, gen_tokens: int | None) -> str:
    """Why a done_reason='length' reply stopped, from Ollama's own token
    counts. Pure so it can be tested: a reply that ended far below
    max_tokens can only have run out of context window."""
    max_tokens = CONFIG.llm.max_tokens
    num_ctx = CONFIG.llm.num_ctx
    if gen_tokens is not None and gen_tokens >= max_tokens:
        return f"hit the reply cap (llm.max_tokens={max_tokens})"
    if prompt_tokens is not None and num_ctx and prompt_tokens + (gen_tokens or 0) >= num_ctx * 0.95:
        return (
            f"the context window filled (prompt {prompt_tokens} + reply "
            f"{gen_tokens or 0} of num_ctx {num_ctx}) -- history is too big for it"
        )
    return "unknown -- stopped well under both max_tokens and num_ctx"


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


async def stream_reply_with_tools(
    messages: list[dict[str, Any]], tools: list[dict[str, Any]]
) -> AsyncIterator[dict[str, Any]]:
    """Like stream_reply() above, but for turns that have tools available
    -- currently only app.py's main conversation loop. consolidation.py
    and forget.py's internal background calls don't need tools and keep
    using the original stream_reply() completely unchanged, so this is a
    new function rather than a change to that one's signature -- no risk
    of touching their already-tested behavior.

    Yields {"type": "content", "text": str} for ordinary reply text (same
    text stream_reply() would hand back, just wrapped), or, if/when the
    model decides to call a tool instead of replying directly,
    {"type": "tool_calls", "calls": [{"name": str, "arguments": dict}]}
    -- at which point the generator ends (the caller is expected to run
    the tools and start a fresh call with the results appended, see
    app.py's _run_turn).

    ollama_native only -- tool-calling isn't wired for the openai-
    compatible path (Phase 4 was built and tested against Ollama; add
    openai-path support later if that's ever actually needed).

    **Not verified against a real server.** Whether qwen3.5:9b actually
    emits tool_calls reliably through Ollama's *streaming* endpoint (as
    opposed to only in non-streaming responses), and what shape/timing
    those calls arrive in mid-stream, is genuine unknown territory --
    Ollama's own tool-calling-while-streaming behavior has varied across
    versions and models, and this has never run against a real Ollama
    instance. Written defensively because of that: any chunk carrying a
    tool_calls array is treated as the deciding chunk, whatever else is
    in it (see _normalize_tool_calls' own docstring for the parsing side
    of that same defensiveness). If this doesn't hold up in practice, the
    fallback is a non-streaming detect-then-stream two-call shape instead
    (slower, but a much better-trodden path for tool-calling models
    generally) -- see docs/DECISIONS.md.
    """
    if CONFIG.llm.api_style != "ollama_native":
        raise LLMUnreachableError(
            "tool-calling needs api_style: ollama_native -- not wired for "
            "the openai-compatible path"
        )

    url = f"{CONFIG.llm.base_url.rstrip('/')}/api/chat"
    payload: dict[str, Any] = {
        "model": CONFIG.llm.model,
        "messages": messages,
        "tools": tools,
        "stream": True,
        "options": _ollama_options(),
    }
    if CONFIG.llm.think is not None:
        payload["think"] = CONFIG.llm.think

    # Debug visibility while this is still unverified against a real
    # server (see this function's own docstring) -- one line per call,
    # not per chunk, so cheap enough to leave in rather than strip out
    # once this is confirmed working. Directly answers the question "did
    # Ollama even attempt this" the next time she doesn't use a tool she
    # should have -- print(s) go to the orchestrator's own terminal, not
    # anywhere the user would see them mid-conversation.
    tool_names = [
        t["function"]["name"]
        for t in tools
        if isinstance(t, dict) and isinstance(t.get("function"), dict)
    ]
    saw_tool_calls_key = False
    saw_any_content = False
    # Tracked for the truncation diagnostic printed below: replies were
    # observed ending mid-sentence on the user's real machine with no user
    # action and no error anywhere in the log, and a stream that just *ends*
    # (Ollama aborting a generation) used to be indistinguishable here from
    # one that finished normally.
    done_seen = False
    done_reason: Any = None
    chars_streamed = 0
    # Ollama reports real token counts on the final chunk; logging them is
    # what turns "she cut off" from a guess into a diagnosis.
    prompt_tokens: int | None = None
    gen_tokens: int | None = None
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
                    message = chunk.get("message")
                    if isinstance(message, dict):
                        if "tool_calls" in message:
                            saw_tool_calls_key = True
                        calls = _normalize_tool_calls(message.get("tool_calls"))
                        if calls:
                            print(
                                f"[luna] tool-calling: model called "
                                f"{[c['name'] for c in calls]}",
                                file=sys.stderr,
                            )
                            yield {"type": "tool_calls", "calls": calls}
                            return
                        content = message.get("content") or ""
                        if content:
                            saw_any_content = True
                            chars_streamed += len(content)
                            yield {"type": "content", "text": content}
                    if chunk.get("done"):
                        done_seen = True
                        done_reason = chunk.get("done_reason")
                        prompt_tokens = _int_or_none(chunk.get("prompt_eval_count"))
                        gen_tokens = _int_or_none(chunk.get("eval_count"))
                        break
    except httpx.RequestError as exc:
        raise LLMUnreachableError(f"couldn't reach {url}: {exc}") from exc
    print(
        f"[luna] tool-calling: offered {tool_names}, replied directly "
        f"(saw_content={saw_any_content}, "
        f"'tool_calls' key ever present={saw_tool_calls_key}, "
        f"done={done_seen}, done_reason={done_reason!r}, chars={chars_streamed}, "
        f"prompt_tokens={prompt_tokens}, gen_tokens={gen_tokens}, "
        f"num_ctx={CONFIG.llm.num_ctx})",
        file=sys.stderr,
    )
    if done_reason == "length":
        print(
            "[luna] WARNING: reply stopped by 'length' -- "
            f"{explain_length_stop(prompt_tokens, gen_tokens)}",
            file=sys.stderr,
        )
    elif (
        CONFIG.llm.num_ctx
        and prompt_tokens is not None
        and prompt_tokens >= CONFIG.llm.num_ctx * 0.85
    ):
        print(
            f"[luna] WARNING: context nearly full (prompt {prompt_tokens} of "
            f"num_ctx {CONFIG.llm.num_ctx}) -- the next reply may be cut short.",
            file=sys.stderr,
        )
    if not done_seen or done_reason not in (None, "stop"):
        # The smoking gun for a reply that was cut off by the *model side*
        # rather than by the user or a bug in this app: either the stream
        # ended with no done marker at all (Ollama aborted mid-generation),
        # or it ended for a reason other than a natural stop (e.g.
        # "length" = hit the max_tokens cap).
        print(
            f"[luna] WARNING: LLM reply ended abnormally (done={done_seen}, "
            f"done_reason={done_reason!r}) after {chars_streamed} chars -- "
            "if she cut off mid-sentence, this is why.",
            file=sys.stderr,
        )


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _normalize_tool_calls(raw_calls: Any) -> list[dict[str, Any]]:
    """Defensive parsing on purpose -- see stream_reply_with_tools'
    docstring for why this is genuinely untested against a real server.
    A malformed entry is skipped rather than crashing the turn; a chunk
    with only malformed entries just yields no tool call at all, and the
    caller falls through to treating it as ordinary content (there won't
    be any text either in that case, so it's effectively a no-op round --
    covered by app.py's MAX_TOOL_ROUNDS cap). Expected shape per entry,
    per Ollama's/OpenAI's tool-calling convention both converged on:
    {"function": {"name": str, "arguments": dict}}."""
    if not isinstance(raw_calls, list):
        return []
    calls = []
    for raw in raw_calls:
        if not isinstance(raw, dict):
            continue
        function = raw.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        if not isinstance(name, str) or not name:
            continue
        arguments = function.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        calls.append({"name": name, "arguments": arguments})
    return calls


async def describe_image(prompt: str, image_b64: str) -> str:
    """One-shot, non-streaming multimodal call -- used internally by
    tools/vision.py's describe_screen() to turn a screenshot into the
    text description ARCHITECTURE.md's vision-tools section calls for
    ("returns a textual analysis (not raw pixels) to the reasoning
    pass"). Not part of the main conversation's own streamed reply, and
    not visible to app.py's tool-calling loop at all -- from that loop's
    point of view, capture_screen is just a tool that returns a string,
    same as read_clipboard.

    ollama_native only, same reasoning as stream_reply_with_tools above
    -- image support here specifically relies on Ollama's native
    "images": [base64...] field on a message, which isn't part of the
    generic OpenAI-compatible shape this project also supports.

    **Not verified against a real server**: qwen3.5:9b is documented as
    natively multimodal (see config.yaml's llm.model comment), but this
    exact request shape has never actually been sent to it.
    """
    if CONFIG.llm.api_style != "ollama_native":
        raise LLMUnreachableError(
            "vision tools need api_style: ollama_native -- image support "
            "isn't wired for the openai-compatible path"
        )

    url = f"{CONFIG.llm.base_url.rstrip('/')}/api/chat"
    payload: dict[str, Any] = {
        "model": CONFIG.llm.model,
        "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
        "stream": False,
        "options": _ollama_options(temperature=0.4, num_predict=400),
    }
    if CONFIG.llm.think is not None:
        payload["think"] = CONFIG.llm.think

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0)) as client:
            response = await client.post(url, json=payload)
            if response.status_code >= 400:
                raise LLMUnreachableError(
                    f"{response.status_code} from {url}: {response.text[:300]!r}"
                )
            data = response.json()
    except httpx.RequestError as exc:
        raise LLMUnreachableError(f"couldn't reach {url}: {exc}") from exc

    message = data.get("message")
    if not isinstance(message, dict):
        return ""
    return (message.get("content") or "").strip()


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
        "options": _ollama_options(),
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
