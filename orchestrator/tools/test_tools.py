"""
Tests for Phase 4's tool registry (tools/__init__.py) and the parts of
tools/vision.py that don't need a real display/clipboard/LLM server --
PIL.ImageGrab and pyperclip are both mocked, and llm.describe_image is
stubbed, same "stub the boundary, exercise everything else for real"
approach memory/test_memory.py already uses for consolidation.py/
forget.py's LLM calls. What none of this covers: whether ImageGrab and
pyperclip actually behave this way on the user's real Windows machine
(no display/clipboard exists in this sandbox at all), and whether a real
Ollama server actually calls these tools the way the fakes below assume
-- see vision.py's and llm.py's own docstrings for that half of the
picture.
"""

import base64
from unittest.mock import MagicMock, patch

import pytest

import tools
from tools import vision


# ---------------------------------------------------------------------------
# vision.capture_screen -- PIL.ImageGrab mocked, never touches a real display
# ---------------------------------------------------------------------------


def test_capture_screen_returns_base64_png():
    fake_image = MagicMock()

    def fake_save(buffer, format):
        assert format == "PNG"
        buffer.write(b"FAKE_PNG_BYTES")

    fake_image.save.side_effect = fake_save

    with patch("PIL.ImageGrab.grab", return_value=fake_image):
        result = vision.capture_screen()

    assert base64.b64decode(result) == b"FAKE_PNG_BYTES"


def test_capture_screen_wraps_grab_failure():
    with patch("PIL.ImageGrab.grab", side_effect=RuntimeError("no display")):
        with pytest.raises(vision.ToolUnavailableError):
            vision.capture_screen()


# ---------------------------------------------------------------------------
# vision.describe_screen -- capture_screen mocked, llm.describe_image stubbed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_describe_screen_passes_capture_to_llm(monkeypatch):
    monkeypatch.setattr(vision, "capture_screen", lambda: "fake_b64_png")

    captured = {}

    async def fake_describe_image(prompt, image_b64):
        captured["prompt"] = prompt
        captured["image_b64"] = image_b64
        return "A code editor with a Python file open."

    monkeypatch.setattr(vision.llm, "describe_image", fake_describe_image)

    result = await vision.describe_screen()
    assert result == "A code editor with a Python file open."
    assert captured["image_b64"] == "fake_b64_png"
    assert "screen" in captured["prompt"].lower()


# ---------------------------------------------------------------------------
# vision.read_clipboard -- pyperclip mocked
# ---------------------------------------------------------------------------


def test_read_clipboard_returns_pasted_text():
    with patch("pyperclip.paste", return_value="Traceback (most recent call last):"):
        assert vision.read_clipboard() == "Traceback (most recent call last):"


def test_read_clipboard_none_becomes_empty_string():
    with patch("pyperclip.paste", return_value=None):
        assert vision.read_clipboard() == ""


def test_read_clipboard_wraps_failure():
    with patch("pyperclip.paste", side_effect=RuntimeError("no clipboard owner")):
        with pytest.raises(vision.ToolUnavailableError):
            vision.read_clipboard()


# ---------------------------------------------------------------------------
# tools.dispatch_tool_call -- the registry itself
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_capture_screen(monkeypatch):
    async def fake_describe_screen():
        return "An IDE with a failing test highlighted."

    monkeypatch.setattr(vision, "describe_screen", fake_describe_screen)
    result = await tools.dispatch_tool_call("capture_screen", {})
    assert result == "An IDE with a failing test highlighted."


@pytest.mark.asyncio
async def test_dispatch_read_clipboard(monkeypatch):
    monkeypatch.setattr(vision, "read_clipboard", lambda: "some copied text")
    result = await tools.dispatch_tool_call("read_clipboard", {})
    assert result == "some copied text"


@pytest.mark.asyncio
async def test_dispatch_unknown_tool_name():
    result = await tools.dispatch_tool_call("delete_system32", {})
    assert "no such tool" in result


@pytest.mark.asyncio
async def test_dispatch_tool_unavailable_becomes_text_not_exception(monkeypatch):
    async def failing_describe_screen():
        raise vision.ToolUnavailableError("no display")

    monkeypatch.setattr(vision, "describe_screen", failing_describe_screen)
    result = await tools.dispatch_tool_call("capture_screen", {})
    assert "tool unavailable" in result
    assert "no display" in result


@pytest.mark.asyncio
async def test_dispatch_ignores_hallucinated_arguments(monkeypatch):
    # Neither real tool takes arguments -- a model passing some anyway
    # (both handlers accept **kwargs) shouldn't be a crash or an error
    # string, just silently absorbed. Mocked rather than hitting the real
    # OS clipboard, which doesn't exist at all in this headless sandbox --
    # the point here is the kwarg-absorption behavior, not what pyperclip
    # actually returns.
    monkeypatch.setattr(vision, "read_clipboard", lambda: "clipboard text")
    result = await tools.dispatch_tool_call("read_clipboard", {"region": "full"})
    assert result == "clipboard text"


# ---------------------------------------------------------------------------
# tools.dispatch_tool_call -- set_active_task (Phase 4 Round 2)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_set_active_task_starts_tracking():
    import task_guide  # local import: avoid module-load-order surprises

    task_guide.clear_active_task()
    result = await tools.dispatch_tool_call(
        "set_active_task", {"active": True, "description": "writing the game loop"}
    )
    assert "writing the game loop" in result
    assert task_guide.get_state().active is True
    task_guide.clear_active_task()


@pytest.mark.asyncio
async def test_dispatch_set_active_task_stops_tracking():
    import task_guide

    task_guide.set_active_task(True, "something")
    result = await tools.dispatch_tool_call("set_active_task", {"active": False})
    assert "stopped" in result.lower()
    assert task_guide.get_state().active is False


@pytest.mark.asyncio
async def test_dispatch_set_active_task_missing_active_defaults_false():
    import task_guide

    task_guide.set_active_task(True, "something")
    # A model omitting the (schema-required) "active" argument shouldn't
    # crash the turn -- same "absorb a malformed call gracefully"
    # philosophy as the hallucinated-arguments test above, just for a
    # tool that now actually takes real arguments.
    result = await tools.dispatch_tool_call("set_active_task", {})
    assert task_guide.get_state().active is False
    task_guide.clear_active_task()


# ---------------------------------------------------------------------------
# tools.dispatch_tool_call -- capture_camera (Phase 5)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_capture_camera_passes_websocket_through(monkeypatch):
    import camera

    received_ws = []

    async def fake_describe_camera(websocket):
        received_ws.append(websocket)
        return "A person at a desk."

    monkeypatch.setattr(camera, "describe_camera", fake_describe_camera)
    sentinel_ws = object()
    result = await tools.dispatch_tool_call("capture_camera", {}, websocket=sentinel_ws)
    assert result == "A person at a desk."
    assert received_ws == [sentinel_ws]


@pytest.mark.asyncio
async def test_dispatch_capture_camera_no_websocket_returns_safe_string():
    # dispatch_tool_call's websocket param defaults to None -- every real
    # call site (app.py's tool-calling loop) always passes one, but a
    # missing one shouldn't crash, just degrade to a message the model
    # can react to.
    result = await tools.dispatch_tool_call("capture_camera", {})
    assert "unavailable" in result.lower()


@pytest.mark.asyncio
async def test_dispatch_capture_camera_tool_unavailable_surfaces_cleanly(monkeypatch):
    import camera

    async def failing_describe_camera(websocket):
        raise vision.ToolUnavailableError("camera isn't armed right now")

    monkeypatch.setattr(camera, "describe_camera", failing_describe_camera)
    result = await tools.dispatch_tool_call("capture_camera", {}, websocket=object())
    assert "unavailable" in result.lower()
    assert "armed" in result.lower()
