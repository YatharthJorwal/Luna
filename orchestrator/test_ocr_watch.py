"""
Tests for ocr_watch.py -- same shape as test_task_guide.py's own tests,
since ocr_watch.py deliberately mirrors task_guide.py's architecture
(module-level state, forgiving JSON parse, a one-shot VLM call). What's
NOT covered here, same caveat as task_guide's own tests: whether
qwen3.5:9b actually produces the requested JSON reliably against a real
server, and whether the "is this worth a comment" judgment reads as
well-calibrated (not naggy, not silent) in actual use.
"""

from __future__ import annotations

import time

import pytest

import ocr_watch


@pytest.fixture(autouse=True)
def _reset_state():
    """ocr_watch's WatchState is module-level (see its own docstring on
    why) -- reset it before and after every test so tests don't leak
    state into each other."""
    ocr_watch.set_active(False)
    yield
    ocr_watch.set_active(False)


# ---------------------------------------------------------------------------
# set_active -- the state machine itself
# ---------------------------------------------------------------------------


def test_set_active_true_starts_watching():
    ocr_watch.set_active(True)
    state = ocr_watch.get_state()
    assert state.active is True
    assert state.last_seen_summary == ""


def test_set_active_false_stops_watching():
    ocr_watch.set_active(True)
    ocr_watch.set_active(False)
    assert ocr_watch.get_state().active is False


def test_starting_resets_check_clock_and_summary():
    ocr_watch.set_active(True)
    state = ocr_watch.get_state()
    assert abs(time.time() - state.last_check_at) < 1.0
    assert state.last_seen_summary == ""


def test_restarting_clears_stale_summary():
    ocr_watch.set_active(True)
    ocr_watch.mark_checked("an old summary from before")
    ocr_watch.set_active(False)
    ocr_watch.set_active(True)
    # A fresh start shouldn't carry over a summary from a previous
    # watching session -- the next check has nothing to compare against.
    assert ocr_watch.get_state().last_seen_summary == ""


# ---------------------------------------------------------------------------
# mark_checked
# ---------------------------------------------------------------------------


def test_mark_checked_noop_when_not_active():
    before = ocr_watch.get_state()
    ocr_watch.mark_checked("something")
    after = ocr_watch.get_state()
    assert before == after


def test_mark_checked_updates_summary_when_given():
    ocr_watch.set_active(True)
    ocr_watch.mark_checked("a code editor open")
    assert ocr_watch.get_state().last_seen_summary == "a code editor open"


def test_mark_checked_keeps_summary_when_omitted():
    ocr_watch.set_active(True)
    ocr_watch.mark_checked("a code editor open")
    ocr_watch.mark_checked()  # no new summary given
    assert ocr_watch.get_state().last_seen_summary == "a code editor open"


# ---------------------------------------------------------------------------
# due_for_check
# ---------------------------------------------------------------------------


def test_due_for_check_false_when_not_active():
    state = ocr_watch.WatchState(active=False, last_check_at=0.0)
    assert ocr_watch.due_for_check(state, interval_seconds=10) is False


def test_due_for_check_true_past_interval():
    state = ocr_watch.WatchState(active=True, last_check_at=time.time() - 100)
    assert ocr_watch.due_for_check(state, interval_seconds=10) is True


def test_due_for_check_false_within_interval():
    state = ocr_watch.WatchState(active=True, last_check_at=time.time())
    assert ocr_watch.due_for_check(state, interval_seconds=10) is False


# ---------------------------------------------------------------------------
# check_for_comment -- llm.describe_image stubbed, forgiving JSON parse
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_check_for_comment_worthy(monkeypatch):
    async def fake_describe_image(prompt, image_b64):
        assert "nothing yet" in prompt
        return '{"comment_worthy": true, "summary": "a browser open to a game store page", "note": "looks like they are eyeing a new game"}'

    monkeypatch.setattr(ocr_watch.llm, "describe_image", fake_describe_image)
    result = await ocr_watch.check_for_comment("", "fake_b64")
    assert result == {
        "comment_worthy": True,
        "summary": "a browser open to a game store page",
        "note": "looks like they are eyeing a new game",
    }


@pytest.mark.asyncio
async def test_check_for_comment_not_worthy(monkeypatch):
    async def fake_describe_image(prompt, image_b64):
        assert "a code editor open" in prompt
        return '{"comment_worthy": false, "summary": "a code editor, same as before", "note": ""}'

    monkeypatch.setattr(ocr_watch.llm, "describe_image", fake_describe_image)
    result = await ocr_watch.check_for_comment("a code editor open", "fake_b64")
    assert result == {"comment_worthy": False, "summary": "a code editor, same as before", "note": ""}


@pytest.mark.asyncio
async def test_check_for_comment_llm_unreachable_returns_none(monkeypatch):
    async def failing_describe_image(prompt, image_b64):
        raise ocr_watch.llm.LLMUnreachableError("no server")

    monkeypatch.setattr(ocr_watch.llm, "describe_image", failing_describe_image)
    result = await ocr_watch.check_for_comment("", "fake_b64")
    assert result is None


@pytest.mark.asyncio
async def test_check_for_comment_unparseable_returns_none(monkeypatch):
    async def fake_describe_image(prompt, image_b64):
        return "sure, nothing much going on I guess"

    monkeypatch.setattr(ocr_watch.llm, "describe_image", fake_describe_image)
    result = await ocr_watch.check_for_comment("", "fake_b64")
    assert result is None


def test_parse_watch_result_handles_markdown_fenced_json():
    raw = '```json\n{"comment_worthy": true, "summary": "x", "note": "y"}\n```'
    result = ocr_watch._parse_watch_result(raw)
    assert result == {"comment_worthy": True, "summary": "x", "note": "y"}


def test_parse_watch_result_missing_comment_worthy_key_returns_none():
    result = ocr_watch._parse_watch_result('{"summary": "x", "note": "y"}')
    assert result is None


def test_parse_watch_result_non_bool_comment_worthy_returns_none():
    result = ocr_watch._parse_watch_result('{"comment_worthy": "yes", "summary": "x", "note": "y"}')
    assert result is None


def test_parse_watch_result_missing_summary_and_note_default_empty():
    result = ocr_watch._parse_watch_result('{"comment_worthy": false}')
    assert result == {"comment_worthy": False, "summary": "", "note": ""}
