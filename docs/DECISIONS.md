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

## Phase 10 (partial) -- full-body sandbox, isolated from the shell

User asked for a dedicated place to develop full-body locomotion/animation
work -- the desktop shell's bust-up framing has no floor and no legs to
animate -- **without touching the shell itself** (`src/main.ts`,
`index.html`, `style.css`, `src-tauri/`, `orchestrator/`). This maps to
half of ROADMAP.md's existing Phase 10 entry ("a fuller sandbox scene she
stands in") but deliberately *not* the other half (selectable
classroom/home/park backgrounds) -- scoped down to exactly what was asked
for: a full-body model, a plain white space, and walking, as groundwork
the rest of Phase 10 and any real animation work can build on.

**A parallel, self-contained entry point, not a shared module the shell
also imports.** `sandbox.html` / `src/sandbox.ts` / `src/sandbox.css` sit
alongside `index.html` / `src/main.ts` / `src/style.css` as a second,
independent Vite page -- same pattern Vite supports for any root-level
`.html` file with zero config changes in dev (`npm run dev`, then open
`/sandbox.html`, or the new `npm run sandbox` shortcut). It isn't wired
into `vite.config.ts`'s build inputs or `src-tauri/tauri.conf.json`'s
window config, so it never ships in the packaged app and can't affect
it -- confirmed by rebuilding the existing `npm run build` (index.html
only, 16 modules, output unchanged) and separately smoke-building
`sandbox.html` on its own (12 modules, clean bundle, both checked in this
sandbox environment).

This meant deliberately **duplicating a handful of small main.ts
functions** (the GLTF/VRM loader setup, `applyIdlePose`'s arm-down rest
pose, the blink loop) rather than extracting them into a shared module
that main.ts would then also need to import from -- doing that would mean
editing main.ts, which was explicitly out of scope. The duplication is
small (well under 50 lines total) and the two files are likely to keep
diverging anyway -- the sandbox needs bounding-box-based full-body camera
framing where main.ts needs head-relative bust framing, a floor and
lighting where main.ts needs transparency, and a locomotion loop main.ts
has no use for at all. If this ever becomes worth de-duplicating, that's
its own explicit follow-up, not something to sneak in here.

**Two additive, non-behavioral changes to existing project files** (the
brief's "don't touch anything else" is read as "don't touch the shell's
behavior," not literally zero-byte-diff everywhere): `package.json` gained
`@pixiv/three-vrm-animation` (official pixiv package, same publisher/
version line as the already-installed `@pixiv/three-vrm`, see below) plus
a `sandbox` script; `.gitignore` gained one entry for the new asset folder
below, same pattern as the existing `public/vrm/*.vrm` line. Neither
changes what `npm run tauri dev` or `npm run build` do.

**Walking: camera-relative input, not world-fixed.** WASD/arrows read
against the *camera's* current forward/right (`camera.getWorldDirection()`
projected onto the floor plane), the standard third-person convention --
not raw world XZ axes, which would feel wrong the moment the orbit camera
has been dragged away from its start angle. The model turns to face its
own movement direction (`Math.atan2(-move.x, -move.z)`, derived by hand
from VRM's -Z-forward convention -- see the code comment for the actual
sign derivation, not guessed) via a shortest-path angle lerp, not a
snap. Movement is clamped to a fixed invisible square (`FLOOR_HALF_SIZE`)
since there's no room geometry yet to collide against -- real bounds are
part of the *other* half of Phase 10 (background/room selection), not
this piece.

**Animation: a real-clip path is wired up, but there's no clip to test it
with.** `@pixiv/three-vrm-animation`'s documented pattern
(`VRMAnimationLoaderPlugin` + `createVRMAnimationClip` +
`THREE.AnimationMixer`) is implemented against a `walk.vrma` path under a
new gitignored `public/vrm-animations/` folder (mirrors `public/vrm/`'s
own existing pattern exactly, README.txt included) -- confirmed the
package's actual exported API by downloading and reading its shipped
`.d.ts` files rather than assuming the function signatures from memory,
same discipline as Phase 7's VRM loader work. Not verified: this path
actually running against a real `.vrma` file, since none exists in this
sandbox (no browser, no GPU, no asset) -- same standing caveat as every
prior phase's "not verified against real hardware" note. Until a real
clip is dropped in, `ProceduralWalker` drives the walk cycle instead: sine-
wave hip-swing on the leg bones (amplitude eased toward current speed, so
starting/stopping blends rather than snaps), counter-swinging arms
layered onto `applyRestPose`'s existing rotation (only the swing axis is
touched, so the authored idle pose survives underneath it), and a small
hip bob -- all driven by VRM's normalized humanoid bone nodes the same way
`applyIdlePose` already does in main.ts, not a new mechanism. This exists
specifically so locomotion/camera/room work is testable *today*, without
waiting on a sourced animation asset the way the character model itself
was already gitignored and waited-on back in Phase 7.

**Idle<->walk crossfading deliberately left out of v1.** With only one
optional clip (`walk.vrma`, no `idle.vrma`), the real-clip path pauses via
`timeScale = 0` (freezing on the clip's current pose) rather than
blending to a second authored idle animation -- simplest thing that could
work with one clip, and proper crossfading is much easier to get right
once there's an actual clip in hand to test blend timing against, rather
than guessing at it now.

**Verified in this sandbox:** `tsc --noEmit` clean across the whole
project (existing files included -- confirms nothing here broke shell
typechecking); `npm run build` (the real production build, index.html
only) produces the same 16-module bundle as before this change;
`sandbox.html` builds cleanly on its own via a throwaway Vite config
(12 modules, no import/type errors) confirming every import -- `three`'s
`OrbitControls`, `@pixiv/three-vrm`, `@pixiv/three-vrm-animation` -- and
the loader plugin registration actually resolve. **Not verified:** the
actual visual/gameplay feel (walking speed, turn responsiveness, camera
framing, the procedural walk's cadence) against a real model in a real
browser -- no GPU or browser in this sandbox, same limitation every
rendering-facing phase since Phase 7 has had. Expect to tune
`WALK_SPEED_MPS`, `TURN_RATE_RAD_S`, and the `LEG_SWING_RAD`/
`ARM_SWING_RAD`/`WALK_CYCLE_RATE` constants near the top of
`src/sandbox.ts` by eye on first real run, same spirit as main.ts's own
hand-tuned camera constants.

## Phase 10 (partial), round 2 -- spectator camera, AI-owned movement, real box room, live chat in the sandbox

Follow-up to the entry above, after actually seeing the first round
running (two screenshots): direct feedback was "this is her space, I
don't control her model," the gray sheen on the jacket, "don't make the
horizon blurry and infinite, it's supposed to be a box," a completely
different camera scheme (WASD-fly + right-drag-look + middle-drag-pan,
spectator-only), and -- the bigger one -- bringing the shell's actual
chat/voice/caption features into the sandbox so this becomes a second,
real way to talk to her, with the two windows aware of each other.

Also found and fixed on the way in: the merge that landed the round-1
entry above into `main` left literal, uncleaned `<<<<<<<`/`=======`/
`>>>>>>>` conflict markers sitting in this file (both sides' content was
there, just never actually reconciled) -- removed; both entries survive
intact, nothing was dropped.

**Movement is no longer player input.** The previous round's
`CharacterController` read WASD directly; that's gone. `WanderController`
(new, in `src/sandbox.ts`) is an explicit, clearly-labeled placeholder for
"the AI decides where she walks and stays" -- it picks a random point in
the room, walks her there, waits a random beat, repeats, and pauses (without
picking a new destination mid-wait) whenever `sandbox-hud.ts` reports a
conversation turn is actually active. `CharacterController` itself only
ever asks "where should she be walking to, if anywhere" and steers toward
that -- swapping in real orchestrator-driven navigation later (a
`walk_to`/`play_animation` message over the same WebSocket connection
`sandbox-hud.ts` already opens) means replacing this one class, nothing
downstream of it. Not built now because there's no such message type or
navigation-brain on the orchestrator side yet -- the user's own phrasing
("the AI *will* handle her future animations") reads as forward-looking,
not a request to fake real decision-making today.

**The camera is a from-scratch fly cam, not OrbitControls.** OrbitControls
always orbits around a target point, which stopped being the right shape
once she's no longer something to keep centered -- the person is a pure
spectator now. `FlyCamera` (new, in `src/sandbox.ts`) hand-implements
WASD-relative-to-view-direction flight, Space/Shift for pure vertical
movement, right-drag look-in-place (yaw/pitch via `THREE.Euler`'s `"YXZ"`
order, the standard non-gimbal-locking approach for a first-person-style
camera), middle-drag pan, and scroll-to-adjust-fly-speed. WASD is
suppressed while any `<input>`/`<textarea>` is focused (`isTypingTarget()`)
so typing in the chatbox doesn't also fly the camera around.

**The room is now an actual box: floor, four walls, a ceiling, no fog.**
The previous round used `scene.fog` to fade a much-larger floor into the
white background at a distance -- exactly the "blurry infinite horizon"
the user called out, not a subtle issue to tune, so it's removed outright
rather than just toned down. `ROOM_HALF_SIZE`/`ROOM_HEIGHT` define real
wall geometry now (`THREE.DoubleSide` on every surface, since the camera
can now fly outside the box entirely and there's no reason for that view
to show through the wall). Her wander bounds (`WANDER_MARGIN_M` inset from
the walls) are separate from the room geometry itself, not inferred from
it -- deliberately, since a real decorated room (the *other* half of
ROADMAP.md's Phase 10 entry) will want its own, possibly-irregular
walkable area later.

**Lighting: reduced fill, neutralized the hemisphere's tint.** The
screenshots showed a flat gray sheen across the jacket, consistent with
Phase 7's already-documented "jacket artifact" (MToon's toon shading reads
lit/shadow bands off the light direction; too much ambient/hemisphere fill
flattens those bands into a uniform wash instead of a clean split) --
same root cause, same style of fix: the previous round's
`HemisphereLight(0xffffff, 0xd8d8e0, 1.15)` (slightly blue-gray ground
tint, fairly strong) is now `HemisphereLight(0xffffff, 0xf3f3f3, 0.5)`
(near-neutral, much dimmer), and the directional key light dropped from
0.9 to 0.55. The key light is also no longer positioned relative to the
camera (that reasoning stopped making sense the moment the camera became
free-flying) -- it's a fixed point in the room now, which is fine for a
`DirectionalLight` specifically since only its angle matters, not its
distance from what it's lighting. Not independently re-verified against a
real render -- no GPU/browser in this sandbox, same limitation as Phase
7's own version of this exact fix.

**The sandbox now has a real, live connection to the orchestrator, not
just a silent 3D view.** `src/sandbox-hud.ts` (new) ports main.ts's
chatbox, mic button, captions, "/"-to-focus, and the emotion blend over to
the sandbox -- same duplication-over-shared-module reasoning as the first
round (a `WsClient`/`MicInput`/`lipsync.ts` import is fine, those are
already pure reusable modules main.ts itself doesn't own exclusively; the
HUD *logic* -- SpeakQueue, caption timing, the emotion blend -- is copied
and adapted, not imported, so `main.ts` stays untouched beyond the one
patch described below). Ported against `main.ts`'s *current* state, not
the snapshot round 1 was written against -- the user's own intervening
commits (`8306d5e`) had already renamed the `relaxed` emotion tag to
`teasing` with a composite `EMOTION_BLENDS` map and reworked captions to
individually fade trailing words, both of which this round's
`sandbox-hud.ts`/`sandbox.css` now match exactly rather than silently
drifting out of sync. No F9 push-to-talk here: that's wired through a
Tauri global-shortcut event that only exists inside the Tauri webview, and
this page is a plain browser tab (confirmed by the user's own screenshot
-- Chrome, with tabs, not a borderless Tauri window). The mic button
itself is functionally identical to the shell's for now -- the user
flagged that the sandbox's mic will eventually mean something more than
"record and transcribe," without saying what; the seam (`MicInput`'s
`onClip` callback handing a blob to `client.sendUserAudio`) doesn't assume
anything about *why* a clip was captured, so whatever that turns out to be
should still slot in without protocol changes.

**Two windows, one Luna, only one may drive at a time.** This is the one
piece that genuinely couldn't stay sandbox-only: "aware of where I'm
running her so neither collide" needs both ends of the WebSocket to agree
on it. `ws-client.ts` gained a required `surface: "shell" | "sandbox"`
constructor field (sent as a `?surface=` query param) and an optional
`onSurfaceStatus` callback for a new `surface_status` message.
`orchestrator/app.py` gained `_driver`/`_connection_surface` module-level
state: whichever connection opens first becomes the "driver" (allowed to
send `user_text`/`user_audio`); anything else connecting while the driver
is still open is an "observer," gets told so immediately, and if it tries
to start a turn anyway gets a canned in-character decline
(`SURFACE_BUSY_LINE`, tagged `teasing` -- not `relaxed`, which no longer
exists as a valid app-facing tag as of the rename above) rather than
either silently doing nothing or -- the actual failure mode being
prevented -- both windows generating a reply and playing TTS audio over
each other. If the driver disconnects, the orchestrator promotes whichever
other connection is still open and tells it so. `main.ts` needed a small,
explicit patch for this (a new `observerLocked` flag gating input/the F9
hotkey alongside the existing `turnActive` flag, plus `surface: "shell"`
on its `WsClient` construction) -- the only shell-file edit in this whole
round, made because the feature genuinely requires both ends to
participate, not because the isolation approach from round 1 was
abandoned. `index.html`, `style.css`, `src-tauri/`, `persona.py` remain
untouched.

**Known, accepted limitation, not an oversight:** conversation `history`
is still tracked per-connection (unchanged since Phase 2), not per-
character. A promoted observer starts a *fresh* conversation rather than
inheriting the old driver's mid-thread state -- continuous handoff would
mean restructuring history to live per-character across connections
instead, a bigger change than this round's scope. Also unaddressed:
nothing stops a *third* simultaneous connection (it'd just also be an
"observer," which is at least safe, if not maximally useful); and
`_active_connections`/`_driver` are plain module-level state with no
per-process-restart persistence, same as everything else `app.py` already
tracks this way.

**Verified in this sandbox:** `tsc --noEmit` clean across the whole
project (rebuilt from the actual current `origin/main`, not the stale
branch round 1 was written against -- see the merge-marker note above for
why that distinction mattered here); `npm run build` (index.html only)
still produces the same 16-module shell bundle; `sandbox.html` builds
cleanly standalone via a throwaway Vite config (15 modules now, up from
12, expected given `sandbox-hud.ts`/`mic.ts`/`lipsync.ts`/`ws-client.ts`
joining the graph). `orchestrator/app.py`'s actual driver/observer/
promotion/decline logic -- the real `ws_endpoint` function, not a
reimplementation -- was exercised directly under a hand-driven `asyncio`
event loop against a minimal fake WebSocket object (Starlette's own
`TestClient` hit a cross-event-loop error against this file's
module-level `_shutdown_event`, a test-harness quirk of this sandbox's
installed Starlette version, not a bug in `app.py` -- a real
single-process `uvicorn` run only ever has one loop). Confirmed: first
connection gets `"driver"`, a second gets `"observer"` and is declined in
character (with the right canned line and the correct `teasing` emotion
tag) if it tries to send `user_text` anyway, and the observer is promoted
to `"driver"` the moment the original driver disconnects. **Not
verified:** any of this against the real `pyttsx3`/`faster-whisper`/
`sqlite-vec` stack (all three stubbed out for the test above, same
reasoning as every prior phase's "no GPU/no native deps in this sandbox"
caveat) or against two real browser windows actually open at once.

## Phase 7/8/10 confirmed clean on the user's machine

The user confirmed, from a real screenshot (Tauri-free browser tab
running the full-body sandbox, room + HUD rendering correctly, model
loaded, status line showing the procedural-walk fallback message): the
VRM avatar migration (Phase 7), the sandbox environment (Phase 10's
round 1 + round 2 work), and the emotion/expression system (Phase 8) all
render and work as designed on real hardware, not just sandbox-verified
as before. `docs/ROADMAP.md` updated accordingly -- Phase 7 and Phase 8
move to ✅, confirmed rather than 🔶. Phase 10 stays 🔶: the rendering
itself is now confirmed, but the phase's remaining open items (desktop
companion mode, background selection, real orchestrator-driven
navigation replacing `WanderController`, a sourced walk cycle and other
real body-language clips) are unrelated to what was just confirmed and
still unbuilt.

## Gesture clips (Angry/Blush/Clapping/Goodbye/Jump/LookAround/Relax/Sad/Sleepy/Surprised/Thinking.vrma) wired into the sandbox

The user dropped eleven real `.vrma` files into
`public/vrm-animations/` (more to come, per the user) and asked whether
these should *replace* the VRoid-default facial expression system
(`EMOTION_BLENDS` in `main.ts`/`sandbox-hud.ts`) rather than sit
alongside it. They don't, and can't cleanly: facial expression is a
continuous per-frame morph-target blend with no notion of "playing" or
"finishing" -- it's just whatever weight `updateEmotion()` currently
eases toward. A `.vrma` gesture is the opposite shape: a fixed-duration
authored animation clip that plays once and ends. One can't substitute
for the other's job. What actually makes sense, and what's built here,
is additive: the facial blend keeps running exactly as before, and a
matching one-shot *body* gesture now plays on top of it when a turn ends
with an emotion tag, giving the reaction both a face and a body instead
of a face alone.

`sandbox.ts` is the only file touched this round (main.ts still has no
`AnimationMixer` at all -- it never needed one before this, since it
only ever drove facial blends -- porting gestures to the shell is real
but separate follow-up work, not done here). Two new tables sit next to
the existing `WALK_CLIP_PATH`: `GESTURE_CLIP_FILES` (gesture name →
filename, all eleven current files registered, loaded best-effort
exactly like `walk.vrma` already was -- a missing file just means that
one gesture never registers, not a boot failure) and
`GESTURE_FOR_EMOTION` (a *separate* table mapping the six app-facing
emotion tags to a gesture name, kept independent of
`GESTURE_CLIP_FILES`'s keys on purpose so gesture files can be
renamed/re-picked later without touching the emotion vocabulary
`persona.py` actually sends). Only five of the six emotions got a
gesture assigned: `angry`→Angry, `sad`→Sad, `surprised`→Surprised,
`teasing`→Relax (closest authored body language on hand to the
model's own "relaxed"-preset-plus-a-hint-of-angry composite), and, as a
stand-in only, `happy`→Blush, since no dedicated joy/happy body clip
exists yet -- worth swapping the moment one does. `neutral` has no
gesture on purpose: returning to idle/wander already reads as neutral.
The other six files (Clapping/Goodbye/Jump/LookAround/Sleepy/Thinking)
don't correspond to any emotion tag at all and have no trigger wired up
yet -- they're loaded and available through
`CharacterController.playGesture()` (see below), just not fired by
anything yet. Natural next signals for them once they exist: a
goodbye-on-disconnect hook, a thinking-while-generating indicator, idle
variety during long stretches of `WanderController` inactivity, and so
on.

`CharacterController` (previously walk-only) now always owns an
`AnimationMixer` -- it used to only construct one conditionally, when a
walk clip actually loaded, since gestures didn't exist yet to need one
either way. It gained `registerGesture(name, clip)` (called once per
successfully-loaded clip from `boot()`'s loop, sets `LoopOnce` +
`clampWhenFinished` so a gesture holds its last pose rather than
snapping back to bind pose the instant it ends) and `playGesture(name)`
(silently no-ops for an unregistered name, same tolerance-of-absence
philosophy as everything else gesture-related here; fades out
whichever gesture was already running, if any, rather than layering
two). While a gesture is active, `update()` freezes position/facing and
skips driving the walk/procedural-walk path entirely for that duration
-- letting a walk cycle keep running underneath an authored full-body
clip would just be two systems fighting over the same bones. **Known,
accepted rough edge:** if she's already mid-stride when a gesture
fires, she freezes mid-step rather than easing to a stop first; not
solved here, worth a look once there's a real model/browser to actually
see it against. The trigger itself lives at the same `turn_end` signal
the facial blend already reacts to: `sandbox-hud.ts`'s
`setupSandboxHud` now takes an optional `opts.onEmotion` callback,
fired once per turn right alongside `setTargetEmotion(emotion)` inside
`onTurnEnd` (and *not* fired from the other `setTargetEmotion("neutral")`
call sites -- stop button, audio-idle reset -- since those are UI resets,
not a reaction worth replaying a gesture for). `boot()` wires that
callback to `GESTURE_FOR_EMOTION` → `character.playGesture(...)`, both
lookups tolerant of a miss.

**Verified in this sandbox:** `tsc --noEmit` clean across the whole
project after these changes. **Not verified:** any of it visually --
same "no GPU/browser in this sandbox" caveat as every rendering-related
entry above. In particular: whether the freeze-in-place behavior during
a gesture actually looks right, whether the `happy`→Blush stand-in reads
as intended, and whether 0.2s fade in/out is the right timing for these
particular clips -- all first-guess values pending a real look.

## Two real bugs from the user's first on-machine gesture test, plus idle variety

First real-hardware run of the gesture system from the previous round
surfaced two bugs, both found by re-reading the code against the user's
report/screenshot rather than guessed at blind -- same "trust the report,
trace the actual logic" approach as every other on-machine bug fix in
this doc.

**Bug 1: a finished gesture froze her permanently ("gets stuck like
this").** `registerGesture()` sets `clampWhenFinished = true`, which
holds a clip's last frame forever once it ends -- nothing was ever
un-clamping it. Compounding that: `CharacterController.update()` calls
`this.mixer.update(delta)` unconditionally every frame, gesture-or-not,
so the frozen action kept reapplying its held pose over whatever the
walk/idle path had just set, every single frame, forever. Clearing
`activeGesture` on the `finished` event (previous round's fix) only
stopped *new* gestures from being blocked -- it did nothing to release
the old action's grip on the bones. Fixed with an explicit hold/fade
state machine: `finished` now starts a `"hold"` phase
(`GESTURE_HOLD_S` = 1.4s, holding the pose on purpose, per the user's
own "bring her back to normal after a few seconds" -- not a snap-back),
then a `"fade"` phase (`GESTURE_FADE_S` = 0.4s, `fadeOut()` easing the
weight down) that ends in an actual `action.stop()` -- the step that was
missing before, and the one that actually releases the bones.

**Bug 2: "moonwalking."** `update()`'s translation step was a flat
`WALK_SPEED_MPS * delta` regardless of `speedFraction`; `speedFraction`
only ever scaled the *animation* (leg-swing amplitude, or the walk
clip's mixer weight/timeScale). Near a wander target, her legs would
visually ease down to a stop (animation slowing via speedFraction) while
her body kept translating toward the target at full, undiminished
speed underneath -- exactly the skating/moonwalk look reported. Fixed by
computing `speedFraction` first and using it to scale the actual
translation step too, so root motion and leg animation now slow down
together rather than only one of them. Not yet re-confirmed on the
user's machine -- this was diagnosed and fixed from reading the logic,
not from a repro in this sandbox (no GPU/browser here); it's a real
inconsistency in the math either way, not a guess, but the user should
still confirm it reads right in motion.

**Idle variety, the user's other ask.** A new `IdleGestureScheduler`
(next to `WanderController`, not folded into it, so their timers stay
independent) rolls a random 8-20s interval and plays a random pick from
`lookAround`/`sleepy`/`thinking` whenever she's just standing there --
not walking, not mid-turn, not already gesturing. The other loaded
gestures (`Clapping`/`Goodbye`/`Jump`) are left out of the random pool
since they read as reactive/contextual rather than ambient idle flavor
-- same reasoning as why they had no `GESTURE_FOR_EMOTION` entry either.
`boot()`'s `animate()` loop checks eligibility *after*
`character.update()` runs for the frame, so it sees the real
post-lifecycle gesture state rather than stale info from before this
frame's hold/fade bookkeeping.

**Verified in this sandbox:** `tsc --noEmit` clean; `npm run build`
(shell) and a standalone `sandbox.html` build both produce clean
bundles. **Not verified:** any of it visually, same recurring caveat --
whether 1.4s is the right hold duration, whether the moonwalk fix
actually reads as fixed, and whether the idle-gesture interval (8-20s)
feels natural rather than too frequent or too rare are all pending a
real look on the user's machine.

## Round 5, "go big": adopting the Hanami VRMA pack wholesale

The user sourced a much larger animation pack (from an open-source VRM
companion app, "Hanami") and asked to go all-in: real walk-cycle data,
idle variety, and swapping the emotion gestures over to the pack's own
family, in one round rather than split across several.

**License check first, as always with third-party assets.** Three
sources feed the pack: Overte (Apache-2.0), Microsoft Rocketbox (MIT),
Quaternius (CC0). All three are permissive and redistributable; the
obligation that actually matters is Apache-2.0/MIT's requirement to keep
copyright/license notices with any redistribution. `public/vrm-animations/`
now has `NOTICE.md` (the pack's own full per-file attribution, kept
verbatim, not edited), `PACK-README.md` (its engineering documentation --
seam measurements, phase contracts, the `world.json`/`transitions.json`
schema), and a `LICENSES/` folder with the full Apache-2.0 and MIT texts.
Rocketbox's `rb-*` family (38 files, an alternate, unused body/face style)
and the pack's own `extra/` folder (15 files its authors explicitly set
aside) were **not** copied in -- `NOTICE.md` still documents them by name
in case they're wanted later, but there's no reason to carry ~12 MB of
files nothing in this codebase loads. What did get copied: the active
Overte set plus two Quaternius world-clips, 113 files, alongside the
user's own capitalized-filename clips from rounds 3/4.

**A real bug caught before it shipped, not after:** two of the user's
own clips from round 3 (`Angry.vrma`, `Sad.vrma`) are, byte for byte,
different files from the pack's `angry.vrma`/`sad.vrma` -- but identical
*names* once case is ignored. Harmless on the Linux filesystem this
sandbox runs on, but the user is on Windows, where the filesystem is
case-insensitive by default: committing both would silently collide on
checkout. Both roles are superseded by the pack's fitted versions this
round anyway (see below), so the fix was straightforward: `Angry.vrma`
and `Sad.vrma` are removed from the repo (along with `Blush.vrma` and
`Relax.vrma`, which don't collide by name but became just as unreferenced
once `happy`/`teasing` also moved to the pack's clips). `Surprised.vrma`,
`Clapping.vrma`, `Goodbye.vrma`, `Jump.vrma`, `LookAround.vrma`,
`Sleepy.vrma`, `Thinking.vrma` are untouched -- still in use, no
case-collision with anything in the pack. See
`public/vrm-animations/README.md` for the fuller explanation, written so
this doesn't get rediscovered the hard way later.

**Real walk-cycle data, replacing the round-4 patch's guesswork.**
`world-walk.vrma` is a cycle played *in place* (zero baked translation);
its `world.json` entry records a *measured* speed (1.421 m/s) on a
reference rig with hips at 1.0167 m, meant to be scaled by
`vrm.humanoid.normalizedRestPose.hips.position[1] / 1.0167` for any other
model -- exactly the API `world.json` itself cites. `CharacterController`
now computes that real per-model speed once at construction, instead of
the flat guessed constant round 4 was still using (round 4 only fixed
*that* guess decelerating consistently with the animation; this replaces
the guess itself with a measured number). These numbers are hand-copied
into `sandbox.ts` as named constants citing their `world.json` origin,
not read from that file at runtime -- a deliberate scope cut this round
(see "Deferred" below), not an oversight.

**Phase-locked start/stop, not just a faster loop.** `world-walk-start`'s
last frame is authored to match `world-walk`'s pose 0.2s into the cycle,
not at t=0 -- entering anywhere else pops by up to 81cm at the reference
rig, per the pack's own measurement. The mirror image: every stop clip's
first frame matches the loop's pose at its cycle seam (t=0/t=duration),
with up to 46cm of pop if entered elsewhere. `CharacterController` now
runs a five-state machine (`none -> starting -> looping -> arriving ->
stopping -> none`) to honor both contracts: `starting` plays the wind-up
once and enters the loop at exactly t=0.2s; when `WanderController`
declares arrival (target goes `null`), the new `arriving` state doesn't
cut the stride short -- it keeps walking the same direction, watching
`world-walk`'s own `time % 1.0` against a `[0.967, 0.033]` tolerance
window (wrapping across the seam), and only then plays a stop clip. Which
stop: four "long stop" variants picked at random for a walk that covered
real ground, or a dedicated small-stop clip if the bout covered under 1m
(mirroring the pack's own long-vs-small distinction, which the source
player draws on momentum/speed -- our only gait never reaches its 2.2 m/s
threshold, so distance covered is the stand-in signal here instead).
**Known, accepted simplification:** she doesn't cover any *remaining*
distance-to-target during the stop clip itself (no data for that), so
she can land up to about one arrival-radius short/long of the exact wander
point -- invisible in practice given `ARRIVE_RADIUS_M` is already 8cm and
the room is 9m across, but worth stating rather than implying frame-perfect
foot-planting throughout.

**Idle variety, both the "during idles" and "during dialogues" halves of
the ask.** She now stands in a real looping idle pose instead of a walk
clip frozen at `timeScale=0` (round 3/4's placeholder) -- drawn randomly
from five variants (`idle`/`idle-2/3/4/7`) and redrawn every 10-30s if
she stays put that long, the same cadence the source pack's own player
uses. A second pool (`idle-talking` + four numbered variants) plays
instead, on a faster 7-12s redraw, whenever `hud.isTurnActive()` is true
-- giving a reply-in-progress a visibly different idle than plain
silence, which is exactly the "during dialogues, idles" distinction the
user pointed at in Genshin/MiSide. `idle-5`/`idle-6` are missing from both
pools on purpose (the source pack repurposed them as `world-idle-alt1/2`,
a different standing stance -- not wired up this round, see "Deferred").

**Emotion gestures swapped to the pack's fitted family.** `happy`→
`happy.vrma`, `sad`→`sad.vrma`, `angry`→`angry.vrma`, `teasing`→
`relaxed.vrma` (closest available role) now play the pack's own clips,
each measured to land within 10cm of idle/idle-talking before it shipped
-- replacing round 3's untested placeholders for those four. `surprised`
keeps the user's own `Surprised.vrma`: the pack has no surprised clip at
all (documented gap in its own `NOTICE.md`), same as it has no "teasing"
role either. Per-gesture hold time (how long she holds the final pose
before fading back to idle) is now two-tiered: 0.3s for the pack's
measured-fit clips, versus the 1.4s round 4 gave the user's own untested
ones to let a reaction visibly land before dissolving -- no longer
appropriate to apply that same long pause to clips already proven to
land close to idle. `happy-2/3/6` and `angry-2` (extra variants the pack
ships for those two emotions) are copied into the repo but not wired up
to anything yet -- a natural, low-risk follow-up (random pick among
variants, same pattern idle variety already uses) once this round's core
plumbing is confirmed working.

**Deferred, explicitly, not silently:** reading `world.json`/
`transitions.json` at runtime instead of hand-copied constants (more
maintainable long-term, meaningfully more plumbing now); `world-turn-left/
right` (in-place rotation clips -- facing still just interpolates smoothly
as before); `world-idle-alt1/2` (a second standing stance with its own
enter/exit clips); the seated domain (no chair in the sandbox yet);
`nod`/`shake`/`raise-hand`/`think` (loaded, unwired -- no click/agree/
disagree signal in the protocol to drive them from yet); `world-afk-texting`,
`world-clap-*`, `world-jog*`, `world-point-*`, `world-run-*` and the rest
of the world-domain clips visible in the repo now but not referenced by
any code path. All of these are sitting in the repo already (see the file
list `git log` will show), so wiring any one of them up later is a
follow-up round, not another asset hunt.

**Verified in this sandbox:** `tsc --noEmit` clean; `npm run build`
(shell) and a standalone `sandbox.html` build both produce clean
bundles; the case-collision check was run directly against the actual
committed filenames (not assumed). **Not verified:** everything visual,
same recurring caveat -- whether the phase-locked start/stop actually
reads seamlessly, whether five idle variants feel varied enough or too
samey, whether the emotion swap's timing (0.3s hold) feels too abrupt
compared to the old 1.4s, and whether `normalizedRestPose.hips` actually
returns a sane value for this specific VRM model are all pending a real
look on the user's machine.

## Round 6: wall clipping, "kinda awkward," and a walk-direction diagnostic

First real on-machine run of round 5 surfaced three more reports:
walking still looked wrong ("she still walks like this," a screenshot of
mid-stride), she now collides through walls, and the whole thing reads
"kinda awkward." Two of these had a real, provable cause found by
re-reading the round-5 logic; the third did not, after real effort, and
is handled differently below rather than papered over with another
guess.

**Wall clipping -- a real, provable bug in round 5's own design, not
anything the walk-cycle pack did wrong.** The "arriving" phase
deliberately keeps walking for up to a full gait cycle past
`WanderController`'s own arrival point, so the stop clip can start
exactly on `world-walk`'s seam (see round 5's phase-contract writeup
above). But a wander target can legally sit as close as
`WANDER_MARGIN_M` (0.5m) from a wall, and that grace stride can cover up
to roughly `walkSpeedMps * WORLD_WALK_LOOP_DURATION_S` (~1.4m) in the
worst case -- nothing was stopping that extra distance from carrying her
straight through a wall. Fixed with a second, unconditional layer rather
than trying to make the phase-timing logic itself aware of room bounds:
`stepAlong()` (used by both the real-walk and fallback paths) now hard-
clamps her position to stay `WALL_CLEARANCE_M` (0.3m) inside
`ROOM_HALF_SIZE`, regardless of any animation-timing subtlety, present or
future.

**"Kinda awkward" -- one concrete, defensible cause found, applied; one
suspected but not applied.** Found: facing only ever updated inside
`stepAlong()`, which is never called during the "starting" wind-up phase
-- so if a new wander target landed in a very different direction from
wherever she last faced, she'd play the whole 0.4s wind-up still facing
the old way and then visibly snap to the new facing the instant the loop
began. Fixed by turning toward the target during "starting" too (in
place, no translation, matching `world-walk-start`'s own documented zero
net translation). Suspected but genuinely just a judgment call, not a
bug: `TURN_RATE_RAD_S` was 10 (a ~0.3s full about-face, functionally
instant) -- fine next to the old crude procedural sway, but a real
authored walk cycle makes an instant snap-turn read as more jarring by
contrast. Turned down to 4 (~0.8s for a full about-face). Flagged
explicitly as a reasoned guess, not a measurement, since there's no way
to confirm the "why" here (only the wall-clipping math is provable) --
if it now reads as too slow/sluggish instead, that's the number to
revisit.

**"Still walks backward" -- re-derived the facing math twice, found
nothing, shipped a diagnostic instead of a third guess.** The
`atan2(-dir.x, -dir.z)` facing formula has been unchanged since before
round 3 (this predates every round in this doc). Re-derived by hand
against three.js's actual Y-axis rotation matrix convention, twice, on
the assumption that `VRMUtils.rotateVRM0()` leaves local forward at -Z
(the three.js/VRM1 convention) -- both derivations land on the same
formula already in the code, so no error was found in *this* codebase's
own math through static analysis alone. Rather than ship a fourth guess
with no better basis than the last three, `CharacterController` gained a
temporary `debugFacingTravelText` getter: it compares `facing` (what the
formula computed and actually applied) against the direction she
*literally* moved that frame, computed independently straight from the
raw position delta using the exact same `atan2` convention -- so a
correctly-behaving frame reports two matching numbers, a facing-inversion
bug reports numbers ~180° apart, and anything else (e.g. ~90° apart)
points at a different axis mixup entirely. Rendered as a small on-screen
readout (bottom-left, green monospace, clearly labeled `[debug]`) only
while she's actually translating. **This is deliberately temporary** --
remove the getter and its boot()-side readout once the actual numbers
are back and the real bug (if any is left after this) is found.

**"Light the box up."** The walls/floor are specified near-white
(`0xf5f5f7`/`0xefeff2`) but were reading as flat medium gray in every
screenshot so far -- the key light and hemisphere light's intensities
were deliberately turned down in round 2 specifically to stop MToon's
toon-shading from washing out the jacket into a flat gray sheen (see
that entry). Simply turning those same lights back up would brighten the
room but risks reintroducing exactly that character artifact. Used
three.js layers instead of fighting that tradeoff: a new
`ROOM_LIGHT_LAYER` is enabled on the floor/walls/ceiling/grid only (never
on the character, added separately on the default layer in `boot()`),
and a new, brighter `HemisphereLight` is scoped to only that layer
(`light.layers.set(...)`) -- so it can only ever brighten room geometry,
never the character, regardless of how its own intensity is tuned later.
Untested visually like everything else in this entry, but logically
sound regardless: the layer scoping is what makes it safe, not the
specific intensity chosen.

**Orchestrator not resetting on Ctrl+C ("orchestrator.log showed old
data").** Real, diagnosable bug, not a guess: the user's own terminal
log shows `cargo run`'s `luna.exe` dying with
`STATUS_CONTROL_C_EXIT` on Ctrl+C -- Windows' raw console Ctrl+C signal
tears down the Tauri parent process directly, *before* any of Tauri's
own event handlers run. `graceful_shutdown_then_kill()` in
`src-tauri/src/lib.rs` (see this doc's Phase-3 entry on it) only ever
fires from a tray-Quit click or a window-close event -- neither of which
a terminal Ctrl+C is. The orchestrator child process spawned underneath
is left running, orphaned, still bound to port 8765, with whatever
history it already had -- so the next launch either fails to bind the
port, or -- what actually happened -- silently succeeds while the
frontend keeps talking to the same stale orphan the entire time. Also
separately confirmed from the user's own log: `npm run sandbox` never
started the orchestrator at all (`vite --open /sandbox.html`, nothing
else) -- so testing sandbox-only, before ever running `tauri dev`,
predictably found no orchestrator running and a stale log file.

Fixed at the orchestrator level rather than the Rust/Windows level --
reliably intercepting a raw console Ctrl+C (as opposed to a window/tray
event) is real, fiddly, hard-to-verify-without-a-Windows-machine
territory, unlike everything else in `lib.rs` (which was at least
checkable against Tauri's own documented event model). A PID-file
takeover in `orchestrator/app.py`'s `__main__` block is portable and
actually testable without any of that: on every start, it checks
`logs/orchestrator.pid` for a still-alive PID left over from a previous
run and kills it first (`taskkill /PID ... /F` on Windows,
`os.kill(..., SIGTERM)` elsewhere) before writing its own PID and
binding the port -- so a fresh `python app.py` always ends up as the
sole orchestrator, however it's launched (Tauri's child spawn, a manual
terminal, or the new sandbox launcher below) and however the previous
one died. **Actually verified in this sandbox**, not just read for
syntax: simulated a stale orphaned process (a real backgrounded Python
process with its own PID file), ran the takeover function against it,
and confirmed the stale process was actually killed and the PID file
correctly updated -- this is the one piece of this whole entry that's
more than "logically sound but unverified."

Separately, `scripts/dev-sandbox.mjs` (new) plus `package.json`'s
`sandbox` script now spawning it instead of bare `vite --open
/sandbox.html`: launches vite and the orchestrator together, tears both
down on Ctrl+C or if either exits on its own, so sandbox-only testing no
longer needs a manually-run third terminal. Actually run in this
sandbox too (not just read): started it, confirmed vite came up,
confirmed the venv-not-found warning prints and vite still starts anyway
when there's no orchestrator venv (this sandbox's own state), sent it a
real SIGINT, and confirmed with `pgrep` afterward that nothing was left
running. GPT-SoVITS is deliberately not spawned by this script -- it's
already a separate, heavier server `lib.rs` starts once for the whole
app, and `tts.py` already falls back to pyttsx3 automatically if it's
unreachable, so sandbox-only testing works without it, just with a
lower-quality voice.

**Verified in this sandbox:** `tsc --noEmit` clean; shell + standalone
`sandbox.html` builds both clean; the pidfile takeover was actually
exercised against a simulated stale process, not just read; the sandbox
launcher was actually run and SIGINT-tested, not just read. **Not
verified:** the wall-clamp and turn-rate/facing-during-start changes are
logically sound (the same "no GPU/browser" caveat as ever), but whether
they're the *whole* story behind "kinda awkward" isn't something static
analysis can settle -- and the persistent facing/direction complaint is
explicitly unresolved pending the debug readout's actual numbers from a
real run.

## Round 7 (planning only, full apartment) — renumbered from a parallel session

The user ran a separate planning conversation in parallel with this
one's round 5 build work, against the same round-4 base -- both
sessions independently landed on "round 5" for unrelated things (that
session never touched any code, purely `docs/ROADMAP.md`/
`docs/DECISIONS.md`). Reconciled here by keeping round 5 as this
session's already-shipped VRMA pack work and renumbering the apartment
planning to round 7, after this doc's own round 6 (immediately above).
The content below is that other session's planning work, carried over
as-is aside from the renumbering and this note -- nothing in it has been
independently re-verified by this session.

Planning-only entry (see `docs/ROADMAP.md`'s round-7 note) covering two
decisions made before any of this is built.

**Room geometry: CC0 asset-pack assembly, not hand-modeled in
Blender.** The user is a Blender layman and asked whether this sandbox
could just "build one" via a Blender connector -- checked the MCP
registry, no real Blender connector exists (only unrelated matches like
Render/BioRender came back). Even if one did, freehand modeling and
lighting a five-room apartment is a visual-iteration task -- you place
something, look at the render, adjust, repeat -- and this sandbox has no
GPU/browser to render-check against, the same "not verified visually"
caveat that already applies to every rendering change in this doc, just
sharper here because there'd be *nothing* to compare a first attempt
against. Assembling pre-made low-poly furniture (Kenney-style CC0 packs)
into the room layouts sidesteps that: the modeling and material/lighting
judgment is already done by the pack's artist, the remaining work is
arrangement, which is far more tolerant of being done blind and easy for
the user to eyeball-correct on their own machine afterward. Explicitly
not reproducing MiSide's actual room/assets -- the reference image is a
ChatGPT-generated moodboard, not an extractable asset, and the user
flagged it as inspiration only, not a source to copy.

**Why first-person camera isn't how she "knows" the room.** A camera
parented to a head bone is cheap in three.js and worth having as a
spectator/debug view, but it was *not* picked as the channel her
situational awareness runs through, for two reasons. First, cost/latency:
even though `qwen3.5:9b` is natively multimodal (`docs/MODELS.md`),
feeding it a rendered frame on every turn means a vision call in the hot
path of every response, on hardware already tight on VRAM
(`docs/MODELS.md`'s GPU/VRAM section). Second, reliability: a 9B model's
spatial/geometric reasoning from a single 2D frame is shallow --
fine for "there's a couch in view," not trustworthy for "which anchor
point is she closest to" or path-planning, which need to stay
deterministic app code (the navmesh/anchor system in the round-7 plan),
not something inferred from a picture. Decision: a small structured
text scene-state block (current room, current anchor/activity) pushed
into `persona.py`'s context is the primary awareness path -- same
"cheap deterministic app state over an LLM call" reasoning already used
for cursor reactions and the driver/observer surface handoff. Occasional
vision calls stay available for later, non-blocking uses (e.g.
Task Guide Mode's screenshot checks), just not as the default way she
finds out where she is.

**Also worth flagging while this was being planned: `qwen3.5:9b`'s
actual limits**, since the user asked directly. It's a 9B model at
Q4_K_M (~6.6GB VRAM per `docs/MODELS.md`) sharing a 12GB card with
GPT-SoVITS and, during Task Guide Mode, whatever game is running --
there's a real ceiling on how much can be kept loaded and resident at
once, not just a context-length number. Context budget itself is also
already partially spent before any scene-state addition:
`orchestrator/config.yaml`'s `num_history_turns` caps how many past
turns ride along, and the persona prompt, memory recall, and (now)
scene-state all compete for the same window. It's a hybrid-thinking
model with its reasoning phase deliberately forced off
(`llm.think: false`, see this doc's earlier `think`-flag entry) because
the plain OpenAI-compatible endpoint couldn't be trusted to suppress it
reliably. None of this blocks the room-state plan -- the text
scene-state block is small and cheap -- but it's the reason precise
spatial math (navmesh containment, anchor selection, path-planning)
should stay in deterministic app code rather than being handed to the
model to reason about, same principle as the trivial cursor-event
handling from Phase 0/M2.

**Verified:** none of this -- planning-only entry, nothing built yet.

## Round 6 result: direction confirmed correct, not a facing bug

The user ran round 6's diagnostic and reported back real numbers:
`facing 417°` (= 57° mod 360) vs `travel 58°` -- a 1° difference, i.e.
these already match. **This settles it: the facing formula is not
inverted, and was never the bug.** The user's own read of the situation
("flip it or smth") would have introduced a real, confirmed-wrong
inversion into code that's currently correct -- declined for that
reason, with the numbers to back it up, rather than complying just
because it was asked.

Since direction is ruled out, "moonwalk" must be a foot-plant/gait
quality problem instead -- a fundamentally different, more specific
class of bug (something making a foot look like it's sliding along the
ground rather than lifting and resetting between steps), independent of
which way she's actually heading. A single screenshot can't show this at
all -- sliding is inherently a *time-based* artifact, not something a
still frame captures, which is part of why three rounds of guessing
based on screenshots alone hasn't landed on it.

Added a second temporary diagnostic, `debugFootTraceText`: samples both
foot bones' real world-space height directly (`vrm.humanoid.getRawBoneNode`,
not anything retargeted or computed) once a frame, sampled *after*
`mixer.update()` so it reflects the actually-applied pose, and reports
each foot's min/max height range roughly every 1.5s. A healthy stride
should show both feet regularly sweeping through a real range as they
alternate planting/lifting; a foot stuck at a near-zero range for a
stretch is direct, numeric evidence it's dragging rather than lifting --
this is the next real lead, not another guess. Rendered as a second
on-screen line, same style as the first.

**Verified in this sandbox:** `tsc --noEmit` clean; both builds clean.
**Not verified:** everything about the actual gait quality -- this
entry adds a way to *measure* the problem, it doesn't yet claim to have
found or fixed it.

## Round 6, third attempt: the diagnostic's blind spot, and an experimental facing flip

The user ran both diagnostics: `facing 445°` (=85° mod 360) vs
`travel 85°` (matching, same as the first run), and both feet showing
healthy lift ranges (0.099m and 0.126m, both well above the ~0.02m
"dragging" floor). **Both diagnostics came back clean, and she's still
visibly sliding backward.** The user's own read of this: the
diagnostic itself has a blind spot, and it does.

They're right. `debugFacingTravelText` checks whether `facing` and
`travel` agree *with each other*, both computed through the same
assumed "-Z is forward" convention `updateFacing()` was built on. If
that whole convention is backward for this model, both sides of the
comparison shift by the same 180° and *still agree* -- the diagnostic
proves internal self-consistency, not correctness against the actual
rendered orientation. It was never capable of catching this specific
class of bug, and continuing to point at "the numbers match" would have
kept missing it.

Since there's no way to check the real rendered orientation from this
sandbox (no GPU/browser, the recurring caveat), and the two clean
diagnostic results have exhausted what static/self-referential checking
can offer here, the user proposed the obvious next experiment: flip the
convention and confirm by eye, since it's a one-line, trivially
revertible change. Implemented as `directionToFacingAngle(x, z)`, a
single shared function (`Math.atan2(x, z)`, dropping the negation
`Math.atan2(-x, -z)` had) that both `updateFacing()` and
`debugFacingTravelText`'s travel computation now go through -- routing
both through one function means there's only one sign to flip back if
this guess is wrong, and the diagnostic still checks out as
self-consistent afterward (same blind spot as before, now just
confirming the flip didn't introduce a *new* mismatch on top of the
old, unprovable-from-here one).

**If this makes it worse, not better:** `git restore` (or `git checkout
--`) `src/sandbox.ts` back to commit `16bbf59` (the previous commit,
before this flip) undoes just this change, keeping everything else from
rounds 5/6.

**Verified in this sandbox:** `tsc --noEmit` clean; both builds clean.
**Not verified, by design this time:** whether the flip actually looks
right -- that's exactly the one thing this sandbox cannot check, which
is the whole reason this is framed as an experiment for the user to
confirm by eye rather than another confident claim of a fix.

## Round 6, fourth attempt: the flip didn't work, confirmed with real video evidence, one layer deeper

The user reported the facing flip made no visible difference and sent an
actual screen recording. Extracted frames from it (`ffmpeg`, available in
this sandbox) rather than taking the report on faith -- and independently
confirmed the bug from a segment where the camera is provably static
(matched wall-corner positions across four frames spanning ~3.75s at the
very start of the recording): she visibly grows larger/closer in frame
over that span while her back stays to the camera in both the first and
last frame. She is moving toward the camera while facing away from it --
real backward walking, confirmed against a fixed reference, not
guessed. This also confirms the round-6-third-attempt flip genuinely had
no effect, not just that it "felt" unchanged.

That non-result is itself informative: the flip only changes
`vrm.scene.rotation.y`, the outermost transform in the chain. If flipping
the *outermost* rotation changed nothing about which way she visually
faces, the actual visual-orientation bug isn't at that layer -- something
further down the chain (most likely the retargeted animation clip itself
applying its own rotation to the hips bone) is what's actually
determining her visible orientation, and it doesn't care what the scene
node above it is set to.

Added a third temporary diagnostic to check exactly that:
`debugHipsWorldFacingText` reads the hips bone's actual *composed* world
orientation (`getWorldQuaternion` -- scene rotation and whatever the
animation clip itself contributes, together, i.e. what the render
actually ends up showing) and compares it to the scene-level `facing`
value the other two diagnostics already track. Also fixed a latent
correctness bug this surfaced: `mixer.update()` only writes each bone's
*local* transform from its animation track -- the *world* transform
`getWorldPosition`/`getWorldQuaternion` actually read isn't refreshed
until something calls `updateMatrixWorld()`, which normally only happens
inside the renderer's own render-time traversal. Without an explicit
call, both this new diagnostic and the existing foot-trace one would
have been silently reading last frame's pose. Fixed with one explicit
`vrm.scene.updateMatrixWorld(true)` right after `mixer.update()`, before
either diagnostic samples anything.

If `debugHipsWorldFacingText` shows the hips bone's world-forward roughly
matching scene `facing` (both already known to match `travel`), that
would mean all three agree yet she still visually walks backward --
pointing at something beyond even this class of bug (e.g. genuinely
wrong retargeting output, or a coordinate-space mismatch in
`createVRMAnimationClip` itself). If it shows the hips bone's world-
forward roughly 180° from scene `facing`, that directly identifies the
animation clip as the source, and the fix becomes compensating for that
offset (or investigating why the retargeted clip carries it) rather than
touching `updateFacing()` again.

**Verified in this sandbox:** `tsc --noEmit` clean; both builds clean;
frames from the user's actual video were extracted and inspected
directly (`ffmpeg`), not just read about -- this is the first entry in
this whole saga backed by real visual evidence rather than either a
guess or a self-referential diagnostic. **Not verified:** what
`debugHipsWorldFacingText` will actually report -- that's the next real
data point, from the user's machine, not this sandbox.

## Round 6, resolved: the flip was never actually tested until now -- and it was the fix

Before applying the hips-diagnostic bundle, the user checked their own
`git log` and found their `round6-fixes` branch was still at the
foot-trace commit -- the facing-flip commit had never actually landed.
The apply instructions for that bundle were correct, but somewhere
between being given them and recording the video, the fetch/checkout
never happened (or didn't take). This means the video analyzed in the
previous entry, and the conclusion drawn from it ("the flip had no
effect, so the bug must be deeper than vrm.scene.rotation.y"), was built
on a false premise -- the user was recording the *original, unflipped*
code both times. The video itself was still real, useful evidence (it
independently confirmed backward walking against a static-camera
reference), but the inference about *why* the flip didn't help was
wrong, because the flip had never run.

Rebuilding the bundle was simple and didn't require touching history:
the user's actual tip (`16bbf59`) was already the direct parent of both
the flip commit and the hips-diagnostic commit in this session's own
history, so a fresh bundle spanning `16bbf59..round6-fixes` carried both
commits' full content while only requiring the one commit the user
actually had -- no rebase, no reset, nothing rewritten.

With the flip actually applied for the first time, the user confirmed:
**she now walks forward.** The `directionToFacingAngle` flip (dropping
the negation in the old `atan2(-x, -z)` formula) was the real fix all
along -- round 6's earlier diagnostics weren't wrong about what they
measured, they just couldn't measure the one thing (whether the
assumed forward-axis convention matched this specific model's actual
rendered orientation) that turned out to be broken, exactly the blind
spot identified when the user first proposed the flip.

**Diagnostics removed** now that the bug is confirmed fixed:
`debugFacingTravelText`, `debugFootTraceText`, `debugHipsWorldFacingText`
and their boot()-side on-screen readouts, plus the fields/methods that
only existed to support them (`leftFootBone`/`rightFootBone`/`hipsBone`
references, `updateFootTrace()`, the forced `updateMatrixWorld()` call
that only mattered for those diagnostics' own accuracy). The actual fix
-- `directionToFacingAngle()` -- stays, with its comment updated to
describe it as confirmed correct rather than an open experiment.

**Full trail, for the record, since this took four attempts across two
rounds to actually land:** round 4 fixed a real speed/animation
mismatch that wasn't the whole story; round 5 replaced a guessed walk
speed with the pack's real measured data, still not the whole story;
round 6 first tried a facing-formula re-derivation (found no error,
correctly, since the error wasn't in the math but in an unverified
assumption about this model), then a wall-clamp and start-phase facing
fix (both real, both still valid), then a diagnostic-driven flip
proposed by the user that turned out to be exactly right -- just not
confirmed until the user independently caught that it had never
actually been deployed. The lesson worth keeping, not just the fix
itself: a diagnostic that checks a value against itself can look clean
while completely missing a bug in the shared assumption both sides of
the check were built on -- confirmed by comparing against something
external (the user's own eyes, this time) is what actually closed it
out.

**Verified in this sandbox:** `tsc --noEmit` clean; both builds clean.
**Confirmed on the user's real machine:** she walks forward now. This
entry closes out the "walks backward"/"moonwalk" saga that ran across
rounds 4-6.

## Round 6 closed; apartment build paused; Phase 4 picked as next priority

The user confirmed on-machine that round 6's remaining tuning (wall
clamp, walk-start facing, turn rate, idle-variety gestures) all read
correctly in motion, on top of the already-resolved walk-direction
fix — round 6 is fully closed. Round 7 (the full apartment) is paused,
not cancelled: the interaction half (sit/cook/read/sleep/bathe/
watch-TV/play-game poses) needs animation clips the user is deferring
buying, and doing just the room-geometry half now would front-load
real asset-sourcing/placement effort for a payoff that's blocked on
that future purchase. Full reasoning, and the shell-polish alternative
that was weighed against it (UI theme, shell hide toggle, on-demand
vision+OCR), is in `docs/ROADMAP.md`'s "Shell-polish vs.
apartment-build" section.

One item from that discussion is flagged rather than adopted outright:
giving Luna a Playwright-driven cursor to actually operate the mouse
would reverse `CLAUDE.md`'s own non-negotiable "observe-and-advise
only" constraint, not just add a feature on top of it. Not built,
pending explicit confirmation that real input control is actually the
intent — versus a non-interactive on-screen pointer/highlight, which
wouldn't touch that constraint at all and could be built either way.

**Decision:** Phase 4 (vision tools + Task Guide Mode) picked as the
next build — it's the one item on the shell-polish list that isn't
pure polish, and it's the project's own stated flagship behavior
(`CLAUDE.md`), not started at all yet. Phase 9 (UI overhaul) and the
shell hide toggle are smaller and lower-risk, and can go before or
alongside it.

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

## Round 6, fully closed: wall-clamp and turn-rate confirmed fine too

Separate from the direction fix above, round 6 also shipped a hard wall
clamp and a slower turn rate (`TURN_RATE_RAD_S` 10 → 4) as reasoned-but-
unverified tuning changes -- see this doc's earlier round-6 entry. The
user has now confirmed, plainly, that walking reads as fixed on their
real machine, closing the one item that entry left open. Nothing in the
code changed for this note; it's here so `docs/ROADMAP.md`'s "still
open" list doesn't keep carrying an item that's actually done.

## Round 7 -> Round 8: the apartment render itself shows up

Round 7 (above) was planning only. The user then supplied an actual
built asset -- a single self-contained HTML file, `THREE.js` r128 loaded
from a CDN `<script>` tag, procedurally building a four-room apartment
(kitchen, living/dining, bedroom, bathroom) in a pastel "dollhouse"
style with day/noon/evening/night lighting presets and its own
orbit-style pointer camera. Instruction was explicit and narrow: get it
into the project and reachable, don't touch the apartment's own code --
the room/furniture layout is expected to change before anyone spends
time tuning it.

**Landed as a standalone static page, not merged into `sandbox.ts`'s
scene.** Copied verbatim to `public/apartment/index.html` (confirmed
Vite's dev server resolves `/apartment/` to it, `200` on both
`/apartment/` and `/apartment/index.html`, checked directly against a
running `vite` instance in this sandbox, not assumed) and linked from
the sandbox's own info panel (`sandbox.html`'s `#sandbox-apartment-link`,
opens in a new tab). Three reasons this stayed a link rather than an
import into `sandbox.ts`:

1. **API mismatch.** The file uses Three.js r128's global-script API
   (`renderer.outputEncoding = THREE.sRGBEncoding`, among others) --
   this project's own `three` dependency is `^0.185.1`, an ESM import
   where `outputEncoding`/`sRGBEncoding` were removed years ago in favor
   of `outputColorSpace`/`SRGBColorSpace`. Importing the file's script
   as-is into the Vite/TS pipeline wouldn't compile against the
   project's `three`; running it because of its own CDN `<script>` tag
   means it's really a second, independent Three.js instance on the
   page, not a module sharing state with `sandbox.ts`'s.
2. **Two renderers, two animate loops, one canvas budget.** The
   apartment file owns its own `<canvas>`, `WebGLRenderer`, camera, and
   `requestAnimationFrame` loop, entirely separate from `sandbox.ts`'s.
   Actually merging the geometry into the character's own scene means
   porting the room-building functions (not the renderer/camera/input
   scaffolding around them) into `buildStudio()`'s territory -- real
   work, not a copy-paste.
3. **The instruction itself.** "Just put it there, we edit the
   apartment itself later" -- spending effort reconciling render
   pipelines before the room layout is even settled would be solving a
   problem that's about to change shape anyway.

**What this sets up for later** (step 1 of the round-7 plan, done as a
drop-in rather than a from-scratch Blender build since a finished asset
already existed): once the apartment's own layout is settled, the actual
integration work is (a) porting its room/furniture-building code into
the modern `three` API and into a scene the VRM character also lives in,
replacing `buildStudio()`'s plain box; (b) the per-room navmesh replacing
`WanderController`'s free-roam bounding box; (c) named sit/cook/read
anchors; (d) the scene-state channel to `persona.py`. None of that is
started -- this round is purely "it exists in the repo and you can look
at it."

**Verified in this sandbox:** the file has zero external asset
dependencies beyond a CDN script tag and Google Fonts link (checked by
grep -- no relative `src=`/texture/GLTF loads to break by moving it), so
copying it verbatim was safe; Vite actually served it correctly at
`/apartment/` from a real running dev server, not assumed from reading
Vite's docs; `tsc --noEmit` clean; `vite build` (the shell's production
build) still succeeds and copies `public/apartment/` into `dist/`
unchanged, confirmed by listing `dist/` after a real build; `sandbox.html`
still serves correctly with the new link markup, checked against the
same running dev server. **Not verified:** anything about how the
apartment actually looks or performs -- no GPU/browser in this sandbox,
the same recurring caveat, though for once that caveat barely matters
yet: nothing about its rendering was touched, only its location in the
repo.

**Scope note for this round:** a second, parallel session is working on
the shell/UI (`index.html`/`src/main.ts`/`src/style.css`) at the same
time. Everything above touched only sandbox-side files
(`sandbox.html`, `src/sandbox.css`) plus a new `public/apartment/`
asset and these docs -- same isolation discipline as Phase 10 round 2's
original shell/sandbox split.

## Round 9: the apartment becomes the real scene, not a linked page

Round 8's standalone page died almost immediately. The user's own
report: opened from inside the actual Tauri shell, the sandbox's
`target="_blank"` link didn't reach `/apartment/` at all -- it just
reopened the shell's own bound window, because Tauri's webview resolves
new-window requests against the app's configured window URL rather than
an arbitrary href. Splitting "the apartment" and "the character that's
supposed to live in it" into two pages that can't even both be open at
once was never going to work as an end state anyway; the instruction
this round was explicit and unambiguous: put the apartment *in* the
sandbox, for real, and remove the placeholder box outright.

### What moved

`public/apartment/index.html` is deleted. `src/apartment.ts` is new: the
same room-building logic, ported to an ESM module against this
project's own `three` (`^0.185.1`) instead of the r128 CDN global. It
exports `buildApartment(scene)`, returning `{ root, rooms, update,
setMode, initMode, currentMode }` -- no renderer, no camera, no input
handling, no animate loop of its own; `sandbox.ts`'s `boot()` owns all
of that and just calls `apartment.update(dt, elapsed)` once a frame.
`buildStudio()`, `ROOM_HALF_SIZE`/`ROOM_HEIGHT`, `ROOM_LIGHT_LAYER`, and
`roomFillLight` are all gone with the box they existed for.

The port itself was done mechanically rather than by hand-retyping
~1050 lines from memory of having read them: the original script was
sliced out of the uploaded HTML by exact line range, then a small Python
pass applied the same handful of substitutions everywhere they occurred
(`scene.add(` -> `root.add(`, the three encoding-API rename below,
adding TypeScript parameter types to the ~30 helper functions) rather
than retyping each call site, so anything *not* deliberately changed is
verified identical to the source rather than merely believed to be. The
one deliberate content change: `addBook()` was dropped -- defined in the
original but never actually called (confirmed by grep), and
`noUnusedLocals` would have rejected it as dead code if kept.

### Three porting issues that weren't obvious from the diff

**1. Scale.** The apartment is authored in what amount to dollhouse
units -- 6-unit ceilings, 5-unit doors, a 9-unit room depth -- roughly
2.4x life size. Every locomotion constant in `sandbox.ts`
(`FALLBACK_WALK_SPEED_MPS`, step length, `TURN_RATE_RAD_S`, arrival
radii) is tuned in metres for a 1.0-scale VRM. Two ways to close that
gap: scale the character up, or scale the room down. Scaled the room
down (`APARTMENT_SCALE = 2.5/6`, pinned to ceiling height, which is the
single cue most likely to give away a wrong scale once a person is
standing under it) rather than the character, because scaling a VRM up
is not obviously safe -- its spring-bone physics (hair, skirt) are
tuned against real gravity at 1.0 scale, and there was no way to check
in this sandbox whether scaling the mesh would also need re-tuning
`gravityPower`/`stiffness` on every spring bone to still look right.
Scaling the room is a single multiply with no such risk.

**2. Two three.js properties are world-space and do not inherit a
parent group's scale.** This was checked against the actual three.js
source under `node_modules/three/src`, not assumed from general
three.js knowledge, because getting it wrong would have silently broken
shadows or lamp falloff in a way that would only show up as "looks
subtly off" with no error:
  - `LightShadow.updateMatrices()` (`lights/LightShadow.js`) parents the
    shadow camera to nothing; it copies only the light's *world
    position* (`_lightPositionWorld.setFromMatrixPosition(light.matrixWorld)`)
    and aims it at the target's world position. The ortho frustum's
    `left/right/top/bottom/near/far` are set once, in the original
    dollhouse-unit values, and never get multiplied by the parent
    group's scale.
  - `WebGLLights.js` uses `light.distance` directly as a shader uniform
    (`uniforms.distance = distance`) while position comes from
    `matrixWorld`. Same story: the number, not a scaled derivative of
    it.
  Fixed in one place, `applyScaleFixups()`, run once after the whole
  tree exists: the shadow camera's six frustum fields and the two shadow
  bias fields (also world-space depth offsets) are multiplied by `S`,
  and every `PointLight` found via `root.traverse()` has `.distance`
  scaled the same way. `PointsMaterial.size` under `sizeAttenuation` is
  also a world-space diameter and got the same treatment for the
  sparkle motes.

**3. Point-light falloff changed shape between r128 and this three
version -- not just its default toggle, its actual curve.** r128's
non-physical lighting used a bounded falloff,
`(1 - d/cutoffDistance)^decay`, which is 1 at the bulb and a clean 0 at
`cutoffDistance` regardless of `decay`. Checked
`node_modules/three/src/renderers/shaders/ShaderChunk/lights_pars_begin.glsl.js`:
modern three's `getDistanceAttenuation()` is the physically-based
`1/max(d^decay, 0.01)`, separately windowed toward zero near
`cutoffDistance` but otherwise unbounded and equal to the old formula
only at `decay=0`. At the authored `decay=2` (every `PointLight` call in
the file), this is a materially different curve, not a units/intensity
mismatch fixable by a constant multiplier -- it blows up close to the
bulb and falls off much faster with distance, which reads as a small
hot spot surrounded by near-darkness rather than the gentle pool of
light the original was tuned to produce. There is also no
`legacyLights`/`physicallyCorrectLights` toggle left to fall back to --
grepped `WebGLRenderer.js` for both names, neither exists in this three
version, so this isn't a one-line opt-out. `applyScaleFixups()` sets
`decay = 0` on every point light, which restores the old *shape* of
falloff (bounded, roughly linear-ish, controlled by `distance` alone)
so the originally-authored intensity numbers stay meaningful instead of
needing to be re-tuned from scratch against an unfamiliar curve.
Reasoned from the shader source, not confirmed by eye -- no GPU here.

### The character's lighting, and why one piece of the old rig survived

`ROOM_LIGHT_LAYER`/`roomFillLight` are gone -- that whole mechanism
existed only to brighten the old box's near-white geometry without also
washing out the character's MToon shading, and a textured apartment with
its own four-mode lighting rig doesn't have a flat-grey-box problem to
solve. `scene.background` and `scene.fog` are no longer set in
`sandbox.ts` at all; `apartment.ts`'s lighting-mode system drives both
now (a `THREE.Fog` still has to exist on the scene *before*
`buildApartment()` runs, since `applyLiveState()` mutates an existing
fog rather than constructing one, so `boot()` creates a placeholder that
gets overwritten on the first `initMode('day')` call inside
`buildApartment()`).

One piece did survive, renamed `addCharacterFill()`: a low, fixed,
directionless `DirectionalLight` on the character specifically. Reason:
the apartment's own key light swings hard across its four modes, from
`(14,24,18)` at midday to `(-8,20,-10)` at night, and MToon's toon
shading reads its lit/shadow band split from light *direction* --
letting her banding swing with the room's mood lighting would make her
read as a differently-shaded character depending on the time of day,
which is a worse problem than a static room ever was. A low fixed fill
(`0.35`, well under the apartment's own `dirI` of `0.85-1.3`) keeps her
face legible in every mode without overpowering whichever mode is
active. This is the same "don't fight MToon's own shading with fill
light" lesson as the Phase 7 jacket artifact and the original
`roomFillLight` comment -- carried forward, not rediscovered, but not
independently re-confirmed against a real render either, for the same
reason neither of those was: no GPU/browser in this sandbox.

### The navmesh: rectangles, not a real polygon mesh

`WanderController` no longer picks a point in a square centered on the
origin. Round 7's plan (above) explicitly scoped a real per-room navmesh
as future work, suggesting "even a flat convex-hull check to start" --
this round built that starting version, not the real thing.

The design: `apartment.ts` exports a table of named axis-aligned
rectangles (`RoomRect`), each one a patch of floor confirmed clear of
furniture by reading coordinates out of the room-builder functions
(table sits in `ROOM_RECTS_LOCAL`, in the apartment's own dollhouse
units, converted to world metres by the same `apartmentToWorld()` used
for the spawn point and camera target). `sandbox.ts` gets two new
classes: `WalkableArea`, a last-resort position clamp that snaps a point
to the nearest rectangle only if it's inside none of them; and a
rewritten `WanderController` that picks a target either inside the room
she's currently considered to be in, or -- with `ROOM_CHANGE_CHANCE`
(0.35) probability per leg -- inside the *overlap* between her current
room and an adjacent one.

That overlap-targeting is the whole trick, and it's why this works
without pathfinding: a straight line between any two points inside one
convex rectangle stays inside that rectangle. So a leg either stays
entirely within the room she's in, or is aimed at a point that is, by
construction, inside *both* the current room and the destination room's
rectangles simultaneously. There is no leg that can cut a corner through
a wall, because there is no target that was ever picked outside the
rectangle the walk started in. Arriving at an overlap point makes the
new room "current" for the next leg, and the next leg can then range
over that whole room. The bathroom is the one genuinely walled-off room
in the apartment; its rectangle only overlaps `bedroom` through a
narrow `bath-door` rectangle sized to the actual doorway gap
(x 16, z 5.4-7.1), so she has to pass through that gap rather than
being able to aim anywhere near the dividing wall.

Kitchen/dining/lounge share one open-plan strip with no dividing walls
at all in the original geometry, so those four rectangles
(`corridor`/`kitchen`/`dining`/`lounge-run`/`lounge-tv`) are just
different clear patches of the same floor, deliberately overlapping
generously with each other -- there's no doorway to thread there, so
there was no reason to pinch those transitions down the way `bath-door`
is.

### Verification actually performed, in increasing order of how much it proves

This is the part worth reading closely, because "ported 1050 lines of
someone else's three.js scene with no GPU to look at it" is exactly the
kind of change where "compiles clean" and "is actually correct" can
diverge, and this project's whole documented history (rounds 4-6) is a
case study in diagnostics that checked a value against itself and
missed the real bug. Four different checks were run, each one closer to
the real thing than the last:

1. **`tsc --noEmit` and both production builds.** Necessary, proves
   nothing beyond types lining up and the module graph resolving.
   `sandbox.html` was bundled with an explicit one-off Vite config
   (`rollupOptions.input`) since the project's default `vite build` only
   covers `index.html`/the shell -- confirmed this by listing `dist/`
   after a normal build and seeing no `sandbox.html` in it, so a green
   `npx vite build` alone would NOT have caught a broken sandbox module
   graph.
2. **The rect table, parsed back out of the committed file (not a copy
   kept in a test) and checked for connectivity and containment.** A
   short Python script regexes `ROOM_RECTS_LOCAL` straight out of
   `src/apartment.ts`, builds the overlap graph between all eight
   rectangles, and confirms every rectangle is reachable from the one
   containing the spawn point via a breadth-first search over
   non-degenerate overlaps, plus that no rectangle escapes the
   apartment's outer shell or crosses the bedroom/bathroom wall (except
   `bath-door`, which is supposed to). Caught nothing this time, but
   would have caught an unreachable room immediately -- exactly the
   failure mode a purely visual read of the source can't easily catch
   by eye across an 8-rectangle table.
3. **`buildApartment()` actually executed, in Node, not just
   type-checked.** It never touches WebGL -- only the scene graph plus
   `document.createElement('canvas')` and a 2D context for its
   procedural textures, both stubbed. Bundled with esbuild
   (`--platform=neutral --external:three`) and run against real `three`
   from `node_modules`. This is the check that actually caught something
   real: a comment claiming world origin sits in "the living/dining
   room" was true geometrically but misleading in effect, since that
   exact point is where the coffee table sits and isn't itself
   walkable -- the code was already correct (spawn is pinned to a named
   rect, not origin), but the comment was corrected once the harness
   printed out which rectangle actually contains origin (none) and
   forced the question. Also confirmed by running it: mesh count (387),
   that every point light actually got `decay=0` and a scaled
   `distance`, that the shadow camera frustum was multiplied by `S` and
   not left at dollhouse-unit values, the built root's bounding box
   (~15.6 x 2.8 x 3.8m, floor at y~-0.08m -- consistent with a
   2.5m-ceiling conversion of the authored 6-unit height), and that
   switching modes and running 90 frames of `update()` doesn't throw and
   leaves `scene.fog.far` at a sane in-metres value rather than still a
   dollhouse-unit number or `NaN` from a bad lerp.
4. **The real `WalkableArea` and `WanderController` classes, extracted
   verbatim out of `sandbox.ts` by source-slicing (not reimplemented),
   run through a 40-simulated-minute wander** against the real rect
   table, with every step deliberately overshooting its target by 35% to
   stand in for the walk system's own documented "arriving" overshoot
   (the exact failure mode the old `ROOM_HALF_SIZE - WALL_CLEARANCE_M`
   clamp existed to catch). Zero frames landed off walkable floor across
   roughly 144,000 simulated ticks, and all eight rectangles -- including
   the bathroom, only reachable through its narrow doorway overlap --
   were visited at least once. This is the strongest check available
   without a GPU: it isn't a description of what the code should do,
   it's the actual shipped decision logic run for a long time against
   the actual shipped data and checked against the actual invariant the
   design depends on.

**Still not verified by any of the above, and unverifiable without a
GPU/browser:** whether the room actually looks right. The furniture
clearances in `ROOM_RECTS_LOCAL` were derived by reading coordinates out
of the builder functions and reasoning about what they imply, not by
looking at a render -- they're the kind of thing that's right until
proven otherwise by an actual screenshot, and were kept as a flat,
commented data table specifically so they're fast to nudge once there's
something to look at. Same caveat on the lighting: the scale/falloff
reasoning above is checked against the three.js source, which is a much
stronger form of "reasoned" than earlier rounds' guesses, but it is
still reasoning, not a screenshot.

### Camera and spawn

Character spawn moved from an implicit `(0,0,0)` (which happened to be
the old box's center) to an explicit `apartmentToWorld(2.5, 7.7)` --
roughly the middle of the lounge floor, a named point rather than an
assumption that origin is walkable (see the harness finding above: it
isn't). The contact-shadow decal, previously added once at a fixed
position and never updated -- silently correct only because both it and
the character defaulted to the same origin in the old room -- now tracks
`vrm.scene.position` every frame in `animate()`, since that coincidence
no longer holds and an unfixed decal would otherwise sit under the
coffee table while she's across the room. `FlyCamera`'s starting
position moved to a point at the open front edge of the apartment,
looking in; its far clip plane went from 60 to 80 to comfortably fit the
apartment's ~15m span.

### Scope note

A second, parallel session is working on the shell/UI
(`index.html`/`src/main.ts`/`src/style.css`) at the same time. Everything
this round touched stayed on the sandbox side: `sandbox.html`,
`src/sandbox.css`, `src/sandbox.ts`, the new `src/apartment.ts`, and
these docs. `public/apartment/` is deleted rather than left to go stale
now that `src/apartment.ts` is the canonical copy of this scene --
keeping both around was a guaranteed way to eventually edit one and
forget the other existed.

## Round 10: full rebuild -- new floor plan, real furniture, IBL/post pipeline, first-person mode, she's aware of the flat, and a navmesh verification pass that found two real bugs

The user's instructions this round were explicit and broad: the round-9
apartment was "kinda crappy," a "starting phase" -- small low-poly furniture,
dark unlit corners, particles that had drifted out of the building, doors
that don't open, and a layout she was stuck in one corner of rather than
walking through. The ask was to go "full throttle," clone the repo fresh to
get current state, and rebuild rather than patch. This entry covers what
changed and, in more detail than usual, the verification work -- because a
chunk of that verification actually caught real bugs before they shipped,
which is exactly the point of doing it.

### The repo was behind the user's own machine

Cloning fresh from GitHub landed at `a3ed637` -- round 6's tip. Rounds 8 and 9
existed only as local commits on the user's machine (applied from bundles)
and had never been pushed. The user's screenshots proved they were running
round 9 locally, so the git bundles from those rounds (kept from this
session's own output) were fetched into the fresh clone to reconstruct the
actual starting point before doing anything else. Worth flagging to the user
directly: GitHub is not a reliable source of "current state" for this
project as long as work only ever leaves this sandbox as a bundle.

### Structure: one file to four modules, plus two new top-level ones

`src/apartment.ts` (1555 lines, round 9) is deleted. `src/apartment/` is four
modules with a clear split of responsibility:
- `floorplan.ts` -- the entire building as data: room bounds, wall runs with
  their openings, the navmesh rectangle table, named anchors. No three.js
  import at all.
- `materials.ts` -- palette, canvas-generated textures (now 512-1024px with
  actual grain/grout/weave rather than flat fills), and the geometry
  primitives (`rbox`, `cyl`, `sph`, `torus`, `lathe`, `cushion`) everything
  else is built from.
- `shell.ts` -- turns the floor-plan data into walls with real punched
  openings (piers, lintels, reveals, architraves), glazed windows, skirting,
  and animated door leaves on pivots.
- `furniture.ts` -- the five rooms' worth of furniture, built entirely on the
  primitives from `materials.ts`.
- `index.ts` -- wires the above together, owns the lighting-mode state
  machine, the ambient dust motes, and the public `ApartmentHandle`.

Two new top-level modules: `src/postfx.ts` (the render pipeline) and
`src/camera-modes.ts` (spectator + first-person visitor, replacing the old
`FlyCamera` class that used to live inline in `sandbox.ts`).

### Floor plan: authored in metres, from scratch, not ported

Round 9's whole scale-conversion headache (dollhouse units, `APARTMENT_SCALE`,
manually re-scaling shadow frusta and point-light `distance` because they
don't inherit a parent group's transform) doesn't exist any more, because
this floor plan is authored directly in metres. There is no `apartmentToWorld()`
any more; a coordinate in `floorplan.ts` is already the coordinate the VRM
stands at.

The layout itself changed shape, not just scale: an L-ish plan around a
central hallway (living/dining and kitchen along the north side, bedroom and
bathroom along the south side, connected by a hallway with the front door on
its east end) rather than round 9's one-room-deep east-west strip. This
directly answers "it's not necessary we keep this long, horizontal layout."
Interior walls are genuine 3D geometry (`shell.ts`'s `WallDef`/`Opening`
system) with piers either side of every doorway, a lintel above, and an apron
below any window -- not a floor plan implied by furniture placement, which is
what round 9 actually was.

### Furniture: verified detail-level jump, not an assumed one

The user's specific complaint -- "just simple cubes," "small pellets in the
name of furniture" -- is a claim about `furniture.ts`'s previous use of bare
`box()`/`cyl()` calls with no secondary detail. This round's `materials.ts`
adds `rbox()` (a `RoundedBoxGeometry` wrapper, used for essentially all
furniture now) and `cushion()` (a rounded box with its top face pulled down
toward the centre via direct vertex manipulation, so upholstery has a visible
sag rather than being a flat-topped block). Every material family
(paint/wood/fabric/metal/ceramic) gets its own roughness/metalness pair,
which only actually shows up once IBL is providing something for those
different finishes to reflect (see below).

This is a claim worth actually checking rather than asserting, so it was
checked: `buildApartment()` was executed for real in Node (bundled with
esbuild, `--platform=neutral --external:three`, run against real `three`
from `node_modules`, with `document.createElement('canvas')` and a 2D
context stubbed -- no WebGL touched at any point, since scene-graph
construction and procedural-texture drawing don't need it) and the resulting
tree was walked and measured. Mesh count: round 9's 387 -> round 10's
**1173**. Triangle count: ~175,588. Both numbers came from actually
traversing the built `THREE.Group` and summing `geometry.attributes.position.count`,
not from estimating.

### Lighting and the post-processing pipeline -- and an honest answer on "ray traced"

The user asked by name for "actual ray traced stuff." That claim needs to be
addressed directly rather than glossed: real-time ray or path tracing is not
available in a browser WebGL2 context, and this machine also has to run a
VRM with spring-bone physics, an LLM bridge, and a TTS pipeline at the same
time as whatever renders the apartment. What *is* available, and what this
round actually built, is the set of screen-space approximations that most of
what people react to when they call a render "ray traced" actually comes
from:
- **Image-based lighting**: `THREE.PMREMGenerator` fed a `RoomEnvironment`
  (from `three/examples/jsm/environments/RoomEnvironment.js`), assigned to
  `scene.environment`. This is what makes the roughness/metalness
  differences in `materials.ts` visible at all -- under point lights alone,
  a matte-paint nightstand and a glazed-ceramic mug reflect nothing
  different; under IBL they do.
- **GTAO** (`GTAOPass`, ground-truth ambient occlusion) in the post chain
  (`postfx.ts`) -- contact darkening in corners, under furniture, where a
  wall meets a floor. This is arguably the single effect that most reads as
  "raytraced" to a casual viewer, because unoccluded ambient light is one of
  the most obviously-synthetic things about a naive real-time render.
- **ACES Filmic tone mapping** (`renderer.toneMapping`) with a mode-driven
  exposure, so window daylight and night lamps get a highlight rolloff
  instead of clipping to flat white/grey, which is what the "many dark
  spaces" complaint was largely about -- round 9's lighting was correct in
  intensity but had nowhere for bright values to go.
- **VSM shadows** (`THREE.VSMShadowMap`) for genuinely soft shadow edges
  rather than PCF's fixed-tap pattern, appropriate for an interior where
  every shadow is cast by a window or a lampshade, not a hard outdoor sun.
- **UnrealBloomPass**, strength driven by the active lighting mode (low by
  day, high at night so the lamps actually glow), and SMAA since the
  composer bypasses the renderer's own MSAA.
All of this sits behind a high/medium/low quality switch in the sandbox's
info panel (GTAO and SMAA both disable at lower tiers), because the combined
cost of VRM + spring bones + LLM/TTS + this pipeline on a shared card is real
and untested here.

Four lighting modes (dawn/day/dusk/night, `TimesOfDay` in `apartment/index.ts`)
replace round 9's carried-over day/noon/evening/night set, tuned for
physically-correct intensities from the start rather than migrated from an
r128-era non-physical scene, which sidesteps the entire falloff-curve
problem round 9 had to reason about after the fact.

### First-person visitor mode, spectator kept

`src/camera-modes.ts` is new. Spectator is the round-9 `FlyCamera` behaviour,
moved out of `sandbox.ts` into its own module (free-fly, no collision, WASD
+ Space/Shift + right-drag look, scroll for speed) and kept as the default,
per the explicit "keep the spectator mode" instruction. Visitor is new:
first-person, eye height, head bob scaled by actual speed, clamped to the
*same* `WalkableArea` Luna's own `WanderController` uses (so "we are stuck in
that plane" is literal -- the person and the character share one navmesh),
and slides along a wall on partial-axis collision rather than stopping dead,
which is the difference between a floor plan and a place that feels
inhabitable. Tab toggles between the two modes without needing the panel.

### She knows she's in the apartment

The user asked directly: "I also want Luna to be aware we are in her
apartment." This is the round-7 plan's point 4 (a text scene-state channel to
`persona.py`, explicitly chosen over a first-person camera feed back in that
planning round -- see this doc's earlier round-7 entry for why), left
unbuilt through round 9 and built now. `ws-client.ts` gets a
`sendSceneState()` method: fire-and-forget, never a turn, silently dropped if
the socket isn't open. `app.py` gets a module-level `_scene_state` string,
updated on receipt and spliced into `_run_turn()`'s memory-block list
alongside the existing ephemeral system-message injections -- deliberately
*not* added to `history`, for the same reason the memory blocks aren't: it
would go stale, repeat itself every subsequent turn, and get fed into
`consolidation.py` as though someone had said it out loud. `sandbox.ts`
computes and pushes this at most every two seconds and only on change (room,
nearest anchor, time of day, visitor presence/room), which is ambient
context, not telemetry -- a message every frame would be both useless and
wasteful.

### She looks at you

Not asked for by name -- offered as the "surprise, stick to the core idea"
the user invited. VRM ships a lookAt rig; `sandbox.ts` points
`vrm.lookAt.target` at a small tracking object whose position blends between
"a point ahead of her, in her walking direction" and "wherever the camera
currently is," gated on two things: distance (under ~5.5m) and a dot-product
check that she's roughly facing the camera already (not behind her). Without
that second gate she'd crane her head round to stare at a camera behind her,
which reads as unsettling rather than attentive -- the gate is what makes it
read as noticing you rather than tracking you.

### The navmesh: rewritten from 14 rectangles to 20, after a script found two real bugs

This is the part of this round most worth reading carefully, because it is a
case of verification actually doing its job rather than being a formality
after the fact.

The round-9 rectangle-union navmesh design is unchanged in principle (see
that round's entry): convex rectangles, a straight line inside one stays
inside it, a room change is a walk to a point in the *overlap* between two
rectangles. What changed is that this round's first draft of the rectangle
table was checked against the *actual placed coordinates* of every major
piece of furniture in `furniture.ts` -- computed by hand from each piece's
local geometry and its `put(group, x, y, z, rotation)` call, not eyeballed
from the room's general shape -- via a short Python script (kept in this
session's own working notes, not part of the shipped app). That script found
two real, shipped-if-unchecked bugs:

1. **The TV media console was sitting inside the open kitchen archway.** Its
   world position happened to fall at `z=3.0` on the `int-living-kitchen`
   partition wall, which has an archway opening from `z 1.4` to `z 3.9` --
   meaning the console was floating in the middle of an open wall gap with
   no wall behind it, and physically blocking the one wide passage between
   the living room and the kitchen. Fixed in `furniture.ts`, not by nudging
   the nav rectangle around it: the console was shrunk (1.9m -> 1.2m wide)
   and moved to the wall's actual solid pier (`z 0-1.4`). This surfaced a
   real room-planning constraint worth stating plainly: a full 1.9m-wide TV
   console does not fit anywhere on that partition wall without either
   blocking the archway or (on the wall's other solid pier, only 1.1m long)
   not fitting at all. The fix trades an ideal sofa-facing sightline for
   actually being mounted against a wall -- flagged here as something worth
   revisiting once there's a render to judge the trade-off by, not silently
   accepted as ideal.
2. **A rectangle overlapped roughly half a metre of the bedroom wardrobe.**
   Root cause once traced back further: the gap between the bed's east edge
   and the desk's west edge was only 0.25m in the original placement, too
   narrow for any nav rectangle to route through at all without either
   touching the bed or the desk/chair. Fixed at the source -- the desk (and
   its chair and lamp, which share its world position) moved 0.3m east,
   widening the gap to 0.55m -- rather than by shrinking a rectangle down to
   fit an impractically tight gap.

Fixing these two, plus getting every doorway rectangle to have genuine
positive-area overlap with the room rectangles either side of it (the
original round-9-style table had several rectangles that only *touched* at a
shared boundary -- e.g. a room rectangle's `maxZ` exactly equal to a doorway
rectangle's `minZ` -- which is a zero-width intersection and silently breaks
the overlap-based connectivity graph even though the two numbers look
adjacent when read by eye), meant redesigning the table properly rather than
patching two entries. The result is 20 rectangles instead of 14: more
granular, each one small enough to reason about individually, with inline
comments in `floorplan.ts` stating which specific furniture edge each
boundary is clearing and by how much.

Five of the nine named anchors moved too, for the same reason: `sofa`,
`dining`, `fridge`, and `desk` were all originally placed either on top of or
overlapping the furniture piece they're named after (an anchor is meant to
be *where she stands*, not the coordinates of the object itself), caught by
the same script checking anchor points against furniture footprints.

**Verification performed, in order of how much each proves:**
1. `tsc --noEmit` and both production builds (shell + sandbox, the latter
   via the same one-off Vite config as previous rounds, since the default
   build still doesn't cover `sandbox.html`).
2. The furniture/rectangle/anchor audit script described above, re-run after
   every fix until it reported zero overlaps and zero anchors-inside-furniture.
3. `buildApartment()` actually executed in Node (see the furniture-detail
   section above for the harness) -- 20 checks covering mesh/triangle counts,
   footprint dimensions, all four doors actually swinging on command *and*
   on proximity (and staying shut when the subject is elsewhere), lighting
   modes cross-fading without throwing and leaving fog/bloom at sane
   in-metres values, the ambient dust motes never drifting outside the
   building after 10 simulated minutes (the direct fix for "particles
   somehow shifted out of map" -- traced to the old `Points` object sitting
   at world origin while its geometry lived 10+ units away, so the slow
   rotation swept a huge arc through and past the building; the geometry is
   generated centred on the apartment now, so the same rotation keeps it
   inside), and the scene-state describe function resolving room and anchor
   correctly.
4. **The real `WalkableArea` and `WanderController` classes, extracted
   verbatim from `sandbox.ts` by source-slicing (not reimplemented), run
   through two simulated hours of wandering** against the real 20-rectangle
   table, with a deliberate 35% overshoot on every step standing in for the
   walk system's own "arriving" grace stride. Zero frames landed off
   walkable floor across roughly 432,000 simulated ticks, and all five
   rooms and all nine anchors were reached -- directly answering "she just
   stays in that little bedroom space," which was the user's original
   complaint about round 9's behaviour.

**Still not verified, and cannot be from here: how any of it actually
looks.** Every clearance number above is arithmetic on real placed
coordinates, which is a meaningfully stronger claim than round 9's
eyeballed table -- but it is still not a screenshot. No GPU/browser in this
sandbox, same as every round before this one.

### Scope note

Same isolation discipline as every round since Phase 10 round 2: everything
this round touched is sandbox-side (`sandbox.html`, `src/sandbox.css`,
`src/sandbox.ts`, `src/sandbox-hud.ts`, `src/ws-client.ts`, the new
`src/apartment/`, `src/postfx.ts`, `src/camera-modes.ts`,
`orchestrator/app.py`) and these docs -- no changes to
`index.html`/`src/main.ts`/`src/style.css`, which a second, parallel session
is working on.

## Round 11: first real screenshots find two bugs -- day-mode overexposure, no ceiling toggle

Round 10 shipped and, for the first time, got looked at on the user's actual
machine. Two concrete things came back from that first look, both flagged in
detail in `handoff.md` rather than left as vague "it looks off" reports, and
both fixed this round.

### The day-mode wash: three lights and an exposure bump, all pointed the same way

`MODES.day` in `src/apartment/index.ts` was not one number too high, it was
four numbers each individually plausible but never checked against each
other: `sunI: 3.1` (more than double dawn's `1.5`), `hemiI: 0.95` (roughly
1.7x dawn's `0.55`), `envI: 1.0` (full-strength IBL, ~1.8x dawn's `0.55`),
and `exposure: 1.05` on top of all three. Compare dusk, the next-brightest
mode: `sunI: 1.8`, `hemiI: 0.48`, `envI: 0.45`, `exposure: 1.0` -- day was
running every one of those levers well past dusk's, simultaneously. ACES
Filmic tone mapping compresses highlights rather than hard-clipping them,
but there's a limit to how much it can rescue once three independent light
contributions are all pushed high at once and then multiplied by an
above-baseline exposure -- past a point the compression itself reads as a
flat, saturation-crushed white wash, which is exactly what the user's
screenshot showed. It's also not a corner case: `let live = cloneState
(MODES.day)` and `setTimeOfDay('day', true)` at the end of `buildApartment()`
mean day is the mode the scene boots into, so this was the very first thing
anyone saw.

Fix, in `src/apartment/index.ts`'s `MODES.day`: `sunI` 3.1 -> 2.0, `hemiI`
0.95 -> 0.68, `envI` 1.0 -> 0.68, `exposure` 1.05 -> 0.95 (dropped slightly
*below* the other modes' 1.0 baseline, deliberately, to leave headroom for
the fact that the other three numbers are still the highest of any mode).
`bloom` nudged up slightly, 0.26 -> 0.32, to compensate: bloom in this
pipeline is a highlight-threshold glow, so a less blown-out base scene
naturally triggers less of it, and day going *starker* than dawn/dusk instead
of brighter-but-glowier wasn't the goal. Day is still the brightest time of
day overall (every one of its four numbers is still above dusk's), it just
no longer stacks three separately-elevated light contributions into one
compounding wash. `sandbox.ts`'s `renderer.toneMappingExposure = 1.05` boot
placeholder was brought in line with the new `0.95` too, with a comment
noting it's overwritten every frame by `apartment.exposure()` regardless --
it was never load-bearing, just worth keeping honest since it happened to
equal day's exposure before and would otherwise silently stop matching it.

**Not screenshotted -- reasoned from the numbers and the ACES curve, same
limitation as every lighting decision in this project's history.** What
*was* verified this round (see the harness section below): the new numbers
actually land on the real `THREE.HemisphereLight`/`THREE.DirectionalLight`
objects and `scene.environmentIntensity` when `setTimeOfDay('day')` runs,
and a real transition into day over 90 simulated frames lerps toward them
without producing `NaN` or throwing. That confirms the mechanism is sound;
it does not confirm the render looks right, because nothing here can render
it.

### Ceiling hide/show, scoped to spectator mode specifically

The user's ask, and `handoff.md`'s lead: no way to hide or show the ceiling
while flying around in spectator mode. The ceiling geometry already
existed -- `shell.ts` builds one `PlaneGeometry` per room at `y = CEILING_H`,
single-sided (`lib.ceiling` never sets `side`, so it defaults to
`THREE.FrontSide`) -- which is also *why* the existing dollhouse-style
overhead spectator shot already reads as ceiling-less from directly above:
that's the plane's backface, invisible by default, not a toggle doing
anything. There was never an actual switch, though, so from any angle where
the frontface *is* visible (level with or below the ceiling, looking up)
there was no way to get it out of the way.

Implementation, following the same pattern `doors`/`glazing`/
`daylightPanels` already use in `shell.ts`:
- `ShellResult` gained a `ceilings: THREE.Mesh[]` field; `buildShell()`
  pushes each room's ceiling mesh onto it as it's built (5 meshes, one per
  room in `ROOMS`).
- `ApartmentHandle` gained `setCeilingsVisible(v: boolean)` and
  `ceilingsVisible(): boolean`, backed by a local `ceilingsOn` flag in
  `src/apartment/index.ts` that just sets `.visible` on every mesh in
  `shell.ceilings`.
- `sandbox.ts`'s dev panel (`setupSceneControls`) gained a "ceiling"
  show/hide row, same button-pair pattern as the existing time-of-day and
  camera-mode rows, plus a `KeyH` shortcut for toggling without reaching for
  the panel (chosen over `KeyC`, which visitor mode's crouch already owns).

**Scoped to spectator specifically, per the user's own framing of the ask**,
via an `applyCeilingVisibility()` closure in `sandbox.ts`: the ceiling
preference (`ceilingHiddenPref`) only actually takes effect while
`rig.mode() === 'spectator'`; switching to visitor mode always forces
ceilings back on regardless of the preference, since standing inside a room
at eye height with no ceiling overhead reads as broken rather than useful,
and the preference is remembered and reapplied the moment you switch back to
spectator. `applyCeilingVisibility()` is called after every place the camera
mode can change -- both dev-panel buttons and the existing `Tab` handler --
so the two controls can't drift out of sync.

### Verification: a real Node harness this round, not just tsc

Both production builds (`npm run build` for `index.html`, plus the same
one-off Vite config used in prior rounds, `rollupOptions.input:
"sandbox.html"`, for the sandbox entry) came back clean, as always -- proves
the module graph resolves and nothing else.

Beyond that, this round actually executed `buildApartment()` in Node against
the real, current source -- not a copy, not a reimplementation -- closer to
round 10's own harness than any round since. `src/apartment/index.ts` was
bundled with esbuild (`--platform=neutral --external:three`) and run under
real `three` from `node_modules`. Two things needed stubbing to make that
possible without a GPU, both scoped as narrowly as they could be:
- `document.createElement('canvas')`, for the procedural texture drawing in
  `materials.ts`/`furniture.ts` -- a `Proxy`-based no-op 2D context (any
  method call is swallowed, `createLinearGradient`/`createRadialGradient`
  return a stub with a no-op `addColorStop`) so `THREE.CanvasTexture`
  construction succeeds without ever needing real pixels.
- `THREE.PMREMGenerator`, which needs a real WebGL context to compile a
  shader and can't be faked into actually working -- replaced with a
  no-op class (`compileEquirectangularShader()`/`fromScene()` do nothing
  and return an inert texture) via a generated shim module that re-exports
  everything else from real `three` untouched, swapped in for the bare
  `'three'` specifier only (not the `three/examples/jsm/...` subpath
  imports, which resolve to real code) through a Node `--experimental-loader`
  resolve hook. This is unrelated to what changed this round -- IBL
  construction was round 10's work, already verified there -- so it's
  stubbed rather than re-proven.

Everything else in the harness run is the real, unmodified pipeline:
`floorplan.ts`'s room/anchor data, `materials.ts`'s and `furniture.ts`'s
actual geometry construction, `shell.ts`'s wall/door/ceiling building, and
`index.ts`'s lighting state machine. Results:
- `apt.ceilingsVisible()` starts `true`; after `setCeilingsVisible(false)`,
  walking the real scene graph for horizontal `PlaneGeometry` meshes
  (the ceiling planes' actual signature: rotated `Math.PI/2` about X) found
  exactly 5 -- one per room -- all hidden, zero still visible; calling
  `setCeilingsVisible(true)` brought all 5 back. Confirms the array is wired
  correctly, not just that the getter/setter pair type-checks.
- After `setTimeOfDay('day', true)`, the real `HemisphereLight.intensity`
  read `0.68`, the real `DirectionalLight.intensity` (the sun, distinguished
  from the dimmer bounce light by intensity) read `2.0`,
  `scene.environmentIntensity` read `0.68`, and `apt.exposure()`/
  `apt.bloomStrength()` read `0.95`/`0.32` -- the new numbers actually
  reaching the objects they're supposed to drive, not just sitting correct
  in a data table.
- All four `TIMES_OF_DAY` applied via `setTimeOfDay(t, true)` in sequence
  without throwing.
- A `night` -> `day` transition (`setTimeOfDay('day', false)`, non-instant)
  run for 90 simulated frames at 1/60s landed at `exposure ≈ 0.951`,
  `hemi ≈ 0.676`, `sun ≈ 1.986` -- converging on the new targets, all finite,
  no `NaN` anywhere in the lerp.

**Still not verified, same limitation as every round: how any of this
actually looks.** The harness proves the mechanism -- right values, right
objects, right mesh count, no exceptions -- not the picture. No GPU/browser
in this sandbox, unchanged from round 10 and everything before it. The
harness scripts themselves are one-off, kept in this session's own working
notes rather than committed, same as round 10's furniture/rectangle audit
script -- they're diagnostic tooling for this round's specific change, not
part of the shipped app.

### Scope note

Same isolation discipline as prior rounds: this round touched
`src/apartment/index.ts`, `src/apartment/shell.ts`, `src/sandbox.ts`, and
these docs. No changes to `index.html`/`src/main.ts`/`src/style.css`.

## Round 12: the procedural apartment is gone -- replaced with a prebuilt model

Round 11 fixed two specific bugs the user's first screenshots surfaced. The
screenshots after *that* fix showed the deeper problem: a UV-checker/barcode
texture on the bathtub, a rolled towel floating unattached near the ceiling,
a toilet with no bowl (just a tank sitting on a black disc), a mirror
rendering as a solid white blob, and a bathroom light fixture blown out even
in *night* mode. That's not a lighting-numbers problem -- it's hand-authored
procedural geometry and canvas-drawn textures (`shell.ts`, `furniture.ts`,
`materials.ts`) that nobody building them could actually see. The user's
own conclusion, and the right one: stop hand-authoring 3D content blind and
swap in something real, the same way the VRM avatar was always a real
external asset rather than something built in code.

### What changed

The user found and provided `public/apartment/twokinds_modern_trio_apartment.glb`,
a prebuilt apartment interior downloaded from Sketchfab (~40MB, self-contained,
generator tag confirms the Sketchfab exporter). This round wires it in as a
full replacement, not an addition:

- **`src/apartment/shell.ts`, `furniture.ts`, `materials.ts` deleted.** Those
  three files *were* the procedural room -- walls, doors, furniture geometry,
  and every hand-drawn canvas texture. Nothing outside `apartment/index.ts`
  imported them (checked before deleting), so removing them is contained.
- **`src/apartment/index.ts` rewritten.** `buildApartment()` is now `async`
  (it has to be: loading a `.glb` is inherently asynchronous, unlike the old
  procedural build which was synchronous JS). It loads the model through
  `GLTFLoader` -- the exact same loader class already imported for the VRM
  avatar, since VRM is itself a glTF extension; no new dependency. Image-based
  lighting (`RoomEnvironment` + `PMREMGenerator`), ACES tone mapping, the
  four-time-of-day state machine, and the dust-mote particle system are kept,
  restructured around the new model instead of the old shell.
- **`src/apartment/floorplan.ts` rewritten.** The old file had nine real
  rooms, real wall/door geometry, and named furniture anchors, all hand-
  measured against the procedural shell. The new model has none of that
  available to read: `gltf-transform inspect` shows generic `Object_0`,
  `Object_1`, ... mesh names, not `Kitchen_Counter` or `Bedroom_Door` -- there
  is no reliable way to derive real room boundaries, door positions, or
  furniture locations from the file itself. `floorplan.ts` now describes one
  placeholder room/navmesh rectangle sized to the model's actual measured
  bounding box, with four generic, scattered anchors (not real furniture
  positions) so the wander controller has more than one place to go. This is
  a real capability loss -- no room-level scene-state ("she's in the
  kitchen"), no doors, no per-room lighting, no wall-aware collision inside
  the footprint -- stated plainly rather than papered over, because getting
  any of it back requires someone who can actually see the loaded model
  point out where the real walls and furniture are. That can't happen from
  inside this sandbox.
- **The round-11 ceiling toggle removed.** It was built against `shell.ts`'s
  ceiling meshes, which no longer exist. Rather than leave a UI row and a
  `KeyH` shortcut that quietly do nothing, both were deleted from
  `sandbox.ts`, along with `ApartmentHandle.setCeilingsVisible`/
  `ceilingsVisible`. Same reasoning for `doors`/`requestDoor`/`DoorLeaf`:
  confirmed via grep that nothing outside `index.ts` ever consumed them, so
  they're gone rather than stubbed.
- **Camera spawn points rewritten**, in `sandbox.ts`. The old spectator/
  visitor spawn coordinates were tuned by hand against the old floor plan's
  specific room layout -- meaningless against a 19m x 11m building nobody
  building this has seen rendered. Spectator now starts pulled back and
  above the whole footprint (`CENTRE.x, CEILING_H + 6, CENTRE.z + 12`) --
  guaranteed not to spawn embedded in a wall or a piece of furniture at an
  unknown position, at the cost of not being a curated first shot. Visitor
  mode spawns at the footprint's centre, the one point guaranteed to sit
  inside the placeholder walkable rectangle.
- **Sun shadow-camera frustum widened** from round 11's `±12` to `±16`, to
  cover the new model's much larger real footprint (19.1m x 10.9m, roughly
  double the old hand-built room's scale) with margin for the sun's oblique
  angle.
- **New `MODES` lighting table**, written from scratch rather than ported.
  The round 10/11 numbers were tuned (twice, badly the first time) against
  this project's *own* hand-authored `materials.ts`. This is a real,
  unfamiliar model with its own PBR textures and zero tuning history, so
  every value was picked deliberately modest -- no light contribution pushed
  near its max, unlike round 11's mistake of stacking three at once. Also
  worth noting from the inspect report: several materials
  (`Glowy_Green`, `RGB_Material`, `Magic_Glow`, the `*_glow` set, the various
  screen materials) carry their own emissive textures, self-lit regardless
  of scene lighting -- likely load-bearing for a "gamer den" aesthetic that
  leans on practical/neon lighting. Night mode's scene lights are
  deliberately dim on purpose, to let those emissive materials carry the
  room's visual interest instead of fighting them.
- **`.gitignore`/`public/apartment/README.txt` added**, mirroring
  `public/vrm/`'s existing pattern exactly: the model file itself is
  gitignored (large, personal, and see the licensing note below), the setup
  note is committed.

### Licensing -- flagged, not resolved

The model's filename and material names (`DJ_Dragon_Poster`, `Sims_Screen`,
`Dorditos`, `squirrelmart_pretzels`, `laura_blanket`, `Red_Letter_Day`) read
like a fan-made scene tied to the *TwoKinds* webcomic with some brand-parody
set dressing, downloaded from Sketchfab. The generator tag in the file
confirms the Sketchfab origin but says nothing about which license that
specific listing carried -- that lives on the Sketchfab page, not in the
binary. The user was told this plainly before providing the file (CC0/
CC-BY/CC-BY-SA are fine to use; a "Standard" Sketchfab license or CC-BY-NC
would mean personal-use-only and shouldn't sit in a repo that's already on
public GitHub) and chose to proceed. Not re-litigated here; just recorded so
a future session doesn't assume this was verified when it wasn't.

### Verification: the real file, through the real loader, for the first time

Both production builds (`tsc --noEmit`, `index.html`, and `sandbox.html` via
the usual one-off Vite config) came back clean, as always.

Beyond that, this round went further than any prior round's Node harness:
rather than faking the asset pipeline, it loaded the *actual* 40MB file
through three.js's real `GLTFLoader`, over a real local HTTP server (Node's
`fetch`, which `GLTFLoader`'s internal `FileLoader` uses, needs an absolute
URL -- a bare relative path like the production `/apartment/...` doesn't
resolve without a page origin, so a throwaway `http.createServer()` served
`public/` locally for the test). Getting there needed three small,
environment-only polyfills, none of which touch the app: a `ProgressEvent`
stub (three's `FileLoader` reports download progress via the browser's
`ProgressEvent`, which Node lacks), `self = globalThis` (`GLTFLoader`'s
texture-loading path checks `self.URL`), and the same PMREMGenerator fake
and canvas-2D-context stub used in round 11's harness, for the same reasons
(no WebGL, no real canvas in Node). Results:

- The real JSON+binary glTF structure parsed correctly: **445 meshes,
  ~271,754 triangles, 82 unique materials** -- the material count matches
  `gltf-transform inspect`'s report exactly.
- The loaded scene's bounding box (`min [-9.90, -0.16, -3.74]`,
  `max [9.32, 2.78, 7.15]`) matches the earlier `gltf-transform inspect`
  numbers to within a few centimetres -- confirms the geometry assembled
  into the real `THREE.Scene` at the position and scale expected, not just
  that the file parses in isolation.
- Both `KHR_texture_transform` and `KHR_materials_transmission` (the file's
  only two `extensionsUsed`, confirmed by parsing the glb's JSON chunk
  directly before writing any loader code) resolved without needing any
  extra decoder setup -- both are natively handled by stock `GLTFLoader`.
  Also confirmed: no Draco/meshopt compression (`extensionsRequired` is
  empty), which would have needed `.setDRACOLoader()`/`.setMeshoptDecoder()`
  configured before loading works at all.
- The lighting state machine, `describe()`, and the new single-room
  `floorplan.ts` all ran against the real loaded scene without throwing;
  `describe()` correctly returns the placeholder room/anchor for a point
  inside the footprint and `null`/the generic fallback label for a point
  far outside it.
- `buildApartment()` resolved in ~530ms against a local server -- not a
  meaningful production timing (no real network/disk latency modeled), but
  confirms nothing hangs or infinite-loops on this file.

**What this does *not* verify: any pixel of any texture.** Node has no
image decoder -- `GLTFLoader` logged 11 "Couldn't load texture" warnings for
embedded image blobs it has no way to decode outside a browser, which is
expected and non-fatal (the loader warns and continues; this is purely a
Node-vs-browser environment gap, not evidence of a problem with the file).
Whether any material actually looks right, whether the emissive "glow"
materials read the way the model's creator intended, whether the new
lighting numbers over- or under-expose this specific model's textures --
none of that can be checked from here. This is, however, meaningfully
further than any prior round's verification got: the full scene graph,
geometry, and material *assignment* (as opposed to material *appearance*)
is now confirmed correct against the real file, not reasoned about or
mocked.

### Scope note

This round touched `src/apartment/floorplan.ts` (rewritten),
`src/apartment/index.ts` (rewritten), deleted `src/apartment/shell.ts`,
`src/apartment/furniture.ts`, `src/apartment/materials.ts`, edited
`src/sandbox.ts`, added `.gitignore`/`public/apartment/README.txt`, and
these docs. No changes to `index.html`/`src/main.ts`/`src/style.css`.

## Round 13: first real usage of the round-12 model -- six real bugs, found with evidence not guesses

Round 12 got the prebuilt apartment loading and rendering, verified as far
as this sandbox can verify anything (structural loading through the real
`GLTFLoader`, no pixels). This round is the first time it actually ran on
the user's machine: a 47-second video plus five screenshots came back,
showing several real problems. Unlike round 11 (reasoned from numbers
alone) and round 12 (reasoned from an inspect report's summary), this round
had the actual video to look at (frames pulled with `ffmpeg`) and, since
the original `.glb` upload was still sitting in this sandbox from the
conversation that produced it, the actual glTF JSON to parse by hand for
exact material values -- so most of what follows is diagnosed from evidence,
not inferred from first principles.

### What the video actually showed

Pulling frames every 2 seconds (`ffmpeg -vf fps=1/2`) and looking at them
directly:
- The kitchen, gaming bedroom, and living room all render with real detail
  and generally reasonable lighting -- textures, furniture, and screens
  mostly look fine. This mattered: it ruled out "textures aren't loading in
  the browser" as an explanation for anything else (Node's lack of an image
  decoder, flagged as a real gap in round 12's verification, turned out not
  to matter here -- real browsers decode images fine).
- Luna is a near-total black silhouette in every single frame, day or
  night, including standing directly in front of a very bright TV.
- The living-room TV screen is blown out to a solid white glow with visible
  ring-artifact banding at its edges -- a classic UnrealBloomPass symptom
  on a very bright small source, not just "the screen is bright."
- One frame (spectator/dawn) shows a large soft-edged concentric-ring halo
  around a floor lamp -- the same bloom-ringing symptom, elsewhere.
- One frame shows Luna's whole body clipped directly into a white sofa's
  cushions.
- One frame, deep in a corner near some moving boxes, shows a large flat
  gray plane with a visible hard seam filling the right half of the frame --
  consistent with the user's "walking in void" description.

### Root cause 1: Luna's MToon shader doesn't read the room's ambient lighting at all

This is the single most useful thing this round found, because it's not a
guess -- it's read straight out of `@pixiv/three-vrm-materials-mtoon`'s
actual shader source
(`node_modules/@pixiv/three-vrm-materials-mtoon/lib/three-vrm-materials-mtoon.module.js`):
the fragment shader has `// #include <envmap_fragment>` -- commented out.
MToon materials (her avatar's shading model) never sample
`scene.environment` under any circumstances. Every bit of round 12's `envI`
tuning, and everything in round 11 before it, was scaling a light
contribution that only ever reached the apartment's own PBR furniture --
never her.

Worse: the shader's `getDiffuse()` function blends between `diffuseColor`
and `shadeColor` based on a toon ramp (`getShading()`, a `linearstep` over
`dotNL + shadingShift`), and `shadeColorFactor` defaults to
`new THREE.Color(0, 0, 0)` -- pure black -- unless the VRM file itself
authored something else per-material. Round 12's `MODES.night` set
`hemiI: 0.16` and `sunI: 0.12` deliberately low, reasoning that the
apartment's own emissive "glow" materials (RGB strips, screens) should
carry the room's visual interest instead of a bright ambient wash. That
reasoning wasn't wrong for the *room* -- but it left the one light source
that actually reaches MToon (hemisphere + directional, not IBL) too low to
lift her out of full shade-color territory, especially from behind (the
camera angle in nearly every frame of the video), where the sun's `dotNL`
against her back is near zero regardless of hemi/sun intensity.

**Fix:** rather than raise the room's ambient (which would undo the actual,
correctly-diagnosed "pure-white materials blow out" fix below -- the two
problems were pulling `hemiI` in opposite directions), added a dedicated
`THREE.PointLight` (`lunaFill`) that follows her position every frame
(`update()`'s `subject` parameter, previously accepted and ignored --
`sandbox.ts`'s call site now always passes `vrm.scene.position`, dropping a
vestigial "whoever's closest to a door" computation left over from before
doors existed at all). Short range (`distance: 3.2`, `decay: 1.8`) so it
doesn't meaningfully brighten nearby walls or furniture -- it's a
character-fill light, decoupled from room mood lighting entirely, the same
way a key/fill light on a live-action actor is separate from set lighting.
Intensity (`fillI` in the `LightState`/`MODES` table) is highest at night
(11) where ambient is lowest, tapering to 0 at day (where hemi+sun are
already enough on their own). **Not verified against her actual VRM
materials' `shadeColorFactor`** -- if her file does define a non-black
shade color already, the room may have needed less of a fix than assumed;
either way, the fill light approach is robust to that uncertainty since it
adds real direct light rather than depending on precisely which shade color
she blends toward.

### Root cause 2: several "white" materials are the glTF spec-default, not a real color

The exact same `.glb` uploaded earlier this conversation was still in this
sandbox, so rather than guess at PBR values, they were read directly out of
the file's own JSON chunk (manual parse: read the GLB header, extract the
JSON chunk, `JSON.parse` it, inspect `materials[]`). Findings, matched
against the user's specific complaint ("sofa, toilet, doorhinge"):

- `Porcelain_-_White` (near-certainly the toilet/sink) has `metallicFactor:
  0` and **no `baseColorFactor` key at all** -- meaning it renders at
  glTF's spec default of pure `(1,1,1,1)` white, not any color the artist
  actually chose.
- `Couch_Beige` and `Couch_BeigeDark` (near-certainly the sofa) are the
  same story: `metallicFactor: 0`, no `baseColorFactor` override --
  rendering pure white despite names that say "beige."
- `Gold` (the likely door-hardware/hinge material) has `roughnessFactor:
  0.15` and no `metallicFactor` override -- defaulting to glTF's
  `metallicFactor: 1.0`. A fully metallic surface at 0.15 roughness is
  close enough to a mirror finish to throw a tight, easily-blown-out
  specular highlight under any real light, independent of overall scene
  brightness.
- Three screen-like materials (`screen`, `Sims_Screen`, `Desktop_Screen`)
  all share the identical risky profile: `roughnessFactor: 0` (perfect
  mirror) plus `emissiveFactor: (1,1,1)` (spec-maximum emissive) over a
  real emissive texture. Only `screen` visibly washed out in the footage;
  the desk's two monitors (almost certainly `Sims_Screen`/`Desktop_Screen`)
  looked fine in the same video, so only `screen` was touched -- dimming
  the two that already looked right on a hunch would have been guessing
  again, exactly what this round was trying to stop doing.
- `light_window` is a separate finding, not a complaint: an emissive-only
  (`emissiveFactor: (1, 0.637, 0.36)`, warm orange, no base texture) plane
  that's almost certainly the model's own baked "sunlight glow at the
  window" trick prop. Since emissive materials ignore scene lighting
  entirely, this would have glowed exactly the same at night as at
  day -- so its `emissiveIntensity` is now driven by the same day/night
  state machine as everything else (`lightWindowI` in `MODES`, ~1.0 by day
  down to ~0.12 at night).

**Fix, in the new `fixupMaterials()` in `src/apartment/index.ts`:** a
traversal, once at load time, that corrects these specific named materials
by their exact glTF name -- real off-white/beige colors for the three
white-by-default ones, raised roughness on `Gold`, reduced
`emissiveIntensity`+slightly raised roughness on `screen` alone. This is
deliberately narrow: five named materials out of 82, not a blanket
brightness/saturation pass, because every one of them traces to a specific
number pulled from the file, not a vibe. `RGB_Material`/`Glowy_Green`/
`Magic_Glow`/the `*_glow` family were left untouched -- their emissive
colors clearly match their names (an orange-glow material's emissive really
is orange, etc.), so they read as intentional gamer-den accent lighting,
not an authoring gap.

### Root cause 3: bloom radius was too wide for this model's small bright props

`src/postfx.ts`'s `UnrealBloomPass` was constructed with radius `0.7` --
fine for the round-10/11 procedural apartment's larger, softer light
sources, but on this model's small bright points (a screen, a bulb) it
produces the wide, ring-banded halo visible in two separate frames of the
video, independent of the material-level fixes above. Narrowed to `0.35`
and threshold nudged from `0.92` to `0.96`, so only genuinely blown-out
pixels bloom rather than merely bright ones. `MODES`' per-mode `bloom`
strength values were also trimmed down somewhat (e.g. night 0.65 -> 0.5)
now that the worst source-level offenders are corrected rather than fought
with bloom tuning alone.

### Root cause 4: no collision against the real model at all -- "we clip"

Round 12's placeholder navmesh was one rectangle covering the whole
building footprint, explicitly documented as not wall-aware. The user
found this immediately and asked for it directly: "add boundaries for
walls (yes we clip.), add furniture boundaries and collision so i dont end
up inside a fridge." This is real, substantial new work, added via
`three-mesh-bvh` (a well-established, widely-used three.js addon
specifically for fast collision/raycast queries against complex static
meshes -- not something to hand-roll against 271k triangles).

**How it works, in `src/apartment/index.ts`:**
- `buildCollisionGeometry()` walks every mesh in the loaded model once at
  load time, strips each one down to *only* its position attribute
  (collision doesn't need UVs/normals/vertex color, and stripping to one
  common attribute set is what lets 445 differently-authored meshes merge
  at all -- `mergeGeometries()` refuses to merge geometries with
  mismatched attribute sets), bakes each mesh's `matrixWorld` directly into
  the vertex positions via `applyMatrix4`, and merges all of them into one
  `BufferGeometry` with `mergeGeometries()`
  (`three/examples/jsm/utils/BufferGeometryUtils.js`). One
  `computeBoundsTree()` call (the `three-mesh-bvh` prototype extension,
  installed once at module load) builds a single BVH over the whole merged,
  already-world-space geometry -- so queries need no per-mesh transform
  math at all, just a world-space sphere.
- `collidesAt(x, z)` checks three stacked spheres (radius `0.3`) at ankle/
  waist/head-ish heights against that one BVH via `intersectsSphere()`, not
  a full capsule-vs-triangle sweep (the more thorough technique
  `three-mesh-bvh`'s own examples use for smooth sliding resolution) --
  cheaper and much simpler to get right blind, at the cost of not handling
  a very thin obstruction between two sample heights, or perfectly smooth
  sliding along a curved surface.
- `ApartmentHandle.collidesAt()` is consulted from two places in
  `src/sandbox.ts`: `WalkableArea.contains()`/`.clamp()` (now takes the
  `ApartmentHandle` too, ANDs the existing rectangle check with
  `!collidesAt(...)`) -- which means **`camera-modes.ts`'s existing
  axis-decomposed sliding movement in `updateVisitor()` needed zero
  changes** to start sliding along real walls, since it was already written
  against the `Clampable` interface, not the rectangle implementation
  directly. And `WanderController`, so Luna's own random wander targets
  (and the anchor she's walking to) get rejected and re-picked if they'd
  land her inside real geometry, rather than only checking the placeholder
  rectangle.

**A real bug found and fixed before this ever left the sandbox:** the
first version's height samples were `[0.15, 0.9, 1.55]` (ankle/waist/head).
Running the actual collision system against the real file (see
Verification below) showed **89.9% of the entire footprint blocked** --
obviously wrong; nobody could walk anywhere at that rate. Cause: a sphere
of radius 0.3 centred at y=0.15 reaches down to y=-0.15, comfortably inside
the floor slab itself (the model's real bbox min y is -0.08) -- the check
was flagging the floor as an obstruction almost everywhere, not real
furniture or walls. Raised the lowest sample to 0.45 (sphere bottom at
0.15, clear of any floor slab) and re-ran: **54.3% blocked**, which is at
least plausible for a small multi-room "trio" apartment with real interior
wall thickness and furniture, rather than obviously broken. This is
exactly the kind of bug that categorically could not have been caught by
reasoning about the code -- it only showed up by actually running the real
collision query against the real geometry and looking at the resulting
number.

**Not verified: whether 54.3% "feels" right to actually walk around in**,
or whether the three-height-sample approximation produces any awkward
getting-stuck-on-furniture-edges moments a full capsule sweep wouldn't.
Flagged as the single piece of this round most likely to need a follow-up
tuning pass once someone's actually walked around with it.

### Smaller fixes

- **Eye height**: `camera-modes.ts`'s `EYE_HEIGHT` constant, `1.62` ->
  `1.5`, per a direct request to bring visitor-mode height down a bit.
- **Dust motes**: count `220` -> `320`, point size `0.035` -> `0.055`, and
  the opacity floor raised (`0.05` -> `0.18` base) so they read as a
  deliberate ambient effect rather than the barely-visible scattering round
  12 shipped -- per the request for a more noticeably "dreamy" particle
  effect.
- **"Windows are 'nothing outside'"**: no code change needed -- confirmed
  this was already the case. The apartment was never given any exterior
  geometry or skybox; `scene.background` (the sky color from `MODES`) is
  everything a window shows through, which is exactly "nothing outside" as
  requested.

### "Real ray-traced reflections" -- not feasible here, here's what actually exists

Asked for "if you can," which it can't, honestly: this renderer is
`WebGLRenderer`, not `WebGPURenderer` with a ray-tracing backend, and
real-time hardware ray/path tracing isn't something a standard WebGL
context can do at all, regardless of tuning. This isn't new to this round
-- `postfx.ts`'s own top comment has said as much since round 10.

What's already doing the closest available job: the `Mirror` material
(`roughnessFactor: 0.223`, left untouched by this round's fixups since it
wasn't reported as broken) reflects the PMREM-baked `RoomEnvironment` IBL
already in place -- a real, if approximate and static, environment
reflection, not a flat color. The realistic next step *up* from that,
if actually wanted, is `THREE.SSRPass` (screen-space reflections) from
three.js's own postprocessing examples -- genuinely more accurate for
nearby reflected geometry, at a real cost (noticeably heavier per-frame
render cost, and screen-space artifacts at grazing angles or off-screen
reflections). Not added this round: it's a real feature with real
trade-offs, not something to bolt on blind without being asked for it
specifically once the trade-offs are clear.

### Verification: a working collision harness against the real file, for the first time

Both production builds (`tsc --noEmit`, `index.html`, `sandbox.html` via
the usual one-off Vite config) came back clean.

Beyond that, this round extended round 12's real-`GLTFLoader`-over-local-
HTTP-server harness (same `ProgressEvent`/`self`/PMREMGenerator-fake/canvas-
stub polyfills, `three-mesh-bvh` left external and resolved for real since
it's pure geometry math with no browser dependency) to actually exercise
everything new:
- Confirmed each `fixupMaterials()` correction landed on the real,
  loaded material instances (not just compiled without error): `Porcelain_
  -_White`'s color read back as `(0.86, 0.84, 0.8)`, `Couch_Beige` as
  `(0.75, 0.66, 0.53)`, `Gold`'s roughness as `0.38`, `screen`'s
  `emissiveIntensity` as `0.55` -- exactly the values written in code.
- Built the real collision BVH from the real 271k-triangle model
  (`buildApartment()` resolved in ~830ms including this) and ran a 576-
  point grid query across the whole real footprint -- this is what caught
  and let me fix the floor-collision bug above. Also spot-checked: the
  building's exact centre point is walkable (not blocked), and a point far
  outside the building entirely reports "not blocked" from `collidesAt`
  alone (correct in isolation -- it's `WalkableArea`'s separate rectangle
  check that's responsible for "outside the building," not `collidesAt`).
- A full day/night/transition cycle with the new `fillI`/`lightWindowI`
  fields interpolating alongside everything else ran without producing
  `NaN` or throwing.

**Still not verified, the same limitation as every round: how any of this
actually looks or feels to walk around in.** The harness proves the
mechanisms are real and produce plausible numbers against the actual file
-- not that the lighting reads right, that 54% blocked feels natural to
navigate, or that the fill light makes her look natural rather than
oddly spotlit. No GPU/browser in this sandbox, unchanged from every round
before this one.

### Scope note

This round touched `src/apartment/index.ts` (material fixups, collision
system, fill light, revised `MODES`), `src/apartment/floorplan.ts` (no
changes needed), `src/camera-modes.ts` (eye height), `src/postfx.ts`
(bloom radius/threshold), `src/sandbox.ts` (`WalkableArea`/
`WanderController` collision wiring, `update()` call site), `package.json`/
`package-lock.json` (added `three-mesh-bvh`), and these docs. No changes to
`index.html`/`src/main.ts`/`src/style.css`.

## Round 14: round 13's own fixes shipped two new, worse bugs -- both found from the field, both fixed with evidence

Round 13 shipped real collision and a fix for Luna's night darkness. Both
were wrong in ways that only showed up once actually run: a screenshot and
a plain description came back showing walking into any wall repeatedly
teleporting to a different spot in the building, Luna doing the same
("even luna is stuck"), Luna rendering as a solid white glowing silhouette
at night, and the spectator camera moving far faster than intended. This
round traced each one to an exact line of code, not a re-guess.

### Bug 1: `WalkableArea.clamp()`'s fallback wasn't a fallback -- it was hit constantly, and it teleported

Round 13's `clamp()`, for the rare case where even the axis-sliding
attempts were blocked, stepped 75%/50%/25%/10% of the way from the blocked
point toward `CENTRE` -- the geometric centre of the whole ~19m building --
reasoning this would rarely run. Two things were wrong with that
reasoning, both found by re-reading the actual call sites rather than
re-guessing at the symptom:

1. **`CharacterController.moveClamped()` (Luna's own per-step movement)
   called `clamp()` unconditionally on every blocked step** -- it never had
   the axis-decomposed sliding attempt `camera-modes.ts`'s `updateVisitor()`
   uses first. So for her, `clamp()` wasn't a rare last resort at all; it
   was the *only* thing standing between her and a wall, hit on
   essentially every step near one.
2. Even for `updateVisitor()`, where `clamp()` genuinely is a last resort
   (tried only after the combined move AND both single-axis moves already
   failed), that turned out not to be rare in practice: with acceleration/
   friction smoothing on velocity (`ACCEL`/`FRICTION` lerp in
   `camera-modes.ts`), even a single held key rarely produces perfectly
   axis-aligned velocity, so grazing a wall at almost any angle can fail
   all three attempts.

The result, confirmed by the user's exact description ("walking into a
wall teleports to a point beside the TV... again and again... other
points too teleport you to different places, like beside the couch") --
different starting walls landing at different fixed fractions of the way
toward one shared centre point produces exactly that pattern: a handful of
recurring "teleport spots," not a crash and not randomness.

**Fix, in both `WalkableArea.clamp()` (`src/sandbox.ts`) and
`CharacterController.moveClamped()` (`src/sandbox.ts`):**
- `clamp()` no longer steps toward `CENTRE` at all. Once the rectangle-only
  clamp point is confirmed still blocked, it searches a small ring around
  *that* point instead -- radii from 0.08m to 0.6m in 12 directions per
  ring -- and returns the first unblocked point found. Since the point
  being resolved is only ever a few centimetres from wherever the mover
  already was, the result reads as "stopped at the wall," never a jump.
  Only in the genuinely-cornered case where nothing in that whole ring
  search is clear does it fall back to the rectangle-only point, accepting
  a small chance of clipping over freezing or jumping -- same trade-off
  round 13 intended, just actually confined to a small area now.
- `moveClamped()` gained the same axis-decomposed sliding attempt
  `updateVisitor()` already had (try the full step, then X-only, then
  Z-only, only reaching `clamp()` if all three fail) -- so she now reaches
  the fallback about as rarely as the visitor camera does, instead of on
  every blocked step.

**Verified against the real file, not reasoned about in the abstract:**
extracted the exact `WalkableArea` class source (not a re-implementation --
the literal class text, via `sed`, wrapped in a small harness) and ran it
against the real collision BVH built from the real model. Scanned outward
from the building's centre until hitting real blocked geometry, then
called `clamp()` on it: resolved to a point **0.16m away**. Broader check:
every blocked point on a grid across the whole real footprint (67 blocked
samples found) resolved to a point **at most 0.56m away** -- nowhere near
the multi-metre jumps the centre-stepping version could produce. This is
the same category of finding as round 13's floor-slab collision bug: only
visible by actually running the real query against the real geometry, not
by reading the code.

### Bug 2: the fill light's near-field falloff was miscalibrated by roughly an order of magnitude

Round 13's screenshot showed exactly what was reported: Luna as a solid
white glowing silhouette at night, not merely "a bit bright." The cause is
straightforward once the actual numbers are run: the fill light
(`THREE.PointLight`) was positioned at `subject.y + 1.4` (chest height) and
`0.35m` in front of her root -- close enough to her own body's surface
(realistically 0.15-0.3m away) that physically-correct `PointLight`
falloff (`intensity / distance^decay`) amplifies the nominal intensity by
roughly **8x to 25x** at that range with `decay: 1.8`. Night's `fillI: 11`
was therefore delivering something like 90-275 effective units of light at
her skin -- for scale, the brightest any `MODES` entry ever asked of the
sun directly is `1.7`. This wasn't a subtle miscalibration; it was
multiple orders of magnitude off, entirely from underestimating how
punishing point-light falloff gets at close range.

**Fix:** repositioned the light to `subject.y + 2.3` (well above her ~1.6m
height, versus chest-height-and-in-front before) so the minimum distance
from light to body is closer to 2m regardless of exact pose, softened
`decay` from `1.8` to `1.4` (less punishing if the distance ends up off
again), extended `distance` from `3.2` to `5.5` to still reach her from
further away, and cut every mode's `fillI` roughly 3-4x on top of the
repositioning (night `11` -> `3`, dusk `6` -> `1.6`, dawn `4` -> `1.2`) as
a safety margin rather than relying on the geometry fix alone. Deliberately
erred toward *under*-lighting this time -- a slightly dim Luna is a far
less jarring failure mode than a second glowing-ghost screenshot.

**Not independently verified against a render** -- same limitation as
every lighting number in this project's history. What's different this
time is the reasoning is grounded in the actual falloff formula and the
actual reported failure, not a fresh guess; if it's still off, it should
at least be off by a much smaller margin.

### Bug 3: "many things are still glowing"

Round 13's `fixupMaterials()` only touched one emissive material (`screen`)
by name, on the reasoning that the other emissive-heavy materials
(`Sims_Screen`, `Desktop_Screen`, `RGB_Material`, the `*_glow` family) had
looked fine in that round's footage. The user's report this round --
"many things are still glowing," without naming specifics -- suggests
either that reasoning didn't hold up under more use, or that round 13's
massively-overexposed fill light was bleeding/blooming across nearby
surfaces and making adjacent objects look like they were glowing too (a
plausible secondary effect of Bug 2, not necessarily a separate problem).
Without a fresh screenshot naming specific objects, guessing at more
individual material names would be repeating the exact mistake this
project has been trying to stop making.

**Fix: a general safety net instead of more individual guesses.** Added a
uniform cap in `fixupMaterials()`, applied after the named fixes, to
*every* material in the model: if a material's peak effective emissive
brightness (`max(emissive.r, g, b) * emissiveIntensity`) exceeds `0.85`,
its `emissiveIntensity` is scaled down to bring it under that ceiling.
This is harmless for anything already under the cap (everything fixed by
name last round already lands there) and catches whatever else is still
too hot without needing to know its name -- directly addresses "many
things," plural and unspecified, rather than requiring another round of
screenshot-driven whack-a-mole.

### Smaller: spectator "lightspeed"

Flagged as new; turned out to be pre-existing, untouched-by-round-13
behavior: `camera-modes.ts`'s scroll wheel has always adjusted spectator
fly speed (`flySpeed *= 0.88` or `1.14` per tick), clamped between `0.35`
and `24`. Scrolling while looking around is an easy way to ratchet this up
without meaning to. Whether or not that's what happened, `24` units/s
crosses this building's real ~19m width in under a second, which reads as
"lightspeed" regardless of cause -- the ceiling was lowered to `14`.

### Scope note

This round touched `src/apartment/index.ts` (fill light repositioning/
retuning, general emissive cap), `src/camera-modes.ts` (fly-speed
ceiling), `src/sandbox.ts` (`WalkableArea.clamp()` rewrite,
`CharacterController.moveClamped()` axis-sliding), and these docs. No
changes to `index.html`/`src/main.ts`/`src/style.css`.

## Round 15: round 14 confirmed working -- pizza, doors, ceiling, and the "stuck" complaint

First round-14 confirmation from the user: "works properly." Four smaller,
more specific asks followed: a pizza prop rendering as a solid black disc,
Luna "walking into the wall for the last 10 minutes" (a pathfinding
complaint distinct from round 14's teleport bug), real furniture
boundaries, and door/ceiling functionality -- both removed in round 12
because the model's generic mesh names (`Object_0`, `Object_1`, ...) gave
no way to identify them. This round investigated each one directly against
the file rather than guessing, since the original upload was still in this
sandbox.

### The pizza: a real UV-mapping bug in the source file

Traced to the `pizza_pizza` material and, past that, to the mesh's actual
UV coordinates -- read directly out of the accessor data, not inferred.
The mesh's UVs span nearly the *entire* 2048x2048 texture atlas (measured:
U 0.013-0.927, V 0.013-0.987). Extracting the actual PNG from the file's
binary chunk (`pizza_pizza_baseColor.png`, confirmed valid, 2048x2048) and
looking at it showed why that's a problem: the real pizza artwork
(pepperoni, herbs, a warm orange base) occupies only a small centred
region of that atlas -- most of the image is dark brown padding. A mesh
whose UVs span almost the full 0-1 range samples mostly that padding, not
the artwork, which is exactly a near-black disc.

This is a real bug in the source file itself (a UV/atlas-packing mismatch
from however the original scene was authored), not anything introduced by
loading it here. The precise fix would be remapping this mesh's UVs into
the artwork's actual sub-rectangle -- but with no way to visually confirm
the crop lands on the right spot, that risks trading one wrong-looking
result for a different one. Instead, `fixupMaterials()` drops the broken
texture (`map`/`emissiveMap` cleared) and sets a flat color sampled
directly from the real artwork's pixels: cropped the texture's centre
region and took ImageMagick's mean color (`srgb(84%, 41%, 5%)`, a warm
cheese/pepperoni orange) rather than guessing at a plausible pizza color.
Loses the pepperoni/herb detail; guarantees it isn't a black disc.

### "She's been walking into the wall for the last 10 minutes": no pathfinding, now with a way out

Round 14 fixed the *teleport*, but not the underlying gap: `WanderController`
plans a straight-line point and walks toward it with wall-sliding
(`moveClamped`), not real pathfinding. Round 13 made *target selection*
collision-aware (won't pick a point that's inside geometry), but nothing
checks whether the straight-line route *to* an otherwise-valid target
actually clears whatever's between here and there. A target on the far
side of a wall from an unlucky anchor/spawn position leaves her pushed up
against that wall, making zero progress, indefinitely -- exactly the
reported symptom.

Building real navmesh-graph pathfinding would be the complete fix, but
needs real per-room polygon data this model still doesn't have (see the
round-12/13 entries on why `floorplan.ts` is one placeholder region).
Instead, added stuck-detection to `WanderController.getTarget()`: track
her position across calls, and if she hasn't moved more than 5cm in 3
seconds while actively walking toward a target, abandon that target *and*
the rest of the queued path (which was planned against it, so it's
suspect too) and let the next `plan()` call pick something fresh. This
doesn't make her route around obstacles -- it makes the failure mode
"occasionally picks a new target after a few seconds of being blocked"
instead of "stuck indefinitely," which is what was actually reported.

### Furniture boundaries: already covered, not a new gap

Round 13's collision BVH is built from every mesh in the loaded model,
furniture included -- there isn't a separate "furniture boundary" system
to add on top of it. Read the request as most likely the same underlying
gap as the pathfinding item above (getting stuck *because of* furniture in
the path, not being able to walk *through* furniture, which collision
already prevents) rather than a distinct missing feature.

### Doors: found geometrically, opened by disappearing rather than swinging

The file has no per-object names to identify doors by, so they were found
the same way the ceiling search worked in principle: scanning every
mesh's real world-space bounding box (computed from the glTF node
hierarchy's transforms and each primitive's accessor min/max, walked and
multiplied by hand) for the shape of a door panel -- roughly 0.6-1.2m
wide, 1.7-2.3m tall, thin the other way, bottom near the floor. That
search found **7 matching meshes at 5 distinct locations** (two locations
matched two nearby meshes each, most likely a frame+panel pair -- no way
to tell which is which from geometry alone, so both are toggled
together).

What "opening" means here, deliberately: the door mesh(es) at a location
become invisible and stop blocking movement when either Luna or the
visitor comes within 1.3m, and reappear/re-block once nobody's near.
**Not a hinge swing** -- geometry alone doesn't say which vertical edge
hinges or which direction it opens, and animating a guess wrong would
look worse than a clean disappear/reappear.

Implementation: `floorplan.ts` gained a `DOORS` export (5 `DoorDef`
entries, each with its mesh name(s) and a footprint box).
`buildCollisionGeometry()` now takes an exclusion set and leaves door
meshes out of the static BVH entirely, since unlike everything else in
it, whether a door blocks movement changes at runtime.
`ApartmentHandle.update()` gained a second position parameter
(`visitorPos`, alongside the existing `lunaPos`) so doors can react to
whichever camera mode is actually walking around -- `sandbox.ts`'s call
site now passes `rig.visitorPosition()` when in visitor mode, `null`
otherwise.

**A real bug found by actually running it, same pattern as every
collision fix this project has needed**: the first version checked the
static BVH before the door-open override, so even with the door panel
excluded from the BVH, the flanking wall/frame geometry immediately next
to a door's centre was close enough to still trip the collision sphere --
doors that were confirmed "open" (mesh hidden) still blocked movement.
Fixed by checking door boxes *first*: being inside an open door's box now
settles the question outright (always passable there, regardless of what
the BVH reports nearby) rather than merely skipping the door's own
check and falling through to a BVH query that could still say blocked.

### Ceiling show/hide: there's no ceiling to show or hide

Searched for it the same way doors were found -- scanning every mesh's
bounding box for the shape of a ceiling panel (thin in Y, large
horizontal area, positioned near the building's real max height of
~2.6-2.78m). The search found exactly **one** match, a `LightMetal`
mesh roughly 7.8m x 3.6m at y~2.05-2.08m -- almost certainly a duct or
ceiling grid over one specific area, not a general room ceiling. Broadening
the search to anything with its bounding box top above 2.4m regardless of
thickness turned up only full floor-to-ceiling wall segments (`Wall_material`,
spanning y 0.00-2.77m) -- no separate horizontal cap at all.

This model is genuinely roofless: an open-top "dollhouse" interior,
common for Sketchfab room showcases meant to be viewed from directly
above (matching round 12's original guess about the file's likely
intended viewing angle). There's no ceiling geometry anywhere in it to
build a show/hide toggle around -- not a gap to fix, a real property of
the source file. Confirmed by actually searching the file's geometry, not
assumed.

### Verification

Both production builds clean. All three geometric findings (pizza UV
range, door candidates, ceiling absence) came from directly walking the
glTF node hierarchy and computing real world-space bounding boxes by hand
(matrix composition from each node's translation/rotation/scale, applied
to each primitive's accessor min/max) -- not `gltf-transform`'s summary
view, which doesn't expose per-node world transforms. The door system was
then verified against the real loaded model, real collision BVH included:
found all 7 named door meshes in the actual loaded scene, confirmed all 5
doors start closed, and confirmed a door at its exact centre reports
blocked before anyone approaches, unblocked while someone's standing
there, and blocked again once they leave -- this exact sequence is what
caught the BVH-priority bug described above.

**Not verified: how the stuck-detection timeout feels in practice** (3
seconds is a guess at a reasonable "clearly not making progress" window,
not tuned against real play), **or whether hiding both meshes at a
paired door location (rather than only the actual swinging panel) looks
right** -- no way to tell which of a pair is the frame without seeing it.
Same limitation as every round: no GPU/browser in this sandbox to check
any of this against a render.

### Scope note

This round touched `src/apartment/floorplan.ts` (`DOORS`/`DoorDef`
added), `src/apartment/index.ts` (pizza fixup, door system, collision
exclusion + priority fix, `update()` signature), `src/sandbox.ts`
(`WanderController` stuck-detection, `update()` call site), and these
docs. No changes to `index.html`/`src/main.ts`/`src/style.css`.

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
