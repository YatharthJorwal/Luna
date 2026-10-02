"""
Keeps every LLM call inside the model's context window, and keeps unprompted
comments from flooding history.

Why this exists (docs/DECISIONS.md, "Reply cutoffs were the context window"):
replies were ending after 24-132 characters with done_reason='length' while
llm.max_tokens (512) was nowhere near reached. The window was full. A turn's
prompt is the persona system prompt (~9 KB) + tool schemas (~2.7 KB) + the
recall/hint block + up to 40 history messages, and Continuous OCR and Task
Guide were each adding one assistant message per check. `_trim_history` only
counts messages, never size, so nothing noticed the window filling.

Two independent guards live here, both pure functions so they are testable
without a server:

- fit_messages(): at call time, drops the OLDEST droppable history messages
  from the copy being sent until the estimated prompt plus a reserved reply
  fits num_ctx. System messages (the persona prompt and the per-turn
  memory/hint block) and the final message are never dropped. `history`
  itself is untouched, so end-of-session consolidation still sees the whole
  conversation.
- cap_unprompted(): permanently removes all but the newest few unprompted
  assistant turns (Task Guide chides, OCR remarks) from `history`. They add
  little, and stacked back-to-back with no user turn between them they made
  the model reply to a user who never spoke.

Token counts are an estimate (chars / 3.5, deliberately a bit pessimistic for
English) because nothing here may call the model just to count. Ollama's real
prompt_eval_count is logged per turn by llm.py, which is how to check it.
"""

from __future__ import annotations

import json
import math
from typing import Any

CHARS_PER_TOKEN = 3.5
MESSAGE_OVERHEAD_TOKENS = 6
# Slack for the chat template's own markup and for estimate error.
SAFETY_TOKENS = 400


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def message_tokens(message: dict[str, Any]) -> int:
    tokens = MESSAGE_OVERHEAD_TOKENS + estimate_tokens(str(message.get("content") or ""))
    calls = message.get("tool_calls")
    if calls:
        tokens += estimate_tokens(json.dumps(calls, ensure_ascii=False, default=str))
    return tokens


def tools_tokens(tools: list[dict[str, Any]] | None) -> int:
    if not tools:
        return 0
    return estimate_tokens(json.dumps(tools, ensure_ascii=False))


def fit_messages(
    messages: list[dict[str, Any]],
    *,
    num_ctx: int | None,
    reply_reserve: int,
    tools: list[dict[str, Any]] | None = None,
    extra: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], int, int, int]:
    """Returns (fitted, dropped_count, estimated_prompt_tokens, budget).

    `extra` is appended to the request but never dropped (a tool round's
    call/result messages); it only reduces the room for history. `budget` is
    what the prompt may use: num_ctx minus the reply reserve, the safety
    margin, the tool schemas and `extra`. If the fixed parts alone exceed it
    nothing more can be dropped and the over-budget list is returned as is --
    the caller logs that, since it means the persona/memory block itself is
    too big for num_ctx. num_ctx None (server default, unknown) = no-op.
    """
    if not num_ctx:
        return list(messages), 0, sum(message_tokens(m) for m in messages), 0

    budget = (
        num_ctx
        - reply_reserve
        - SAFETY_TOKENS
        - tools_tokens(tools)
        - sum(message_tokens(m) for m in (extra or []))
    )
    sizes = [message_tokens(m) for m in messages]
    total = sum(sizes)
    last = len(messages) - 1
    droppable = [i for i, m in enumerate(messages) if m.get("role") != "system" and i != last]

    dropped: set[int] = set()
    for i in droppable:
        if total <= budget:
            break
        dropped.add(i)
        total -= sizes[i]

    fitted = [m for i, m in enumerate(messages) if i not in dropped]
    return fitted, len(dropped), total, budget


def cap_unprompted(
    history: list[dict[str, Any]],
    temp_turn_flags: list[bool] | None,
    unprompted: list[dict[str, Any]],
    cap: int,
) -> int:
    """Drops all but the newest `cap` unprompted messages from `history`
    (index 0 is the system prompt and is never touched) and removes the
    matching entry from `temp_turn_flags`, which is kept in lockstep with
    history[1:]. `unprompted` is the connection's list of the message dicts
    that were appended as unprompted comments; it is matched by identity and
    pruned in place, including of messages _trim_history already dropped.
    Returns how many messages were removed from history."""
    live = [m for m in unprompted if any(m is h for h in history[1:])]
    unprompted[:] = live

    removed = 0
    while len(unprompted) > max(cap, 0):
        oldest = unprompted.pop(0)
        for i in range(1, len(history)):
            if history[i] is oldest:
                del history[i]
                if temp_turn_flags is not None and 0 <= i - 1 < len(temp_turn_flags):
                    del temp_turn_flags[i - 1]
                removed += 1
                break
    return removed
