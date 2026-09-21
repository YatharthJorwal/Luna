"""
Phase 4's tool registry -- what app.py's main conversation loop hands to
llm.stream_reply_with_tools() as available tools, and how it dispatches
a tool_calls event it gets back. One place so adding a new tool later
(Phase 4 Round 2's ocr_region, Phase 11's browser-automation tool, etc.)
means adding one schema + one handler here, not touching app.py's
turn-handling loop itself.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import task_guide
from tools import vision

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "capture_screen",
            "description": (
                "Take a screenshot of the user's screen right now and get "
                "back a text description of what's on it. Use this when "
                "the user asks you to look at their screen or check their "
                "progress on something, or when you need current visual "
                "context you don't already have. Don't use this if the "
                "user already pasted text or described something in "
                "words -- only when you actually need to see the screen."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_clipboard",
            "description": (
                "Read whatever text is currently on the user's clipboard "
                "-- e.g. a stack trace or code snippet they just copied. "
                "More reliable than asking them to retype it or reading "
                "it off a screenshot. Use this when the user says they've "
                "copied something, or asks you to look at what they just "
                "copied."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_active_task",
            "description": (
                "Start, update, or stop tracking a task the user is "
                "currently working on, so their screen can be checked "
                "periodically and they can be nudged back if they drift. "
                "Call this with active=true and a short, concrete "
                "description of the current step (e.g. 'writing the game "
                "loop in main.py for the Flappy Bird clone', not just "
                "'Flappy Bird game') whenever the user states a task or "
                "you infer one and they confirm it, and call it again "
                "with an updated description whenever the current step "
                "changes. Call it with active=false once the task is "
                "finished, the user says to drop or pause it, or they "
                "ask you to stop watching. Do not call this for small "
                "one-off questions that are not really an ongoing task."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "active": {
                        "type": "boolean",
                        "description": "true to start or update tracking, false to stop.",
                    },
                    "description": {
                        "type": "string",
                        "description": (
                            "Short, concrete description of the current "
                            "step. Required when active is true; ignored "
                            "when active is false."
                        ),
                    },
                },
                "required": ["active"],
            },
        },
    },
]


async def _capture_screen_tool(**_ignored: Any) -> str:
    return await vision.describe_screen()


async def _read_clipboard_tool(**_ignored: Any) -> str:
    # read_clipboard() itself is a plain blocking sync call (OS clipboard
    # access) -- to_thread here so it doesn't stall the event loop, same
    # reasoning as recall.py/store.py's own asyncio.to_thread use around
    # blocking sqlite calls.
    return await asyncio.to_thread(vision.read_clipboard)


async def _set_active_task_tool(active: bool = False, description: str = "", **_ignored: Any) -> str:
    # Plain in-memory dict update (task_guide.py) -- no blocking I/O, so
    # unlike read_clipboard above this doesn't need asyncio.to_thread.
    return task_guide.set_active_task(bool(active), str(description or ""))


# name -> async callable, every one of which always returns a plain
# string result and never raises anything but vision.ToolUnavailableError
# (dispatch_tool_call below turns even that into a safe string instead of
# propagating). **kwargs on every handler absorbs any argument the model
# passes even though most tools take none today -- a local 9B model
# occasionally hallucinating a parameter shouldn't be a crash.
_HANDLERS: dict[str, Callable[..., Awaitable[str]]] = {
    "capture_screen": _capture_screen_tool,
    "read_clipboard": _read_clipboard_tool,
    "set_active_task": _set_active_task_tool,
}


async def dispatch_tool_call(name: str, arguments: dict[str, Any]) -> str:
    """Runs one tool call by name and always returns a plain string --
    either the real result, the tool's own failure message
    (ToolUnavailableError), or a note that the model asked for a tool
    that doesn't exist (a hallucinated name, which -- being a local 9B
    model -- is real enough to handle rather than crash the turn over).
    """
    handler = _HANDLERS.get(name)
    if handler is None:
        return f"(no such tool: {name!r})"
    try:
        return await handler(**arguments)
    except vision.ToolUnavailableError as exc:
        return f"(tool unavailable: {exc})"
    except TypeError as exc:
        # Neither tool takes required arguments, so this only fires on a
        # genuinely malformed call -- degrade gracefully rather than
        # crash the turn over it.
        return f"(tool call failed: {exc})"
