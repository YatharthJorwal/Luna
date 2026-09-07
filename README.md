# Luna -- Phase 2.5

Shell + Live2D + audio pipeline + a real local LLM brain, now with real
cloned voice output and voice input. Type in the input box (or click the
mic and talk), she thinks with an actual model (via Ollama or llama.cpp,
your choice in `orchestrator/config.yaml`), and replies by voice with
lip-sync, one sentence at a time as she "thinks" of them. See `/CLAUDE.md`
at the repo root for the full architecture and roadmap.

If you're updating an existing Phase 2 checkout: `orchestrator/stt.py` is
new (STT), `src/mic.ts` is new (mic capture, both a mic-button toggle and
an F9 global push-to-talk hotkey), and `src/ws-client.ts` / `src/main.ts`
/ `index.html` / `src/style.css` all picked up small voice-input
additions -- no `vendor/` or Live2D asset changes this round.

**Three things to redo after pulling this bundle, not just `git pull`:**
1. `pip install -r requirements.txt` again in your orchestrator venv --
   picks up `faster-whisper`. If the orchestrator crashes on startup with
   `ModuleNotFoundError: No module named 'faster_whisper'`, this is why;
   it's not an STT-specific failure, the whole orchestrator (including
   typed chat) won't start until this is run, since `stt.py` is imported
   at the top of `app.py`.
2. `npm install` -- `@tauri-apps/api` moved from a dev to a real
   dependency (it's now actually used, for the F9 hotkey listener), no
   new packages otherwise.
3. The F9 hotkey needed a small Rust change (`src-tauri/Cargo.toml` and
   `src-tauri/src/lib.rs`, a new `tauri-plugin-global-shortcut`
   dependency) -- `npm run tauri dev` (or `cargo build` directly) will
   pull and compile it automatically, updating `src-tauri/Cargo.lock` in
   the process. That Rust code has never been through `cargo check`
   anywhere (no Rust toolchain in the sandbox this was built in) -- see
   "What's actually been verified" below before you run it.

## What's actually been verified vs. not, honestly

This was built in a Linux sandbox with no GUI, no Rust toolchain, no GPU,
and no network path to Hugging Face (where faster-whisper's model weights
live) or to a real running Ollama instance, so:

- **Confirmed on the user's actual machine, full stack:** Phases 1 and 2,
  and now Phase 2.5 (GPT-SoVITS voice cloning + faster-whisper STT, both
  mic button and F9 global push-to-talk) -- a complete voice turn
  end-to-end, one-command launch (Tauri spawning both backend processes
  hidden), all confirmed working for real. STT currently runs on CPU
  after a missing-CUDA-DLL issue on this machine (see `docs/DECISIONS.md`).
- **Verified for real, in this environment:** the orchestrator's LLM
  client (`orchestrator/llm.py`) was run against hand-written stub servers
  matching both the OpenAI-compatible and Ollama-native streaming
  protocols; `orchestrator/stt.py`'s transcription logic against a
  stubbed `WhisperModel`; `app.py`'s WebSocket handling driven end-to-end
  through a real connection with stt/llm/tts stubbed. The frontend passes
  a full `npm run build`. **Phase 3 memory's DB layer
  (`orchestrator/memory/db.py`/`store.py`) is fully, honestly verified,
  not just stub-shaped** -- sqlite-vec is a pure local C library with no
  GPU/network dependency, so its schema, facts/episodes CRUD, and the
  actual vec0 nearest-neighbor query all ran for real against real
  temp-file databases (see `orchestrator/memory/test_memory.py`, 19
  passing tests -- the first committed test file in this repo, unlike
  every prior phase's ad hoc sandbox verification, precisely because this
  layer doesn't carry the "can't verify without real hardware" caveat).
  `memory/embeddings.py`'s request/response handling was verified against
  a stub HTTP server built to match Ollama's current (checked, not
  assumed) `/api/embed` shape, and `app.py`'s Phase 3 wiring (recall
  injected per-turn without polluting persisted history, consolidation
  firing once on disconnect) was driven through a real WebSocket
  connection with recall/consolidation/LLM/TTS all stubbed. The
  explicit-forget feature (`memory/forget.py`, 29 tests total now in
  `memory/test_memory.py`) is verified the same real way -- regex gate,
  fact deletion, and degradation all exercised against a real DB with
  only the LLM classification call stubbed. The graceful-shutdown
  handshake's **Python half** was verified end-to-end against a real
  running server in a background thread with a real websocket client --
  an idle connection actually noticing `/shutdown`, tearing itself down
  cleanly, consolidation running on the real completed-turn history, and
  the process-exit path firing -- including catching and fixing a test
  that initially passed for the wrong reason (see `docs/DECISIONS.md`).
  The stop-response button's concurrency change (`_run_turn()` now runs
  as its own cancellable `asyncio.Task` instead of being awaited inline,
  so the connection can react to a `stop` message mid-generation) was
  also driven through a real running server with a real websocket
  client -- confirmed cancellation is immediate, `turn_end` arrives
  promptly, a fresh turn works right after (the connection doesn't get
  left wedged), and the partial reply lands correctly in `history`
  (present, non-empty, shorter than the uncut reply, no duplicates, no
  dangling turn). The frontend half of that (`lipsync.ts`'s new
  `stop()`, `main.ts`'s `stopAll()`/`turnActive` state, the new HTML/CSS)
  passed a real `tsc` typecheck + production `vite build`, same bar as
  every other frontend change -- but there's no browser in this sandbox,
  so whether it actually *feels* instant when clicked is first-run
  territory.
- **Not verified, because I had no way to:** actual faster-whisper CUDA
  execution on the 3060 (currently moot -- running on CPU by choice, see
  above); a real Ollama instance actually serving `nomic-embed-text` (the
  request/response *shape* is verified against current docs, not a real
  server); the one Phase 3 piece with a real open question --
  whether `qwen3.5:9b` (a small model) reliably follows the
  consolidation JSON format in practice on real conversations rather than
  the handful of synthetic transcripts tested here (`consolidation.py`'s
  parser is deliberately forgiving specifically because this wasn't
  something to assume would just work; if it turns out to fail often in
  practice, that's a real signal to revisit, not a sign the fallback
  logic is wrong); the graceful-shutdown handshake's **Rust half**
  (`graceful_shutdown_then_kill()`/`request_orchestrator_shutdown()` in
  `src-tauri/src/lib.rs`) -- no Rust toolchain in this sandbox at all,
  flagged explicitly at its own definition in that file, same starting
  status the process-spawning code itself had before its own first real
  `cargo build`; and two prompt-wording fixes (the recall block now
  explicitly forbids fabricating specifics beyond what's actually stored,
  and persona.py's terseness instruction is now a concrete sentence-count
  constraint instead of a vaguer "terse by default") -- prompt wording's
  effect on a specific small model's actual behavior is inherently
  something to confirm by using it, not something a stub-server test can
  verify.

Expect to still fix small things on first run -- normal for anything that's
never touched real model weights, a real mic, or a real Rust compiler, not
a sign something's fundamentally wrong.

## Prerequisites (on your machine)

- **Rust** (stable) -- https://rustup.rs
- **Node.js 18+** -- you likely already have this
- **Python 3.11+**
- **WebView2** -- already installed on any up-to-date Windows 10/11, which
  covers you
- **Live2D Cubism Core runtime** -- download the "Cubism SDK for Web" from
  https://www.live2d.com/en/sdk/download/web/, pull
  `live2dcubismcore.min.js` out of its `Core/` folder, and drop it in
  `public/live2dcubismcore.min.js` (see `public/live2d/README.txt`). This
  can't be bundled here -- Live2D's own license terms don't allow third
  parties to redistribute it, you have to grab it yourself.
- **Ollama** -- https://ollama.com/download/windows. After installing,
  pull the default model:
  ```
  ollama pull qwen3.5:9b
  ```
  (~6.6 GB download at the default Q4_K_M quantization; fits comfortably
  alongside everything else on a 12GB 3060 since Ollama loads/unloads the
  model on demand.) Prefer llama.cpp instead? It works, but needs
  `orchestrator/config.yaml`'s `llm.api_style` set to `"openai"` alongside
  pointing `llm.base_url` at your llama.cpp server's OpenAI-compatible
  endpoint (usually `http://127.0.0.1:8080/v1`) -- see `docs/DECISIONS.md`
  for why the native/OpenAI split exists at all.
- **Ollama embedding model, for Phase 3 memory** -- same Ollama install
  above, just pull one more model:
  ```
  ollama pull nomic-embed-text
  ```
  (~274MB -- small enough to sit in VRAM alongside qwen3.5:9b with room to
  spare.) Used for semantic recall of past-session summaries; if this
  isn't pulled, memory degrades to facts-only recall rather than the
  orchestrator failing to start -- see `orchestrator/memory/recall.py`.
- **GPT-SoVITS** (optional -- `tts.engine` falls back to `pyttsx3`
  automatically if its server isn't reachable) -- run its own API server
  per https://github.com/RVC-Boss/GPT-SoVITS, then fill in
  `orchestrator/config.yaml`'s `tts.gpt_sovits` block with your reference
  clip's path and exact transcript. **Windows path gotcha:** use single
  quotes (`'C:\Users\...'`), not double -- see `docs/DECISIONS.md` if you
  hit a YAML parse error here.
- **faster-whisper's model weights** -- nothing to install manually; the
  first time you use the mic, `orchestrator/stt.py` downloads the
  configured model size (`"small"` by default, `orchestrator/config.yaml`'s
  `stt` block) from Hugging Face automatically and caches it locally. Needs
  an internet connection for that one first download; fully offline after.
- **CUDA for STT** -- runs on CPU by default now (`stt.device: "cpu"`),
  after confirming the exact missing-DLL error
  (`Library cublas64_12.dll is not found or cannot be loaded`) on the
  first real attempt. faster-whisper/CTranslate2 does fully support CUDA,
  and this is worth revisiting later on your 3060 -- either a system-wide
  cuBLAS/cuDNN install, or the `nvidia-cublas-cu12`/`nvidia-cudnn-cu12`
  pip wheels (these likely also need their DLL folder added to `PATH` or
  via `os.add_dll_directory()` for CTranslate2 to find them -- not
  confirmed either way yet) -- but CPU with the `"small"` model works with
  zero extra setup and is fast enough for short conversational clips. See
  `docs/DECISIONS.md` for the full trail if you want to chase CUDA later.

The Hiyori sample model in `public/live2d/Hiyori/` is already included --
it's Live2D's own official free sample, licensed for exactly this kind of
prototyping. Swap it for a licensed/purchased/commissioned model before
this becomes anything more than a local dev build (see CLAUDE.md's open
decisions).

## Run it

Down to two manual steps now -- GPT-SoVITS and the orchestrator both get
started automatically when the Tauri app launches (see
`src-tauri/src/lib.rs`'s `spawn_backend_processes()` and
`docs/DECISIONS.md` for how). `start-luna.bat`'s three separate terminal
windows aren't needed anymore; keep it around only as a manual fallback if
something about the auto-start ever doesn't work for you.

**One-time setup, before your first run:**
```
cd orchestrator
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```
And copy `src-tauri\launcher.local.txt.example` to
`src-tauri\launcher.local.txt`, filling in your real GPT-SoVITS install
path (gitignored -- machine-specific, same reasoning `config.yaml`'s real
`ref_audio_path` and the old `start-luna.bat` stayed local-only). Skip
this file entirely if you're fine with the `pyttsx3` fallback voice --
GPT-SoVITS auto-start is just skipped if it's missing, nothing else
breaks.

**Every time after that:**

**1. Ollama** (if not already running as a background service -- the
Windows installer usually sets this up for you; check the system tray
first):
```
ollama serve
```

**2. Everything else, in one command:**
```
npm install
npm run tauri dev
```
This starts GPT-SoVITS and the orchestrator itself, hidden -- give it a
few seconds (GPT-SoVITS loading the model is the slow part) before
talking to her. If you want to watch what they're doing, `logs/gpt_sovits.log`
and `logs/orchestrator.log` (repo root, gitignored, created on first run)
have exactly what the old visible terminal windows used to show you.

Type something in the input box and hit Enter -- or click the mic button
and talk, then click it again to stop (it's a toggle, not press-and-hold)
-- or just hold F9 and talk, release when you're done (this one *is*
press-and-hold, and works globally: you don't need Luna's window focused,
so you can hold F9 while a game or anything else has focus). Either way
you should hear her reply in her own words (not a canned line), possibly
as a few short bursts of speech in quick succession as each sentence
finishes generating rather than one long clip -- that's expected, it's
the streaming pipeline working, not a bug. The first time you use the
mic (button or F9), Windows/WebView2 will prompt for microphone
permission; allow it.

**Quitting:** use the tray icon's Quit item, not just closing the window
(closing just hides it -- Luna's meant to live in the tray). Quit now
tries a graceful shutdown of the orchestrator first (so Phase 3
consolidation actually gets to run -- see `docs/DECISIONS.md`), falling
back to a hard kill after ~5s for anything still alive, so it still can't
hang or leave orphans behind either way. If you ever kill the app a
harder way (Task Manager, etc.), that graceful path is skipped entirely
-- expect that session's memory not to be saved, and check Task Manager
for orphaned `python.exe` processes afterward regardless.

## If something doesn't work



New in this round:

- **GPT-SoVITS/orchestrator don't seem to start at all when you launch the
  app:** check `src-tauri/launcher.local.txt` exists and has the right
  `GPT_SOVITS_DIR` (copy from `.example` if you haven't yet), and check
  `logs/gpt_sovits.log` / `logs/orchestrator.log` for what actually
  happened -- these replace the old visible terminal windows' output.
- **Mic blinks/reacts to F9 or the button, but she never hears or
  responds, and typed chat stops working right after too:** this was a
  real, now-fixed bug -- a model that failed once (e.g. the missing CUDA
  DLL case below, back when `stt.device` was `"cuda"`) was getting reused
  on every later attempt instead of rebuilt fresh, which could hang
  instead of failing the same clean way. Fixed by dropping the cached
  model on any STT failure. If it still happens, check
  `logs/orchestrator.log` for `[luna] received N bytes of audio`,
  `[luna] loading faster-whisper model...`, and `[luna] transcribing...`
  lines -- whichever is the *last* one to print pinpoints the stuck stage.
  After 90s it times out and recovers either way.
- **Mic/F9 records fine but nothing ever comes back, no error at
  all:** check for a `[luna] STT failed: ...` line in the log -- that's
  the actual underlying error, printed instead of failing silently.
- **Orchestrator won't start at all, `ModuleNotFoundError: No module
  named 'faster_whisper'`:** run `pip install -r requirements.txt` again
  in your orchestrator venv -- this isn't STT-specific, `stt.py` is
  imported at the top of `app.py`, so the whole orchestrator (typed chat
  included) won't start until this dependency is actually installed.
  Double check you're actually running it from inside `orchestrator/`
  with the venv active (`(venv)` in your prompt) -- running `pip install`
  from the repo root, or with the venv not activated, silently installs
  nowhere useful and looks identical to having done it right.
- **Orchestrator won't start / no traceback you can make sense
  of:** if you just edited `tts.gpt_sovits.ref_audio_path` (or any other
  Windows path in `config.yaml`), check you used single quotes
  (`'C:\Users\...'`) not double -- double-quoted YAML strings treat
  backslashes as escape codes, so `"C:\Users\..."` fails to parse. See
  `docs/DECISIONS.md` for the full story.
- **`[luna] STT failed: Library cublas64_12.dll is not found or cannot be
  loaded`** (or a similar `cudnn_*.dll`/`cublas*.dll` message):** confirmed
  real on this project -- `stt.device: "cuda"` needs cuBLAS/cuDNN DLLs on
  `PATH` that `pip install faster-whisper` does not provide. `stt.device`
  defaults to `"cpu"` now for exactly this reason (see
  `docs/DECISIONS.md`); if you've switched it back to `"cuda"` and hit
  this, either revert that, or try `pip install nvidia-cudnn-cu12
  nvidia-cublas-cu12` in the orchestrator venv (may also need that
  package's DLL folder added to `PATH` -- not confirmed working end to
  end yet).
- **F9 doesn't do anything:** check the orchestrator/Tauri dev console for
  a Rust error on startup -- the global-shortcut registration
  (`src-tauri/src/lib.rs`) is new code that's never been run through a
  real Rust compiler (see README's verification section above), so a
  first-run compile error here is more likely than with the rest of the
  Rust side. If it compiled fine but F9 still does nothing, another app
  may already have that hotkey registered system-wide (some games and
  overlay tools grab function keys) -- try a different key in `lib.rs`'s
  `Shortcut::new(None, Code::F9)` line.
- **Clicking the mic does nothing, or the console shows a permission
  error:** Windows/WebView2 should prompt for mic access the first time --
  if you clicked "block" by accident, or it never prompted, check
  `chrome://settings/content/microphone`-equivalent in WebView2's app
  settings, or just try clicking the mic button again.
- **Mic button pulses (recording) but nothing happens after you click it
  again:** check the orchestrator terminal -- most likely the first-ever
  `faster-whisper` model download is still in progress (needs internet,
  only happens once) or failed partway through.
- **The input box briefly shows "Didn't catch that -- try again?":** not a
  bug -- that's `transcript` coming back empty, meaning the mic picked up
  silence or nothing intelligible. Try speaking a bit louder/closer, or
  check the right input device is selected at the OS level.
- **She says "I can't reach my own brain right now":** that's the actual
  in-character fallback line, not a crash -- it means the orchestrator
  couldn't reach the LLM server at all. Check `ollama serve` is actually
  running (`ollama list` in another terminal should work if it is), and
  that `orchestrator/config.yaml`'s `llm.base_url` matches wherever it's

  listening.
- **Long pause, then a wrong-sounding error, or nothing at all:** check the
  orchestrator terminal for a traceback -- most likely the model name in
  `config.yaml` (`qwen3.5:9b` by default) doesn't match what you actually
  pulled. `ollama list` shows exact tags.
- **Audio chunks overlap or play out of order:** shouldn't happen --
  `SpeakQueue` in `src/main.ts` is specifically there to prevent this. If
  it does, that's a real bug worth reporting back with the console output,
  not a config issue.
- **Replies feel slow to start:** the first sentence has to fully generate
  before anything speaks (TTS needs complete text, not partial tokens) --
  a short first sentence from the model helps; a very long, run-on first
  sentence will feel sluggish. This is a known trade-off, not a bug -- see
  `docs/DECISIONS.md`.

Still applies from Phase 1 -- unchanged:

- **Window never appears / `cargo` errors:** almost certainly a Tauri API
  mismatch in `src-tauri/src/lib.rs` -- see the note at the top of that
  file for the likeliest spots, and the compiler error will name the exact
  item that's wrong.
- **Window appears but no model, or a console error mentioning
  `doDrawModel`/Cubism Core:** open devtools (right-click won't work since
  there's no titlebar -- add `"devtools": true` temporarily to the window
  config) and check the Console tab. Most likely one of:
  - a 404 on `Hiyori.model3.json` or `live2dcubismcore.min.js` -- the
    latter is the manual step above, the most common miss;
  - a 404 under `/cubism5/shaders/` -- this fork loads 13 GLSL files at
    runtime from `public/cubism5/shaders/`, already included, but confirm
    they made it into your copy if you're updating an existing checkout.
- **Model appears but is tiny, huge, or off-window:** `SCALE` in
  `src/main.ts` is a starting guess, not measured against your actual
  window size. Adjust the constant and let Vite hot-reload.
- **Model appears but never speaks:** check the orchestrator terminal is
  still running and the status dot in the HUD ever turns solid (means the
  WebSocket connected). If it stays dim, the shell can't reach
  `ws://127.0.0.1:8765/ws` -- confirm the orchestrator is actually up.
- **She speaks but lips don't move:** check the console for errors from
  `lipsync.ts` -- likely an autoplay-policy block on the `Audio` element
  (browsers sometimes require a user gesture before audio plays; typing in
  the input box and hitting Enter should count, but worth confirming) or a
  browser blocking `AudioContext` until user interaction.
- **Memory recall seems to be missing / facts never come up:** check
  `logs/orchestrator.log` for `memory recall:` lines -- most likely
  `nomic-embed-text` hasn't been pulled yet (`ollama pull
  nomic-embed-text`), or `ollama serve` isn't reachable at all. Facts
  (not needing an embedding) should still show up even if only episode
  recall is degraded; if *neither* ever shows up, confirm
  `orchestrator/data/memory.db` actually exists and is growing after a
  few sessions -- if it's not being created at all, check for a
  `MemoryUnavailableError` in the log around startup.
- **Startup prints a `WARNING` about `episode_vectors` / embedding
  dimension:** you (or a config change) swapped the embedding model
  after episodes already existed with the old model's vector width --
  see the warning's own text for the fix (revert the model, or accept
  losing existing episode memory by deleting `orchestrator/data/memory.db`).
- **Telling her to forget something doesn't seem to work:** the forget
  feature only triggers on fairly explicit language ("forget that...",
  "delete that", "stop remembering...") -- check `logs/orchestrator.log`
  for `[luna] forget:` lines either way. It won't catch an implicit
  correction like "actually I like X now" without the word "forget"
  somewhere in there -- that's an open limitation, not a bug (see
  `docs/DECISIONS.md`).
- **She still yaps despite the terseness fix, or still invents specifics
  memory recall shouldn't have produced:** both are prompt-wording fixes
  made without a real Ollama/qwen3.5:9b to test against in the sandbox
  this was built in -- see `docs/DECISIONS.md` for exactly what changed
  and why. If either is still happening after this round, that's useful
  signal the wording alone isn't enough, not a sign something's broken;
  worth flagging so the next fix can go further (e.g. lowering the
  model's temperature, or for recall specifically, making facts
  semantically-filtered the same way episodes already are instead of
  "all facts, always").
- **Stop button doesn't seem to actually stop anything:** check that the
  orchestrator log shows a `stop` message arriving (nothing specific is
  logged for it currently, but a `turn_end` should follow quickly after
  you click it). If audio keeps playing but generation did stop, that's
  a frontend-only issue (`SpeakQueue.stopAll()`/`lipsync.ts`'s `stop()`
  not actually reaching the currently-playing audio element) -- this
  piece only has a `tsc`/build-level check behind it, no real browser
  verification, since there's no browser in the sandbox this was built
  in.
- **Orchestrator fails to start with `WinError 10048` (address already in
  use) on port 8765:** something's already listening on that port --
  most likely a previous orchestrator process that didn't actually exit.
  Run `netstat -ano | findstr :8765` in PowerShell, find the PID in the
  last column, check Task Manager for it (Details tab) -- if it's a
  lingering `python.exe`, end it (`taskkill /PID <pid> /F` or End Task)
  and relaunch. If this keeps happening after a normal tray-icon Quit,
  that points at the graceful-shutdown handshake's Rust half not actually
  working -- see `docs/DECISIONS.md`, that half was never verified in the
  sandbox this was built in.

## Running the tests

The memory subsystem (`orchestrator/memory/`) has a real, non-stub test
suite -- sqlite-vec is a pure local library with no GPU/network
dependency, unlike the LLM/TTS/STT backends, so it's honestly testable
without real hardware:
```
cd orchestrator
pip install -r requirements-dev.txt
python -m pytest memory/test_memory.py -v
```

## Next

Phase 3 (persistent memory) is done -- see `docs/ROADMAP.md` for what's
scoped next (Phases 7-10: VRM/VRoid avatar migration, an emotion system,
a UI overhaul, and environments/cursor-reactions) and `docs/DECISIONS.md`
for why they're sequenced the way they are.
