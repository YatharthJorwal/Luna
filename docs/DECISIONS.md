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

