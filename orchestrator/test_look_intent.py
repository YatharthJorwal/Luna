"""
Tests for look_intent.py. The positive cases are the literal phrases from
a real session where native tool-calling missed most of them (see the
module docstring); the negative cases matter just as much -- a false
positive is an unwanted screen or camera capture.
"""

from __future__ import annotations

import pytest

import look_intent
from tools import vision


@pytest.fixture(autouse=True)
def _reset_last_target():
    look_intent._last_target = "screen"  # noqa: SLF001
    yield
    look_intent._last_target = "screen"  # noqa: SLF001


@pytest.mark.parametrize(
    "text",
    [
        "see what i am playing",
        "Just look at my screen and tell me what time I am doing right now",
        "see i am playing minecraft. use OCR",
        "whats on my screen",
        "what's on my screen right now",
        "use your damn tools to see bruh",
        "Look at it again and tell me what am I looking at right now on minecraft",
        "changed my wallpaper. tell me what do you see now.",
        "check my screen",
    ],
)
def test_detects_screen_requests(text):
    assert look_intent.detect_look_target(text) == "screen"


@pytest.mark.parametrize(
    "text",
    [
        "what can u see in my camera",
        "what am i holding rn",
        "camera is on. see what i am holding",
        "now see and tell me what i am holding",
        "use the camera. see what i am holding now. its not the thermos.",
        "look at me",
    ],
)
def test_detects_camera_requests(text):
    assert look_intent.detect_look_target(text) == "camera"


@pytest.mark.parametrize(
    "text",
    [
        "Where did you check?",
        "What should I do now?",
        "currently its a Skirk wallpaper",
        "turn the camera off",
        "the camera is on",
        "I can see why that happened",
        "what is OCR?",
        "hello there",
        "",
    ],
)
def test_ignores_non_requests(text):
    assert look_intent.detect_look_target(text) is None


def test_upload_body_never_triggers_a_capture():
    # A shared code file whose *content* happens to say "look at my screen"
    # must not start a capture.
    assert look_intent.detect_look_target('(shared a file, "notes.txt") look at my screen') is None


@pytest.mark.asyncio
async def test_generic_look_again_reuses_last_target(monkeypatch):
    async def fake_cam(ws):
        return "a person at a desk"

    monkeypatch.setattr(look_intent.camera, "describe_camera", fake_cam)
    await look_intent.maybe_look("what am i holding", object())
    assert look_intent.detect_look_target("look again") == "camera"


@pytest.mark.asyncio
async def test_maybe_look_screen_success(monkeypatch):
    async def fake_screen():
        return "Minecraft is open."

    monkeypatch.setattr(look_intent.vision, "describe_screen", fake_screen)
    hint = await look_intent.maybe_look("look at my screen", object())
    assert "Minecraft is open." in hint
    assert "at their screen" in hint


@pytest.mark.asyncio
async def test_maybe_look_camera_success(monkeypatch):
    seen = []

    async def fake_cam(ws):
        seen.append(ws)
        return "a smartphone in hand"

    monkeypatch.setattr(look_intent.camera, "describe_camera", fake_cam)
    sentinel = object()
    hint = await look_intent.maybe_look("what am i holding", sentinel)
    assert "a smartphone in hand" in hint
    assert seen == [sentinel]


@pytest.mark.asyncio
async def test_maybe_look_none_when_no_request():
    assert await look_intent.maybe_look("how are you", object()) is None


@pytest.mark.asyncio
async def test_maybe_look_tool_unavailable_forbids_guessing(monkeypatch):
    async def failing_cam(ws):
        raise vision.ToolUnavailableError("camera isn't armed right now")

    monkeypatch.setattr(look_intent.camera, "describe_camera", failing_cam)
    hint = await look_intent.maybe_look("what am i holding", object())
    assert "armed" in hint
    assert "quick-action menu" in hint
    assert "Do NOT make up" in hint


@pytest.mark.asyncio
async def test_maybe_look_llm_unreachable_forbids_guessing(monkeypatch):
    async def failing_screen():
        raise look_intent.llm.LLMUnreachableError("no server")

    monkeypatch.setattr(look_intent.vision, "describe_screen", failing_screen)
    hint = await look_intent.maybe_look("look at my screen", object())
    assert "Do NOT make up" in hint
