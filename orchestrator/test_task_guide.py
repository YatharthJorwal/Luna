"""
Tests for task_guide.py -- the state (set/clear/idle/due-for-check) is
pure and fully testable here with no stubbing needed. check_task_progress
itself is thin (one llm.describe_image call + the same forgiving-parse
pattern forget.py's own tests already cover), so llm.describe_image is
stubbed the same way tools/test_tools.py stubs it for vision.
describe_screen -- what's NOT covered here is whether qwen3.5:9b actually
produces the requested JSON shape reliably against a real server, same
caveat as every other LLM-call test in this project.
"""

from __future__ import annotations

import dataclasses
import time

import pytest

import task_guide


@pytest.fixture(autouse=True)
def _reset_state():
    """task_guide's TaskState is module-level (see its own docstring on
    why) -- reset it before and after every test so tests don't leak
    state into each other, same reasoning app.py's globals would need if
    they were ever tested directly."""
    task_guide.clear_active_task()
    yield
    task_guide.clear_active_task()


# ---------------------------------------------------------------------------
# set_active_task / clear_active_task -- the state machine itself
# ---------------------------------------------------------------------------


def test_set_active_task_starts_tracking():
    result = task_guide.set_active_task(True, "writing the game loop")
    state = task_guide.get_state()
    assert state.active is True
    assert state.description == "writing the game loop"
    assert "writing the game loop" in result


def test_set_active_task_empty_description_falls_back():
    task_guide.set_active_task(True, "   ")
    assert task_guide.get_state().description == "an unspecified task"


def test_set_active_task_false_clears_tracking():
    task_guide.set_active_task(True, "something")
    result = task_guide.set_active_task(False)
    state = task_guide.get_state()
    assert state.active is False
    assert state.description == ""
    assert "stopped" in result.lower()


def test_clear_active_task_matches_set_false():
    task_guide.set_active_task(True, "something")
    task_guide.clear_active_task()
    assert task_guide.get_state().active is False


def test_starting_a_task_resets_interaction_and_check_clocks():
    task_guide.set_active_task(True, "step one")
    state = task_guide.get_state()
    # Freshly set -- both clocks should read "now," not stale/zero, so
    # is_idle/due_for_check don't fire immediately on a task that was
    # just stated.
    assert abs(time.time() - state.last_interaction_at) < 1.0
    assert abs(time.time() - state.last_check_at) < 1.0


# ---------------------------------------------------------------------------
# mark_interaction / mark_checked -- only matter while a task is active
# ---------------------------------------------------------------------------


def test_mark_interaction_noop_when_no_active_task():
    before = task_guide.get_state()
    task_guide.mark_interaction()
    after = task_guide.get_state()
    assert before == after


def test_mark_interaction_bumps_last_interaction_at(monkeypatch):
    task_guide.set_active_task(True, "step one")
    # Force the clock into the past (via the module's own replace()-based
    # state, not private internals) so the bump from mark_interaction()
    # is actually observable rather than a no-op within the same instant.
    stale_state = dataclasses.replace(task_guide.get_state(), last_interaction_at=0.0)
    monkeypatch.setattr(task_guide, "_state", stale_state)
    task_guide.mark_interaction()
    assert task_guide.get_state().last_interaction_at > 0.0


def test_mark_checked_noop_when_no_active_task():
    before = task_guide.get_state()
    task_guide.mark_checked()
    after = task_guide.get_state()
    assert before == after


# ---------------------------------------------------------------------------
# is_idle / due_for_check
# ---------------------------------------------------------------------------


def test_is_idle_false_when_not_active():
    state = task_guide.TaskState(active=False, last_interaction_at=0.0)
    assert task_guide.is_idle(state, idle_timeout_seconds=10) is False


def test_is_idle_true_past_timeout():
    state = task_guide.TaskState(active=True, last_interaction_at=time.time() - 100)
    assert task_guide.is_idle(state, idle_timeout_seconds=10) is True


def test_is_idle_false_within_timeout():
    state = task_guide.TaskState(active=True, last_interaction_at=time.time())
    assert task_guide.is_idle(state, idle_timeout_seconds=10) is False


def test_due_for_check_false_when_not_active():
    state = task_guide.TaskState(active=False, last_check_at=0.0)
    assert task_guide.due_for_check(state, capture_interval_seconds=10) is False


def test_due_for_check_true_past_interval():
    state = task_guide.TaskState(active=True, last_check_at=time.time() - 100)
    assert task_guide.due_for_check(state, capture_interval_seconds=10) is True


def test_due_for_check_false_within_interval():
    state = task_guide.TaskState(active=True, last_check_at=time.time())
    assert task_guide.due_for_check(state, capture_interval_seconds=10) is False


# ---------------------------------------------------------------------------
# check_task_progress -- llm.describe_image stubbed, forgiving JSON parse
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_check_task_progress_on_task(monkeypatch):
    async def fake_describe_image(prompt, image_b64):
        assert "writing the game loop" in prompt
        return '{"on_task": true, "note": "A Python file is open in an editor."}'

    monkeypatch.setattr(task_guide.llm, "describe_image", fake_describe_image)
    result = await task_guide.check_task_progress("writing the game loop", "fake_b64")
    assert result == {"on_task": True, "note": "A Python file is open in an editor."}


@pytest.mark.asyncio
async def test_check_task_progress_off_task(monkeypatch):
    async def fake_describe_image(prompt, image_b64):
        return '{"on_task": false, "note": "A video streaming site is open."}'

    monkeypatch.setattr(task_guide.llm, "describe_image", fake_describe_image)
    result = await task_guide.check_task_progress("writing the game loop", "fake_b64")
    assert result == {"on_task": False, "note": "A video streaming site is open."}


@pytest.mark.asyncio
async def test_check_task_progress_llm_unreachable_returns_none(monkeypatch):
    async def failing_describe_image(prompt, image_b64):
        raise task_guide.llm.LLMUnreachableError("no server")

    monkeypatch.setattr(task_guide.llm, "describe_image", failing_describe_image)
    result = await task_guide.check_task_progress("writing the game loop", "fake_b64")
    assert result is None


@pytest.mark.asyncio
async def test_check_task_progress_unparseable_returns_none(monkeypatch):
    async def fake_describe_image(prompt, image_b64):
        return "sure, it looks fine I guess"

    monkeypatch.setattr(task_guide.llm, "describe_image", fake_describe_image)
    result = await task_guide.check_task_progress("writing the game loop", "fake_b64")
    assert result is None


def test_parse_check_result_handles_markdown_fenced_json():
    raw = '```json\n{"on_task": false, "note": "unrelated site"}\n```'
    result = task_guide._parse_check_result(raw)
    assert result == {"on_task": False, "note": "unrelated site"}


def test_parse_check_result_missing_on_task_key_returns_none():
    result = task_guide._parse_check_result('{"note": "something"}')
    assert result is None


def test_parse_check_result_non_bool_on_task_returns_none():
    result = task_guide._parse_check_result('{"on_task": "yes", "note": "x"}')
    assert result is None


def test_parse_check_result_missing_note_defaults_empty():
    result = task_guide._parse_check_result('{"on_task": true}')
    assert result == {"on_task": True, "note": ""}
