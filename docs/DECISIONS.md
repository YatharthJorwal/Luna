# Decisions

A running log of *why*, specifically for the things that would otherwise look
like unexplained weirdness in the codebase. Add to this whenever a decision
gets made that isn't obvious from the code alone -- especially ones forced by
reality during implementation, not planned in Phase 0.

## Live2D rendering: `pixi-live2d5` (vendored), not `pixi-live2d-display`

The obvious choice, `pixi-live2d-display` (and its `-lipsyncpatch` fork,
which was tried first), crashes on render against Cubism Core 6.0.1 — which
is the only version Live2D's site currently serves. This is a real, open
upstream bug: neither library has been updated for that Core release
(confirmed via https://github.com/guansss/pixi-live2d-display/issues/177 and
similar open issues).

Fix: `omniwaifu/pixi-live2d5` (https://github.com/omniwaifu/pixi-live2d5) is
a fork built and tested specifically against Core 6.0.1. It's not published
to npm, so it's vendored as a prebuilt local package at
`vendor/pixi-live2d5/` — see that folder's `NOTES.md` for exact rebuild
steps. This also forced PixiJS 7 → 8 (this fork's peer dependency).

Trade-off: this fork dropped the old library's `speak()`/auto-lipsync
convenience method (confirmed by reading its source — the hook exists in
`Cubism5InternalModel.ts` but is commented out). `src/lipsync.ts` drives it
manually instead, via a Web Audio `AnalyserNode` reading amplitude each frame
and pushing it into whichever parameters the model's own `model3.json`
declares under its `LipSync` group (not hardcoded to Hiyori's
`ParamMouthOpenY` specifically, so this keeps working if the model changes).

## Window: `maximizable: false`, `layout()` runs off the ticker, not a resize listener

A decorationless Tauri window's drag region still honors Windows' native
double-click-to-maximize gesture by default. Combined with our own
`window.addEventListener("resize", layout)` racing against PIXI's own
`resizeTo: window` plugin (both listen for resize independently, no
ordering guarantee between them), a maximize/restore cycle could reposition
Luna using stale renderer dimensions and send her off-window entirely.

Fix: `maximizable: false` in `tauri.conf.json` (she can still be dragged and
edge-resized, just not maximized), and `layout()` now runs every tick via
`app.ticker.add(layout)` instead of on a resize event — negligible cost,
can't race.

## Hiyori (Live2D's official free sample) is committed to the repo

Normally a Live2D model wouldn't belong in version control (see
`docs/ROADMAP.md`'s open decision on sourcing a real one), but Hiyori is
explicitly licensed by Live2D for exactly this kind of prototyping (Free
Material License) and there's nothing user-specific or sensitive about it —
committing it means the repo is immediately runnable after a clone (module
the Cubism Core file below). Swap it for a licensed/purchased/commissioned
model before this is anything more than a local dev build.

## `public/live2dcubismcore.min.js` is gitignored, always missing after a clone

Live2D's license terms don't allow third parties (including us) to
redistribute the Cubism Core runtime. It has to be downloaded fresh from
https://www.live2d.com/en/sdk/download/web/ after every fresh clone — see
the README's Prerequisites section. This is the #1 thing to check first if a
fresh clone renders a blank window.

## Git workflow: bundle-based handoff, not a shared remote

Claude doesn't have push access to the user's GitHub repo (or persistent
access to their machine at all) — each work session happens in a fresh
sandbox. Changes get committed there with real messages, then handed over as
a `git bundle` file the user clones or pulls from locally, and finally
pushes to GitHub themselves (`YatharthJorwal/Luna`). This preserves real
commit history end to end instead of flattening every update into one blob.

## pyttsx3 as the Phase 1 placeholder voice

Zero model download (uses SAPI5 on Windows already), which matters for
proving the shell/audio pipeline works before spending time on GPT-SoVITS
setup. Swap it for real TTS in `orchestrator/tts.py` when Phase 2/6 gets to
voice work — see `docs/MODELS.md`.

## Phase 2: sentence-level chunking, not token-level, for the streaming pipeline

`docs/ARCHITECTURE.md` describes the Phase 2 pipeline as "streamed text →
TTS → lip-sync." Token-level audio streaming isn't practical with pyttsx3
(or most local TTS engines — they synthesize a complete utterance, not a
running stream), so `orchestrator/chunking.py` buffers the LLM's token
stream and cuts it into sentence-sized pieces instead: each becomes its
own `speak` message the instant it's ready, rather than waiting for the
full reply. That's the level "streamed" actually means here.

Two things worth knowing if this looks off:
- `MIN_CHUNK_CHARS` (40) folds short sentences into the next one before
  cutting. Without it, pyttsx3's per-call engine re-init (see `tts.py`)
  fires for every three-word fragment and sounds choppy. The final
  trailing chunk always flushes regardless of length once the LLM stream
  ends (`chunking.flush()`), so nothing is ever dropped.
- The boundary regex isn't real NLP sentence segmentation — it'll misfire
  on abbreviations ("Mr. Smith" can split mid-name if enough text has
  already accumulated). Accepted as a known limitation rather than pulling
  in an NLP dependency for it; revisit only if it's audibly wrong often
  enough in practice to matter.

## Phase 2: LLM endpoint defaults to Ollama's OpenAI-compat API, not llama.cpp

`docs/MODELS.md` left the choice between Ollama and a llama.cpp server
open. `orchestrator/llm.py` talks to a plain OpenAI-compatible
`/chat/completions` endpoint either way — both servers speak that
protocol — so `config.yaml`'s `llm.base_url` defaults to Ollama's
(`http://127.0.0.1:11434/v1`) since it's the lower-friction setup (`ollama
pull qwen3-vl:8b` vs. building/running llama.cpp's server binary
directly). Switching to llama.cpp later is a one-line `base_url` edit in
`config.yaml`, not a code change — matches the working agreement in
`CLAUDE.md`.

## Phase 2: a failed/unreachable LLM turn drops the user's message from history

If `llm.stream_reply()` never yields anything for a turn (server down,
connection refused, etc.), `app.py` pops that turn's `user` message back
out of the session history instead of leaving it in context with no
matching `assistant` reply. Reasoning: an unanswered turn sitting in
history would get sent back to the LLM on the *next* successful turn,
which is confusing context for no benefit — there's nothing useful to
recover from a call that never returned anything. If the stream fails
*partway through* (some sentences already sent), whatever did come
through is kept and committed to history as normal; only a fully-empty
turn gets dropped. The in-character fallback line
(`LLM_UNREACHABLE_LINE`) is always spoken either way, so the user isn't
left staring at silence.

## Phase 2: persona pass is a real function call, not just a comment, even though it's a no-op

`CLAUDE.md`'s working agreement says to keep the persona pass separable
from the core reasoning pass "even while it's collapsed into one prompt
for now." `orchestrator/persona.py`'s `apply_persona_pass()` is that seam
made literal: every chunk flows through it in `app.py` before being
spoken, even though today it just returns its input unchanged (the
persona is already baked into `SYSTEM_PROMPT`, which is the one LLM call
Phase 2 makes). When Phase 6 splits this into a real second pass, that
function is the only thing that changes — `app.py`'s streaming/chunking
loop doesn't need to move.

## Phase 2: frontend needs a playback queue now that one reply is several `speak` messages

Phase 1's `speak()` in `src/main.ts` assumed one `speak` message per
reply and played it immediately. Phase 2's sentence-chunked streaming
means a single reply can arrive as several `speak` messages in quick
succession — calling `speakWithLipsync()` again while a previous chunk is
still playing would start a second `Audio`/`AnalyserNode` racing the
first one, not queue politely. `SpeakQueue` in `src/main.ts` replaces the
old direct call: it holds pending chunks and only starts the next one
once the current one's `onFinish` fires.

## First real-hardware test: mouth never moved — `src/lipsync.ts` was hooking the wrong update cycle

Audio played correctly on the first Windows test, but the model's mouth
never moved at all — 100% of the time, not intermittently. Root cause,
found by cloning the actual fork source
(`github.com/omniwaifu/pixi-live2d5`, not just the vendored prebuilt
`dist/`) and reading `Cubism5InternalModel.ts`'s `update()` directly:

Every frame, that method calls `model.loadParameters()` *first* to
restore Cubism parameters to the snapshot taken right after the motion
system last ran (`model.saveParameters()`, called partway through the
same function), then does the actual deformation/render-prep in
`model.update()` at the very *end* of that same synchronous call. The
original `src/lipsync.ts` called `addParameterValueById()` from its own
independent `requestAnimationFrame` loop — completely uncoordinated with
that cycle. Whichever order the two rAF callbacks happened to fire in
during a given browser frame, the result was the same: run before the
model's own update and the addition gets wiped by that frame's
`loadParameters()` restore; run after and it modifies parameters *after*
that frame's deformation was already computed from the old values. There
is no timing where an external caller lands inside the window that
actually reaches the render. Not a rare race — structurally guaranteed to
never work, which is exactly what showed up.

Fix: `InternalModel` (which `Cubism5InternalModel` extends) is a
`pixi.js` `EventEmitter` and emits `"beforeModelUpdate"` from inside that
exact window — after motion/physics/pose, right before `model.update()`.
`src/lipsync.ts` now calls `internalModel.on("beforeModelUpdate", ...)`
instead of running its own animation loop; `src/types/pixi-live2d5.d.ts`
gained `on()`/`off()` on the `InternalModel` shim to type it. Confirmed
the `EventEmitter` semantics this relies on (that `on`/`off`/`emit`
behave like a standard emitter) by exercising `pixi.js`'s actual
`EventEmitter` class directly, not just reading its type signature.

Still genuinely unverified: whether the mouth *visibly* opens and closes
in a way that looks right, since that needs eyes on a running window.
The fix addresses the confirmed structural bug (parameters never reaching
a render at all); `MOUTH_GAIN` in `lipsync.ts` is still an untested guess
and may need retuning once it's actually visible.

## First real-hardware test: chunks played with a slight audio overlap — added a deliberate inter-chunk gap

Reported alongside the lipsync bug above. Read through `SpeakQueue`
(`src/main.ts`), `speakWithLipsync` (`src/lipsync.ts`), the WebSocket
message handler (`src/ws-client.ts`), and the backend's TTS call
sequencing (`orchestrator/tts.py`, `orchestrator/app.py`) looking for a
structural cause — a queue race, concurrent `pyttsx3` synthesis producing
a corrupted file, anything that would cause literal overlap — and didn't
find one: `SpeakQueue.push()`/`playNext()` has no `await` in it so two
messages can't interleave, the WebSocket `message` handler is fully
synchronous before calling `onSpeak`, and each backend `synthesize()`
call is awaited to completion (via `asyncio.to_thread`) before the next
chunk's LLM tokens are even processed, so there's no concurrent pyttsx3
usage either.

Best remaining explanation, not confirmed: chaining separate
`HTMLAudioElement`s back-to-back on the `"ended"` event can have a few ms
of boundary overlap in practice — the next element's `.play()` has its
own startup latency, and audio already queued in the previous element's
Web Audio routing (through the `AnalyserNode`) can trail slightly past
when `"ended"` fires. `SpeakQueue` now waits `GAP_MS` (150ms) after one
chunk finishes before starting the next, which should mask that and also
makes the sentence-by-sentence delivery sound like natural pauses instead
of abrupt bursts. If overlap is still audible after this, it's a real bug
worth digging into further with actual console/audio output from a
running session, since static reading of the code didn't turn up a
structural cause.
