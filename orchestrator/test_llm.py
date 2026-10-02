"""
Tests for llm.py's Phase 4 additions. Only _normalize_tool_calls is
covered here -- it's the one piece of stream_reply_with_tools/
describe_image that's pure logic with no network/event-loop involved, so
it's the one piece that can be genuinely tested rather than just reasoned
about in this sandbox (no real Ollama server to talk to -- see both
functions' own docstrings for what's still unverified as a result).
"""

from llm import _normalize_tool_calls


def test_normalize_tool_calls_happy_path():
    raw = [{"function": {"name": "capture_screen", "arguments": {}}}]
    assert _normalize_tool_calls(raw) == [{"name": "capture_screen", "arguments": {}}]


def test_normalize_tool_calls_multiple():
    raw = [
        {"function": {"name": "capture_screen", "arguments": {}}},
        {"function": {"name": "read_clipboard", "arguments": {}}},
    ]
    assert _normalize_tool_calls(raw) == [
        {"name": "capture_screen", "arguments": {}},
        {"name": "read_clipboard", "arguments": {}},
    ]


def test_normalize_tool_calls_missing_arguments_defaults_to_empty_dict():
    raw = [{"function": {"name": "capture_screen"}}]
    assert _normalize_tool_calls(raw) == [{"name": "capture_screen", "arguments": {}}]


def test_normalize_tool_calls_arguments_wrong_type_defaults_to_empty_dict():
    # A model occasionally emitting arguments as a JSON string instead of
    # an object is a real enough failure mode for a local 9B model to
    # guard against, not just a theoretical one.
    raw = [{"function": {"name": "capture_screen", "arguments": "{}"}}]
    assert _normalize_tool_calls(raw) == [{"name": "capture_screen", "arguments": {}}]


def test_normalize_tool_calls_skips_entries_missing_name():
    raw = [{"function": {"arguments": {}}}]
    assert _normalize_tool_calls(raw) == []


def test_normalize_tool_calls_skips_entries_with_blank_name():
    raw = [{"function": {"name": "", "arguments": {}}}]
    assert _normalize_tool_calls(raw) == []


def test_normalize_tool_calls_skips_malformed_entries_keeps_valid_ones():
    raw = [
        "not even a dict",
        {"no_function_key": True},
        {"function": "not a dict either"},
        {"function": {"name": "read_clipboard", "arguments": {}}},
    ]
    assert _normalize_tool_calls(raw) == [{"name": "read_clipboard", "arguments": {}}]


def test_normalize_tool_calls_none_input():
    assert _normalize_tool_calls(None) == []


def test_normalize_tool_calls_not_a_list():
    assert _normalize_tool_calls({"function": {"name": "x"}}) == []


def test_normalize_tool_calls_empty_list():
    assert _normalize_tool_calls([]) == []


# --- context window (num_ctx) ---------------------------------------------
# Replies were being cut off with done_reason='length' far below max_tokens
# because nothing set or bounded the context window. These pin the pieces:
# one options helper stamps the same num_ctx on every native request, and
# the token counts Ollama reports are what the log and the diagnosis use.

import dataclasses
import json

import httpx
import pytest

import llm


def _with_num_ctx(monkeypatch, value):
    cfg = dataclasses.replace(llm.CONFIG, llm=dataclasses.replace(llm.CONFIG.llm, num_ctx=value))
    monkeypatch.setattr(llm, "CONFIG", cfg)


def test_ollama_options_stamps_num_ctx(monkeypatch):
    _with_num_ctx(monkeypatch, 8192)
    options = llm._ollama_options()
    assert options["num_ctx"] == 8192
    assert options["num_predict"] == llm.CONFIG.llm.max_tokens


def test_ollama_options_vision_overrides_keep_same_num_ctx(monkeypatch):
    # The vision call tunes temperature/num_predict but must NOT differ on
    # num_ctx, or Ollama reloads the model between a chat and a screen read.
    _with_num_ctx(monkeypatch, 8192)
    chat = llm._ollama_options()
    vision = llm._ollama_options(temperature=0.4, num_predict=400)
    assert vision["temperature"] == 0.4 and vision["num_predict"] == 400
    assert vision["num_ctx"] == chat["num_ctx"] == 8192


def test_ollama_options_null_num_ctx_is_omitted(monkeypatch):
    _with_num_ctx(monkeypatch, None)
    assert "num_ctx" not in llm._ollama_options()


def test_explain_length_stop_context_full(monkeypatch):
    _with_num_ctx(monkeypatch, 4096)
    assert "context window filled" in llm.explain_length_stop(4080, 12)


def test_explain_length_stop_reply_cap(monkeypatch):
    _with_num_ctx(monkeypatch, 8192)
    assert "reply cap" in llm.explain_length_stop(1500, llm.CONFIG.llm.max_tokens)


def test_explain_length_stop_unknown(monkeypatch):
    _with_num_ctx(monkeypatch, 8192)
    assert "unknown" in llm.explain_length_stop(1000, 20)


def _ndjson(*chunks):
    return "\n".join(json.dumps(c) for c in chunks).encode()


@pytest.mark.asyncio
async def test_stream_reply_with_tools_sends_num_ctx_and_logs_token_counts(monkeypatch, capsys):
    _with_num_ctx(monkeypatch, 8192)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["payload"] = json.loads(request.content)
        return httpx.Response(
            200,
            content=_ndjson(
                {"message": {"content": "Hi."}, "done": False},
                {
                    "message": {"content": ""},
                    "done": True,
                    "done_reason": "length",
                    "prompt_eval_count": 8100,
                    "eval_count": 9,
                },
            ),
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        llm.httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    events = [e async for e in llm.stream_reply_with_tools([{"role": "user", "content": "x"}], [])]
    assert events == [{"type": "content", "text": "Hi."}]
    assert seen["payload"]["options"]["num_ctx"] == 8192

    err = capsys.readouterr().err
    assert "prompt_tokens=8100" in err and "gen_tokens=9" in err and "num_ctx=8192" in err
    assert "reply stopped by 'length'" in err and "context window filled" in err


@pytest.mark.asyncio
async def test_stream_reply_with_tools_warns_when_context_nearly_full(monkeypatch, capsys):
    _with_num_ctx(monkeypatch, 8192)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_ndjson(
                {"message": {"content": "Fine."}, "done": False},
                {"done": True, "done_reason": "stop", "prompt_eval_count": 7400, "eval_count": 5},
            ),
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        llm.httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    _ = [e async for e in llm.stream_reply_with_tools([{"role": "user", "content": "x"}], [])]
    assert "context nearly full" in capsys.readouterr().err
