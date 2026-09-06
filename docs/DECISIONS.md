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
