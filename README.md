# Luna -- Phase 2.5

Shell + Live2D + audio pipeline + a real local LLM brain, now with real
cloned voice output and voice input. Type in the input box (or click the
mic and talk), she thinks with an actual model (via Ollama or llama.cpp,
your choice in `orchestrator/config.yaml`), and replies by voice with
lip-sync, one sentence at a time as she "thinks" of them. See `/CLAUDE.md`
at the repo root for the full architecture and roadmap.

If you're updating an existing Phase 2 checkout: `orchestrator/stt.py` is
new (STT), `src/mic.ts` is new (mic capture), and `src/ws-client.ts` /
`src/main.ts` / `index.html` / `src/style.css` all picked up small
voice-input additions -- no `vendor/` or Live2D asset changes this round.
Run `pip install -r requirements.txt` again in your orchestrator venv
(picks up `faster-whisper`) and `npm install` (no new frontend deps, just
new files).

## What's actually been verified vs. not, honestly

This was built in a Linux sandbox with no GUI, no Rust toolchain, no GPU,
and no network path to Hugging Face (where faster-whisper's model weights
live), so:

- **Verified for real, in this environment:** the orchestrator's LLM
  client (`orchestrator/llm.py`) was run against hand-written stub servers
  matching both the OpenAI-compatible and Ollama-native streaming
  protocols; `orchestrator/stt.py`'s transcription logic (segment-joining,
  empty-audio handling, config passthrough, lazy model construction) was
  verified against a stubbed `WhisperModel`; and `app.py`'s new
  `user_audio` WebSocket handling was driven end-to-end through a real
  WebSocket connection (transcript echoed back, turn runs on a non-empty
  result, silence/malformed-audio handled without dropping the connection)
  with stt/llm/tts all stubbed -- same methodology as the LLM verification
  above. The frontend (`src/mic.ts`, `src/ws-client.ts`, `src/main.ts`)
  passes a full `npm run build` (real `tsc` typecheck + Vite production
  build, zero errors), the same bar every phase has been held to.
- **Not verified, because I had no way to:** actual faster-whisper model
  weights (no Hugging Face access from this sandbox -- the *code path* is
  verified, the *transcription quality* isn't), a real microphone, and
  whether WebView2's mic permission prompt behaves the way Chrome's does.
  Same standing caveats as before on the visual/audio side -- no display,
  no WebGL, no Windows box here, so seeing/hearing all of this actually
  work together (mic click → she visibly hears you → she replies in her
  cloned voice) is still first-run-on-your-machine territory.

Expect to still fix small things on first run -- normal for anything that's
never touched real model weights or a real mic, not a sign something's
fundamentally wrong.

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

The Hiyori sample model in `public/live2d/Hiyori/` is already included --
it's Live2D's own official free sample, licensed for exactly this kind of
prototyping. Swap it for a licensed/purchased/commissioned model before
this becomes anything more than a local dev build (see CLAUDE.md's open
decisions).

## Run it

Three things running, in order, in separate terminals -- or write yourself a
`start-luna.bat` that launches all of them (it's gitignored, since it'll
have your machine's actual absolute paths in it -- GPT-SoVITS's folder,
this repo's folder -- baked in, same reasoning as why
`config.yaml`'s real `ref_audio_path` stays local-only too).

**1. Ollama** (if not already running as a background service -- the
Windows installer usually sets this up for you; check the system tray
first):
```
ollama serve
```

**2. GPT-SoVITS API server** (optional -- skip if you're fine with the
`pyttsx3` fallback voice). Start it however its own docs say to for your
setup; the orchestrator just needs it reachable at whatever URL
`orchestrator/config.yaml`'s `tts.gpt_sovits.base_url` points to before
step 3 starts.

**3. Orchestrator:**
```
cd orchestrator
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```
You should see `Uvicorn running on http://127.0.0.1:8765`.

**4. Shell:**
```
npm install
npm run tauri dev
```
Type something in the input box and hit Enter -- or click the mic button
and talk, then click it again to stop (it's a toggle, not
press-and-hold). Either way you should hear her reply in her own words
(not a canned line), possibly as a few short bursts of speech in quick
succession as each sentence finishes generating rather than one long
clip -- that's expected, it's the streaming pipeline working, not a bug.
The first time you click the mic, Windows/WebView2 will prompt for
microphone permission; allow it.

## If something doesn't work

New in Phase 2.5:

- **Orchestrator won't start at all / no traceback you can make sense
  of:** if you just edited `tts.gpt_sovits.ref_audio_path` (or any other
  Windows path in `config.yaml`), check you used single quotes
  (`'C:\Users\...'`) not double -- double-quoted YAML strings treat
  backslashes as escape codes, so `"C:\Users\..."` fails to parse. See
  `docs/DECISIONS.md` for the full story.
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
