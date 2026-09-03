# Luna -- Phase 2

Shell + Live2D + audio pipeline + a real local LLM brain. Type in the input
box, she thinks with an actual model (via Ollama or llama.cpp, your choice
in `orchestrator/config.yaml`), and replies by voice with lip-sync, one
sentence at a time as she "thinks" of them. See `/CLAUDE.md` at the repo
root for the full architecture and roadmap.

If you're updating an existing Phase 1 checkout: nothing in the frontend
build changed except `src/main.ts` (a small addition, not a rewrite), so a
normal `git pull` / bundle apply + `npm install` is all you need -- no
`vendor/` or Live2D asset changes this round. The `pixi-live2d5` library
swap from early Phase 1 is old news at this point; see
`docs/DECISIONS.md` if you're curious why it happened.

## What's actually been verified vs. not, honestly

This was built in a Linux sandbox with no GUI, no Rust toolchain, and no
GPU, so:

- **Verified for real, in this environment:** the orchestrator's new LLM
  client (`orchestrator/llm.py`) was run against a hand-written stub server
  that speaks the exact same OpenAI-compatible streaming protocol Ollama
  does, driven by a real WebSocket client end-to-end -- sentence chunking
  (`chunking.py`), session history accumulation across multiple turns,
  history trimming at the configured cap, a fresh connection getting fresh
  (not leaked) history, and the in-character fallback line when the LLM
  server is unreachable all confirmed working, not just read over. The
  frontend's new `SpeakQueue` in `src/main.ts` passes a full
  `npm run build` (real `tsc` typecheck + Vite production build, zero
  errors), the same bar Phase 1 was held to.
- **Not verified, because I had no way to:** an actual local LLM. The stub
  server proves the *protocol handling* is correct, but Ollama/llama.cpp
  themselves, real `qwen3-vl:8b` output quality, and GPU memory/VRAM
  behavior under load are all unverified until you run it. Same standing
  caveats as Phase 1 on the visual/audio side -- no display, no WebGL, no
  Windows box here, so seeing her actually speak in sentence-chunked bursts
  with correct queueing (not overlapping audio) is still first-run-on-your-
  machine territory.

Expect to still fix small things on first run -- normal for anything that's
never touched a real model server, not a sign something's fundamentally
wrong.

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
  ollama pull qwen3-vl:8b
  ```
  (~6 GB download; fits comfortably alongside everything else on a 12GB
  3060 since Ollama loads/unloads the model on demand.) Prefer llama.cpp
  instead? It works unmodified -- just point `orchestrator/config.yaml`'s
  `llm.base_url` at your llama.cpp server's OpenAI-compatible endpoint
  (usually `http://127.0.0.1:8080/v1`) instead of Ollama's.

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

**2. Orchestrator:**
```
cd orchestrator
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```
You should see `Uvicorn running on http://127.0.0.1:8765`.

**3. Shell:**
```
npm install
npm run tauri dev
```
Type something in the input box and hit Enter. You should hear her reply
in her own words this time (not a canned line) -- possibly as a few short
bursts of speech in quick succession as each sentence finishes generating,
rather than one long clip. That's expected; it's the streaming pipeline
working, not a bug.

## If something doesn't work

New in Phase 2:

- **She says "I can't reach my own brain right now":** that's the actual
  in-character fallback line, not a crash -- it means the orchestrator
  couldn't reach the LLM server at all. Check `ollama serve` is actually
  running (`ollama list` in another terminal should work if it is), and
  that `orchestrator/config.yaml`'s `llm.base_url` matches wherever it's
  listening.
- **Long pause, then a wrong-sounding error, or nothing at all:** check the
  orchestrator terminal for a traceback -- most likely the model name in
  `config.yaml` (`qwen3-vl:8b` by default) doesn't match what you actually
  pulled. `ollama list` shows exact tags.
- **Audio chunks overlap or play out of order:** shouldn't happen --
  `SpeakQueue` in `src/main.ts` is specifically there to prevent this. If
  it does, that's a real bug worth reporting back with the console output,
  not a config issue.
- **Replies feel slow to start:** the first sentence has to fully generate
  before anything speaks (TTS needs complete text, not partial tokens) --
  a short first sentence from the model helps; a very long, run-on first
  sentence will feel sluggish. This is a known Phase 2 trade-off, not a
  bug -- see `docs/DECISIONS.md`.

Still applies from Phase 1 -- unchanged this phase:

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

Persistent memory: SQLite facts/episodes, a consolidation job, and recall
injected into the system prompt each turn -- so she remembers things across
restarts, not just within one session. Nothing in the frontend needs to
change again; it's still orchestrator-only work.
