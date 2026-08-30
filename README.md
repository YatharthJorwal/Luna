# Luna -- Phase 1

**Update:** if you already have a copy of this project running, read this
first. The Live2D rendering library originally used here
(`pixi-live2d-display-lipsyncpatch`) crashes against the Cubism Core version
Live2D currently ships (6.0.1) -- this is a real, currently-open upstream bug
(https://github.com/guansss/pixi-live2d-display/issues/177), not anything
wrong with your setup. This version switches to `omniwaifu/pixi-live2d5`, a
fork built and tested specifically against Core 6.0.1, and moves PixiJS
7 -> 8 to match its peer dependency. It also drops the old library's
`speak()` convenience method (this fork doesn't have one -- confirmed by
reading its source, the hook is there but commented out), so lipsync is now
driven manually in `src/lipsync.ts` via a Web Audio AnalyserNode.

**To update an existing copy:** delete `node_modules` and `package-lock.json`,
replace every file with what's in this archive (the whole project, not just
the changed files -- `vendor/`, `src/`, `public/cubism5/`, and
`package.json` all matter), then `npm install` again. Your
`public/live2dcubismcore.min.js` file doesn't need to change -- it's the
same Core version this fork wants.

Shell + Live2D + audio pipeline, no brain yet. This proves the plumbing
works: a transparent always-on-top window with Luna idling on screen, an
input box, and hitting Enter round-trips through a local WebSocket server
and comes back as spoken (lip-synced) audio. See `/CLAUDE.md` at the repo
root for the full architecture and roadmap.

## What's actually been verified vs. not, honestly

This was built in a Linux sandbox with no GUI and no Rust toolchain, so:

- **Verified for real, in this environment:** the frontend now goes further
  than a type-check -- `pixi-live2d5` was cloned from source, actually built
  (`node scripts/build.js`, no errors), and vendored in prebuilt; `npm run
  build` (full production build, not just `tsc --noEmit`) succeeds against
  it with zero errors. The exact API used in `lipsync.ts`
  (`coreModel.addParameterValueById`, `motionManager.lipSyncIds`) was
  confirmed by reading the fork's actual source, not guessed from docs. The
  orchestrator (`app.py`/`tts.py`) was actually run -- a live WebSocket
  client connected, sent a message, and got back a valid WAV payload
  end-to-end.
- **Not verified, because I had no way to:** actually seeing pixels. No
  WebGL, no display server, no browser in this sandbox -- so while the
  *build* is solid, I can't confirm the model renders, scales, and
  lip-syncs correctly on screen. `SCALE` in `main.ts` is a guessed starting
  value; expect to tune it once you can see her. Same caveat as before on
  the Rust/Tauri side -- no `cargo` here either, though it compiled clean
  on your machine last time, which is a good sign the API knowledge is
  solid.
- **pyttsx3 note:** it uses whatever TTS the OS provides -- SAPI5 on
  Windows, which is what you'll actually run. I tested it here against
  Linux's espeak-ng instead since that's what the sandbox had; same code
  path either way, but SAPI5 itself is untested since I don't have a
  Windows box here.

Expect to still fix small things on first run -- that's normal for a
scaffold that's never touched real hardware or a real GPU, not a sign
something's fundamentally wrong.

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

The Hiyori sample model in `public/live2d/Hiyori/` is already included --
it's Live2D's own official free sample, licensed for exactly this kind of
prototyping. Swap it for a licensed/purchased/commissioned model before
this becomes anything more than a local dev build (see CLAUDE.md's open
decisions).

## Run it

Two processes, in two terminals.

**Orchestrator:**
```
cd orchestrator
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```
You should see `Uvicorn running on http://127.0.0.1:8765`.

**Shell:**
```
npm install
npm run tauri dev
```
First run will take a while (Rust compiling all of Tauri's dependencies).
A transparent window should appear bottom-right of your screen with Hiyori
idling in it. Type something in the input box and hit Enter -- you should
hear a canned line (through your default Windows voice, not the real one
yet) with her mouth moving roughly in sync.

## If something doesn't work

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
    they made it into your copy if you're updating an existing checkout;
  - the `doDrawModel`/Cubism Core error from the old library -- if you see
    this specifically, you're still running old files, see the Update note
    at the top of this file.
- **Model appears but is tiny, huge, or off-window:** expected on first
  run -- `SCALE` in `src/main.ts` is a starting guess, not measured against
  your actual window size (see "What's been verified" above for why).
  Adjust the constant and let Vite hot-reload.
- **Model appears but never speaks:** check the orchestrator terminal is
  still running and the status dot in the HUD ever turns solid (means the
  WebSocket connected). If it stays dim, the shell can't reach
  `ws://127.0.0.1:8765/ws` -- confirm the orchestrator is actually up.
- **She speaks but lips don't move:** check the console for errors from
  `lipsync.ts` -- likely an autoplay-policy block on the `Audio` element
  (browsers sometimes require a user gesture before audio plays; typing in
  the input box and hitting Enter should count, but worth confirming) or a
  browser blocking `AudioContext` until user interaction.

## Next: Phase 2

Wire a real local LLM in behind `orchestrator/app.py` (replacing
`CANNED_REPLIES`) and swap `tts.py`'s pyttsx3 call for a GPT-SoVITS request.
Nothing in the frontend needs to change -- it only knows about the
`{type: "speak", text, audio_b64, mime}` contract.
