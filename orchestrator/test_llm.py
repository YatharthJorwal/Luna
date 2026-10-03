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


# --- separate vision model, no-tools fallback, capability report ------------


def _patch_llm_config(monkeypatch, **llm_overrides):
    cfg = dataclasses.replace(
        llm.CONFIG, llm=dataclasses.replace(llm.CONFIG.llm, **llm_overrides)
    )
    monkeypatch.setattr(llm, "CONFIG", cfg)


_REAL_ASYNC_CLIENT = httpx.AsyncClient  # captured once: a second patch must not wrap the first


def _mock_http(monkeypatch, handler):
    monkeypatch.setattr(
        llm.httpx,
        "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw),
    )


def test_vision_model_name_falls_back_to_the_chat_model(monkeypatch):
    _patch_llm_config(monkeypatch, vision_model=None, model="chat-model")
    assert llm.vision_model_name() == "chat-model"
    _patch_llm_config(monkeypatch, vision_model="small-vlm", model="chat-model")
    assert llm.vision_model_name() == "small-vlm"


@pytest.mark.asyncio
async def test_describe_image_sends_the_vision_model_and_logs_timing(monkeypatch, capsys):
    _patch_llm_config(monkeypatch, vision_model="small-vlm", model="chat-model")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["payload"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "message": {"content": " a cake "},
                "load_duration": 2_500_000_000,
                "prompt_eval_count": 2650,
                "prompt_eval_duration": 3_100_000_000,
                "eval_count": 40,
                "eval_duration": 900_000_000,
            },
        )

    _mock_http(monkeypatch, handler)
    assert await llm.describe_image("what is this", "aGVsbG8=") == "a cake"
    assert seen["payload"]["model"] == "small-vlm"
    err = capsys.readouterr().err
    assert "[luna] vision: model=small-vlm" in err
    assert "load=2.5s" in err and "prompt_tokens=2650" in err and "prompt_eval=3.1s" in err


@pytest.mark.asyncio
async def test_describe_image_explains_a_model_without_vision(monkeypatch):
    _patch_llm_config(monkeypatch, vision_model=None, model="text-only")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text='{"error":"this model is missing data required for image input"}')

    _mock_http(monkeypatch, handler)
    with pytest.raises(llm.LLMUnreachableError) as err:
        await llm.describe_image("x", "aGk=")
    assert "llm.vision_model" in str(err.value)


@pytest.mark.asyncio
async def test_tool_calling_retries_without_tools_when_the_model_has_none(monkeypatch, capsys):
    _patch_llm_config(monkeypatch, model="community-gguf")
    llm._NO_TOOLS_MODELS.clear()
    payloads = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        payloads.append(body)
        if "tools" in body:
            return httpx.Response(400, text='{"error":"registry.ollama.ai/x does not support tools"}')
        return httpx.Response(
            200,
            content=_ndjson(
                {"message": {"content": "Hello."}, "done": False},
                {"done": True, "done_reason": "stop", "prompt_eval_count": 100, "eval_count": 3},
            ),
        )

    _mock_http(monkeypatch, handler)
    tools = [{"type": "function", "function": {"name": "t", "description": "d", "parameters": {}}}]
    first = [e async for e in llm.stream_reply_with_tools([{"role": "user", "content": "hi"}], tools)]
    assert first == [{"type": "content", "text": "Hello."}]
    assert "tools" in payloads[0] and "tools" not in payloads[1]  # retried without them
    assert "doesn't support tool-calling" in capsys.readouterr().err

    # remembered: the next turn doesn't pay for the failed attempt again
    payloads.clear()
    second = [e async for e in llm.stream_reply_with_tools([{"role": "user", "content": "again"}], tools)]
    assert second == [{"type": "content", "text": "Hello."}]
    assert len(payloads) == 1 and "tools" not in payloads[0]
    llm._NO_TOOLS_MODELS.clear()


@pytest.mark.asyncio
async def test_other_400s_are_still_errors_not_silent_retries(monkeypatch):
    _patch_llm_config(monkeypatch, model="community-gguf")
    llm._NO_TOOLS_MODELS.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text='{"error":"something else is wrong"}')

    _mock_http(monkeypatch, handler)
    with pytest.raises(llm.LLMUnreachableError):
        _ = [e async for e in llm.stream_reply_with_tools([{"role": "user", "content": "x"}], [{"type": "function", "function": {"name": "t"}}])]
    assert "community-gguf" not in llm._NO_TOOLS_MODELS


def test_capability_warnings_flag_missing_vision_and_tools():
    warnings = llm.capability_warnings("chat", ["completion"], "chat", ["completion"])
    assert any("no 'vision' capability" in w and "llm.vision_model" in w for w in warnings)
    assert any("no 'tools' capability" in w for w in warnings)


def test_capability_warnings_quiet_when_all_is_present_or_unknown():
    assert llm.capability_warnings("m", ["completion", "vision", "tools"], "m", ["completion", "vision", "tools"]) == []
    assert llm.capability_warnings("m", None, "m", None) == []  # old Ollama: say nothing


@pytest.mark.asyncio
async def test_model_capabilities_reads_api_show(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/show"
        return httpx.Response(200, json={"capabilities": ["completion", "vision", "tools"]})

    _mock_http(monkeypatch, handler)
    assert await llm.model_capabilities("qwen3.5:9b") == ["completion", "vision", "tools"]


@pytest.mark.asyncio
async def test_model_capabilities_unreachable_or_old_server_is_none(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"license": "x"})  # older Ollama: no field

    _mock_http(monkeypatch, handler)
    assert await llm.model_capabilities("m") is None

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    _mock_http(monkeypatch, boom)
    assert await llm.model_capabilities("m") is None


def test_vision_timing_summary_tolerates_missing_fields():
    line = llm._vision_timing_summary("m", "a" * 2048, 4.2, {})
    assert "model=m" in line and "image=2KB" in line and "load=?" in line


@pytest.mark.asyncio
async def test_turn_log_pairs_the_estimate_with_the_real_count_and_calibrates(monkeypatch, capsys):
    import context_budget

    context_budget.reset_calibration()
    _with_num_ctx(monkeypatch, 8192)
    big = [{"role": "system", "content": "p" * 9000}, {"role": "user", "content": "u" * 6000}]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=_ndjson(
                {"message": {"content": "ok"}, "done": False},
                {"done": True, "done_reason": "stop", "prompt_eval_count": 3300, "eval_count": 2},
            ),
        )

    _mock_http(monkeypatch, handler)
    _ = [e async for e in llm.stream_reply_with_tools(big, [])]
    err = capsys.readouterr().err
    assert "est_prompt_tokens=" in err and "prompt_tokens=3300" in err and "calibration=0.77" in err
    assert context_budget.calibration_ratio() < 1.0
    context_budget.reset_calibration()
