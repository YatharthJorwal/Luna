# Luna

Shell + a VRM 3D avatar + audio pipeline + a real local LLM brain with
persistent memory, cloned voice output, and voice input. Type in the
input box (or click the mic and talk), she thinks with an actual model
(via Ollama or llama.cpp, your choice in `orchestrator/config.yaml`),
remembers things across restarts, and replies by voice with lip-sync,
one sentence at a time as she "thinks" of them. See `/CLAUDE.md` at the
repo root for the full architecture and roadmap.

**Phase 7 (this bundle): the avatar migrated from Live2D to VRM.** If
you're updating an existing checkout with a Live2D model already set up,
that setup is gone -- `public/live2d/`, `public/cubism5/`,
`vendor/pixi-live2d5/`, and the Cubism Core script tag in `index.html`
have all been removed, replaced by `three` + `@pixiv/three-vrm`. You'll
need an actual `.vrm` file to see anything on screen -- see "Putting
your VRoid model in" below.

**After pulling this bundle:**
1. `npm install` -- picks up `three`, `@pixiv/three-vrm`, and
   `@types/three` (this version of three.js doesn't ship its own type
   declarations); drops `pixi.js`/`pixi-live2d5`.
2. Export a `.vrm` from VRoid Studio and drop it at `public/vrm/luna.vrm`
   -- see "Putting your VRoid model in" below for the full walkthrough.
   Nothing renders without this.
3. No orchestrator/Python changes this round -- skip `pip install` unless
   you're also behind on an earlier bundle.

## Putting your VRoid model in

1. **Export from VRoid Studio.** File -> Export -> "Export as VRM" (or
   similar, depending on your VRoid Studio version). Either VRM format
   works -- `main.ts` calls `VRMUtils.rotateVRM0()` on load, which
   auto-detects and corrects the one orientation difference between them
   (a no-op if you exported VRM1, the newer format).
2. **Drop the file at `public/vrm/luna.vrm`** -- that exact path; it's
   what `MODEL_PATH` in `src/main.ts` points at. `public/vrm/` already
   exists (with a `README.txt` reminder) and is gitignored, so your model
   file itself never gets committed -- it's yours, not source.
3. **Run it** -- `npm run tauri dev` as usual. If she doesn't appear:
   check the browser devtools console (right-click the window ->
   Inspect, or check `logs/` if Tauri surfaces it there) for a load
   error. A 404 almost always means the filename/path doesn't match
   exactly; anything else is likely a genuinely malformed export, worth
   re-exporting.
4. **Expect the framing to be off at first.** `CAMERA_POSITION` /
   `CAMERA_FOV_DEGREES` / `CAMERA_LOOK_AT` in `src/main.ts` are a
   hand-tuned *guess* at bust-up framing for a roughly-average VRM
   humanoid's proportions -- they were never tested against a real
   model, only a sample test asset used to verify the loading code
   itself works (see `docs/DECISIONS.md`). Depending on your model's
   actual height/proportions, you'll likely need to nudge these:
   - Model's head is cut off / too zoomed in -> increase
     `CAMERA_POSITION`'s Y and Z values (move the camera back and up).
   - Too much empty space above her head -> decrease `CAMERA_LOOK_AT`'s Y
     value slightly, or decrease `CAMERA_FOV_DEGREES`.
   - Model looks tiny in the middle of the window -> decrease
     `CAMERA_POSITION`'s Z value (move the camera closer).
5. **Lipsync needs the "aa" and "blink" expressions to exist** on your
   model -- these are part of VRM's standard expression preset list, so
   any normal VRoid Studio export should have them automatically (nothing
   you need to configure by hand in VRoid Studio itself). If her mouth
   never moves while she talks, or she never blinks, check your model's
   file in a VRM viewer (e.g. https://hub.vroid.com/en/ has an online one)
   to confirm those expressions are actually present.

## Full-body sandbox (Phase 10 groundwork)

A separate, dev-only page — a second, real way to see and talk to Luna,
not just a static preview. Her space, not yours: you're a spectator here,
flying a free camera around; she's the one who decides where she stands
and walks (today, via a simple placeholder wander behavior — see
`docs/DECISIONS.md` — real AI-driven navigation is a later step).

1. **Run it:** `npm run sandbox` (or `npm run dev` and open
   `http://localhost:1420/sandbox.html` yourself). Same `public/vrm/luna.vrm`
   model as the main shell.
2. **Camera (you):** WASD flies, relative to wherever you're currently
   looking. Space/Shift move straight up/down. Right-click-drag looks
   around in place; middle-click-drag pans; scroll adjusts fly speed.
   You're not tied to her at all — fly wherever.
3. **Her (not you):** she wanders the room on her own and stands still
   while actually mid-conversation. There's nothing here that lets you
   move her directly, on purpose.
4. **Talk to her:** same chatbox/mic/captions as the desktop shell, `/` to
   focus the input. If the shell is *also* open and connected, whichever
   one connected first is the one that can actually talk to her — the
   other shows a status message and won't let you send anything, rather
   than both windows racing to reply at once. See `docs/DECISIONS.md`'s
   "Phase 10 (partial), round 2" entry for exactly how that's decided.
5. **Animation:** with no animation file present, she walks via a small
   procedural (code-only) walk cycle. Drop a `walk.vrma` file at
   `public/vrm-animations/walk.vrma` (see that folder's own `README.txt`)
   to use a real walk cycle instead; picked up automatically on reload, no
   code changes needed.
6. **Tuning:** movement/room constants are at the top of `src/sandbox.ts`
   (`WALK_SPEED_MPS`, `TURN_RATE_RAD_S`, `ROOM_HALF_SIZE`, fly-camera speed
   constants, etc.) — hand-tuned by eye, same spirit as the main shell's
   own `CAMERA_*` constants.

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
  territory. **Phase 7 (VRM avatar migration)**: the loading pipeline
  itself was verified for real, not just typechecked -- downloaded an
  official VRM1 sample model from `pixiv/three-vrm`'s own repo and ran
  the exact loader code path (`GLTFLoader` + `VRMLoaderPlugin`) in a
  plain Node script (with a `self` global polyfill for the one
  browser-only texture-decode call path), confirming it actually parses,
  resolves humanoid bones (`head`, `hips`), finds the `aa`/`blink`
  expressions the lipsync and blink code depend on, and that
  `setValue()` + `vrm.update()` don't throw. Also checked, not assumed:
  whether `VRMExpressionManager` has a Cubism-style snapshot/restore
  cycle that would silently undo a value set from an independent render
  loop (the exact bug that shaped the old Live2D lipsync code's
  architecture) -- read `@pixiv/three-vrm-core`'s actual bundled source
  to confirm it does not, before writing the new lipsync code around
  that assumption. `src/main.ts`/`src/lipsync.ts` both pass a real `tsc`
  typecheck + production `vite build`.
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
  verify. Most significantly for this round: **the actual visual result
  of the VRM migration itself.** There is no browser, no GPU, and no
  real `.vrm` file in the sandbox this was built in, so while the
  *loading pipeline* is genuinely verified (see above -- a real sample
  model, a real loader run, not just a typecheck), whether a real model
  actually renders correctly, whether the camera framing looks anywhere
  close to right, and whether the lipsync/blink actually look good in
  motion are all first-run-on-your-machine territory, more so than
  anything else in this project so far -- see "Putting your VRoid model
  in" above for what to expect and adjust.

Expect to still fix small things on first run -- normal for anything that's
never touched real model weights, a real mic, or a real Rust compiler, not
a sign something's fundamentally wrong.

## Prerequisites (on your machine)

- **Rust** (stable) -- https://rustup.rs
- **Node.js 18+** -- you likely already have this
- **Python 3.11+**
- **WebView2** -- already installed on any up-to-date Windows 10/11, which
  covers you
- **VRoid Studio** (free) -- https://vroid.com/en/studio, for designing
  and exporting your own `.vrm` model. Not needed to build/run the code
  itself, only to have an actual character on screen -- see "Putting
  your VRoid model in" above.
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

No sample model is bundled anymore -- Live2D's Hiyori sample (used during
Phases 1-6) is gone along with the rest of the Live2D stack. Nothing
renders until you drop your own `.vrm` at `public/vrm/luna.vrm` (see
"Putting your VRoid model in" above).

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
- **Window appears but no model, or a console error about loading the
  VRM:** open devtools (right-click won't work since there's no
  titlebar -- add `"devtools": true` temporarily to the window config)
  and check the Console tab. Most likely:
  - a 404 for `/vrm/luna.vrm` -- you haven't dropped your exported file
    at `public/vrm/luna.vrm` yet, or the filename doesn't match exactly;
  - a parse/loader error -- most likely a genuinely malformed export;
    try re-exporting from VRoid Studio, or opening the file in an online
    VRM viewer (e.g. https://hub.vroid.com/en/) to confirm it's valid.
- **Model appears but is tiny, huge, cut off, or off-window:**
  `CAMERA_POSITION`/`CAMERA_FOV_DEGREES`/`CAMERA_LOOK_AT` in
  `src/main.ts` are a starting guess, not measured against your actual
  model's proportions -- see "Putting your VRoid model in" above for
  which constant to nudge for which symptom. Adjust and let Vite
  hot-reload.
- **Mouth never moves while she talks, or she never blinks:** your VRM
  export is likely missing the standard `aa`/`blink` expression presets
  the lipsync/blink code depends on -- check in an online VRM viewer
  (link above). This should be automatic from a normal VRoid Studio
  export; if it's missing, that points at an export issue, not something
  to configure in this code.
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
