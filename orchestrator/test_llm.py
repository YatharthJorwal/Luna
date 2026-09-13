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
