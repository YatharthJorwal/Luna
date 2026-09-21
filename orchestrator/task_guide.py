"""
Phase 4 Round 2 -- Task Guide Mode's other half (docs/ARCHITECTURE.md's
"Task Guide Mode" section): tracking whether a task is currently active,
and checking a screenshot against it. The actual scheduling (waking up
on an interval, deciding when to run a check, speaking the chide) lives
in app.py's `_task_guide_loop`/`_run_task_guide_check` -- this module is
just the state and the one LLM call that turns a screenshot + task
description into an on-task/off-task verdict, kept separate so both
halves stay independently testable (same split as vision.py's
capture_screen/describe_screen).

Single active task at a time, tracked as plain module-level state --
same pattern as app.py's `_driver`/`_scene_state` globals. This is a
single-user, single-driver-connection app (see app.py's driver/observer
comment), so there's never a real need for more than one "what am I
tracking right now" slot; a second concurrent task genuinely doesn't
make sense for one person at one screen.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, replace

import llm


@dataclass(frozen=True)
class TaskState:
    active: bool = False
    description: str = ""
    # When set_active_task() last actually changed something -- not used
    # for idle detection (that's last_interaction_at below), just useful
    # for debugging/logging.
    updated_at: float = 0.0
    # Bumped by mark_interaction() on every real user turn (see app.py's
    # _run_turn), regardless of whether that turn was about the tracked
    # task at all -- any real interaction means the user is still there.
    # is_idle() compares against this, not updated_at, so a task that's
    # been tracked a long time but the user keeps actively talking never
    # times out just because the *step itself* hasn't changed.
    last_interaction_at: float = 0.0
    # Bumped by mark_checked() every time a screen check actually runs
    # (whether or not it found drift) -- due_for_check() compares against
    # this so the interval is measured from the last real check, not from
    # when the task was first set.
    last_check_at: float = 0.0


_state = TaskState()


def get_state() -> TaskState:
    """Frozen snapshot -- the caller can't accidentally mutate module
    state through the object it gets back."""
    return _state


def set_active_task(active: bool, description: str = "") -> str:
    """The set_active_task tool's actual implementation (see
    tools/__init__.py for the schema/handler wiring). Returns a short
    plain-string confirmation for the tool result the model sees --
    never raises; there's no real failure mode here beyond "the
    description was empty," handled by just falling back to a generic
    label rather than refusing.

    Starting a new task (active=True) always resets last_interaction_at
    and last_check_at to now -- a freshly stated task shouldn't be
    treated as already overdue for a check the instant it's set, and the
    user just talked about it, so the idle clock should start fresh too.
    """
    global _state
    now = time.time()
    if active:
        clean_description = description.strip() or "an unspecified task"
        _state = TaskState(
            active=True,
            description=clean_description,
            updated_at=now,
            last_interaction_at=now,
            last_check_at=now,
        )
        return f"Task tracking started: now watching for progress on '{clean_description}'."
    _state = TaskState(active=False, description="", updated_at=now)
    return "Task tracking stopped."


def clear_active_task() -> None:
    """Same effect as set_active_task(False), but for app.py's own
    internal idle-timeout path (_task_guide_loop) rather than a model
    tool call -- no confirmation string needed there, nothing reads it."""
    global _state
    _state = TaskState(active=False, description="", updated_at=time.time())


def mark_interaction() -> None:
    """Called from app.py's _run_turn on every real user turn. A no-op
    if no task is active -- nothing to reset the idle clock on."""
    global _state
    if _state.active:
        _state = replace(_state, last_interaction_at=time.time())


def mark_checked() -> None:
    """Called right before/after a screen check actually runs (whether
    or not it finds drift) -- due_for_check() measures the interval from
    this, not from when the task was set."""
    global _state
    if _state.active:
        _state = replace(_state, last_check_at=time.time())


def is_idle(state: TaskState, idle_timeout_seconds: float) -> bool:
    if not state.active:
        return False
    return (time.time() - state.last_interaction_at) >= idle_timeout_seconds


def due_for_check(state: TaskState, capture_interval_seconds: float) -> bool:
    if not state.active:
        return False
    return (time.time() - state.last_check_at) >= capture_interval_seconds


_CHECK_SYSTEM_PROMPT = """\
You are checking whether a computer screen matches what someone is \
supposed to be working on. You will be given their current task/step \
and a screenshot. Respond with ONLY a JSON object, no markdown fences, \
no commentary before or after it:

{"on_task": true, "note": "one short sentence on what you actually see"}

Be conservative: if the screen plausibly relates to the task, or you \
genuinely cannot tell what is on screen, set on_task to true. Only set \
it to false when the screen is clearly something unrelated -- a \
different app or website that has nothing to do with the stated task \
(e.g. a game, unrelated social media, an unrelated video). A blank \
screen, a lock screen, or an unreadable capture should also be treated \
as on_task true -- there is no real evidence of drift there, just \
missing information.\
"""


async def check_task_progress(task_description: str, image_b64: str) -> dict | None:
    """One-shot VLM call comparing a screenshot against the tracked
    task, via llm.describe_image (same entry point vision.py's
    describe_screen uses) with a different, comparison-focused prompt.
    Returns {"on_task": bool, "note": str} or None if the call failed or
    came back unparseable -- both treated the same by the caller
    (app.py's _run_task_guide_check): skip this check, try again next
    interval, never crash the loop or chide on a guess.

    **Not verified against a real server** -- same caveat as every other
    describe_image/stream_reply_with_tools call in this project (see
    llm.py's own docstrings): this exact prompt shape has never actually
    been sent to qwen3.5:9b.
    """
    prompt = (
        f"{_CHECK_SYSTEM_PROMPT}\n\nCurrent task/step: {task_description!r}"
    )
    try:
        raw_output = await llm.describe_image(prompt, image_b64)
    except llm.LLMUnreachableError:
        return None
    return _parse_check_result(raw_output)


def _parse_check_result(raw_output: str) -> dict | None:
    """Forgiving, same reasoning/shape as forget.py's
    _parse_remove_indices and consolidation.py's own JSON parsing -- a
    small model's output shouldn't be trusted to be clean JSON and
    nothing else. Returns None (not a guessed default) on anything that
    doesn't parse into the expected shape -- the safe direction to fail
    in is "skip this check," not "assume drift" or "assume on task"."""
    candidates = [raw_output.strip()]
    match = re.search(r"\{.*\}", raw_output, re.DOTALL)
    if match:
        candidates.append(match.group(0))

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        on_task = parsed.get("on_task")
        if not isinstance(on_task, bool):
            continue
        note = parsed.get("note")
        if not isinstance(note, str):
            note = ""
        return {"on_task": on_task, "note": note.strip()}
    return None
