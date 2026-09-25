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

## Model re-pick: `qwen3-vl:8b` → `qwen3.5:9b`, and why `llm.py` now speaks two protocols

Requested directly, from a list of models already pulled locally. Worth
recording why this wasn't just a one-line `model:` edit.

`qwen3.5:9b` is a real step up over the original pick — natively
multimodal (Qwen3.5 was trained multimodal from the start; Qwen3-VL is
the earlier generation's vision-bolted-onto-a-text-model approach) and
benchmarks put it ahead of Qwen3-VL even at larger sizes. Similar VRAM
footprint (Q4_K_M ~6.6GB vs. the original ~6GB), so the sizing story in
`docs/MODELS.md` still holds.

The complication: Qwen3.5 is a *hybrid-thinking* model — it can emit a
reasoning phase before its actual reply, and left enabled that's reported
to add 5-10x latency per response. Terrible trade for a companion that's
built around replying in quick, streamed sentence bursts. The obvious fix
— send `think: false` — turned out to not be reliably obvious at all:
searched current (dated within the last several months, some within
days) Ollama GitHub issues and found the OpenAI-compatible
`/v1/chat/completions` endpoint — what `llm.py` exclusively talked to
before this change — unreliably forwards *any* thinking-control field for
several model families (`think`, `reasoning_effort`, and
`chat_template_kwargs.enable_thinking` all have open reports of being
silently ignored or, worse, of breaking the response entirely for some
models — Gemma 4 was found to dump its whole reply into a `reasoning`
field instead of `content` over `/v1` regardless of any flag, making it
outright unusable over that endpoint). Ollama's *native* `/api/chat`
endpoint is confirmed (via Ollama's own docs) to honor `think` correctly
— the bug is specifically in the OpenAI-compatibility shim, not the
underlying thinking control itself.

Fix: `llm.py` now speaks two wire protocols, picked by
`config.yaml`'s new `llm.api_style`:
- `"ollama_native"` (the new default) — Ollama's own `/api/chat`, NDJSON
  streaming (one JSON object per line, `"done": true` on the last one
  instead of an SSE `[DONE]` sentinel). `llm.think: false` is only sent,
  and only reliably honored, in this mode.
- `"openai"` (the original Phase 2 behavior, kept for llama.cpp or any
  non-thinking model where the distinction doesn't matter) — unchanged
  SSE parsing of `/v1/chat/completions`.

This does narrow the "just edit `base_url` to switch between Ollama and
llama.cpp" story from Phase 2 slightly — llama.cpp doesn't implement
Ollama's native `/api/chat` shape, so a llama.cpp switch now also needs
`api_style: "openai"` alongside the `base_url` edit, not just the URL.
Judged worth it: reliable thinking-control beats a slightly simpler
config surface, especially since the alternative (staying on `/v1` and
hoping `think: false` gets respected) is a real, current, and apparently
still-open reliability gap, not a solved problem.

Also added a second, independent layer of protection that doesn't rely on
the flag working at all: `_extract_ollama_native_delta()` only ever reads
`message.content`, never `message.thinking` — so even a model that
completely ignores `think: false` and leaks reasoning into the stream
regardless can't get that reasoning spoken aloud. Verified this
specifically: a stub chunk containing both `content` and `thinking` in
the same object correctly yields only the `content` half.

## STT/TTS pulled forward to Phase 2.5, ahead of the original Phase 6 slot

`docs/ROADMAP.md`'s original v1 spec put real voice (GPT-SoVITS) at
Phase 6 and explicitly scoped STT *out* of v1 entirely ("input is the
text box; add later if wanted"). Requested directly, now that a usable
voice reference sample is available — pulling this forward doesn't
conflict with anything Phase 3-5 builds (persistent memory, vision tools,
Task Guide Mode are all independent of how audio gets in/out), so there's
no real ordering cost to doing it now instead of later.

Concrete API shapes for both were confirmed by reading a real, working
reference implementation rather than assumed from general knowledge of
the two projects — `rayenfeng/riko_project` on GitHub (MIT-licensed,
credits `RVC-Boss/GPT-SoVITS` and `SYSTRAN/faster-whisper`, the same two
picks `docs/MODELS.md` already had queued up as the "if added later"
answer even before this session). Full details in `docs/MODELS.md`'s
TTS/STT sections. GPT-SoVITS's `orchestrator/tts.py` backend is
implemented as of the next entry below; STT (faster-whisper, plus mic
capture in the frontend) is still the next chunk of work.

## `orchestrator/tts.py` gained a GPT-SoVITS backend, engine-selected like the LLM

Implemented as soon as the API contract was confirmed (see the entry
above) rather than waiting for the user's GPT-SoVITS server to exist,
since the contract doesn't depend on whether the underlying voice was
zero-shot or fine-tuned — same `ref_audio_path`/`prompt_text` fields
either way. Verified against a stub server matching the real contract
exactly (`POST /tts`, that exact field set, raw WAV back).

`config.yaml`'s `tts.engine` still defaults to `"pyttsx3"` — not flipped
to `"gpt_sovits"` automatically, since that requires the user to actually
have the API server running and `ref_audio_path`/`prompt_text` filled in
with real values, neither of which is true yet at time of writing. The
`gpt_sovits` config block ships with those two fields empty so it's
inert until deliberately turned on.

One addition beyond a straight port of the LLM's config-driven-backend
pattern: if `engine` is `"gpt_sovits"` but the server can't be reached,
`synthesize()` catches that itself and falls back to `pyttsx3` for that
one line, rather than the turn going silent or crashing. This is
different from the LLM's unreachable-server handling (an in-character
fallback *line*) because TTS failure doesn't lose the actual reply
content the way an unreachable LLM does — there's still a real sentence
to speak, just via the placeholder voice instead of the cloned one for
that turn.

## First real config edit: a Windows path in `config.yaml` silently killed the whole orchestrator

The user filled in `gpt_sovits.ref_audio_path` with a real Windows path
in double quotes — `"C:\Users\User\Downloads\...\.wav"` — and the
orchestrator stopped starting at all: no crash message they could easily
connect to the symptom, just "she doesn't speak" and the frontend's
connection-status dot never lighting up.

Root cause, confirmed by reproducing it with the user's exact file
content: YAML double-quoted strings process backslashes as C-style escape
codes (`\n`, `\t`, `\uXXXX`, `\UXXXXXXXX`, etc.), so `\Users` isn't the
literal text it looks like — PyYAML sees `\U` and tries to read the next
8 characters as a hex-digit unicode escape, fails, and raises a
`ScannerError`. Because `config.py`'s `CONFIG = load_config()` runs at
*module import time*, that exception happens the instant `app.py` tries
to `import config` — before the process ever binds the WebSocket port.
Nothing was listening on 8765, so the frontend's connection attempt just
failed silently with no orchestrator-side log the user was looking at yet
to explain why.

Immediate fix for the user: single-quoted YAML strings don't process
escapes at all, so `'C:\Users\...'` (single quotes) is the correct way to
write a literal Windows path here — same fix as forward slashes, pick
whichever's easier to read.

Fix in the codebase, so this doesn't repeat silently: `load_config()` now
catches `yaml.YAMLError` specifically and re-raises with a message that
names the Windows-path-in-double-quotes gotcha directly (this is by far
the single most likely real-world cause of a YAML error in this file, so
worth naming explicitly rather than leaving someone to decode a raw
`ScannerError` trace) — plus a warning comment right on
`ref_audio_path` in `config.yaml` itself, so the mistake is less likely
on the *next* edit too, not just easier to diagnose after the fact.

## STT: `faster-whisper` on CPU by default, model loaded lazily not at import time

`orchestrator/stt.py` is the last piece of Phase 2.5. `WhisperModel(model_size,
device, compute_type)` + `.transcribe()` returning segments to join was
already confirmed against `riko_project` (see the Phase 2.5 entry above and
`docs/MODELS.md`) — what's recorded here are the two real choices made
implementing it.

**Device defaults to `"cpu"`, not `"cuda"`.** Same reasoning `docs/MODELS.md`
already gives for running GPT-SoVITS on CPU: the 3060's 12GB is already
carrying `qwen3.5:9b` (~6.6GB) and has to share with a game during Task
Guide Mode, so a third thing competing for VRAM on every single utterance
is a bad trade against a few hundred ms of CPU latency for a short spoken
clip. `stt.model_size` ("small") and `stt.compute_type` ("int8") are both
config, not hardcoded, so this is a one-line edit if CPU transcription
turns out to feel sluggish on the user's actual hardware — untested for
real the same way GPT-SoVITS's first real config edit was (see above),
since there's no way to load real model weights in this sandbox (no
network path to Hugging Face here — see README's honesty section).

**Model loads lazily, on the first `transcribe()` call, not at import
time.** Unlike `config.py`'s `CONFIG = load_config()` (cheap, always
needed), constructing a `WhisperModel` pulls weights from Hugging Face on
a first-ever run and takes a real moment to load onto CPU/GPU after
that — paying that cost at orchestrator startup would slow down every
launch (including pure-typed-text sessions that never touch the mic) for
a feature that isn't guaranteed to be used that session. `stt._model` is a
module-level singleton, constructed once on first use and reused after.

Verified in the sandbox against a stubbed `WhisperModel` (segment-joining,
empty-transcript handling, language passthrough, lazy-singleton
construction reading the right config values) and via a real WebSocket
connection through `app.py`'s new `user_audio` handling end-to-end (stt/
llm/tts all stubbed, same methodology as Phase 2's LLM verification) —
not against real model weights or real audio, for the reason above.

## `user_audio` transcription always echoes a `transcript` message back, even when empty

`app.py`'s `user_audio` handler sends `{"type": "transcript", "text": ...}`
to the frontend right after transcribing, *before* deciding whether to run
a turn on it — including when the text comes back empty (silence, noise,
nothing intelligible). Two reasons this isn't just a debug nicety:

- The frontend needs *some* signal that the mic clip was received and
  processed, distinct from "orchestrator never got the message at all" —
  without this, an empty transcription and a dropped WebSocket message
  look identical from the UI's side (nothing happens).
- `src/main.ts` uses the transcript text to briefly show what Luna heard
  in the input box's placeholder, including a "didn't catch that" message
  for the empty case, since misheard/unheard voice input is otherwise
  invisible — unlike typing, where the user can see exactly what they
  entered before hitting Enter.

An empty transcript still doesn't run `_run_turn()` or touch history —
there's nothing to reply to, and adding an empty turn would just be noise
in the LLM's context for no benefit, consistent with how an unreachable-LLM
turn already gets dropped rather than kept (see the Phase 2 entry above).

## Frontend mic capture: mouse toggle + F9 push-to-talk, both through one start()/stop(); plain Web APIs, no Tauri mic plugin

`src/mic.ts` records via the browser's own `getUserMedia`/`MediaRecorder`
APIs directly — no `@tauri-apps/plugin-*` mic dependency needed, since
WebView2 (the webview Tauri uses on Windows) is Chromium-based and
supports these natively, same reasoning as `lipsync.ts` driving audio
output through plain Web Audio instead of a Tauri-specific API.

**Mouse: click to start, click to stop, not press-and-hold.** Luna's
window is small, draggable, transparent, and always-on-top — a
press-and-hold *mouse* gesture risks losing the `mouseup` event entirely
if the cursor drifts off the tiny HUD before releasing, which would leave
the mic stuck recording with no on-screen way to stop it. A plain
click/click toggle can't get stuck that way.

**Keyboard: F9 push-to-talk, added on request.** A physical key doesn't
have the mouse's lost-mouseup problem — `keyup` fires wherever the cursor
ends up — so press-and-hold is safe for a hotkey even though it isn't for
the mouse, and it's the more natural gesture for "hold this and talk."
More importantly, it's registered as an OS-level *global* shortcut
(`tauri-plugin-global-shortcut`, `src-tauri/src/lib.rs`) rather than a
frontend `keydown` listener, so it fires regardless of which window has
focus — a plain in-page listener would only work while Luna's own window
was focused, which defeats the point for a companion you're talking to
while a game or something else is in the foreground. Rust owns the raw
key event and only relays a `"hotkey-talk"` Tauri event with a
`"pressed"`/`"released"` payload; `src/main.ts` listens for it and calls
the exact same `mic.start()`/`mic.stop()` the click handler calls, so
there's one recording state machine, not two, and both entry points are
idempotent against each other (holding F9 while also clicking the mic
button, or vice versa, can't get the recorder into a stuck or
double-started state).

A `MAX_RECORDING_MS` (30s) safety net still exists as a backstop against
either input method being left "on" (forgetting to click stop, or a stuck
key state) — routed through the same `stop()` every other path uses.

**No `mime` field sent in the `user_audio` message,** unlike `speak`
messages going the other direction (which do carry `mime`, since the
frontend needs it to construct a `Blob` for playback). `stt.py`'s
`decode_audio` sniffs the container/codec from the audio bytes themselves
(via PyAV/ffmpeg) rather than trusting a caller-supplied label, so there
was nothing for the backend to do with it — left out rather than carried
along unused.

Not yet verified on real hardware, for two different reasons:

- WebView2's mic permission prompt behaves the way Chrome's does (same
  open "first real run" caveat as Phase 1/2's audio-autoplay-policy note
  in README's "If something doesn't work" section) — `mic.ts`'s `onError`
  callback logs to the console either way rather than failing silently,
  so a denial is at least diagnosable. **Update:** the user confirmed the
  permission prompt itself worked on first real run.
- The `lib.rs` global-shortcut block (Cargo.toml dependency,
  `register_push_to_talk_hotkey()`, the `Emitter` trait import it needed)
  is written against the Tauri v2 / `tauri-plugin-global-shortcut` v2 API
  as I know it, but this sandbox has no Rust toolchain at all — it's never
  been through `cargo check`, let alone actually pressed F9 on Windows.
  Same standing caveat the rest of `lib.rs` already carries (see the note
  at the top of the file) applied to genuinely new Rust code this time,
  not just genuinely new *config* for already-verified code. If `cargo
  build`/`npm run tauri dev` errors out on this block, Tauri's compiler
  errors are usually specific enough to fix directly from the message; the
  `Shortcut` type needing `Clone`/`PartialEq` (used to compare the pressed
  shortcut against the registered one inside the handler closure) and
  `app.handle().plugin(...)` being callable from inside `.setup()` (rather
  than only chained on `Builder` before `.run()`) are the two API surface
  assumptions most likely to have moved since my knowledge cutoff.

## STT: flipped from CPU to CUDA on request

The CPU-by-default choice recorded above wasn't a claim that
`faster-whisper` lacks GPU support — it's CTranslate2-backed and has full
CUDA support — it was a starting default favoring VRAM headroom over
transcription speed. The user has a 3060 and asked for CUDA specifically,
so `stt.device` is now `"cuda"` and `stt.compute_type` is
`"int8_float16"` (CTranslate2's recommended CUDA pairing — int8-quantized
weights, float16 compute). `qwen3.5:9b` (~6.6GB) plus a `"small"` Whisper
model at this quantization (~1GB) both fit in 12GB with room to spare, so
the original VRAM-contention worry doesn't actually bind here in
practice once you do the arithmetic on the specific models in play.

Real, common gotcha worth naming directly rather than leaving to a cryptic
error: CTranslate2's CUDA path needs cuBLAS/cuDNN DLLs on `PATH`, and
`pip install faster-whisper` does **not** pull those in for you (confirmed
by checking `ctranslate2`'s own declared pip dependencies — no
`nvidia-cudnn-*`/`nvidia-cublas-*` packages listed). If CUDA init fails,
it typically surfaces as a `cudnn_ops64_9.dll` (or similar) not-found
error rather than a clear "CUDA unavailable" message — see README's
troubleshooting section for what to try. Not verified end-to-end in this
sandbox (no GPU here either) — the config change and the reasoning behind
it are solid, whether it loads cleanly on the user's actual Windows/3060
setup is a first-real-run question like everything else GPU-related in
this project so far.

## First real `cargo build`: E0277 on `register_push_to_talk_hotkey`

Predicted this file's global-shortcut block was the least-verified new code
in the STT push (see the note at the top of `lib.rs` and the entry above) —
first real `cargo build` on the user's machine confirmed exactly one error
there, nothing else:

```
error[E0277]: `?` couldn't convert the error to `tauri::Error`
    app.global_shortcut().register(push_to_talk)?;
    the trait `From<tauri_plugin_global_shortcut::Error>` is not
    implemented for `tauri::Error`
```

Root cause: `register_push_to_talk_hotkey()`'s signature declared
`tauri::Result<()>` (i.e. `Result<(), tauri::Error>`), but `.register()`
returns `Result<(), tauri_plugin_global_shortcut::Error>` — two different
crates' error types, and `tauri::Error` has no `From` conversion for the
plugin's own error type, so `?` had nothing to convert through.
`build_tray()` right below it never hit this because everything it calls
already returns `tauri::Error` directly (or something `tauri::Error` does
have a conversion for) — it was never mixing two unrelated crates' error
types in one function.

Fix: changed `register_push_to_talk_hotkey`'s return type to
`Result<(), Box<dyn std::error::Error>>` instead of `tauri::Result<()>`.
`Box<dyn Error>` has a blanket `From<E>` for *any* `E: std::error::Error`,
so both the `tauri::Error` from `.plugin(...)?` and the
`tauri_plugin_global_shortcut::Error` from `.register(...)?` convert into
it without needing a specific `From` impl between the two crates. This
also matches what the `.setup()` closure itself already expects at the
call site (`register_push_to_talk_hotkey(app)?;` needed no further
conversion after the fix) — confirmed by `build_tray(app)?` already
working there beforehand via the same blanket boxing.

General lesson worth keeping in mind for any future function that mixes
calls into more than one plugin/crate in the same `?`-chain: reach for
`Result<(), Box<dyn std::error::Error>>` rather than a specific crate's
`Result` alias, unless every fallible call in the function is guaranteed
to return that same crate's error type.

## STT silently killed the whole connection on failure -- fixed, added error handling everywhere else already had

Real bug, found from the user's actual symptom ("mic blinks/reacts to F9,
but she never hears or responds"): `stt.py`'s `transcribe()` had no error
wrapping at all, unlike `llm.py` (`LLMUnreachableError`) and `tts.py`
(`TTSUnreachableError`), both of which already catch their backend's
failures and fall back gracefully. If `WhisperModel()` fails to construct
— the CUDA cuBLAS/cuDNN DLL gap already flagged in README, or a corrupted
first-time model download, or anything else — that exception was
propagating straight out of `app.py`'s `user_audio` handler, unhandled,
which kills the whole WebSocket connection. From the user's side: the mic
recorded fine (permission already granted, `MediaRecorder` genuinely
captured audio), the clip got sent, and then... nothing. No `transcript`
message, no `speak` message, no visible error anywhere -- the frontend's
own reconnect logic (`ws-client.ts`) just quietly reconnects a moment
later, so it doesn't even look like a crash, just an unresponsive mic.

Fix: `stt.py` now has an `STTError` wrapper (same pattern as the other two
backends), and `app.py`'s `user_audio` handler catches it, prints the real
exception to the orchestrator terminal (`file=sys.stderr`, so it's
actually visible without needing to add logging config), and speaks an
in-character fallback line (`STT_UNREACHABLE_LINE`) instead of dying.
Verified in the sandbox with a stubbed `STTError`-raising `transcribe()`:
the fallback line gets spoken, the connection survives, and typed input
still works immediately after.

This was a real gap in the original STT implementation, not a config or
environment issue on the user's end -- every other backend in this project
already had this kind of defensive handling from day one; STT should have
gotten it too and didn't. Worth remembering for any future backend
integration: wrap it the same way from the start, don't wait for a user to
find the silent-failure case.

## Launcher rework: Rust spawns GPT-SoVITS + orchestrator itself, hidden, on request

The three-separate-terminal-windows `start-luna.bat` was working, but
felt clunky enough that the user asked for a single-launch alternative.
Moved process supervision into `src-tauri/src/lib.rs`
(`spawn_backend_processes()`, called from `.setup()`): GPT-SoVITS's
`runtime\python.exe api_v2.py` and the orchestrator's venv `python.exe
app.py` both get spawned as hidden child processes (no console window --
`CREATE_NO_WINDOW`) the moment the Tauri app itself launches. `npm run
tauri dev` (or the packaged `.exe`, later) is now the one command that
starts everything; Ollama is still separate on purpose, since it's meant
to run as a standing background service, not something this app should be
starting and stopping.

**Real interpreter processes, not `cmd /C` wrappers.** Both children are
spawned by invoking the actual `python.exe` directly with `current_dir()`
set, rather than routing through `cmd /C cd /d ... && ...` the way the old
`.bat` file did. This isn't just simpler -- it matters for cleanup: a
`Child` handle for a `cmd.exe` wrapper only lets you kill `cmd.exe`
itself, not the real process it spawned underneath, which would leave
Python running orphaned in the background. Spawning the real interpreter
directly means the stored `Child` *is* the real process, so `.kill()` (now
wired into the tray menu's "Quit" handler) actually stops it. This was a
deliberate correctness fix over spawning hidden processes and never
cleaning them up, which would've been worse than the old visible-terminal
setup, not better -- invisible orphans instead of windows you can at least
see and close.

**GPT-SoVITS's install path is config, not hardcoded.** It lives outside
this repo at an arbitrary user-chosen location, same category of
machine-specific detail `start-luna.bat` and `config.yaml`'s real
`ref_audio_path` already are. Rather than repeat the mistake into new
*Rust source* this time, it's read from `src-tauri/launcher.local.txt`
(gitignored, one `KEY=value` per line, no new parsing dependency needed
for something this small) with `launcher.local.txt.example` committed to
document the format. Missing file -> GPT-SoVITS auto-start is silently
skipped (a printed note, not an error) -- `tts.py`'s existing per-turn
pyttsx3 fallback already covers that case gracefully, so this isn't a hard
requirement to get the app running at all.

**Orchestrator waits for GPT-SoVITS's port, doesn't guess a delay.** The
old `.bat` file's `timeout /t 8` was a blind guess at how long GPT-SoVITS
takes to load. `wait_for_port()` polls a raw TCP connect to `127.0.0.1:9880`
every 500ms for up to 60s before starting the orchestrator, on a background
thread so it doesn't hold up the window actually appearing. Explicitly a
"port is listening" check, not an HTTP-level readiness check -- api_v2.py
might bind the port slightly before it's actually finished loading weights
onto the GPU, so this is a reasonable proxy, not a guarantee. Didn't add an
HTTP client crate (e.g. `reqwest`) to do this more precisely, on the same
minimize-new-dependencies reasoning as the launcher config format above --
worth revisiting if the TCP check proves too eager in practice.

Not verified in this sandbox (no Rust toolchain, no Windows, no actual
GPT-SoVITS/orchestrator to spawn) -- same standing caveat as the
global-shortcut block when it was new, and given that block needed one
real fix on first `cargo build` despite similar care, this one should be
treated with at least as much suspicion on its first real compile.

## Packaging: not yet, and it's a separate question from the git bundle handoff

Asked whether the app can be packaged (a real Windows installer via
`npm run tauri build`) right now, and whether that changes how updates get
handed over. Two different questions:

**Packaging itself:** technically `tauri build` would produce *something*
even today, but not recommended yet -- a release build hides console
output by design (no visible terminal, and stdout/stderr aren't printed
anywhere obvious), which is exactly the wrong time to switch to that, given
STT only just started actually completing full voice turns and the new
process-spawning Rust code hasn't been through a real build yet either.
Packaging is genuinely a good idea once both of those are confirmed solid
-- it's just premature while there's still active first-run debugging
happening, since it would make that debugging harder, not easier.

**The git bundle workflow doesn't change either way.** Git bundles hand
over *source changes* for the ongoing dev workflow (`npm run tauri dev`);
`tauri build` is a separate, later, optional step that produces a
distributable installer from whatever source is currently checked out.
Packaging becoming relevant someday doesn't require changing how source
gets handed over between sessions now -- those are orthogonal concerns.

## User-found fix: GPT-SoVITS needs PYTHONIOENCODING/PYTHONUTF8 set

Found by the user while debugging why GPT-SoVITS wasn't catching under
the new spawn-it-from-Rust launcher: Windows' default console codepage
(cp1252) doesn't cover whatever non-ASCII output `api_v2.py` was
producing, causing a `UnicodeEncodeError` that killed the process. Fixed
by setting `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` as environment
variables on the spawned `Command` in `spawn_backend_processes()` (the
GPT-SoVITS one specifically) before `.spawn()`. Real Windows gotcha,
specific to this project's redirect-stdout-to-a-log-file design
(`spawn_logged()`) -- a normal visible console window (the old `.bat`
file's approach) apparently tolerates this better than a redirected file
handle does, or the specific output that triggers it just hadn't been hit
yet. Confirmed fixed on the user's actual machine.

## User-found fix: `tts.py` needed to validate GPT-SoVITS's HTTP response, not just check the status code

Also found while debugging the same launcher change: added logging (HTTP
status, `Content-Type`, response byte count) and explicit checks for a
non-audio `Content-Type` or an empty body, raising `TTSUnreachableError`
(the existing exception type, not a new one) so the already-working
pyttsx3 fallback handles it the same way an unreachable server does. This
closes a real gap -- a response that returns HTTP 200 but isn't actually
valid audio (an error message with the wrong status code, or a truncated
body) would previously have been handed to the frontend as if it were
real audio. GPT-SoVITS is confirmed working as the primary backend on the
user's machine now, with this validation in place alongside it, not
instead of it.

## STT hang: instrumented instead of guessed at

New symptom after the two fixes above: mic/F9 use left the connection
stuck (pink status dot never clearing) *and* broke typed chat on that same
connection afterward -- worse than the earlier silent-disconnect bug,
because the connection wasn't dying, it was hanging. The combination is
the tell: `app.py`'s websocket handling is a single `while True:
receive_json()` loop per connection, so an `await` that never returns
(never raises, just blocks forever) stalls every subsequent message on
that connection, typed or spoken alike -- consistent with a hang inside
`await stt.transcribe(...)` specifically, not a crash anywhere else.

Explicitly did not guess a fix without evidence (per the user's own
instruction). Two real candidates existed -- a genuine CUDA/driver hang
during model construction or inference, or a legitimately slow first-time
model download/load that simply had zero visibility (nothing was ever
printed for it) and so looked identical to a hang. Instrumented rather
than picked one:

- `stt.py`: `_get_model()` now prints before and after constructing
  `WhisperModel()`, timed. `_transcribe_sync()` prints before and after
  the actual transcribe-and-join, timed. `app.py` prints the instant audio
  bytes arrive, before `stt.transcribe()` is even called. Together these
  three checkpoints (received -> model loading -> transcribing) pinpoint
  exactly which stage a hang is in from the log alone, rather than
  needing another back-and-forth to add logging after the fact.
- `transcribe()` now wraps the work in `asyncio.wait_for(...,
  timeout=90)`. This was the one non-diagnostic change, and it's a safety
  net that's correct regardless of root cause, not a guess at the root
  cause itself: whatever is or isn't causing the underlying slowness, a
  websocket connection should never be able to hang forever on one
  message. Verified in the sandbox reproducing the user's exact reported
  symptom end-to-end (a `transcribe()` stub that sleeps past the timeout,
  driven through a real websocket connection): the timeout fires, the
  fallback line gets spoken, and -- the actual regression being fixed --
  typed chat on that same connection works again immediately after,
  instead of staying stuck.
- Real, honest limitation worth remembering when reading the log:
  `asyncio.wait_for` cancels the *awaiting coroutine*, not the underlying
  OS thread doing the work (`asyncio.to_thread` uses a real thread pool,
  and Python threads aren't preemptible) -- so if the true cause turns out
  to be "just slow, not hung," the `"transcribe() finished in Ns"` log
  line can still show up *after* the timeout fallback already fired. That
  outcome is actually informative, not a bug: it means the connection
  recovered correctly (the actual regression), and the model is now
  warm/cached for next time.

Not resolved yet, on purpose -- this instrumentation is what determines
which of the two candidates it actually is; the next real-machine run's
log output is the next real piece of evidence, not another guess.

## STT hang, resolved: missing cuBLAS DLL, then reusing a model that had already failed

The instrumentation above did its job -- the real log from the user's
machine gave a definitive answer, no more guessing needed:

```
[luna] STT failed: Library cublas64_12.dll is not found or cannot be loaded
```

Exactly the CUDA DLL gap flagged (as a hypothetical) back when `stt.device`
was first flipped to `"cuda"`. `WhisperModel()` construction succeeded
(logged "loaded in 2.9s") -- the missing DLL only bites once CTranslate2
actually tries to run a CUDA kernel, which happens inside the real
`.transcribe()` call, not at construction.

But that wasn't the whole story: every attempt *after* that first clean
failure hung for the full 90s timeout instead of failing the same clean
way. Root cause: `_model` is a module-level singleton, cached once and
reused (`_get_model()`) -- and it stayed cached even after a call on it
had already thrown a native-library error. A CTranslate2/CUDA object
that's already failed mid-inference is in an unknown state; reusing it
for a second call apparently doesn't reliably reproduce the same clean
exception, it can just hang instead (a native/CUDA-level issue, not
something Python-level exception handling alone can guarantee against).

Two fixes:
1. `transcribe()` now sets `_model = None` in its `except` block, for
   *any* exception (timeout or otherwise) -- so the very next call
   constructs a fresh `WhisperModel` from scratch rather than trusting a
   once-failed one. Verified in sandbox with a model stub that fails
   cleanly once then hangs if reused: confirms the model gets rebuilt
   (construction count increments) and the second attempt fails the same
   clean, fast way instead of hanging.
2. `stt.device` reverted from `"cuda"` back to `"cpu"` (`compute_type:
   "int8"`) in `config.yaml`. This is the pragmatic call, not a claim that
   CUDA is unfixable -- the actual fix (get `cublas64_12.dll`/cuDNN onto
   PATH, whether via a system CUDA/cuDNN install or the
   `nvidia-cublas-cu12`/`nvidia-cudnn-cu12` pip wheels plus likely a
   PATH/`os.add_dll_directory()` step CTranslate2 doesn't do
   automatically) is real but has already consumed several rounds of
   back-and-forth without a GPU in this sandbox to verify any of it
   directly. CPU with a `"small"` model is fast enough for short
   conversational clips on the user's i5-14400F and works with zero
   further setup -- reasonable to revisit CUDA later as a speed
   optimization once STT is confirmed solid on CPU, not as a blocker to
   getting it working at all.

Also worth correcting for the record: the user's closing report described
"the tts fumbling," but the actual log shows GPT-SoVITS responding `200,
content-type='audio/wav'` successfully on every single request across the
whole session -- TTS was never the problem here, only STT was.

## Persona rewrite: roommate-tsundere with flustered-at-flirtation, anti-repetition

Rewrote `persona.py`'s `SYSTEM_PROMPT` on request -- the original ("sharp,
competent... senior dev looking over their shoulder") was read as flat and
repetitive in practice, cycling the same 2-3 stock lines
("quit staring at the screen," "what's the error"). Three changes:

- Reframed from "senior dev colleague" to "roommate who never leaves" --
  closer to the "roommate waifu" framing asked for, while keeping the
  underlying tsundere mechanic (blunt exterior, genuine competence
  underneath) intact.
- Added an explicit flustered-at-flirtation reaction: non-denial denial,
  visibly thrown off rhythm for a line or two before recovering -- a
  named, deliberate trigger distinct from the existing "flustered by
  sincere thanks" behavior, since the user specifically wants direct/
  flirtatious comments to land differently than plain gratitude does.
  Also explicit that when something genuinely matters (user's stuck,
  stressed), the act drops immediately -- this was implicit before, made
  it a named rule so a smaller local model doesn't lose it under the new,
  more playful framing.
- Added an explicit anti-repetition instruction, naming the exact
  overused lines as examples of what to avoid. `qwen3.5:9b` is a small
  model without much creative range by default at temperature 0.8 alone;
  an explicit instruction against reaching for stock lines is worth more
  here than raising temperature further would be (higher temperature
  trades coherence for variety indiscriminately, whereas this targets the
  actual failure mode directly).

Not verified against the real model's output -- no local LLM in this
sandbox to test tone/variety against. Purely a system-prompt change, no
code path changed, so nothing to sandbox-verify beyond "the file still
imports," which it does.

## Bigger roadmap items, scoped not built: VRoid migration, UI overhaul, emotion system, environments

A large batch of future-direction requests arrived in one message. None
of these are started -- scoped into `docs/ROADMAP.md` as new phases so
they're tracked and sequenceable, rather than either building blind or
losing them. See ROADMAP.md itself for the phase-by-phase scope of each;
recorded here is just the reasoning that ties them together and the
cross-dependencies worth knowing about before picking an order:

- **VRoid Studio migration** (2D Live2D -> 3D VRM avatar) is the single
  biggest architectural change in this batch -- it replaces the entire
  rendering stack (`pixi-live2d5` + Cubism -> a WebGL VRM
  renderer, e.g. `@pixiv/three-vrm`), not an incremental change to
  `src/main.ts`. Everything else visual (UI overhaul, emotion-driven
  expressions, environments/backgrounds, cursor-poke reactions) is easier
  to build well on top of a VRM model than on top of Live2D, since VRM's
  blendshape/bone system is a more standard target for that kind of
  control than Live2D's 2D parameter rig is. Worth sequencing this one
  *before* the emotion-expression and environment work, not after, even
  though it's the largest single lift -- otherwise that work risks being
  built twice.
- **Emotion system + face control** is a natural fit for the `emotion`
  field that's already been sitting unused in the `speak` WebSocket
  message since Phase 1 (`ws-client.ts`'s `SpeakMessage.emotion`,
  commented as "Phase 6 will use it to pick a ... expression") -- this
  isn't new protocol surface, it's finally using protocol that was already
  designed in. The hardcoded-trigger idea (e.g. "confused" on an
  out-of-capability request) is a reasonable v1 alongside LLM-driven
  emotion tagging, and is genuinely easier to get first: an explicit code
  path (this specific kind of request -> this specific emotion) rather
  than depending on a small local model to reliably self-report emotional
  state as structured output.
- **UI overhaul** (drop the plain input box, add color) is the smallest,
  most self-contained item in this batch -- pure `index.html`/`style.css`
  work, no backend or protocol changes, no dependency on any of the
  others. Genuinely could be done independently, any time.
- **Two environments now, VR later** -- the user already correctly
  identified VR as "currently unachievable" and scoped it out themselves;
  recorded here only to confirm that's the right call, not a limitation
  worth arguing with. The other two (draggable corner companion with
  cursor-poke reactions; a fuller "sandbox" scene with backgrounds) both
  benefit from VRM's more standard 3D scene/camera model over Live2D's
  flat compositing, another point in favor of sequencing the VRoid
  migration first.

## Persona swapped for a user-authored version

The persona rewrite two entries above was mine; the user asked for a
handoff prompt to get a version from a different LLM instead, then pasted
that result back for me to implement verbatim -- done, replacing my
version entirely rather than merging the two. Implemented exactly as
given, preserving the author's wording (including deliberately allowing
mild profanity -- "swear naturally... words like fuck or crap are fine in
those moments" -- in specific frustration/blunder moments, which wasn't
in my version). Not evaluated for tone/quality against real model output
here either, same standing caveat as the first persona rewrite -- no
local LLM in this sandbox to actually hear it delivered.

Also worth recording since it caused real confusion: the previous
persona-rewrite-plus-roadmap-scoping bundle *did* apply successfully on
the user's machine (a real three-way merge with their own concurrent
Cargo.lock/Cargo.toml commit, completed automatically with no conflicts)
-- but that merge commit was never separately `git push`ed afterward. A
fresh clone (done from a new chat session, correctly checking ground
truth before trusting a stale description) found origin's tip was still
the pre-merge Cargo.lock commit, made it look like the earlier work had
been lost entirely. It hadn't -- it was sitting in the user's local repo,
un-pushed. Worth remembering: every local merge from a pulled bundle
needs its own explicit `git push` afterward, same as a plain commit
does -- pulling a bundle doesn't imply pushing the result anywhere.

## Phase 3 -- persistent memory

Scoped as "full semantic" on purpose, not the simpler facts-only
alternative offered alongside it: SQLite + `sqlite-vec` + a real
embedding model, matching what `docs/ARCHITECTURE.md` originally
specified rather than a scaled-down v1. `nomic-embed-text` via Ollama
was the pick -- see `docs/MODELS.md` for the sizing/API-shape reasoning.

**Design decisions worth recording:**
- Recall is injected as a fresh, ephemeral system message per turn --
  built in `memory/recall.py`, spliced into the LLM call in `app.py`,
  *never* written into the persisted `history` list. Considered just
  appending it into history directly (simpler code), rejected because it
  would (a) go stale immediately next turn, (b) duplicate/compound every
  single turn since nothing ever removes an old one, and (c) get fed
  straight back into `consolidation.py`'s session-summarization pass as
  if the memory block were something the user or Luna actually said.
- The recall block's own wording explicitly tells the model not to refer
  to it as "notes" or "memory" or read it aloud -- an earlier draft
  didn't have this line, and on reflection a small model given a block
  literally labeled "Known facts about the user" without that steering
  seemed likely to just recite it back rather than act on it naturally
  (not confirmed against a real model in this sandbox -- a real thing to
  watch for on first on-machine test).
- `consolidation.py`'s JSON parsing is deliberately forgiving (whole-output
  parse, then regex-extracted `{...}` block, then a raw-text fallback
  episode summary) rather than a strict `json.loads` that throws the
  session's memory away over one stray sentence -- `qwen3.5:9b` is a
  small model, and whether it reliably follows the requested JSON shape
  on real conversations (vs. the synthetic transcripts tested here) is a
  genuinely open question, not an assumption. If this turns out to fail
  often in practice, that's a signal to revisit (a smaller/tighter schema,
  a system prompt tweak, grammar-constrained decoding if the backend
  supports it), not a sign the fallback logic itself is wrong.

**Real bugs found via sandbox testing, not anticipated from docs alone**
(this is the part of Phase 3 that's actually verified for real rather
than stub-shaped, unlike prior phases' backend integrations -- sqlite-vec
is pure-C with no GPU/network dependency, so a real committed test suite
was possible here, see `orchestrator/memory/test_memory.py`, 19 tests,
first committed tests in this repo):
1. `sqlite-vec`'s `vec0` KNN queries reject a bound `LIMIT ?` parameter
   outright (`OperationalError: A LIMIT or 'k = ?' constraint is required
   on vec0 knn queries`), even though a *literal* `LIMIT 5` works fine.
   The accepted parameterized form is `WHERE embedding MATCH ? AND k = ?`
   instead -- not documented anywhere obvious, found by the query
   actually failing in a test, not by reading ahead of time.
2. `facts`' `ORDER BY created_at DESC` alone isn't a stable ordering --
   `datetime('now')` only has 1-second resolution, so several `add_fact()`
   calls in the same second (exactly what `consolidation.py` does,
   writing multiple facts from one session back-to-back) can tie, coming
   back in an arbitrary relative order. Needed `id DESC` as an explicit
   tiebreaker. Also only surfaced from a real test failure.
3. (Test-authoring bug, not a code bug, recorded anyway since it caused a
   real scare mid-session:) an app.py wiring check initially expected 3
   `speak` messages for a 3-delta stub LLM reply, then failed again
   expecting 4 messages in a reconstructed LLM call -- both were wrong
   arithmetic/assumptions in the *test*, not regressions. The first
   ignored `chunking.py`'s `MIN_CHUNK_CHARS` (a short stub sentence never
   clears the mid-stream chunking threshold, so it only ever flushes once
   at the end -- correct existing Phase 2 behavior); the second miscounted
   `history[:-1] + [memory] + history[-1:]`'s actual length. Both were
   caught and fixed by re-reading the actual code instead of trusting the
   first assumption, the same standard this file already holds
   sandbox-verification to elsewhere.

**Not verified, and said so plainly in `README.md`:** a real Ollama
instance actually serving `nomic-embed-text` (the client's request/
response handling is checked against current Ollama docs and exercised
against a stub server matching that shape, not a real running server),
and whether `qwen3.5:9b`'s consolidation output holds up on real
conversations rather than the handful of synthetic transcripts tested
here.

## Phase 3 follow-up: forget feature + hard-kill memory loss + persona tweak

Same session, three separate things, done together since they surfaced
together.

**Explicit "forget that" feature** (`memory/forget.py`) -- scoped
narrowly to what was actually asked: the user explicitly telling Luna to
forget something, not automatic contradiction detection (a user saying
"actually I like ice cream now" without ever saying "forget" is a
different, harder problem -- correcting a stale fact instead of adding a
contradictory new one -- left alone for now, same open limitation
store.py's own docstring already named). Cheap regex gate first (most
turns have zero forget-intent, so this keeps the common case free of any
extra LLM call), then a small classification call given a *numbered*
list of currently stored facts, asked which indices (not verbatim fact
text -- a small model paraphrasing instead of quoting exactly would
otherwise silently fail to match anything) the user means to remove.
Deletion happens immediately (this turn, not waiting for session-end
consolidation), and forget runs *before* recall in the same turn so a
just-removed fact can't immediately resurface in that same turn's recall
block. The classification call only decides *which* facts to remove --
it doesn't write the in-character acknowledgment itself, since it has no
persona context; that's left to the main Luna call via an injected
instruction fragment, so the actual spoken acknowledgment comes from the
model that has her full voice, not a flat classifier's own text.

**Hard-kill was silently losing every session's memory, on every quit
path.** Found while answering the user's own question about the right
way to close the app -- not something anticipated or asked about
directly, surfaced by actually checking `lib.rs`'s quit handler instead
of assuming Ctrl+C was simply "the wrong way" for the usual reasons
(orphaned processes) and leaving it there. `child.kill()` on Windows is
an unconditional `TerminateProcess` -- no signal, no chance for Python's
own `finally` block (and therefore `consolidate_session()`) to run at
all. Every quit -- tray Quit included, not just Ctrl+C -- was silently
discarding that session's Phase 3 memory before this fix.

Fixed with a graceful-shutdown-then-kill handshake: orchestrator/app.py
gains a `/shutdown` POST endpoint that sets an `asyncio.Event`, which
`ws_endpoint`'s main loop races against `websocket.receive_json()` (via
`asyncio.wait`, not a plain blocking receive) so an idle connection
actually notices it instead of sitting there forever. Noticing it makes
the loop `break` the same way a real disconnect would, running the exact
same `finally` teardown (consolidation included). The endpoint then waits
a bounded ~5s for that teardown to finish before calling `os._exit(0)`
itself -- deliberately not uvicorn's own graceful-shutdown machinery
(`server.should_exit`), since this is a single-user local app, not a
server needing a zero-downtime drain, and an explicit self-bounded
teardown is simpler to test and reason about. `lib.rs`'s quit handler now
tries a fire-and-forget raw-TCP HTTP POST to `/shutdown` first, polls
(same ~5s bound) whether the labeled child processes have exited on their
own, then hard-kills whatever's still alive -- GPT-SoVITS has no graceful
path of its own and always falls into that last step, and the
orchestrator falls back to it too if it doesn't finish in time, so
quitting never hangs or leaves an orphan either way.

Verified for real, not just plausible-looking: the Python half was
exercised end-to-end against a real running uvicorn server in a
background thread, with a real websocket client -- an idle connection
sitting on the receive loop, a `/shutdown` POST arriving concurrently,
the connection closing itself cleanly, `consolidate_session()` actually
receiving the completed turn's real history, and the scheduled
`os._exit(0)` callback actually firing. The first attempt at this test
accidentally validated the wrong thing entirely -- with no real Ollama in
the sandbox, the initial turn hit the LLM-unreachable fallback line,
which tried to speak via `pyttsx3`, which crashed outright (no `espeak`
installed in this Linux sandbox) -- and that unhandled exception tore the
connection down via `finally` before `/shutdown` was ever called,
making the test pass for a reason that had nothing to do with the
shutdown mechanism at all. Caught by actually reading what happened
rather than trusting a green checkmark, fixed by stubbing `llm.
stream_reply`/`synthesize` so the turn completes cleanly first, and
re-verified. The Rust half (`graceful_shutdown_then_kill()`,
`request_orchestrator_shutdown()`, and the `ManagedChildren` type change
to carry labels) is **not** verified at all -- no Rust toolchain in this
sandbox, flagged explicitly at its own definition in `lib.rs`, same
unverified status the process-spawning block started in before its own
first real `cargo build`.

**Persona tweak** -- exactly one paragraph inserted into
`persona.py`'s `SYSTEM_PROMPT`, nothing else touched (confirmed via
`git diff` showing a single clean insertion), per explicit instruction
not to rewrite anything else in it. Addresses a real pattern the user
noticed: the model defaulting almost every line to a "what do you
actually want" / "you broke the code again" register, reading as an
annoyed task-queue bot rather than a companion who's just around. The
added paragraph explicitly names those two example lines and tells the
model they're for when that's genuinely what's happening, not a resting
state -- steering toward ordinary-life conversation (games, food, how
the day went, random observations) as the default, while leaving the
tsundere flirt-fluster behavior, the stress/swearing-when-annoyed
behavior, and the "drop the act when it actually matters" behavior
completely as-is, since the user explicitly said those parts already feel
natural and shouldn't change.

## Recall was fabricating specific incidents; terseness; a stop button

Same session, three more things, reported after the user actually used
the app for a while -- the first real qualitative feedback on how memory
recall *reads* in practice, not just whether the plumbing runs.

**Recall was inventing specifics that were never stated.** Given only
"likes pizza", "likes ice cream", and "owns an RTX 3060" as three
separate, unrelated facts, the model was fabricating connective
specifics like a made-up "melted ice cream on your 3060 last Tuesday" --
combining unrelated facts into an invented incident, and eagerly forcing
a reference in on nearly every turn regardless of relevance ("you get
grease everywhere" off of "likes pizza" alone). Root cause: recall.py's
injected block said "act like someone who naturally remembers this"
without ever telling the model NOT to invent detail beyond what's
literally listed, and unconditionally included every fact every turn
with no relevance gating at all. Fixed by rewording the block explicitly:
only bring something up if genuinely relevant to what the user just said,
never invent an incident/date/detail not written there, at most one thing
per reply. Not verified against a real qwen3.5:9b in this sandbox (no
Ollama here) -- this is a prompt-wording fix, and prompt wording effects
on a specific small model's behavior are inherently something to verify
by actually using it, not something a stub-server test can confirm.
Considered also making facts semantically-filtered the same way episodes
already are (rather than "all facts, always") as a more thorough
architectural fix, but skipped for now -- the user's own repro only had
3 facts total, so a relevance *cap* wouldn't have changed anything for
this specific complaint; the wording fix is what actually addresses it,
and doing the heavier rearchitecture without being able to verify its
effect on model behavior here risked solving a problem that wasn't
demonstrated to need it. Worth revisiting if the wording fix alone isn't
enough once the user has accumulated more facts.

**Terseness.** Persona already said "keep it terse by default", but
apparently that wasn't concrete enough for qwen3.5:9b to reliably follow
-- the user reported her "yapping" regularly. Tightened the existing TTS-
format paragraph in persona.py with an explicit, concrete constraint
("one or two sentences is normal, three is already pushing it") instead
of the vaguer "terse by default" -- small models generally follow
concrete numeric guidance more reliably than qualitative adjectives. Not
independently verified here either, same reasoning as above.

**Stop-response button.** Needed real concurrency work, not just a UI
button -- the previous ws_endpoint structure awaited `_run_turn()`
directly inline, meaning the main receive loop couldn't read anything
else off the socket (including a "stop" message) until a turn finished
generating entirely, by which point stopping it would already be too
late. Restructured so `_run_turn()` runs as its own tracked
`asyncio.Task` instead, letting the main loop keep concurrently racing
{receive, shutdown} the whole time a turn is in flight; a `"stop"`
message now cancels that task directly (`task.cancel()`), and `_run_turn`
records whatever was actually generated up to that point into `history`
via a `finally` block (matching reality -- she got cut off
mid-sentence -- rather than silently losing the whole turn or, worse,
leaving a dangling user turn with no reply at all). A new `turn_end`
message tells the frontend when a turn is truly over either way (normal
completion sends it from inside `_run_turn`; a stop sends it from
ws_endpoint's stop-handler instead, once the cancelled task has actually
finished unwinding and it's safe to use the socket again) -- needed
because "the audio finished playing" isn't the same signal as "no more
chunks are coming."

Frontend: `lipsync.ts`'s `SpeakHandle` gained a real `stop()` (pauses the
audio element, cleans up the AnalyserNode/MediaElementSource, but
deliberately does NOT fire the normal `onFinish` callback -- that would
trigger the queue's own auto-advance logic on a queue that's being
cleared anyway). `SpeakQueue` gained `stopAll()` (clears everything
pending, stops whatever's currently playing). `ws-client.ts` gained
`sendStop()` and a `turn_end` message type. `main.ts` tracks a
`turnActive` flag (separate from `ConnectionState`, which flips back to
"connected" as soon as the *first* speak chunk arrives even though
generation/playback can continue for a while after that) to toggle the
stop button, hide the mic button, disable the input box, and guard F9
push-to-talk (a global hotkey, so hiding the mic button alone doesn't
stop it from still firing) against starting a new recording mid-reply.

Verified for real: the concurrency change is exactly the kind of thing
that looks right on a read-through and is wrong in practice, so it was
driven through a real running server with a real websocket client and a
deliberately slow, long streaming stub -- confirmed cancellation is
immediate (zero extra chunks leak through after `stop` is sent),
`turn_end` arrives promptly, a fresh turn works immediately afterward
(the connection doesn't get left in a wedged state), and a second test
confirmed the partial reply lands correctly in `history` (present,
non-empty, shorter than the full un-cut reply, and exactly three
messages total -- system/user/assistant, no duplicates, no dangling
turn). The frontend change was driven through a real `tsc` typecheck +
production `vite build`, both clean, same bar as every previous frontend
change -- but there is no real Live2D/audio runtime in this sandbox
(no browser), so the actual UX -- does the mouth/audio really stop
the instant the button is clicked, does the button reappear/disappear at
the right moments -- is still first-run-on-your-machine territory, same
as the rest of the frontend always has been.

## Send/stop/mic button, dash-to-"minus" fix, and a likely persona side effect

Follow-up feedback after the previous round actually got a fresh test in.

**Send/stop/mic button.** The stop button's own visibility logic
(`turnActive`) was already correct as designed -- the user's "should only
show while responding/thinking" request matched the existing behavior,
no change needed there. What was missing: no explicit send button at
all, just Enter-to-submit, and the mic button stayed visible even while
text was typed. Added a `sendButton`, and a single `updateInputButtons()`
function that shows exactly one of {stop, send, mic} at a time: stop
while `turnActive`, send once the input box actually has text (matches
the common chat-app mic-vs-send pattern -- a send button on an empty box
has nothing to do), mic otherwise. `submitText()` extracted as a shared
helper so both Enter and the new button's click go through the same
path.

**Dash-to-"minus" TTS artifact.** persona.py's " -- " convention (used
throughout this file's own comments and the system prompt's own prose)
was never the problem -- the model's own *generated replies* using a
literal hyphen/dash character were getting read aloud by TTS as the word
"minus", sounding broken. Added an explicit instruction against it in
the TTS-format paragraph. Caught and fixed one thing while writing that
instruction: the first draft used " -- " *inside* the instruction telling
her never to use a dash, which would have been genuinely confusing
(telling her not to do the exact thing sitting right there in front of
her) -- reworded to avoid the irony rather than trusting a model to
correctly read past its own contradiction.

**Likely persona side effect, not a bug.** The user reported "I am back"
producing a dramatic assumption of weeks-long absence and a "dusty"
screen. This lines up with the abandonment/jealousy/fear-of-being-
forgotten paragraph the user added to persona.py themselves earlier this
session -- flagged at the time (see "Phase 3 follow-up") as a known
attachment-maximizing pattern in companion-AI design, and this looks like
a direct, unsurprising consequence of it: a model primed heavily toward
separation anxiety reads an ordinary "I'm back" as confirmation of the
thing it's afraid of, then dramatizes it. Not something fixed here --
the user's call whether this is a character trait they want kept as-is
or toned down, raised again now that there's a concrete example of it in
practice rather than just the abstract risk.

**Port-bind failure (WinError 10048), reported alongside the above but
not yet resolved.** Most likely explanation given the timing (first
launch after applying the graceful-shutdown bundle): a previous
orchestrator process didn't actually exit and is still holding port
8765, which would also mean the fabrication/yapping symptoms reported in
the same message may have been observed against the *old*, unfixed
process rather than this round's fixes -- asked the user to check
`netstat -ano | findstr :8765` + Task Manager before drawing any
conclusions about whether the recall/terseness wording fixes actually
worked. Not diagnosed further yet; genuinely could be the Rust half's
first-compile issue this was already flagged as a candidate for, or
could be an old process from before the bundle was even applied, or
something else entirely -- needs the user's diagnostic output to narrow
down, not guessable from code alone.

## Persona: grounded roasting, task-loop, no empty PC-villain threats; unified action button

Follow-up after real usage confirmed both the recall wording fix and
port-conflict diagnosis (the fabrication reports turned out to have been
against a fresh, correctly-running process, per the user's "yeah it
works" -- so the recall fix genuinely helped, this round is a separate,
deeper persona pass, not a retry of the same fix).

**Task-loop and fabricated roasting share one root cause.** The earlier
"not every moment is a task" paragraph (added two rounds ago) reduced
but didn't eliminate her defaulting to "what do you actually want"/
"what's broken" as a fallback -- and separately, her roasting/insults
were still inventing specific unstated details ("grease stains",
"staring blankly at a wall") the same way recall.py's fabrication bug
did, just in a completely different code path (this is pure persona
behavior, no memory system involved at all). Confirms the earlier
DECISIONS.md note that this was a *pattern* in the model's behavior
(reach for invented vivid specifics to sound observant/personal), not
something scoped only to memory recall. Fixed with two changes: the
task-loop paragraph strengthened with explicit "you are not sitting here
waiting for a task queue" framing and real curiosity/opinion-having
language (kept the original concrete examples -- ask how their day went,
react to a game/show/weather -- rather than replacing them with only
abstract language, caught and corrected during editing since the first
draft accidentally dropped them); and a new paragraph added specifically
for roasting: ground insults in what is actually happening/being said,
never invent an incident or image that was never described, sharp is
good, fabricated is not the same thing as sharp.

**"I'm in your PC, I'll delete your files" had gone stale.** The
capability-boundary paragraph (originally just a boundary statement:
can't control mouse/keyboard/edit files) apparently doubled as license
for generic computer-villain threat material once combined with tsundere
pettiness -- explicitly told her not to threaten things she can't
actually do (delete files, wipe browser history) and to find sharper
material instead, right in the same paragraph that already establishes
she can't do those things.

None of this is verified against a real qwen3.5:9b in this sandbox (no
Ollama here, same standing caveat as every other prompt-wording change
this session) -- needs the user's own read on whether it actually lands
differently in practice.

**Unified action button.** The previous round built stop and send as two
separate `<button>` elements that happened to be shown/hidden mutually
exclusively. The user specifically wanted one element that morphs
(matching how mainstream chat apps do it) rather than two elements
occupying the same visual slot -- `index.html` now has a single
`#action-button` with no icon of its own; `main.ts`'s
`updateInputButtons()` sets its innerHTML/title/aria-label/click-target
based on state (stop while `turnActive`, send once there's text, hidden
entirely otherwise -- mic covers the empty-idle case, unchanged). Mic
stayed a separate element deliberately, matching what the user actually
asked for (send+stop merged) rather than merging all three, which
wasn't requested. Verified via a real `tsc` typecheck + production
`vite build`, same as every frontend change this session -- no browser
in this sandbox, so the actual morph/feel is still first-run territory.

## Phase 7 -- VRM avatar migration

The single biggest architectural change so far, requested explicitly as
the next phase over Phase 4 (vision tools) -- the user wants to finish
the aesthetic/avatar side of things before adding new capabilities, and
is designing the actual model in VRoid Studio themselves while this side
of the work happened in parallel.

**Library choice: `three` + `@pixiv/three-vrm`.** The obvious pick --
`@pixiv/three-vrm` is pixiv's own official library for exactly this (VRM
is pixiv's own format), actively maintained, and there wasn't a real
second option worth weighing against it. This version of `three`
(0.185.1) ships no bundled `.d.ts` files at all (checked, not assumed --
`ls node_modules/three/build/` came back with only `.js` files); needed
`@types/three` from DefinitelyTyped instead, which is the standard way
to consume three.js from TypeScript regardless of version.

**Full removal, not a toggle.** `public/live2d/`, `public/cubism5/`,
`vendor/pixi-live2d5/`, `src/types/pixi-live2d5.d.ts`, and the Cubism
Core script tag in `index.html` are all gone, not kept behind a flag --
ROADMAP.md's own Phase 7 scoping already called this "replace", not
"add alongside", and there's no reasonable path where a desktop
companion runs two rendering stacks at once. The Hiyori Live2D sample
(Live2D's own free sample, used since Phase 1) goes with it.

**The HUD/input shell does not need to change, confirmed by reading the
actual code, not assumed.** `setupHud()` never touched the model/canvas
directly except to pass it through to `SpeakQueue`, which itself only
ever forwarded it into `speakWithLipsync()` -- once lipsync no longer
needs a model reference at all (see below), nothing in the HUD layer
needs to know or care whether the thing behind it is a 2D Live2D canvas
or a 3D WebGL scene. `#hud`, the status dot, input box, and action/mic
buttons are byte-for-byte untouched. Only `#stage-container`'s child
canvas (renamed `#live2d-canvas` -> `#avatar-canvas`) and the rendering
code feeding it changed.

**Lipsync required real architectural work, not a mechanical port --
and this project has been burned by exactly this kind of assumption
before.** The Live2D lipsync code hooked `internalModel.on
("beforeModelUpdate", ...)` specifically because Cubism restores
parameters from a snapshot every frame, silently wiping anything set
from an independent loop before it could ever visibly land. Before
writing the VRM version the same way (independent loop, no special
hook), actually read `@pixiv/three-vrm-core`'s bundled source
(`node_modules/@pixiv/three-vrm-core/lib/three-vrm-core.cjs`) to check
whether `VRMExpressionManager` has anything similar. It does not --
`setValue()` just sets `expression.weight` directly, and `update()`
reads whatever that current weight is; no snapshot/restore cycle exists.
Confirmed this is safe to build on before committing to the simpler
architecture (one shared `requestAnimationFrame` loop in `main.ts`
calling `setValue("aa", getMouthOpenValue())` right before `vrm.update
(delta)` each frame), rather than assuming "VRM is architecturally
different from Cubism so it's probably fine" and finding out the hard
way on the user's machine.

This also let `speakWithLipsync()` drop its `model` parameter entirely
-- lipsync.ts tracks *which* audio clip's mouth-openness reading the
shared loop should read via a module-level `currentMouthDriver`
reference, rather than each call needing to reach into the model itself
the way the old Live2D version did (hooking a specific model instance's
event system per call). `SpeakQueue`/`setupHud()` in `main.ts` lost their
`model`/`vrm` parameters as a direct consequence -- nothing downstream of
the render loop needs a model reference anymore.

**VRM0 vs VRM1 handled without asking the user which one they'll
export.** `VRMUtils.rotateVRM0(vrm)` (three-vrm's own utility) is a
documented no-op for VRM1 files and only rotates legacy VRM0.x exports
180 degrees to match three.js's -Z-forward convention -- called
unconditionally on every load rather than trying to detect the version
and branch, since the library already handles that detection internally
and it's one less thing to get wrong.

**Verified for real, not just typechecked -- the loading pipeline, not
the visual result.** No browser, no GPU, and no real `.vrm` file exist
in this sandbox, so the actual on-screen result is unverifiable here no
matter what. What IS verifiable: whether the exact loader code path
(`GLTFLoader` + `VRMLoaderPlugin`, the same classes `main.ts` imports)
actually parses a real VRM file and produces the humanoid bones /
expression manager the rest of the code depends on. Downloaded an
official sample model from `pixiv/three-vrm`'s own GitHub repo
(sparse-cloned just `packages/three-vrm/examples/models/`, avoiding a
full clone of a large monorepo for one file) -- `VRM1_Constraint_Twist_
Sample.vrm`, confirmed via direct GLB/JSON parsing (no three.js needed
for this part) to be VRM spec 1.0 with 54 humanoid bones and the full
expression preset list including `aa`/`ih`/`ou`/`ee`/`oh` (the viseme
shapes lipsync needs) and `blink`/`blinkLeft`/`blinkRight`. Wrote a
plain Node script running the actual loader code (needed one polyfill --
`globalThis.self = globalThis`, since `GLTFLoader`'s texture-decode path
assumes a browser's `self` global that doesn't exist in Node) and
confirmed: the file loads without throwing, `vrm.humanoid.
getNormalizedBoneNode("head"/"hips")` both resolve, `expressionManager.
getExpression("aa"/"blink")` both resolve, and `setValue()` +
`vrm.update()` run without throwing. This is the actual API surface
`main.ts`/`lipsync.ts` use, not a simplified stand-in -- genuine
confidence the loading code is correct, even though the sample model
used to prove it isn't the user's real one.

**Not verified, plainly:** the actual visual result (does she render
correctly, does the camera framing look anywhere close to right against
a real model's proportions, does the lipsync/blink look good in motion)
-- all first-run-on-the-user's-machine territory once their VRoid Studio
export actually exists. `CAMERA_POSITION`/`CAMERA_FOV_DEGREES`/
`CAMERA_LOOK_AT` in `main.ts` are a hand-tuned starting guess for
bust-up framing at real VRM humanoid scale (VRM models are authored in
real-world meters, unlike Live2D's arbitrary internal units), explicitly
documented as needing retuning, same spirit as the old Live2D `SCALE`
constant always needing hand-tuning too.

## Phase 7 follow-up: T-pose and camera framing, from the user's first real screenshot

The user's first actual on-machine render (their own designed model,
first VRM ever loaded by this code outside the sandbox) surfaced two
real bugs immediately: locked in a T-pose, and zoomed out much further
than intended.

**T-pose was a real gap, not a surprise once named.** VRM's bind/rest
pose is a T-pose by default -- normal for a skeleton, but nothing in the
Phase 7 code posed it into anything more natural, since there was no
idle animation clip and no static pose-setting code at all. Should have
been anticipated (any first-time three-vrm user hits this), wasn't.

Fixed with `applyIdlePose()`, rotating the upper/lower arm bones down to
a natural at-the-side resting position. The rotation values were derived
empirically, not guessed a second time after getting the camera framing
guess wrong the first round: loaded the same real sample VRM in a Node
script, and for each candidate rotation, computed the hand bone's actual
world position via `updateMatrixWorld(true)` + `getWorldPosition()` --
real forward-kinematics math, no rendering needed for this part either.
First guess (positive Z rotation) moved the hand *up*, not down --
caught immediately by the numbers rather than shipped and found out
later. Swept several values and axes empirically until finding the
correct one (negative Z for the left arm), then confirmed X-axis
rotation does nothing at all (rolls around the bone's own long axis,
doesn't move a child bone's position) and Y-axis swings the arm
forward/backward rather than down -- useful to know, not just the one
answer needed. Confirmed the right arm mirrors with the opposite sign
rather than assuming symmetry, since VRM's "normalized" humanoid bone
space is specifically designed to guarantee mirror symmetry and a
consistent convention across different source rigs -- meaning, unlike
the camera framing, these exact rotation values should transfer
correctly to any VRM model, not just the one they were derived against.

**Camera framing switched from a fixed guess to a computed one.** The
original `CAMERA_POSITION`/`CAMERA_LOOK_AT` were fixed world-space
coordinates, explicitly flagged in README.md as an untested guess needing
retuning -- and the user's screenshot confirmed it needed retuning
(zoomed out, character small in frame). Rather than just picking new
fixed numbers (repeating the same kind of guess that already turned out
wrong once), switched to computing camera position relative to the
loaded model's own actual head-bone world position, read after the model
is added to the scene and posed. This makes framing adapt to whatever
height/proportions a given model actually has instead of assuming one
specific set of proportions -- a real engineering improvement prompted
directly by the first guess being wrong, not just a bigger guess.
Verified with the same kind of forward-kinematics math as the pose fix:
simulated `boot()`'s exact sequence (pose, then camera) against the real
sample model and confirmed the head lands almost exactly at the center
of the camera's view frustum (projected head position in normalized
device coordinates: ~(0.000, 0.000), should be ~(0,0) for a correctly
centered look-at) and the camera sits at the intended ~0.9m distance
from the head. This is real confirmation the *math* is correct -- still
can't confirm from this sandbox whether 0.9m/the height offset actually
*look* good as a framing choice without a real render, but at least the
camera is now provably looking at the right point from the right
distance, not just hoped to be.

**"Something on her jacket" -- flagged as a likely-related symptom, not
separately diagnosed.** The user also reported a light/pale patch
visible through the jacket sleeve in their screenshot. Genuinely can't
diagnose this from here (no way to see the actual render), but the
likely explanation: VRoid outfit meshes are typically skinned/weighted
assuming a natural pose, not a full T-pose -- an oversized sleeve mesh
sitting correctly over the arm in a natural pose can clip badly and
expose the arm mesh underneath when stretched into a full T-pose instead.
If that's what happened, fixing the T-pose should fix or substantially
change this on its own. Asked the user to re-check after this fix before
treating it as a separate bug worth chasing further -- diagnosing a
rendering artifact blind, on top of an already-identified likely cause,
risked wasted effort in the wrong direction.

## Dash stripping moved to code; lighting adjustment attempt for the jacket artifact

The user's second screenshot confirmed the T-pose fix worked (close-up
VTuber-style framing looks good, arms down) but disproved the "T-pose
caused the jacket artifact" hypothesis from the previous round -- the
pale patch was still there with the pose fixed, meaning it's a separate
issue. Also reported: the dash-avoidance persona instruction from two
rounds ago isn't actually working -- she still generates dashes.

**Dashes: moved from prompt-only to a code-level regex in
`apply_persona_pass()`.** A plain-language instruction not to use a
specific punctuation mark turned out not to be reliably followed by a
9B model -- confirmed in practice now, not just a theoretical risk.
`apply_persona_pass()` was built in Phase 2 specifically as the seam for
"a real second pass over the text before it's spoken" -- this is the
first real use of it. `_DASH_PATTERN` matches the ASCII hyphen plus the
common Unicode dash-family characters an LLM might actually produce (en
dash, em dash, minus sign), replacing with ", " -- reads fine either way
a dash was being used (a compound word reads slightly oddly but isn't
broken; a spoken-style interruption/pause reads naturally). Verified
directly against realistic sample sentences (compound words, em-dash
interruptions, multi-hyphenated phrases) -- all produce sensible,
speakable output, no case left broken. Deliberately only applied to the
TTS-bound text, not what's stored in `history` -- history is only ever
fed back into the LLM as context, never spoken aloud again, so the
"reads as minus" problem this exists to prevent doesn't apply there.

**Jacket artifact: lighting adjustment, a genuine guess, not a confirmed
fix.** Since the T-pose wasn't the cause, the next most likely
explanation (and the user's own guess) is MToon's toon shading producing
a hard, unnaturally sharp light/shadow transition from the original
single strong off-axis `DirectionalLight` at `(1,1,1)`. Replaced with a
softer, more front-on key light (positioned roughly where the camera
itself sits, to minimize side/self-shadowing) plus a `HemisphereLight`
for softer, more even fill instead of a flat `AmbientLight` -- standard
technique for reducing toon-shading artifacts, and also just a better
match for the flat, even VTuber look the user is going for generally.
Genuinely can't confirm this fixes the *specific* artifact without a
real render -- if it doesn't, the next things worth checking (on the
user's end, not code-fixable) are VRoid Studio's outfit "shape clipping"
/ auto-hide-under-clothing export setting, or opening the file in an
online VRM viewer to see if the same patch shows up there independent of
this app's lighting entirely (which would confirm/rule out an asset
issue vs. a lighting issue).

## Phase 8 -- emotion system + expression control

User picked this explicitly over the other proposed features after a
discussion of feasibility/practicality (facial expressions: cheap, ready
now; animation packs: split between near-term idle polish and
Phase-10-gated real gesture packs; deeper personality: achievable but
real ceiling given the model size; live conversation mode: substantial,
deserves its own phase, not a small change).

**Mapped to the real available expressions, not ROADMAP.md's original
example list.** The original scoping note sketched "bored, angry,
embarrassed, happy, sad, confused" as example categories -- but those
aren't all standard VRM expression presets. VRoid Studio only exports
`happy`/`angry`/`sad`/`relaxed`/`surprised`/`neutral` by default (`bored`/
`embarrassed`/`confused` would need hand-authored custom expressions in
VRoid Studio, which most exports -- including a first one with no extra
polish work -- won't have). `VALID_EMOTIONS` in persona.py and
`EMOTION_NAMES` in main.ts both use the real set, confirmed against an
actual exported VRM file's expression list back during Phase 7's
verification work, not assumed from the ROADMAP text.

**Hybrid trigger design, per the original scoping note's own instinct.**
The ROADMAP entry already anticipated "a small local model won't do
reliably as structured output" and called for some hardcoded triggers
rather than pure LLM self-report -- validated further this session by
the dash-instruction and consolidation/forget JSON-parsing experience.
Two paths: the LLM tags its own reply with a trailing `[emotion]` marker
(persona.py's `extract_emotion_tag()`, same forgiving-parse philosophy as
consolidation.py/forget.py -- no match or an unrecognized tag name
returns None, not a guess, not a crash), and the two canned error-
fallback lines (LLM unreachable, STT unreachable) get a hardcoded
emotion instead of trying to fake an LLM-generated tag for text the LLM
never actually produced.

**Delivered once per whole turn, via `turn_end`, not per spoken
sentence.** Considered tagging every individual chunk (heavier compliance
ask, more chances to fail format per turn, for little benefit since the
client-side blend is what actually makes the transition look gradual --
matching ROADMAP's own "gradually shifting... rather than snapping
per-line" instruction) -- one tag per turn, extracted only once the
LLM's stream has *fully* finished (checking mid-stream risked a false-
positive match on an incidental bracketed word the model wasn't done
writing yet), sent alongside the existing `turn_end` message rather than
inventing a new message type.

**Found and fixed a real pre-existing bug while wiring this up, not
related to Phase 8 itself:** the STT-failure path in `ws_endpoint` never
sent `turn_end` at all -- it sends its fallback line and `continue`s
without ever calling `_run_turn`. Since the frontend sets `turnActive =
true` optimistically the moment audio is sent (before knowing whether
STT will succeed), a failed transcription would leave `turnActive` stuck
true forever: input permanently disabled, stop button stuck visible, no
further signal ever coming to clear it. Not something anticipated up
front -- found by tracing every `turn_end` call site while adding the
emotion field to that message, the same way the shutdown/hard-kill bug
was found by tracing an unrelated question earlier this session. Fixed
by sending `turn_end` (with the hardcoded STT-unreachable emotion) from
that path too.

**Verified for real, not just typechecked.** `extract_emotion_tag()`
tested directly against realistic sample text (a valid trailing tag, a
valid tag with a stray period, no tag, an unrecognized tag name, and
critically a bracketed word appearing *mid-sentence* rather than at the
true end -- confirmed the `$`-anchored pattern correctly leaves that
alone rather than false-matching). The full flow was driven through a
real running server with a real websocket client and a stubbed LLM
response ending in `[happy]`: confirmed the tag never leaked into any
spoken `speak` message, and `turn_end` correctly carried `emotion:
"happy"`. The client-side blend math (exponential decay toward whichever
expression is current target) is standard, well-understood smoothing --
traced by hand rather than needing an isolated test the way the Phase 7
bone-rotation signs did, since there's no directional ambiguity in a
lerp the way there was in "which axis, which sign, moves the arm down."
Not verified: how this actually looks in motion (no browser in this
sandbox), and whether qwen3.5:9b reliably produces a recognizable tag in
practice across real conversations rather than the handful of synthetic
cases tested here -- the parser is deliberately forgiving specifically
because this is a real open question, same standing caveat as
consolidation.py's/forget.py's own JSON-adjacent parsing.

## Emotion tags split into an app-facing name and an underlying VRM preset name

Phase 8 originally treated `EMOTION_NAMES` in main.ts and `VALID_EMOTIONS`
in persona.py as the same list, used two ways at once: the tag the LLM
writes, *and* the literal string passed to
`vrm.expressionManager.setValue()`. That only works while every tag
happens to have a same-named VRM preset. It broke once `relaxed` was
renamed to `teasing` (better match for her actual tsundere default
demeanor -- `relaxed` rarely fit what she was doing) and `teasing` needed
to be a genuine *composite* -- there's no standard VRM preset by that
name, so it's rendered as the model's own `relaxed` preset blended with a
slice of `angry` (for a sultrier, narrower-eyed smirk rather than
`relaxed`'s plain half-lidded look).

Fix: main.ts now keeps two lists -- `EMOTION_NAMES` (app-facing, what
`setTargetEmotion()` accepts) and `VRM_PRESET_NAMES` (the model's own
preset names) -- plus an `EMOTION_BLENDS` map from each app-facing name to
a weighted combination of presets. `updateEmotion()` eases every
*underlying preset's* weight toward its target in the active blend (or 0)
each frame, rather than one weight per app-facing name. Four of six
emotions are still a plain 1:1 blend (`{ happy: 1 }` etc.); `teasing` is
`{ relaxed: 1, angry: 0.3 }`. persona.py's `VALID_EMOTIONS` was updated to
say `teasing` instead of `relaxed`, and the system prompt now explicitly
tells the LLM to reach for `[teasing]` as her default mocking/needling
tone, not just literal flirtation.

Also capped `happy`'s own blend weight at 0.8 (not 1) as a mitigation for
VRoid Studio's default "Joy" preset over-puckering the mouth and fully
squeezing the eyes shut at full weight -- a known, common VRoid quirk, not
specific to this model. This is a blunt fix (softens the effect
everywhere, can't reshape what the preset actually contains); the precise
fix is re-authoring the "Joy" expression's bound shapes in VRoid Studio's
own expression editor and re-exporting the .vrm.

**Not verified against the real model.** Both the 0.3 `teasing` blend
weight and the 0.8 `happy` cap are first-guess starting points -- there's
still no renderer in this sandbox to see the result, same standing
caveat as the rest of Phase 7/8's visual work. Confirmed only that the
TypeScript compiles and builds clean, and that `extract_emotion_tag()`
correctly resolves `[teasing]` and correctly rejects a stale `[relaxed]`
tag as unrecognized.

## Captions: per-word reveal timed against real clip duration, not a fixed rate

Phase 8's caption overlay needed to show what she's saying roughly as she
says it. GPT-SoVITS's HTTP API returns a finished WAV file with no
per-word or per-phoneme timestamps (checked `orchestrator/tts.py` --
nothing in the response carries timing data), so there's no ground truth
to sync against frame-perfectly; a naive fixed words-per-second guess
would drift badly on any sentence with a mix of long and short words.

Fix: `lipsync.ts` exposes `getSpeechProgress()` (elapsed/duration of
whatever clip is currently playing), mirroring the existing
`getMouthOpenValue()` driver pattern -- same one-clip-at-a-time
invariant, same lifecycle (set/cleared alongside the mouth driver).
`SpeakQueue` allots each word a start point proportional to its own
character length against the clip's real duration, and a new `tick()`
(called once a frame from main.ts's existing shared render loop, not a
second rAF/interval) advances which word is "active" against that clip's
actual elapsed time. Approximate, not real forced alignment -- but it
tracks the real audio length instead of a guessed constant rate, and
reads as "in sync" for natural speech pacing.

Visual design (no background box, words popping in with a soft glow
instead of a highlight chip) was matched directly against a reference
image the user provided (MiSide-style overlay). Originally, spoken words
stayed dimly visible until the whole line vanished at once at the end of
a clip; changed so each word individually collapses (both fading out and
shrinking its own reserved width via `max-width`, not just opacity, so
the line doesn't keep growing) once it falls more than
`CAPTION_TRAIL_WORDS` (4) behind the current highlight -- this, not the
end-of-clip fade, is what actually keeps a long sentence from turning
into one large block on screen.

## Phase 10 sandbox/apartment build, rounds 1-15 (condensed)

Frozen as of round 15 in favor of the Tauri shell phases -- this entry
replaces what used to be ~20 separate round-by-round write-ups with one
consolidated account. The full byte-for-byte history was cut (not
archived elsewhere) once it was clearly redundant with `docs/ROADMAP.md`'s
own Phase 10 summary and no longer needed at this level of detail for any
open work -- if a specific round's exact reasoning is ever needed again,
it predates this condensation and isn't recoverable from these docs
alone.

**Architecture basics (rounds 1-2).** `sandbox.html` is a second
`index.html`, sharing the same orchestrator connection as the main shell
via a driver/observer handoff (`ws-client.ts`'s `surface`/
`surface_status`) so both windows can't drive a conversation at once.
Movement was never player-controlled -- `WanderController`, explicitly a
placeholder for real AI-driven navigation, picks where she walks. A free-
flying spectator camera and a live chat HUD (`sandbox-hud.ts`, ported
from `main.ts`, not imported) were added early so the sandbox could
actually be used, not just rendered.

**Gesture/animation system (gesture clips through round 5).** VRMA
gesture files get played alongside facial-expression blends when a turn
carries an emotion tag. Two real bugs from the first on-machine test: a
gesture holding its final pose forever (missing fade/stop), and
"moonwalking" (root translation wasn't scaled by the same speed fraction
the leg animation was). Round 5 replaced the original small gesture set
entirely with a much larger third-party pack ("Hanami," Apache-2.0/CC0,
attributed in `public/vrm-animations/`) for a real measured walk cycle
and proper idle-variety pools, rather than continuing to patch the
original set's guessed constants.

**The walk-direction debugging saga (round 6).** A "walks backward"
complaint took five real attempts to actually fix -- wall clipping and
"kinda awkward" got quick, provable fixes (a missing bounds check; facing
now turns during the walk-start wind-up), but the direction complaint
itself survived two rounds of re-derived-but-unverified formula guesses.
What actually worked: adding an on-screen diagnostic comparing computed
facing against real frame-to-frame travel direction, which first ruled
out a facing bug entirely (they matched), then pointed at a foot-plant/
gait issue via a second diagnostic, then -- after a detour where a
proposed fix was reported as "not working" but had never actually been
applied -- a facing-formula flip, once genuinely tested, turned out to be
the real fix. **The lesson worth keeping:** diagnostic-driven debugging
against real on-screen numbers beat every round of reasoning about the
formula from first principles, and "reported as not working" is worth
double-checking was actually applied before trusting it as a real
disproof. All temporary diagnostics were removed once the real fix was
confirmed; only the fix itself (`directionToFacingAngle()`) stays. Wall-
clamp and turn-rate tuning were separately confirmed fine on the user's
real machine once the direction fix landed.

**The apartment build saga (round 7 planning through round 11).** Planned
approach: asset-pack room geometry (not hand-modeling, given no way to
render-check blind) → a per-room floor polygon replacing free-roam → named
sit/cook/read anchor points → a scene-state channel telling the persona
prompt what room/activity she's in. Round 8's first render was a dead end
(a linked page, unreachable from inside the actual shell window). Round 9
made the apartment the sandbox's real scene and added a first-pass
navmesh. Round 10 was a full rebuild, not an iteration: real floor plan in
metres, punched wall openings, working doors, rebuilt furniture (mesh
count 387 → 1173), image-based lighting + a post-processing chain, a
first-person mode, and the scene-state channel round 9 had left unbuilt --
verified this time by running a script that cross-checked every navmesh
rectangle against furniture's actual placement coordinates, catching two
real overlap bugs before shipping. Round 11 fixed two bugs from the first
real screenshots (an overexposed day-mode lighting stack; no way to hide
ceilings in spectator mode).

**The procedural-to-prebuilt pivot (round 12) -- the single biggest
lesson from this whole phase.** Round 11's fixes didn't fix the real
problem: the next screenshots showed a UV-checker bathtub texture, a
floating towel, a toilet with no bowl, a blown-out mirror. Hand-authored
procedural geometry and canvas textures, built by someone who cannot see
the rendered result, do not converge -- confirmed the hard way across
five rounds before this one. The entire procedural room (`shell.ts`,
`furniture.ts`, `materials.ts`) was deleted and replaced with a prebuilt
`.glb` apartment model (Sketchfab-sourced -- **licensing not
independently confirmed as reusable**, still open) loaded through the
same `GLTFLoader` the VRM avatar already used. Real capability lost in
the trade: no per-room data (generic `Object_0`/`Object_1`... mesh
names), so no room-level scene-state, no doors, no wall-aware collision
at first -- stated plainly rather than hidden, pending someone who can
actually see the model pointing out real room boundaries.

**Real-usage bugfixing from actual footage (rounds 13-15).** Round 13,
first real usage of the round-12 model, found six real bugs with
evidence rather than guesses: Luna rendering too dark (MToon's shader has
no environment-map handling at all, confirmed in its own source --
fixed with a dedicated point light decoupled from room mood lighting,
not by brightening the room, which would've been the wrong fix for the
wrong cause), several materials with missing/wrong properties found by
parsing the glTF JSON directly (not guessed), bloom radius too wide for
small props, and real wall/furniture collision added via `three-mesh-bvh`
-- an established addon, not hand-rolled, with a real bug (the first
collision-height set was catching the floor slab, blocking 90% of the
building) found and fixed by running the actual query against the real
file. Round 14 found round 13's own fixes had shipped two new, worse
bugs: a movement-clamp fallback that jumped toward the building's centre
in big fractional steps whenever blocked (fixed with a small-radius ring
search instead), and a fill light positioned close enough to amplify
falloff 8-25x (fixed by repositioning and softening it) -- both traced to
an exact line, both verified against the real collision geometry
afterward (67 real test points, all resolved within 0.56m). Round 15
fixed four smaller, specific complaints, each investigated directly
against the actual file rather than guessed: a pizza prop's UV mapping
genuinely sampling the wrong part of its texture atlas (fixed with a
sampled flat color, not a blind remap), a pathfinding gap mitigated with
stuck-detection (true pathfinding would need per-room data this model
still doesn't have), 7 real door-shaped meshes found by scanning bounding
boxes and re-added as proximity-based show/hide, and confirmation this
specific model has no ceiling meshes at all -- genuinely roofless, not a
gap to close.

**Still open, all real:** the desktop companion mode (a separate,
entirely unstarted piece of this phase); real per-room navmesh/
furniture-anchor data (round 15's geometric mesh-finding technique could
plausibly extend to finding these too, untried); sit/cook/read animation;
whether round 15's stuck-detection timeout (3s) feels right in practice;
and the model's licensing. Nothing in this whole phase has ever been
visually confirmed from inside the sandbox this was built in (no GPU/
browser here) -- every "confirmed" claim above came from the user's own
real-machine screenshots, video, or explicit report, never from this
sandbox's own judgment.

## Round 6 closed; apartment build paused; Phase 4 picked as next priority

The user confirmed on-machine that round 6's remaining tuning (wall
clamp, walk-start facing, turn rate, idle-variety gestures) all read
correctly in motion, on top of the already-resolved walk-direction fix.
Round 7 (the full apartment) was paused, not cancelled, at this point:
the interaction half (sit/cook/read/sleep/bathe/watch-TV/play-game poses)
needed animation clips the user was deferring buying, and doing just the
room-geometry half then would have front-loaded real asset-sourcing
effort for a payoff blocked on that future purchase. (It later resumed
anyway, per the condensed entry above -- room geometry alone still turned
out to be worth doing first.)

One item from that discussion was flagged rather than adopted outright:
giving Luna a Playwright-driven cursor to actually operate the mouse
would reverse `CLAUDE.md`'s own non-negotiable "observe-and-advise only"
constraint, not just add a feature on top of it. Not built, pending
explicit confirmation that real input control is actually the intent.

**Decision:** Phase 4 (vision tools + Task Guide Mode) picked as the next
build -- the project's own stated flagship behavior, not started yet.

## Reversing "observe-and-advise only" — Work Mode, Phase 11

The project's original framing (`CLAUDE.md`'s intro line, the
`docs/ARCHITECTURE.md` Task Guide Mode "hard boundary," and the
"explicitly out of scope" list in `docs/ROADMAP.md`) was unconditional:
she never touches the mouse/keyboard, never acts, only advises. The
user has now deliberately reversed this — the goal has shifted from a
desktop-companion/"AI girlfriend" experience toward something genuinely
useful: an assistant that can actually do web-based tasks when asked,
not just describe them.

This is a real scope change, not a bug fix, so it's recorded rather
than silently overwritten in the three docs above — each now says
plainly that the constraint changed, when, and why, rather than
pretending the original line never existed.

**What's actually approved, and what isn't (yet):**
- Approved: a gated tool-calling harness, Hermes-style function calling,
  in the shell only, off by default (Conversation Mode), opt-in per
  session (Work Mode). Full spec: `docs/ROADMAP.md`'s Phase 11 entry.
- Approved: "her own cursor" as a Playwright-driven browser instance —
  she can navigate/click/type/read inside that browser window.
- Not approved (a v2 idea, not this phase): general OS-level input
  control across arbitrary desktop apps (e.g. `pyautogui`/`nut.js`
  driving real screen coordinates). That's a materially larger risk
  surface than a sandboxed browser tab — a wrong coordinate there can
  click anything on screen, not just something inside the automated
  page — and deserves its own design/safety pass rather than riding in
  on this one. Flagging this distinction explicitly since "give her a
  cursor" could be read either way; browser-only is the scoped v1
  reading used throughout Phase 11.
- Sandbox/companion room: entirely unaffected. No tools, no camera, no
  OCR, no cursor, ever — this was the user's own explicit line, not an
  oversight, and it's the one part of the original design that didn't
  move.
- Safety scaffolding (visible active-indicator, confirm-before-
  irreversible-action, an action log, a hard abort) is specified
  alongside Phase 11 itself rather than as a follow-up, since retrofitting
  it after the fact on an agent that can already act would be the wrong
  order of operations.

**Also decided in the same conversation:** a third toggle, Smart Mode,
independent of Conversation/Work Mode, controlling reasoning depth
(single-pass vs. a slower plan→act→observe→reflect loop) — mainly a
context-budget lever for `qwen3.5:9b`, not a safety mechanism.

## Phase 9: pastel reskin + persistent conversation-log panel

Two independent pieces landed together since they're both Phase 9 UI
work, but they're worth separating out:

**The reskin** is a pure color-variable swap in `style.css` (plus the
caption glow's hardcoded colors, which weren't on variables at all) —
no layout/structure changes. Nothing here is verified visually; it's
the same "no GPU/browser in this sandbox" caveat as every prior round.

**The log panel** was scoped bigger than Phase 9 originally called for
("no protocol or backend changes") because the user specifically asked
for it to be *persistent* — a real feature, not a styling choice, so it
gets its own reasoning:

- **A separate `transcript_log` table, not reusing Phase 3's facts/
  episodes.** This is a plain verbatim record for the user to read back,
  not something meant to inform her memory or get summarized/recalled —
  mixing it into the facts/episodes tables would risk it leaking into
  `consolidation.py`'s session-summarization pass or `recall.py`'s
  context injection, neither of which should ever see raw transcript
  text. Kept in the same SQLite file (same `db.py` connection) purely
  for convenience — one DB file, not a second one to manage.
- **`spoken_parts` tracked separately from `reply_parts` in
  `app.py`'s `_run_turn`.** `reply_parts` already existed and feeds
  `history` (the LLM's own context) — it deliberately excludes the
  LLM-unreachable fallback line, since she never really "said" it in a
  sense that should count toward future context. But the log panel's
  job is different: it's a record of what the user actually saw/heard,
  full stop, so it needs that fallback line included even though
  `history` shouldn't have it. Rather than stretch `reply_parts` to
  serve both jobs (and risk a future change to one silently breaking
  the other), a second list makes the two purposes explicit and
  independent.
- **Logged in `finally`, unconditionally, including a stopped-mid-
  sentence turn.** Matches the existing philosophy `history.append()`
  already uses in that same block ("she got cut off mid-sentence" is
  itself the honest record) rather than only logging clean completions.
- **Not logged:** the STT-failure fallback line and the observer-
  surface-busy decline, both of which fire before `_run_turn` is ever
  called (no `user_text` turn exists yet in the first case; no turn is
  allowed to start at all in the second) — there's no corresponding
  user line to pair either against in the `user: / assistant:` shape
  that was actually asked for, so extending the log schema to handle a
  one-sided entry wasn't worth it for two rare edge cases.
- **New `session.user_name` config field**, display-only — never sent
  to the LLM or folded into the persona prompt, purely a label the
  frontend uses for the user's own lines in the panel.

**What's actually verified vs. not**, since this phase mixes both for
the first time in one push: the backend (table, CRUD, WebSocket
handlers, the `spoken_parts`/`reply_parts` split) is verified for
real — 5 new committed pytest cases, plus two ad hoc end-to-end
WebSocket runs through the genuine `app.py` code (one direct
`get_log`/`clear_log` exchange, one full stubbed `_run_turn` proving
the logged text matches what was actually sent via `speak`). The
frontend (button, panel, rendering) is only verified structurally —
`tsc --noEmit` and a full `vite build` both pass clean, and the new
markup/CSS were confirmed present in the built output — but nothing
about how it actually looks or behaves in a real window has been
seen. Same split as every other UI change in this project: logic can
be genuinely tested here; appearance can't.

## Phase 4 Round 1: tool-calling loop, capture_screen, read_clipboard

**Why a new `stream_reply_with_tools()` instead of changing
`stream_reply()`.** `consolidation.py` and `forget.py` both already call
`llm.stream_reply()` for their own background LLM calls and are covered
by existing passing tests that assume it yields plain delta strings.
Changing that function's yield shape to support tool-calling events would
have meant touching two working, already-tested subsystems that have
nothing to do with tools, for no real benefit -- neither ever needs to
call a tool. A second function keeps the blast radius to exactly the one
caller that actually needs it (`app.py`'s `_run_turn`).

**Why `capture_screen` does its own internal VLM call instead of handing
raw image bytes to the main tool-calling loop.** `docs/ARCHITECTURE.md`'s
vision-tools section already specified this ("returns a textual
analysis \[...\] to the reasoning pass"), and it turned out to
meaningfully simplify the implementation too: Ollama's tool-result
message convention is built around plain text, and attaching images to a
`role: tool` message is untested, possibly-unsupported territory. Making
`capture_screen` a text-in/text-out tool like `read_clipboard` -- doing
the image-to-text conversion internally via a separate one-shot
`llm.describe_image()` call -- keeps the main tool-calling loop uniform
and avoids relying on that unverified image-on-tool-message behavior at
all.

**Why streaming tool-calls instead of a safer non-streaming
detect-then-stream approach.** The conservative option (a blocking
non-streaming call first to check for `tool_calls`, then stream the
real reply once none come back) would add a full round-trip of latency
to *every* ordinary turn, not just the ones that actually call a tool --
a bad trade for a real-time companion when most turns never touch a
tool at all. Streaming with tools attached is the primary path instead,
written defensively (any chunk carrying `tool_calls` is treated as
decisive) specifically because Ollama's tool-calling-while-streaming
behavior for this exact model has never been tested against a real
server. If it doesn't hold up in practice, the non-streaming shape is
the documented fallback -- see `llm.py`'s own docstrings.

**Why a hard `MAX_TOOL_ROUNDS` cap (3).** A local 9B model calling tools
is new, untested territory -- a model that gets stuck re-calling a tool
(or one that keeps failing) needs a way out that isn't "hang the turn
forever." 3 rounds is generous for what these two tools support today
(a screen check plus a clipboard read chained once is a realistic real
request) and small enough to guarantee termination either way.
`TOOL_STUCK_LINE` is the in-character line said if that cap is actually
hit -- verified via an ad hoc test that forces every round to call a
tool and confirms the loop stops at exactly 3 rounds rather than
hanging.

**What's real and tested vs. genuinely unknown**, since this is the
first phase to add a whole new capability (tool-calling) rather than
extend an existing one: the *loop's own logic* -- dispatch, appending
results, re-calling, the round cap, graceful degradation on an unknown
tool name or a tool's own failure -- is verified for real, including
through the actual `app.py` code end to end with a fake LLM. Whether
Ollama's real wire behavior matches what this was built against, and
whether `qwen3.5:9b` calls these tools sensibly in practice, are both
completely open until the user actually runs this against their own
Ollama instance. Flagged explicitly in `docs/ROADMAP.md`'s Phase 4
entry rather than assumed away.

## Tool-calling wasn't firing -- root cause was a stale line in SYSTEM_PROMPT, not Pillow or the model

First real test showed capture_screen/read_clipboard never actually
firing -- she deflected in character instead of using either tool. The
user's own read was a `qwen3.5:9b` hardware/capability limitation. Full
investigation, step by step, each one a real test rather than a guess:

1. Noticed she'd specifically blamed "the stupid Pillow thing" when
   refusing, which read at the time as a real clue -- `pip show Pillow`
   confirmed it genuinely wasn't installed (landed in `requirements.txt`
   the same round `capture_screen` was built; a docs-only bundle came in
   between with nothing to install, so there was no natural "run pip
   install again" trigger). **This turned out to be a red herring for
   the actual symptom**, though a real bug worth fixing regardless: her
   "the Pillow thing" line was just her echoing a word the user
   themselves had typed at her a few turns earlier ("use pillow"), not
   evidence that `capture_screen` had actually run and hit that error.
   Worth remembering: an in-character line that sounds like it's
   reacting to something real isn't proof it is -- she'll happily
   incorporate whatever's in the recent conversation, including the
   user's own word choices.
2. After the Pillow fix, the diagnostic logging added the round before
   (`[luna] tool-calling:` in the orchestrator's terminal) showed the
   real signal: Ollama's response never contained a `tool_calls` key at
   all, across every real attempt.
3. `ollama show qwen3.5:9b` confirmed the model has the `tools`
   capability -- not a hardware ceiling. A raw call straight to Ollama
   (bypassing Luna's own code entirely), using a trivial "use this
   calculator tool" prompt, got a correct `tool_calls` response
   immediately -- tested with `think: false` and `stream: false` first,
   then again with `stream: true`, ruling out both thinking-mode and
   streaming as the cause, one variable at a time, with real evidence
   for each rather than assuming.
4. A further isolated call using the real `capture_screen`/
   `read_clipboard` schemas verbatim, a real "what's on my screen"
   prompt, but **no system prompt at all**, also got a correct
   `tool_calls` response (`capture_screen`, correctly chosen over
   `read_clipboard` for that prompt).
5. That isolated everything down to one remaining variable: Luna's own
   `SYSTEM_PROMPT`. Reading it over, one line stood out --
   `"You can only observe and advise. You never control the mouse or
   keyboard, never run code yourself, never edit files, at least not
   yet."` -- written before Phase 4's tools existed, and never revised
   when they were added. Every real turn was telling the model, in
   plain language, that it cannot actually do anything, directly
   competing with the tool-calling capability offered in the same
   request. Steps 3 and 4 above had already shown the model, the
   schemas, thinking, and streaming were all fine -- this was the one
   piece never tested in isolation, and it was sitting in every single
   real conversation the whole time.

**Fixed**: that line now explicitly names both tools and tells her to
use them for real when they'd help, while keeping the "no mouse/
keyboard/code/files" boundary for everything else it was originally
protecting (still accurate -- Phase 11 hasn't landed). A canary test
(`test_persona.py`) checks the prompt mentions both tools and that the
old blanket "you can only observe and advise" phrase doesn't come back,
so a future prompt edit can't silently reintroduce the same failure
mode without a test catching it.

**Retest on the user's real machine (the actual app, not an isolated
curl call) still pending.**

The lesson worth keeping for next time a tool/capability gets added:
check `SYSTEM_PROMPT` itself for language written before that capability
existed, not just the docs describing it -- the docs all got updated
correctly when Phase 4 was built; the prompt the model actually runs on
did not, and that's the one that mattered.

## "You're" mispronounced by SoVITS -- fixed proactively, same pattern as the dash fix

User reported the cloned voice specifically mangles "you're" (not other
contractions). Same underlying cause as the dash-to-"minus" issue above:
a plain-language SYSTEM_PROMPT instruction is not the same as a 9B model
that actually never does the thing (confirmed the hard way for the dash
case -- see the entry above, "she still generates dashes" after the
prompt instruction alone). Applied that lesson proactively this time
instead of waiting for the same failure to repeat: added the prompt
instruction AND a regex safety net (`_YOURE_PATTERN` in persona.py) in
the same change, rather than shipping the prompt-only version first.
Case-preserving ("You're" -> "You are", "you're" -> "you are") so it
doesn't read as a capitalization mistake mid-sentence. Scoped to just
this one word, not contractions generally, since that's specifically
what was reported -- no reason to flatten her voice further than the
actual complaint calls for.

Also added `test_persona.py` -- didn't exist before this, so the
original dash safety net had no committed test either, only the ad hoc
sandbox check `docs/DECISIONS.md`'s own dash-fix entry describes. Both
safety nets are pure regex logic with no LLM/network/event-loop
involved, making them fully, genuinely testable rather than
"logically checked, not confirmed" -- there was no reason for either to
have stayed at ad hoc-only verification.

## Freeze checkpoint: sandbox apartment work paused, project-wide audit before the pivot to Tauri shell phases

Fifteen rounds into the apartment (Phase 10), the user called a deliberate
stop: "we've done enough in sandbox... next goal is to freeze the sandbox
development and pursue tauri shell phases which havent been done." Before
handing off, this checkpoint audited the whole project (not just the
sandbox/apartment work this session owned) for stale docs and real bugs,
since a freeze is exactly the moment small inconsistencies stop getting
caught by the next round's own work and start misleading whoever picks
this up next.

### What was checked

- `npx tsc --noEmit` across the whole `src/` tree (one `tsconfig.json`
  covers `main.ts` and everything the sandbox touches) -- clean.
- Every Python file in `orchestrator/` (including `memory/` and `tools/`)
  compiled with `py_compile` -- clean. Not a full runtime/import check
  (the real ML dependencies -- torch, faster-whisper, etc. -- aren't
  installed in this sandbox), just syntax-level, same limitation as
  every round's Python verification in this project.
- `src-tauri/src/lib.rs`/`main.rs` read manually, line by line -- still no
  Rust toolchain in this sandbox (confirmed again: neither `cargo` nor
  `rustc` resolve), so this is a careful read, not a compile. The file's
  own header comment already tracks which blocks have been through a real
  `cargo build` on the user's machine (the global-shortcut block, fixed
  once) versus which haven't (`spawn_backend_processes` and everything it
  calls, `graceful_shutdown_then_kill`, `request_orchestrator_shutdown`) --
  that self-tracking is accurate and worth preserving as-is when Tauri
  work resumes, not something this audit needed to redo.
- `main.ts`'s own imports, confirmed independent of everything the sandbox
  session touched (`apartment/`, `camera-modes.ts`, `postfx.ts`,
  `sandbox.ts`) -- no cross-contamination risk from any of the last five
  rounds' apartment work.
- Grepped the whole `src/`, `src-tauri/src/`, `orchestrator/` tree for
  `TODO`/`FIXME`/`XXX`/`HACK` markers -- none found, consistent with this
  project's habit of writing real `docs/DECISIONS.md` entries instead of
  inline TODOs.
- `package.json` vs. actual imports, `Cargo.toml` vs. actual `use`
  statements -- checked for drift in both directions (declared-but-unused,
  used-but-undeclared).
- `orchestrator/config.yaml` read against `docs/MODELS.md`/`docs/ROADMAP.md`
  for consistency -- matches (Qwen3.5-9B, GPT-SoVITS, faster-whisper on
  CPU, nomic-embed-text, all as documented).

### Real findings, fixed

- **`docs/ROADMAP.md`'s top-level "Scope" section still described Live2D**
  as in-scope (`"Live2D character rendering..."`, `"...TTS + Live2D
  lip-sync"`, `"Live2D model asset itself is not something Claude
  generates"`) with zero mention that Phase 7 replaced the entire Live2D/
  `pixi-live2d5` stack with a VRM avatar. Everywhere else in the same
  document (the Phase 7 entry itself, the "Decisions" appendix near the
  bottom) already correctly marks this as superseded -- only the original
  top-of-file spec was never touched during that migration. Fixed by
  annotating both mentions in place (following the doc's own established
  "~~struck-through~~, superseded by Phase N" convention used elsewhere in
  the same file) rather than silently rewriting the original spec's
  history.
- **`docs/ARCHITECTURE.md`'s directory-layout description of `apartment/`**
  described it as "floor plan, materials, walls/doors, furniture, all as
  data-driven modules" -- accurate for round 10's hand-authored system,
  completely wrong since round 12 deleted `shell.ts`/`furniture.ts`/
  `materials.ts` entirely and replaced them with a loaded `.glb`. Fixed to
  describe what's actually there now: `floorplan.ts` (placeholder data)
  and `index.ts` (the GLB loader plus lighting/collision/doors), with a
  pointer to the round-12 entry for why.
- **`CLAUDE.md`'s docs-map entry for `DECISIONS.md`** used round 9's
  apartment-scaling decision as its example of "why non-obvious things are
  the way they are" -- still a real, findable entry, but describing a
  system round 12 replaced, so citing it as an example of *current*
  reasoning was misleading. Swapped for the round-12 entry (why the
  apartment loads a prebuilt model instead of building one procedurally),
  which is both current and a better example of the pattern anyway.

### A real finding, flagged rather than fixed: `orchestrator/config.yaml` is tracked in git with a real personal path in it

`orchestrator/config.yaml` is committed to this repository (not
gitignored) and its `tts.gpt_sovits.ref_audio_path` field contains a real,
specific Windows path
(`C:\Users\User\Downloads\character_files_main_sample.wav`) along with the
matching `prompt_text` transcript -- not a placeholder. This sits
oddly next to `.gitignore`'s own comment, which explicitly groups this
exact value with the two files that *are* gitignored for being
machine-specific: *"Personal launcher scripts -- hardcode machine-specific
absolute paths... so these stay local-only, same as config.yaml's real
ref_audio_path/prompt_text values."* The policy that value should be
personal/local-only is stated; the mechanism that would actually enforce
it (gitignoring the file, or templating it with a placeholder and keeping
the real value in an untracked override) was never applied to
`config.yaml` itself, unlike `launcher.local.txt` and `start-luna.bat`
right next to it in the same `.gitignore` block.

Two things make this worth surfacing rather than filing away as trivial:
this repository is on public GitHub (confirmed multiple times already
this session, most recently as the reason the apartment model's own
licensing got flagged rather than assumed), and the reference file's name
(`character_files_main_sample.wav`) reads like it could plausibly be
extracted from copyrighted character audio rather than an original
recording -- `docs/ROADMAP.md`'s "Decisions" appendix already carries an
open item, unresolved since Phase 2.5, that rights to this exact sample
are "on the user to confirm -- not something this doc can verify." That
open question and this file being in public git history are two separate
facts about the same file that hadn't been connected before.

**Not fixed by this audit, deliberately** -- unlike the doc-staleness
items above, this isn't a stale description to correct; it's the user's
own file with the user's own reference data in it, and the right fix
(gitignore it and provide a `config.yaml.example` with placeholders the
way `launcher.local.txt.example` already works, versus editing history to
remove it from past commits, versus deciding it's fine as-is) is a call
only the user can make, not something to act on unilaterally mid-audit.
Flagged plainly in the same-day chat reply instead.

### Checked and found to be fine, worth recording so it isn't re-litigated

- `src-tauri/Cargo.toml` declares `serde`/`serde_json` as dependencies;
  neither is actually used anywhere in `src-tauri/src/*.rs` (`use serde`
  appears nowhere). Not a compile error -- Cargo doesn't fail on unused
  declared dependencies -- just unnecessary. Left alone rather than
  removed: the removal itself is trivial, but verifying it doesn't
  regress anything needs a real `cargo build` this sandbox can't run, and
  the cost of leaving two small unused crate declarations in place is
  close to zero. Worth a quick `cargo build` check next time Tauri work
  resumes, not urgent on its own.
- `src-tauri/capabilities/default.json` only grants `"core:default"` --
  no explicit `global-shortcut:*` permission, even though
  `tauri-plugin-global-shortcut` is in use. Not a current bug: the plugin
  is driven entirely from Rust (`app.global_shortcut().register(...)` in
  `setup()`), never invoked from the frontend via `invoke()`, and Tauri's
  permission/ACL system gates frontend-initiated IPC calls, not a plugin's
  own backend-side Rust API. `toggle_click_through` (the one
  `#[tauri::command]` that *is* frontend-invokable) is likewise unused
  from `main.ts` today (confirmed: no `invoke(` call appears anywhere in
  `src/`) -- so nothing is broken right now. Flagged because the pivot to
  Tauri Phase 5/6/9(frontend)/11 will likely add real frontend-to-Rust
  `invoke()` calls, and that's exactly when a missing capability entry
  would first surface, as a runtime permission error rather than a
  compile error -- worth checking `capabilities/default.json` against
  whatever new commands actually get added then, not before.
- `README.md`'s "Run it" section (`npm run tauri dev` auto-starting
  GPT-SoVITS + the orchestrator via `launcher.local.txt`) matches
  `spawn_backend_processes()`'s actual behavior in `lib.rs` exactly --
  correctly updated when that feature was built, not stale.
- `docs/MODELS.md` already self-flags its own possible staleness ("this
  space moves in weeks, not months... worth another pass before Phase
  4/5's vision work actually starts") -- an honest, already-present
  caveat, not a hidden gap this audit needed to add.
- No secrets, API keys, or other committed personal paths found beyond
  the `config.yaml` item above -- checked `orchestrator/` broadly for
  `api_key`/`password`/`secret`/`token` patterns and for any other
  `C:\Users\` occurrences outside of documentation examples and this
  session's own bundle-handoff instructions (both of which use generic
  placeholders, not real values).

### Scope note

This audit touched `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`,
and this entry -- documentation only, no source changes, since everything
found in actual code (the two Rust items above) was judged not worth an
unverifiable change over a flagged note. `handoff.md` was regenerated
separately to reflect the freeze and the pivot to Tauri shell phases, per
its own "snapshot, not a live document" convention.


## Phase 4 Round 2: the scheduled-capture/off-task-chide loop -- Task Guide Mode's other half is built

Everything Round 1 shipped was the *tools* (`capture_screen`, `read_clipboard`)
and the tool-calling loop itself -- confirmed working on the user's real
machine, per the top of this Phase 4 log. What was still missing was the
actual flagship behavior `docs/ARCHITECTURE.md`'s "Task Guide Mode" section
describes: noticing when the user drifts off a task *without being asked*,
on a timer, not just answering when asked to look.

**Why a third tool (`set_active_task`) instead of a tag mechanism.** Phase 8
already established one precedent for "the model marks something about its
own turn" -- the trailing `[emotion]` tag. Task state could have followed
that shape (`[task: description]` / `[task: none]` at the end of every
reply). Went with a tool call instead, for a few concrete reasons: (1) it's
the same shape the two existing Phase 4 tools already use, so there's one
mental model for "things the model can actually *do*, not just say," not two
different mechanisms; (2) an emotion tag is *always* present (every reply
gets exactly one), but a task should usually stay unset -- most turns aren't
about starting or changing a task, and a tool call is naturally optional in
a way a mandatory trailing tag isn't; (3) a tool call carries real
structured arguments (`active: bool`, `description: str`) without needing a
bespoke mini-grammar the way a single bracketed tag would for two fields.

**Single active task, module-level state, same pattern as `_driver`/
`_scene_state`.** This is a single-user, single-driver-connection app (see
`app.py`'s driver/observer comment) -- there's never a real case for more
than one "what's currently being tracked" slot. `task_guide.py` keeps this
as plain module-level state (a frozen `TaskState` dataclass, swapped via
`dataclasses.replace`), not per-connection, for the same reason
`_scene_state` isn't per-connection either: it's world state, not
conversation state, and outlives any one socket. Deliberately does NOT get
cleared when the driver connection closes (see `app.py`'s teardown comment)
-- a driver reconnecting (app restart, crash recovery) should still see
whatever task was being tracked, not have it silently wiped just because the
old socket happened to close. The real limitation this creates: a *new*
driver connection gets a fresh `history` (per the existing driver/observer
design, unchanged here), so if a check fires against the new connection
before the user says anything, the drift-chide prompt references a task the
current `history` never actually mentions being stated. Judged acceptable --
same class of gap as `_scene_state` surviving reconnects already had, not a
new problem this feature introduced, and the alternative (task state tied to
connection lifetime) would mean losing task tracking on every disconnect,
which is worse for the common case (a window losing focus/reconnecting
mid-task) to fix a rare one (reconnecting mid-chide-prompt window).

**On/off-task judgment: one VLM call, forgiving JSON parse, conservative
default.** `check_task_progress()` reuses `llm.describe_image()` (the same
entry point `vision.describe_screen()` uses) with a comparison-specific
prompt instead of a plain description prompt, and parses the same forgiving
way `forget.py`'s `_parse_remove_indices` already does -- extract JSON,
tolerate markdown fences/stray text around it, treat anything that doesn't
parse into the expected shape as "no signal," never a guessed default. The
prompt explicitly biases toward `on_task: true` on anything ambiguous (blank
screen, unreadable capture, plausible-but-not-certain match) -- a false
"still on task" just means one missed chide and a retry next interval; a
false "drifted" means an unearned scold, which is a much worse failure mode
for a companion that's supposed to feel like it's actually paying attention,
not randomly nagging.

**Loop lives in `app.py`, not `task_guide.py`.** Same split as
`vision.py`/`app.py` already have: `vision.py`/`task_guide.py` hold pure,
stubbable logic (a screenshot function, a comparison function, a state
machine); `app.py` holds the orchestration that needs the websocket,
`history`, and the TTS-speak pipeline. `_task_guide_loop` is a *nested*
function inside `ws_endpoint` specifically so it can read `current_turn_task`
by closure (Python's late-binding closures see the current value of an
enclosing-scope variable at call time, not a snapshot) -- this is what lets
it skip a screen-check-and-chide cleanly whenever a real turn is already
mid-reply, without threading extra shared state through. Started only for
the driver connection (an observer never starts turns, so it has no
business triggering an unprompted one either), cancelled in the same
`finally` teardown block `current_turn_task` already used, same pattern.

**Idle timeout drops the task silently, no chide.** Per
`docs/ARCHITECTURE.md`'s own spec ("the task stays active until ... an idle
timeout is hit"), tracked via `last_interaction_at`, bumped by any real user
turn (`task_guide.mark_interaction()`, called from `_run_turn`) regardless
of whether that turn was even about the tracked task. 30 minutes default.
Deliberately no spoken line when this fires -- if the user's been gone that
long, there's nobody there to hear it, and a chide waiting to ambush them
the moment they come back would read as worse, not better, than just letting
the tracking quietly lapse.

**Chide generation reuses `_run_turn`'s pipeline, but isn't `_run_turn`
itself.** A drift check needed to speak through the same persona/chunking/
`_send_speak` machinery a real reply uses (so it sounds like her, gets the
`[emotion]` tag treatment, shows up in the Phase 9 transcript log) without
looking like the user said something they didn't. `_run_task_guide_check`
splices a one-off `user`-role instruction ("you just glanced at their screen
on your own... react to this now") onto the end of `history` for that one
call only -- same "ephemeral context, never written into `history` itself"
treatment `recall.py`'s memory block and `_scene_state`'s injection already
use -- and only the *resulting assistant reply* gets appended to `history`,
with no matching user turn before it. That's a deliberately visible
asymmetry (an assistant message with nothing preceding it), not a bug --
it's the honest shape of "she said something unprompted."

**What this doesn't cover yet, flagged the same way every other Phase 4
piece was:** genuinely untested against a real Ollama server end-to-end --
whether the comparison prompt actually gets qwen3.5:9b to produce the
requested JSON reliably, whether a 90-second default interval feels right in
practice (too naggy vs. too slow to catch real drift), and whether the
chide actually reads as natural in-character noticing rather than
mechanical "checking in" even with the SYSTEM_PROMPT instruction not to
mention that it's automatic. Full test coverage exists for everything that
*doesn't* need a real display/server (`orchestrator/test_task_guide.py`'s
state-machine and parsing tests, `tools/test_tools.py`'s dispatch-level
tests for the new `set_active_task` tool) -- 25 new tests, 90 total passing
in this sandbox. The user's real-machine retest is the next open item, same
as Round 1's was.

## PYTHONUNBUFFERED=1 on both spawned processes -- the logs weren't lying, they were just late

Found during real user debugging of a "can't hear her voice" report: the
user's `logs/orchestrator.log` showed a WebSocket connecting and nothing
else -- no sign of a TTS request ever happening -- while their
`logs/gpt_sovits.log`, from the same time window, clearly showed a
completed `POST /tts` returning `200 OK` with real synthesized audio.
`tts.py`'s `_synthesize_gpt_sovits()` always `print()`s a
`[luna] gpt_sovits response: ...` line immediately after getting that
response, unconditionally, so it should have been in `orchestrator.log`
too. It wasn't a logic bug -- the print statement itself doesn't have
`flush=True`, and Python switches stdout/stderr from line-buffered to
fully block-buffered the moment they're not attached to a real terminal,
which is exactly what `spawn_logged()`'s file redirection in `lib.rs`
does for both the orchestrator and GPT-SoVITS. So the print was sitting
in an in-memory buffer, not lost, just not written to disk yet -- which
made a real, already-successful request look like it never happened, at
exactly the moment someone was trying to use the log to debug why they
couldn't hear anything.

Fixed at the spawn level (`lib.rs`'s `.env("PYTHONUNBUFFERED", "1")` on
both the GPT-SoVITS and orchestrator `Command`s) rather than chasing down
every `print()` call site and adding `flush=True` individually -- some
already had it (`app.py`'s stale-orchestrator-takeover line, its
audio-bytes-received line), most didn't, and a global env var means no
future print call can silently reintroduce this. Also separately turned
up, but deliberately **not fixed this round**: `wait_for_port()` only
checks "is *something* listening on 9880," not "is it the process I just
spawned" -- so a leftover GPT-SoVITS instance from a previous session
that never cleanly exited can satisfy the check and let the orchestrator
proceed talking to a stale process, while the fresh one this launch tried
to start fails to bind and silently exits. This was the actual root cause
of the user's specific session (confirmed via `gpt_sovits.log`'s
`WinError 10048`/`only one usage of each socket address` line). Worth
fixing properly -- e.g. having `spawn_logged` hand back the `Child` so
`wait_for_port`'s caller can confirm it's still alive (`try_wait()`)
before concluding "ready," not just that the port answers -- but that
touches process-lifecycle code in a file already full of "found on the
user's real machine, not predicted" comments, and isn't safe to change
blind without a real Windows machine to verify against. Documented as a
known gap in `README.md`'s troubleshooting section instead (the new port
9880 entry) so it's at least diagnosable next time, rather than attempted
as an untested fix in the same sandbox that already can't build/run the
Rust side at all (no `cargo`/Rust toolchain here -- this round's `lib.rs`
change was reviewed by hand, not compiled).

## Stop button could get stuck showing "stop" after being clicked -- a straggler chunk race

Reported during the same real-debugging session as the log-buffering fix
above. `src/main.ts`'s action button morphs between send/stop based on a
combined `turnActive` signal (`!orchestratorDone || !audioIdle`), and the
stop click handler already set both flags directly and synchronously on
click -- so in isolation, clicking stop should always flip the button back
immediately, no async gap. That part checked out fine on inspection (no
`throw` risk found in `queue.stopAll()`, `lipsync.ts`'s `stop()`, or
`ws-client.ts`'s `sendStop()` -- the last of those already guards on
`readyState !== OPEN`).

The real gap: nothing stopped a **new** `speak` message from reviving the
button afterward. `app.py`'s per-chunk loop calls `await _send_speak(...)`
sequentially inside the same task `current_turn_task.cancel()` targets, so
cancellation *should* interrupt cleanly at whatever await point it's
sitting on -- but GPT-SoVITS synthesis measured **30+ seconds for a single
chunk** on the user's own machine (`gpt_sovits.log`, same session). If a
chunk's synthesis was already in flight when stop was clicked, and for any
reason (network-level cleanup lag, a synthesis call that doesn't fully
respect cancellation, or simply a chunk that had already fully returned
right as the cancel raced in) it still lands as a `speak` message
afterward, the client's `queue.push(msg)` sees an idle queue (`stopAll()`
already cleared `pending`/`playing`) and fires `onActive()` -- which flips
`audioIdle` false and `turnActive` back true, resurrecting the stop button
for a reply the user already dismissed. Not confirmed as *the* exact cause
of this specific report (the backend was in a generally broken state that
session -- stale process on port 9880, possibly a stale orchestrator too --
so there's a real chance this was fallout from that rather than a clean
reproduction), but it's a real, always-possible race regardless, worth
closing defensively either way.

Fixed client-side with a `turnStopped` flag (`src/main.ts`): set `true` the
instant stop is clicked, cleared the instant a new turn actually starts
(`submitText()`/the mic's `onClip`), and checked in `onSpeak` to drop any
chunk that arrives while it's set rather than pushing it onto the queue.
Deliberately *not* applied to `onTurnEnd` -- that handler's only effects on
a late arrival are re-setting `orchestratorDone` (already true from the
manual override) and refreshing the log panel if open, both harmless
no-ops. Chose a client-side fix over trying to make server-side
cancellation airtight because the client is the one place that can
guarantee "nothing reactivates this button after the user said stop,"
regardless of whatever timing quirk let a straggler through on any given
run -- a belt-and-suspenders fix, not a replacement for the server actually
cancelling promptly.

Also touched in the same pass: `_run_task_guide_check` (Phase 4 Round 2)
now logs every screen check's outcome unconditionally
(`[luna] task guide: checked '<description>' -> on_task=<bool> (<note>)`),
not just failures -- found, while writing testing instructions for the
user, that there was no way to confirm the loop was actually alive and
firing on schedule without waiting for a real chide to happen. Cheap
addition, same "make the log tell the truth about what's happening in
real time" spirit as the `PYTHONUNBUFFERED` fix right above this entry.

## set_active_task never actually fired -- strengthened the prompt, not confirmed fixed

First real test of Phase 4 Round 2 against the real machine: the user said
"I will be working on this poster for a bit, keep an eye on me" -- exactly
the trigger case `SYSTEM_PROMPT` describes -- and `llm.py`'s own
diagnostic line (`[luna] tool-calling: offered [...], replied directly
(saw_content=True, 'tool_calls' key ever present=False)`) showed the model
never emitted a `tool_calls` field at all, across all three turns in that
session. It just replied in character, engaging with "the poster"
conversationally, without ever calling `set_active_task`. Downstream
effect, not a separate bug: since no task was ever tracked, the scheduled
loop's new per-check log line (see the entry right above this one) never
printed either -- there was nothing to check.

Most likely cause, unconfirmed without a real retest: prompt salience, not
a wiring bug. The tool-use instruction was one paragraph inside a large,
heavily personality-focused `SYSTEM_PROMPT` (a dozen paragraphs of
character/tone direction before it), competing against a strong, explicit
"speak only in short spoken sentences, get to the point immediately"
instruction that dominates the prompt's overall shape. A 9B general-purpose
model reaching for "reply in character" as the default completion pattern,
rather than treating tool-use as an equally-available action every turn,
is a known and common failure mode for implicit/conversational tool
triggers (as opposed to a direct imperative like "look at my screen,"
which Phase 4 Round 1 confirmed working) -- this wasn't verified against
the model directly, just the most plausible explanation given what changed
nothing else about the wiring (the tool was genuinely offered every turn,
per the diagnostic line's own tool list).

Fixed by rewriting the paragraph in `persona.py`: explicit "these are real
capabilities, not decoration" framing, and -- most importantly -- a
concrete trigger example matching the user's own phrasing almost verbatim
("I'm going to work on X" / "keep an eye on me while I do Y" -> call the
tool right then, don't just reply in character). **Not yet confirmed
working** -- this needs a real retest with the updated prompt before
trusting it. If the model still doesn't call the tool reliably after this
change, the next things worth trying, roughly in order of how invasive
they are: moving the tool-use paragraph earlier in the prompt (higher
positional salience); lowering `llm.temperature` specifically for this
scenario (unlikely to be the core issue, but cheap to rule out); or, if
prompt-only fixes prove insufficient, reconsidering whether a 9B model can
reliably do implicit tool-triggering at all versus needing something more
structured (e.g. a lighter-weight classifier step, or accepting that only
explicit asks like "track this" will reliably work and adjusting the
persona's own behavior/expectations to match rather than fighting the
model).

## set_active_task never fired, round 2: it's a model capability ceiling, not Ollama or prompting -- moved to a dedicated classifier call

Continuation of the entry right above this one. After that prompt
strengthening still didn't work (three more real turns, all "replied
directly," `tool_calls` key never present -- even on the exact described
trigger phrase again), research turned up a genuine, well-documented,
dated Ollama bug: `ollama/ollama#14493` and related issues describe
Ollama routing Qwen 3.5's tool calls through the wrong renderer/parser
pipeline (Hermes-style JSON instead of the Qwen3-Coder XML format the
model was actually trained on) across all Qwen 3.5 sizes -- exactly
matching the observed symptom (tools offered, acknowledged, never
actually called). Community reports describe this as fixed upstream as
of Ollama v0.17.6.

That looked like the answer -- except the user was already running Ollama
0.34.2, well past that fix, and separately confirmed the same 9B model
also failed to call a tool (fail to open a browser, an explicit direct
command, not an implicit one) in a *completely different* agent
framework (Hermes Agent). That combination -- fixed Ollama version, plus
a cross-framework failure on an explicit ask -- rules out both "it's an
Ollama wiring bug" and "it's a Luna prompting problem." What's left is
the more sobering, but actionable, explanation: qwen3.5:9b's actual
agentic tool-calling reliability, independent of framework or prompt
wording, isn't strong enough to trust for this. This tracks with the
broader pattern the Ollama issue thread itself surfaces once you read
past the renderer bug -- reliable agentic tool-use is something larger
Qwen 3.5 sizes (27B+) are actually benchmarked/trained for; smaller
sizes inherit the architecture but not necessarily the same agentic
reliability.

Rather than keep fighting a real capability ceiling with more prompt
engineering, moved `set_active_task`'s trigger detection off of Ollama's
native tool-calling entirely, onto the exact same architecture
`forget.py`'s `maybe_forget()` and `consolidation.py`'s session
distillation already use successfully with this same model: a narrow,
dedicated classification call asking for a small JSON object
(`{"action": "start"|"stop"|"none", "description": "..."}`), forgiving-
parsed the same way every other small-model JSON call in this codebase
already is, calling `task_guide.set_active_task()` directly in Python
rather than depending on the model to emit a `tool_calls` field at all.
The insight worth naming: this model has already been proven, in this
very codebase, to reliably do "read a short prompt, emit one JSON object,
nothing else" -- forget.py and consolidation.py depend on exactly that
and it works. What it apparently can't reliably do is the more open-ended
"decide mid-roleplay-reply whether this is also a moment to invoke a
tool." Decoupling those two into separate calls sidesteps the actual
weakness instead of asking harder for something the model structurally
isn't good at.

Unlike `forget.py`'s cheap keyword gate before its classification call,
`maybe_update_task()` has no such gate -- task-starting phrasing is far
more varied than the word "forget," and Task Guide Mode is the product's
flagship behavior, so one extra short classification call per turn was
judged a reasonable reliability cost rather than a wasteful one.
`set_active_task` (the tool) is left in place, unremoved, as a harmless
redundant path in case the model does call it sometimes -- doesn't hurt
anything if it never fires again.

**Still not confirmed on the user's real machine** -- this fix is
architecturally sound and consistent with what's already proven to work
elsewhere in this exact codebase with this exact model, which is a much
stronger basis for confidence than the previous round's prompt-wording
guess, but it's still unverified against the real Ollama server. Next
real test should watch for `[luna] task guide: detected task start ->
'...'` in `orchestrator.log` rather than the old
`tool-calling: offered [...] ... 'tool_calls' key ever present` line,
which is no longer the mechanism actually driving this.

## Stale one-off mention kept resurfacing across unrelated conversations for weeks -- fact-extraction bar was too loose

Reported alongside the tool-calling investigation above: the user
mentioned a VRoid avatar project once, in passing, two weeks prior, and
Luna kept bringing it up unprompted in roughly ten unrelated
conversations since -- including reaching for it mid-insult when the
user brought up something else entirely ("finishing your damn VRoid
model" apropos of a completely different piece of code).

Root cause, once traced: `consolidation.py`'s fact-extraction prompt told
the model facts are "stated preferences, ongoing projects,
**tools/stack/games mentioned**, anything that would still be true weeks
from now. Skip anything trivial, one-off..." -- two instructions in
tension. "Tools/stack/games mentioned" is broad enough to literally match
a single passing mention, and the "skip trivial/one-off" qualifier
depends on the model correctly judging durability -- the same class of
nuanced conditional judgment call this model has now demonstrated,
across two separate features in the same session, that it doesn't
reliably apply (see the `set_active_task` entries above). Once
mis-extracted as a fact, the bug compounds structurally:
`recall.py`'s `MAX_FACTS_IN_RECALL` facts are injected into *every*
turn's prompt unconditionally (no embedding/relevance filtering the way
episode recall gets -- deliberately so, per recall.py's own docstring,
so fact recall survives an embedding-server outage) with only a prompt
instruction ("only bring something up if genuinely relevant") asking the
model to filter at generation time -- which is exactly the same kind of
instruction this model doesn't reliably follow.

Two-part fix, both in the prompts rather than the architecture (no
change to the unconditional-fact-injection design itself, which has a
real robustness reason to stay that way):
1. `consolidation.py`'s extraction bar tightened with an explicit test
   ("would it still make sense to casually mention this back to the user
   weeks from now, in a conversation about something else entirely?")
   and a concrete positive/negative pair ("let me pull up VRoid real
   quick" vs. "I've been using VRoid for my avatar project") -- built
   directly from this exact real failure, not a hypothetical.
2. `recall.py`'s injected-block instruction strengthened with a matching
   negative example (reaching for a listed fact as a jab when the user
   brings up something unrelated is explicitly called out as "exactly
   the wrong move").
Neither is a structural fix for "small model doesn't reliably follow
conditional instructions" as a general problem -- that's the same
underlying limitation the `set_active_task` entries above describe, just
manifesting here as over-eager fact storage instead of under-eager tool
use. If facts keep leaking after this, the more structural fix worth
trying is embedding-based relevance filtering for facts too (matching
how episodes already work), at the cost of losing the "still works if
the embedding server is down" robustness recall.py's docstring
specifically calls out as the reason facts don't already work that way.

Immediate relief for the user's already-stored bad fact (not a code fix,
just the existing capability): `forget.py`'s explicit "forget that"
handling was already built and already covers this -- telling her
"forget that I mentioned VRoid" (or similar phrasing matching
`_FORGET_TRIGGER`) finds and deletes the specific stored fact right away,
without needing to wait for a code change to take effect.

## Phase 5 Round 1: gated camera tool -- 2D canvas beats WebGL for this, tray icon is the only indicator

`capture_camera` follows `capture_screen`'s exact "pull, not push" shape
(`docs/ARCHITECTURE.md`'s "Vision tools" section): every capture only
happens because the model chose to call the tool, never a continuous
feed. What's genuinely different from `capture_screen`: there is no
server-side equivalent of a webcam grab (unlike `PIL.ImageGrab`/`mss` for
the screen), so the pixels can only come from the browser.

**Why 2D canvas, not WebGL, despite the user specifically asking for a
"WebGL camera setup."** `docs/ARCHITECTURE.md`'s own spec for
`capture_camera()` says the indicator is a tray icon state, "even though
nothing is displayed back to the user" -- there was never going to be an
on-screen preview to render. With nothing shown and no per-frame effects/
filters applied, WebGL provides zero speed advantage over a plain
`canvas.getContext("2d").drawImage()` for grabbing a single still frame --
both are sub-millisecond to a few ms, and the actual bottleneck in this
pipeline is the browser's own `getUserMedia`/video-decode path either way,
not which canvas API reads the pixels out afterward. The user's "I heard
it's millisecond-level fast" instinct about camera capture speed is
correct -- that part of the pipeline genuinely is fast -- but WebGL isn't
what makes it fast, and reaching for a WebGL context/shader setup here
would have been real complexity with no real benefit. Named this
explicitly rather than silently substituting 2D and hoping it doesn't
come up -- if a future feature needs actual GPU-side pixel processing
(a live preview with filters, continuous frame-diffing for the "Dedicated
OCR" menu item), WebGL would earn its keep then, just not for one-shot
still capture.

**The permission/indicator design was mostly already decided, not
invented this round** -- `docs/ARCHITECTURE.md` already specified a
one-time permission plus a tray-icon indicator (not an in-window one)
before this round touched any code. What this round actually built: the
Rust side to make the tray icon swappable at all (`lib.rs` previously
just discarded the `TrayIcon` handle after building it -- now stored via
`app.manage()`, same pattern `ManagedChildren` already uses), a second
tray icon asset (`icons/tray-camera-active.png`, a red dot composited
onto the main icon via Pillow, matching the same visual language a
standard OS camera-in-use light uses), and a new `set_camera_indicator`
Tauri command swapping between it and `app.default_window_icon()`. The
indicator tracks "is the stream open" (armed at toggle-on, released at
toggle-off), not literally "is a frame being read this millisecond" --
deliberately: that's both simpler to implement correctly and more honest
about the actual privacy-relevant fact (the camera *could* be read from
at any point while armed), the same way a physical webcam light works.

**The request/response round trip is new plumbing, not reused from
anything.** `orchestrator/camera.py`'s `request_frame()` sends
`request_camera_frame` over the websocket and awaits an
`asyncio.Future` that `resolve_pending_frame()` completes when
`app.py`'s message loop sees the matching `camera_frame` reply --
bounded by a 10s timeout so a browser that never answers (camera
toggled off, window lost focus, whatever) can't hang a whole turn.
Single-slot module-level state, same reasoning as `task_guide.py`'s
single-active-task design: this is a single-driver-connection app, so
there's never a genuine need for more than one in-flight camera request.
`dispatch_tool_call` (`tools/__init__.py`) now takes an optional
`websocket` parameter, threaded through to every handler as a keyword
argument -- harmlessly absorbed by `**_ignored` on the three tools that
don't need it, so `capture_camera` doesn't require different wiring than
the rest.

**What's still open, beyond real-machine verification:** the Rust
changes (a new Cargo feature, a new command, a new managed-state struct)
have never been compiled -- no cargo in this sandbox, same limit as
`lib.rs`'s other rounds. `camera.ts`'s `getUserMedia`/permission flow,
the actual round-trip timing under a real Ollama VLM call, and whether
the tray icon swap is visually obvious enough in practice are all
genuinely untested. Game-context awareness (the other half of Phase 5)
isn't started.
