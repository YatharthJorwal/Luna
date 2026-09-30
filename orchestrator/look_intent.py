"""
Explicit "look at X" requests, handled deterministically instead of leaving
them to the model's own native tool-calling.

Real usage (a pasted orchestrator.log) showed capture_screen firing for
only 2 of ~9 requests that were plainly asking her to look -- "see what i
am playing", "look at my screen", "use OCR", "use your damn tools to see",
"whats on my screen", "tell me what do you see now". Every miss was a
`replied directly` with no tool_calls key at all, and each one meant she
answered from stale context or made something up (an invented clock
reading, a description of a scene the user had already changed). Same
failure class as set_active_task (task_guide.py) and the camera
re-invocation gap: qwen3.5:9b's autonomous decision to call a tool is not
reliable enough to depend on.

So, same approach as task_guide.maybe_update_task: take the decision away
from the model for the cases where the user's intent is unambiguous. A
regex gate (no extra LLM call, so no per-turn latency cost on ordinary
turns) detects an explicit look-request, this module does the capture
itself in Python via the same describe_screen()/describe_camera() the
tools already wrap, and app.py's _run_turn splices the result in as
ephemeral context -- exactly how forget/task/recall hints already work.
Phrasings the patterns don't catch still fall through to the model's native
tool-calling, which does work some of the time; this only adds a reliable
path for the common explicit ones, it doesn't remove the fallback.

The patterns are deliberately conservative -- a false positive means an
unwanted screen capture (or, worse, an unwanted *camera* capture), which
costs more than a missed phrase costs. In particular the camera only
triggers on look-verb + camera phrasings or "what am I holding/wearing",
never on the bare word "camera", so "turn the camera off" can't capture a
frame.
"""

from __future__ import annotations

import re
import sys

import camera
import llm
from tools import vision

# Explicit screen requests. Objects limited to screen/monitor/display/
# desktop/wallpaper (not "window"/"tab") -- those are common enough in
# ordinary sentences ("I see a window") to cause false positives.
_SCREEN_RE = re.compile(
    r"""
      \b(?:look|see|check|read|show|watch)\b[^.?!]{0,30}\b(?:screen|monitor|display|desktop|wallpaper)\b
    | \bwhat(?:['’]?s|\ is|\ am\ i|\ are\ we)\b[^.?!]{0,20}\b(?:on\ (?:my\ |the\ )?(?:screen|monitor|display)|playing|watching)\b
    | \bsee\b[^.?!]{0,10}\bi(?:['’]?m|\ am)\b[^.?!]{0,6}\b(?:playing|doing|watching|working)\b
    | \buse\b[^.?!]{0,15}\b(?:ocr|tools?|eyes|vision)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Camera requests. Never the bare word "camera" -- see module docstring.
_CAMERA_RE = re.compile(
    r"""
      \b(?:look|see|check|use|through)\b[^.?!]{0,15}\b(?:camera|webcam)\b
    | \b(?:look\ at|see|watch)\ me\b
    | \b(?:what|see|tell\ me)\b[^.?!]{0,25}\b(?:holding|wearing)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# "Look again" style requests that don't name a target -- resolved to
# whatever was looked at last (default: the screen).
_GENERIC_RE = re.compile(
    r"""
      \b(?:what\ do\ you\ see|what\ can\ you\ see|what\ u\ see|tell\ me\ what\ you\ see
        |look\ again|check\ again|look\ at\ it\ again|see\ it\ again|take\ another\ look
        |what\ am\ i\ looking\ at)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

_last_target = "screen"


def detect_look_target(user_text: str) -> str | None:
    """"screen", "camera", or None. Pure and synchronous -- no side effects
    (the last-target memory is only updated by maybe_look, once it actually
    acts on a detection)."""
    # Uploaded files/images arrive as a synthetic "(shared a ...)" user_text
    # whose body can be anything -- a code file that happens to contain
    # "look at the screen" must not trigger a capture.
    if user_text.lstrip().startswith("(shared a"):
        return None
    if _CAMERA_RE.search(user_text):
        return "camera"
    if _SCREEN_RE.search(user_text):
        return "screen"
    if _GENERIC_RE.search(user_text):
        return _last_target
    return None


async def maybe_look(user_text: str, websocket) -> str | None:
    """If user_text is an explicit look-request, does the capture and
    returns an instruction fragment for _run_turn's ephemeral context
    block; None if nothing was asked for. Never raises for an expected
    failure (capture failed, camera not armed, vision model unreachable) --
    those become a hint telling her to say so plainly instead of guessing,
    which is the whole failure this exists to prevent."""
    global _last_target
    target = detect_look_target(user_text)
    if target is None:
        return None
    _last_target = target

    where = "through their webcam" if target == "camera" else "at their screen"
    try:
        if target == "camera":
            description = await camera.describe_camera(websocket)
        else:
            description = await vision.describe_screen()
    except vision.ToolUnavailableError as exc:
        print(f"[luna] look: {target} capture failed: {exc}", file=sys.stderr)
        extra = (
            " If it was the camera, they probably need to turn it on from "
            "their quick-action menu."
            if target == "camera"
            else ""
        )
        return (
            f"The user just asked you to look {where}, but it failed: "
            f"{exc}. Tell them plainly, in character, that you couldn't "
            f"see it.{extra} Do NOT make up or guess what you would have seen."
        )
    except llm.LLMUnreachableError as exc:
        print(f"[luna] look: vision model unreachable: {exc}", file=sys.stderr)
        return (
            f"The user just asked you to look {where}, but your vision "
            "isn't working right now. Tell them plainly, in character, "
            "that you couldn't see it. Do NOT make up or guess what you "
            "would have seen."
        )

    print(f"[luna] look: {target} -> {description[:80]!r}", file=sys.stderr)
    return (
        f"You just looked {where} right now, because they asked. What you "
        f"saw: {description} Answer using only this -- do not add details "
        "it doesn't mention, do not invent readings like a clock time it "
        "doesn't show, and do not say you looked at any other moment. You "
        "have already looked this turn, so there is no need to use a "
        "tool to look again."
    )
