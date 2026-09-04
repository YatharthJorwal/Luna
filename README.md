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
live), so:

- **Verified for real, in this environment:** the orchestrator's LLM
  client (`orchestrator/llm.py`) was run against hand-written stub servers
  matching both the OpenAI-compatible and Ollama-native streaming
  protocols; `orchestrator/stt.py`'s transcription logic (segment-joining,
  empty-audio handling, config passthrough, lazy model construction, and
  now `STTError` wrapping so a backend failure gets surfaced instead of
  silently killing the connection) was verified against a stubbed
  `WhisperModel`/a stubbed failing `transcribe()`; and `app.py`'s
  `user_audio` WebSocket handling was driven end-to-end through a real
  WebSocket connection (transcript echoed back, turn runs on a non-empty
  result, silence/malformed-audio/STT-failure all handled without dropping
  the connection) with stt/llm/tts all stubbed -- same methodology as the
  LLM verification above. The frontend passes a full `npm run build` (real
  `tsc` typecheck + Vite production build, zero errors), the same bar
  every phase has been held to.
- **Confirmed on the user's actual machine:** the mic button renders and
  is clickable and correctly triggers WebView2's microphone permission
  prompt; F9 push-to-talk and the process-spawning global-shortcut Rust
  code both compile clean after one real fix each (E0277 on the hotkey
  code -- see `docs/DECISIONS.md`); the STT silent-failure bug above was
  found from this exact symptom on the user's real machine, not predicted
  in advance.
- **Not verified, because I had no way to:** actual faster-whisper model
  weights or CUDA execution (no GPU, no Hugging Face access from this
  sandbox -- the *code path* is verified, transcription quality and
  whether CUDA init even succeeds on the user's 3060 aren't), a real
  microphone actually capturing intelligible audio start-to-finish through
  a completed voice turn, and the new `spawn_backend_processes()` process-
  supervision Rust code (no Rust toolchain here at all -- see the note at
  the top of `src-tauri/src/lib.rs`; given the hotkey code needed a real
  fix despite similar care, expect this to need at least one too). Same
  standing caveats as before on the visual/audio side otherwise -- no
  display, no WebGL here, so seeing/hearing all of this actually work
  together (mic click or F9 → she visibly hears you → she replies in her
  cloned voice, all auto-started by one command) is still
  first-run-on-your-machine territory.

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
- **CUDA for STT** -- `stt.device` defaults to `"cuda"` (your 3060), which
  needs cuBLAS/cuDNN DLLs on `PATH` that `pip install faster-whisper` does
  **not** install for you. If Ollama/PyTorch/some other GPU tool is
  already on this machine, you may already have them. If mic input fails
  with something like `cudnn_ops64_9.dll not found` (check the
  orchestrator terminal), try `pip install nvidia-cudnn-cu12
  nvidia-cublas-cu12` in the orchestrator venv first -- if that specific
  package name doesn't match what your ctranslate2 version wants, its
  error message plus a search for that exact DLL name should get you the
  rest of the way. If it's more trouble than it's worth, `stt.device:
  "cpu"` with `stt.compute_type: "int8"` in `config.yaml` works with zero
  extra setup, just slower.

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
(closing just hides it -- Luna's meant to live in the tray). Quit is also
what actually stops the GPT-SoVITS/orchestrator processes it started; if
you ever kill the app a harder way (Task Manager, etc.), check Task
Manager for orphaned `python.exe` processes afterward.

## If something doesn't work



New in this round:

- **GPT-SoVITS/orchestrator don't seem to start at all when you launch the
  app:** check `src-tauri/launcher.local.txt` exists and has the right
  `GPT_SOVITS_DIR` (copy from `.example` if you haven't yet), and check
  `logs/gpt_sovits.log` / `logs/orchestrator.log` for what actually
  happened -- these replace the old visible terminal windows' output.
- **Mic blinks/reacts to F9 or the button, but she never hears or
  responds at all:** this was a real bug -- `stt.py` had no error handling,
  so a failure there (most likely the CUDA DLL issue two bullets down)
  used to kill the WebSocket connection silently, with nothing visible
  anywhere. Fixed: check `logs/orchestrator.log` (or the terminal, if
  you're running `python app.py` manually) for a `[luna] STT failed: ...`
  line -- that's the actual underlying error now, instead of nothing.
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
- **Mic input fails with a `.dll not found` error (something like
  `cudnn_ops64_9.dll`):** CUDA's cuBLAS/cuDNN DLLs aren't on `PATH`. Try
  `pip install nvidia-cudnn-cu12 nvidia-cublas-cu12` in the orchestrator
  venv; if the exact package name doesn't match what your `ctranslate2`
  version wants, its own error plus a search for that DLL name will get
  you the rest of the way. Or just set `stt.device: "cpu"` /
  `stt.compute_type: "int8"` in `config.yaml` and skip CUDA for STT
  entirely -- slower, but zero extra setup.
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

## Next: Phase 3

Once STT is confirmed working on real hardware, Phase 2.5 is done. Then:
persistent memory -- SQLite facts/episodes, a consolidation job, and
recall injected into the system prompt each turn -- so she remembers
things across restarts, not just within one session. Nothing in the
frontend needs to change again; it's orchestrator-only work.
