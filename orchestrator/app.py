"""
Luna's orchestrator -- Phase 2.

Real LLM conversation now: user text is appended to a per-connection
session history (system prompt from persona.py + prior turns), sent to the
configured OpenAI-compatible chat endpoint (config.yaml / llm.py), and the
reply streams back token-by-token. Tokens are chunked into sentence-ish
pieces (chunking.py) so TTS/lipsync can start on the first sentence
instead of waiting for the whole reply -- each chunk goes to the shell as
its own `speak` message (src/main.ts queues and plays them back to back,
not overlapping).

`history` itself is still session-only: a plain Python list tied to the
websocket connection, gone when it disconnects. Phase 3 adds durable
memory *alongside* that, not instead of it: each turn gets a fresh recall
block (facts + semantically relevant past-episode summaries, see
memory/recall.py) injected into that turn's LLM call only, and once the
connection actually ends, memory/consolidation.py distills the whole
session into new facts + one episode summary for next time. No tool-calling
yet either way -- that's Phase 4.

Phase 2.5 adds voice input: a `user_audio` message (base64 WAV/WebM bytes
from the frontend's MediaRecorder) is transcribed via faster-whisper
(stt.py) and fed into the exact same turn-handling path as `user_text` --
see `_run_turn()` below, shared by both message types.

Binds to 127.0.0.1 only, on purpose -- never expose this beyond localhost,
per the project's local-only, non-negotiable constraint (see CLAUDE.md).

Graceful shutdown: `/shutdown` (see its own docstring below) exists
because the Tauri side's tray-Quit handler used to just hard-kill this
process (`TerminateProcess` on Windows, via Rust's `Child::kill()`) --
which meant `ws_endpoint`'s `finally` block, and therefore Phase 3's
`consolidate_session()`, never ran on ANY quit path (tray Quit, Ctrl+C,
Task Manager). Every session's memory was silently lost. Found while
answering the user's own "what's the right way to close this" question,
not anticipated up front -- see docs/DECISIONS.md.
"""

import asyncio
import base64
import contextlib
import os
import sys

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import llm
import stt
from chunking import extract_ready_chunks, flush
from config import CONFIG
from memory import consolidation, forget, recall
from persona import SYSTEM_PROMPT, apply_persona_pass, extract_emotion_tag
from tts import synthesize

app = FastAPI()

HOST = "127.0.0.1"
PORT = 8765

# Set by /shutdown, watched by every open connection's main loop (see
# ws_endpoint) so it can close itself gracefully -- letting `finally` run
# consolidation -- instead of the process just being killed out from under
# it. A plain module-level asyncio.Event is enough here: one orchestrator
# process, one event loop, no multi-worker uvicorn setup to worry about.
_shutdown_event = asyncio.Event()

# Tracked so /shutdown knows when it's actually safe to exit the process --
# once every currently-open connection has torn itself down (and therefore
# already run consolidation), there's nothing left to wait for.
_active_connections: set[WebSocket] = set()

# Full-body sandbox round: two different windows (the Tauri shell,
# src/main.ts, and the browser-tab sandbox, src/sandbox.ts) can now both
# hold an open connection to this same orchestrator at once. Only one of
# them should ever actually be allowed to start a turn -- otherwise both
# could end up generating a reply and playing TTS audio at the same time,
# which would be audibly broken, not just untidy. Whichever connects
# first becomes the "driver"; anything else connecting while the driver
# is still open is an "observer" (see ws_endpoint's connect/disconnect
# handling below and ws-client.ts's protocol comment for the client side
# of this). `_driver` is `None` whenever nobody's connected at all.
_driver: WebSocket | None = None
_connection_surface: dict[WebSocket, str] = {}

# Sent (in character, same as LLM_UNREACHABLE_LINE/STT_UNREACHABLE_LINE
# below) if an observer connection tries to start a turn anyway -- a
# stray click on a UI that should already have disabled itself (see
# main.ts's/sandbox.ts's own onSurfaceStatus handling), or a second
# window opened after all. Declining audibly, not just silently dropping
# the message, so it's obvious what happened rather than looking like a
# hang.
SURFACE_BUSY_LINE = "I'm already talking to you somewhere else right now -- finish up there first, hm?"
EMOTION_SURFACE_BUSY = "teasing"

# Said if the configured LLM server can't be reached at all -- most likely
# it just isn't running yet. In character on purpose so a first-run miss
# (forgot to start Ollama) feels like her, not a crash.
LLM_UNREACHABLE_LINE = (
    "H-hey -- I can't reach my own brain right now. Is the model server "
    "even running? Check the orchestrator terminal and try again."
)

# Said if STT itself throws -- most likely stt.device: "cuda" in
# config.yaml but the CUDA cuBLAS/cuDNN DLLs aren't on PATH (see README's
# troubleshooting section), or a corrupted first-time model download.
# Without this, a failure here used to kill the websocket connection
# outright with nothing visible on the user's side at all -- see
# stt.STTError's docstring.
STT_UNREACHABLE_LINE = (
    "I-I can't hear anything right now, something's wrong with my ears. "
    "Check the orchestrator terminal?"
)

# Phase 8 -- hardcoded emotion for the two error-fallback lines above,
# rather than trying to get the LLM to tag them: both LLM_UNREACHABLE_LINE
# and STT_UNREACHABLE_LINE are canned text sent *instead of* a real LLM
# call (the LLM is either unreachable, or was never consulted for the STT
# failure path), so there's no model-generated [tag] to extract either
# way -- this is app-level knowledge, not something to fake a tag for.
EMOTION_LLM_UNREACHABLE = "sad"
EMOTION_STT_UNREACHABLE = "sad"


async def _send_speak(websocket: WebSocket, text: str) -> None:
    audio_bytes = await synthesize(text)
    await websocket.send_json(
        {
            "type": "speak",
            "text": text,
            "audio_b64": base64.b64encode(audio_bytes).decode("ascii"),
            "mime": "audio/wav",
        }
    )


def _trim_history(history: list[dict[str, str]]) -> None:
    """Keeps the system prompt plus the last N (user, assistant) turns.
    Session memory only (Phase 3 adds durable memory), but still needs a
    cap so a long session doesn't grow the LLM's context unbounded."""
    system, turns = history[0], history[1:]
    max_messages = CONFIG.session.max_history_turns * 2
    if len(turns) > max_messages:
        turns = turns[-max_messages:]
    history[:] = [system] + turns


async def _run_turn(
    websocket: WebSocket, history: list[dict[str, str]], user_text: str
) -> None:
    """The actual agent turn: append user_text to history, stream the LLM
    reply, speak each sentence chunk as it's ready, commit (or roll back)
    history. Shared by both `user_text` (typed) and `user_audio`
    (transcribed) messages -- by the time this runs, there's no difference
    between the two."""
    history.append({"role": "user", "content": user_text})

    # Phase 3: forget first, then recall -- so a fact just removed this
    # turn can't immediately resurface in the same turn's recall block.
    # Both are ephemeral system messages built fresh per turn, spliced
    # into the LLM call only -- never written into `history` itself (see
    # memory/recall.py's docstring for why: history is the real
    # conversation, and this would otherwise go stale, double up every
    # turn, and get fed back into consolidation.py as if it were something
    # someone actually said). Falls back to plain `history` unchanged if
    # neither has anything to add -- a turn should never fail or even
    # look different structurally just because memory had nothing to do.
    forget_hint = await forget.maybe_forget(user_text)
    memory_block = await recall.build_recall_context(user_text, CONFIG.memory.recall_top_k)
    memory_parts = [part for part in (forget_hint, memory_block) if part]

    if memory_parts:
        combined = " ".join(memory_parts)
        messages_for_llm = history[:-1] + [{"role": "system", "content": combined}] + history[-1:]
    else:
        messages_for_llm = history

    buffer = ""
    reply_parts: list[str] = []
    detected_emotion: str | None = None
    try:
        async for delta in llm.stream_reply(messages_for_llm):
            buffer += delta
            chunks, buffer = extract_ready_chunks(buffer)
            for chunk in chunks:
                reply_parts.append(chunk)
                await _send_speak(websocket, apply_persona_pass(chunk))
        # Stream's fully done now, not mid-flight -- only safe point to
        # check for a trailing [emotion] tag (see extract_emotion_tag()'s
        # own docstring on why mid-stream would risk a false match).
        buffer, detected_emotion = extract_emotion_tag(buffer)
        for chunk in flush(buffer):
            reply_parts.append(chunk)
            await _send_speak(websocket, apply_persona_pass(chunk))
    except llm.LLMUnreachableError:
        await _send_speak(websocket, LLM_UNREACHABLE_LINE)
        detected_emotion = EMOTION_LLM_UNREACHABLE
    finally:
        # In `finally`, not just after the try block, so a stop-button
        # cancellation (asyncio.CancelledError, raised into whichever
        # await this task happens to be sitting on when ws_endpoint's
        # "stop" handler cancels it) still records whatever was actually
        # said up to that point -- matching reality (she got cut off
        # mid-sentence) instead of silently dropping the whole turn.
        # CancelledError propagates on through after this, same as any
        # other exception would through a finally block. The
        # LLM-unreachable fallback line above is deliberately NOT added to
        # reply_parts -- it was never really said by her, so it shouldn't
        # end up looking like a real reply in history either.
        if reply_parts:
            history.append({"role": "assistant", "content": " ".join(reply_parts)})
        else:
            # Nothing usable came back (LLM unreachable and no fallback
            # line ended up in reply_parts either, or stopped before a
            # single chunk arrived) -- drop the dangling user turn rather
            # than leave a one-sided exchange in context for next time.
            history.pop()
        _trim_history(history)

    # Tells the frontend nothing more is coming for this turn (so it can
    # hide the stop button, re-enable input, etc.) -- only reached on a
    # *normal* completion (finished generating, or hit the LLM-unreachable
    # fallback). A stop-button cancellation skips this entirely (the
    # CancelledError above propagates straight out of the function instead
    # of reaching this line) -- ws_endpoint's "stop" handler sends its own
    # turn_end right after successfully cancelling, once it's actually
    # safe to send anything further over the socket. That stopped-turn
    # case is also why detected_emotion can genuinely be None here even
    # on a real reply -- either the tag-extraction step was never reached
    # (LLM unreachable), or the model just didn't produce a recognized
    # tag this time (see extract_emotion_tag()'s own docstring) -- the
    # frontend leaves the current expression alone rather than guessing
    # when this is omitted/None.
    await websocket.send_json({"type": "turn_end", "emotion": detected_emotion})


@app.post("/shutdown")
async def shutdown_endpoint() -> dict:
    """Requested by src-tauri/src/lib.rs's tray-Quit handler as a graceful
    shutdown attempt *before* falling back to a hard process kill -- see
    this module's own top docstring for why that fallback alone was
    silently losing every session's Phase 3 memory.

    Sets `_shutdown_event`, which every open connection's main loop is
    already watching (see `ws_endpoint`) -- each one notices, breaks out
    of its receive loop, and runs its normal `finally` teardown (including
    `consolidate_session()`) same as a real disconnect would. This handler
    then waits a bounded amount of time for that to actually finish before
    exiting the process itself, so Rust's fallback `.kill()` only ever
    fires if this doesn't finish in time -- not as the normal path.

    Deliberately `os._exit(0)` rather than uvicorn's own graceful-shutdown
    machinery (`server.should_exit`) -- this is a single-user local
    desktop app, not a server that needs a zero-downtime drain; explicit,
    self-bounded teardown here is simpler to reason about and test than
    coordinating with uvicorn's own shutdown sequence on top of it.
    """
    _shutdown_event.set()

    # Bounded wait for every currently-open connection to actually finish
    # tearing down (and therefore finish consolidating) -- 50 x 100ms = 5s,
    # matched to the grace period src-tauri/src/lib.rs's quit handler waits
    # before falling back to a hard kill; if this window's ever too short
    # for a slow consolidation LLM call, that's a mismatch to fix on both
    # sides together, not something to silently paper over on just one.
    for _ in range(50):
        if not _active_connections:
            break
        await asyncio.sleep(0.1)

    sys.stdout.flush()
    sys.stderr.flush()
    # Scheduled slightly after this handler returns, not called inline --
    # os._exit() would otherwise tear down the process before uvicorn gets
    # a chance to actually send this response back.
    asyncio.get_event_loop().call_later(0.1, lambda: os._exit(0))
    return {"status": "shutting down"}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    _active_connections.add(websocket)

    # Driver/observer assignment -- see _driver's own module-level comment
    # above. Decided once, right here, at connect time: "whoever's already
    # open wins" is a simple, honest rule that doesn't need to know
    # anything about *which* surface either window is (shell vs sandbox);
    # `surface` itself is only carried through for logging/debugging, not
    # used in this decision.
    global _driver
    surface = websocket.query_params.get("surface", "unknown")
    _connection_surface[websocket] = surface
    is_driver = _driver is None
    if is_driver:
        _driver = websocket
    await websocket.send_json({"type": "surface_status", "role": "driver" if is_driver else "observer"})

    history: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    # The in-flight turn, if any -- run as its own task (not just awaited
    # inline) specifically so the main loop below can keep concurrently
    # watching for a "stop" message (or /shutdown) while generation is
    # still happening. Awaiting _run_turn() directly, the way earlier
    # phases did, meant the loop couldn't read anything else off the
    # socket until a turn finished -- a "stop" message would just sit
    # unread in the transport buffer until it was too late to matter.
    current_turn_task: asyncio.Task | None = None

    try:
        while True:
            # Raced against _shutdown_event instead of a plain
            # `await websocket.receive_json()` -- otherwise a connection
            # sitting idle (nobody's typed anything) would just block
            # forever, never noticing /shutdown was called at all, and
            # this process would still need the hard-kill fallback every
            # time regardless of the endpoint above existing.
            receive_task = asyncio.create_task(websocket.receive_json())
            shutdown_task = asyncio.create_task(_shutdown_event.wait())
            done, pending = await asyncio.wait(
                {receive_task, shutdown_task}, return_when=asyncio.FIRST_COMPLETED
            )

            if shutdown_task in done:
                receive_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await receive_task
                break  # -> finally below runs, same as a real disconnect

            shutdown_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await shutdown_task
            data = receive_task.result()
            msg_type = data.get("type")

            if msg_type == "stop":
                # No-op if nothing's actually running -- a stray/late
                # click after a reply already finished shouldn't do
                # anything or send anything back.
                if current_turn_task is not None and not current_turn_task.done():
                    current_turn_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await current_turn_task
                    # _run_turn's own turn_end send is skipped on a
                    # cancellation (see its own comment) -- send it here
                    # instead, now that the task has actually finished
                    # unwinding and it's safe to use the socket again.
                    await websocket.send_json({"type": "turn_end"})
                continue

            if msg_type in ("user_text", "user_audio") and websocket is not _driver:
                # Observer window trying to start a turn -- the frontend
                # should already have disabled its own input for this
                # (see onSurfaceStatus in main.ts/sandbox.ts), so this is
                # defense in depth, not the primary guard. Declined
                # audibly rather than silently dropped, and still sends
                # turn_end so that window's own turnActive-style flag
                # (set optimistically the moment it sent something)
                # doesn't get stuck waiting forever for a reply that's
                # never coming.
                await _send_speak(websocket, apply_persona_pass(SURFACE_BUSY_LINE))
                await websocket.send_json({"type": "turn_end", "emotion": EMOTION_SURFACE_BUSY})
                continue

            if msg_type == "user_text":
                user_text = (data.get("text") or "").strip()
                if not user_text:
                    continue
                if current_turn_task is not None and not current_turn_task.done():
                    # Already mid-reply -- ignore rather than overlap two
                    # turns concurrently mutating the same `history` list.
                    # The frontend should disable input while a reply is
                    # in flight; this is just defense in depth regardless.
                    continue
                current_turn_task = asyncio.create_task(_run_turn(websocket, history, user_text))

            elif msg_type == "user_audio":
                audio_b64 = data.get("audio_b64") or ""
                if not audio_b64:
                    continue
                try:
                    audio_bytes = base64.b64decode(audio_b64)
                except ValueError:
                    # Malformed base64 -- nothing recoverable, drop it.
                    continue

                print(f"[luna] received {len(audio_bytes)} bytes of audio", file=sys.stderr, flush=True)

                if current_turn_task is not None and not current_turn_task.done():
                    # Already mid-reply -- drop this clip without even
                    # transcribing it, same "ignore, don't overlap turns"
                    # policy as user_text above, just applied before
                    # spending STT compute on something we're going to
                    # ignore anyway.
                    continue

                try:
                    user_text = (await stt.transcribe(audio_bytes)).strip()
                except stt.STTError as exc:
                    print(f"[luna] STT failed: {exc}", file=sys.stderr)
                    await websocket.send_json({"type": "transcript", "text": ""})
                    await _send_speak(websocket, apply_persona_pass(STT_UNREACHABLE_LINE))
                    # This path never reaches _run_turn (there's no
                    # transcript to reply to), so it's the one other place
                    # besides _run_turn/the stop handler that has to send
                    # turn_end itself -- without it, the frontend's
                    # turnActive flag (set optimistically the moment audio
                    # was sent, before knowing whether STT would even
                    # succeed) would stay stuck true forever: input
                    # disabled, stop button stuck visible, no further
                    # turn_end ever coming to clear it. Found while adding
                    # Phase 8's emotion tagging, not something anticipated
                    # up front -- see docs/DECISIONS.md.
                    await websocket.send_json({"type": "turn_end", "emotion": EMOTION_STT_UNREACHABLE})
                    continue

                # Always echo the transcript back, even empty, so the
                # frontend can clear its "listening" indicator either way.
                await websocket.send_json({"type": "transcript", "text": user_text})
                if not user_text:
                    # Silence, noise, or nothing intelligible -- nothing to
                    # reply to, and nothing worth adding to history.
                    continue
                current_turn_task = asyncio.create_task(_run_turn(websocket, history, user_text))
            else:
                continue
    except WebSocketDisconnect:
        pass
    finally:
        _active_connections.discard(websocket)
        _connection_surface.pop(websocket, None)
        # This connection was the driver -- promote whichever other
        # connection is still open, if any, so a still-open second window
        # (or a third one that connected while both were up) doesn't stay
        # locked out just because the original driver happened to close
        # first. Note this does *not* hand the promoted connection the old
        # driver's `history` -- each connection keeps its own (unchanged
        # since Phase 2) -- so a promoted observer starts a fresh
        # conversation rather than continuing the old one mid-thread. A
        # real shared-session handoff would need restructuring `history`
        # to live per-character rather than per-connection; not done here
        # -- see docs/DECISIONS.md.
        if websocket is _driver:
            _driver = next(iter(_active_connections), None)
            if _driver is not None:
                with contextlib.suppress(Exception):
                    await _driver.send_json({"type": "surface_status", "role": "driver"})
        # A turn still running when the connection itself goes away (not
        # just a "stop" click) -- cancel it too, same reasoning as
        # above, so consolidation below reads a `history` that's finished
        # settling instead of one an abandoned task might still be
        # mutating mid-append.
        if current_turn_task is not None and not current_turn_task.done():
            current_turn_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await current_turn_task
        # Phase 3: distill this session into durable memory (facts +
        # one episode summary) once it's actually over. In `finally`, not
        # just the `except WebSocketDisconnect` branch, so it also runs on
        # a clean/unexpected exit either way (including the shutdown-event
        # `break` above). Wrapped defensively even though
        # consolidate_session() already catches its own known failure
        # modes internally (LLM/embedding unreachable) -- a session ending
        # should never be blocked by memory work, and an unforeseen bug
        # here shouldn't take down connection teardown.
        try:
            await consolidation.consolidate_session(history)
        except Exception as exc:  # noqa: BLE001 -- see comment above
            print(f"[luna] consolidation failed unexpectedly: {exc}", file=sys.stderr)
        # Only reachable for the shutdown-event break above -- a real
        # WebSocketDisconnect means the socket's already gone. Harmless
        # either way; already-closed is a no-op error we don't care about.
        with contextlib.suppress(Exception):
            await websocket.close()


if __name__ == "__main__":
    import uvicorn

    from memory import db as memory_db

    # Cheap check, once per process start -- see
    # check_embedding_dimension_matches()'s docstring for why this is
    # worth doing proactively instead of waiting for a mid-turn error the
    # first time someone swaps the embedding model after episodes already
    # exist.
    memory_db.check_embedding_dimension_matches()

    uvicorn.run(app, host=HOST, port=PORT)
