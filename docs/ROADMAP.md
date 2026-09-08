# Roadmap

## Scope

### In scope (v1)
- Desktop-pet shell: transparent, click-through-able, always-on-top, draggable,
  system tray, low idle resource footprint (must coexist with a running game).
- Live2D character rendering with idle motion, lip-sync, and a small set of
  emotion-driven expressions.
- Text input box → she replies **by voice only** (TTS + Live2D lip-sync). No
  chat bubble transcript required as the primary UX, though logging internally
  is fine.
- Local LLM "brain" with tool-calling.
- Tsundere personality layer that doesn't degrade the model's actual
  reasoning/coding ability.
- **Task Guide Mode**: when a task is active, she takes screenshots on a
  schedule (not continuously) to check progress, and calls out — in
  character — when the user has drifted off-task, until the task is finished
  or the user explicitly says to drop it. The flagship behavior, not a side
  feature — full spec in `docs/ARCHITECTURE.md`.
- Persistent memory that survives app restarts (not just session/context memory).
- Vision tools, invoked on demand by the model, not a continuous stream:
  screen capture, clipboard read, OCR fallback, camera capture.
- Coding-help and gaming-help as the two flagship use cases.
- **STT (voice input from the user)**, via faster-whisper — added mid-build
  (was explicitly out of scope in the original Phase 0 spec below; see
  Phase 2.5 and `docs/DECISIONS.md` for when/why this changed). Confirmed
  working end-to-end on the user's machine as of Phase 2.5, including a
  full voice turn actually completing (currently CPU, see Phase 2.5).

### Explicitly out of scope (v1)
- No continuous/always-on camera or screen streaming into context.
- No cloud fallback mode.
- No elaborate avatar customization, marketplace, monetization, or multi-character
  support. One character, done well.
- No auto-playing games or taking control of input devices — she can *see* and
  *advise*, not act on the user's behalf.
- Live2D model asset itself is **not something Claude generates** — needs to
  be sourced (free sample for prototyping, purchased, or commissioned) and
  licensed properly by the user.

## Phases

(✅ done and confirmed on the user's machine · 🔶 built and sandbox-verified,
awaiting on-machine confirmation · ⬜ not started)

- ✅ **Phase 0 — Spec.** This doc set.
- ✅ **Phase 1 — Shell MVP.** Tauri window (transparent, click-through,
  always-on-top, tray), Live2D model idling on screen, input box, a canned
  line plays through the TTS pipeline end-to-end. Shipped with the Hiyori
  placeholder model, a placeholder pyttsx3 voice, and no LLM yet — see
  `docs/DECISIONS.md` for what changed from the original plan while building
  this (notably: Live2D rendering library swap, manual lipsync). Confirmed
  working on the user's machine.
- ✅ **Phase 2 — Brain online.** Wire the local LLM/VLM server in (see
  `docs/MODELS.md` for the pick), single-pass tsundere persona prompting,
  streamed text → TTS → lip-sync. Real conversation, session-only memory, no
  tools yet. Built and verified end-to-end in the sandbox (real LLM client
  against a stub OpenAI-compatible server, sentence chunking, session
  history, LLM-unreachable fallback, frontend playback queue) — confirmed
  running on the user's machine against a real local LLM (`qwen3-vl:8b`
  initially); two real bugs found on that first run (lipsync never moved,
  slight audio overlap between chunks) and fixed — see `docs/DECISIONS.md`.
- ✅ **Phase 2.5 — Voice input/output upgrade.** Pulled forward from Phase 6
  mid-build once a usable voice reference sample was in hand. GPT-SoVITS
  backend in `orchestrator/tts.py` is built, verified against a stub server
  matching the real API contract, and confirmed working end-to-end on the
  user's machine (`tts.engine: "gpt_sovits"`, real `ref_audio_path`/
  `prompt_text` filled in, response validation added after the user found
  a real gap in it) — falls back to pyttsx3 automatically if the server's
  unreachable. STT via faster-whisper is built: mic capture in the
  frontend (`src/mic.ts`, click-to-toggle via the mic button *or* an F9
  global push-to-talk hotkey — `tauri-plugin-global-shortcut` in
  `src-tauri/src/lib.rs`, one real compile error found and fixed on first
  `cargo build`, see `docs/DECISIONS.md`) sends audio to the orchestrator
  (`orchestrator/stt.py`) over a `user_audio` WebSocket message,
  transcribed and fed into the same turn-handling path `user_text`
  already used. Two real bugs found from actual on-machine testing and
  fixed: (1) `stt.py` had no error handling at all, unlike `llm.py`/
  `tts.py`, so a backend failure was silently killing the WebSocket
  connection — now wrapped in `STTError`, caught in `app.py`, logged and
  spoken as an in-character fallback line; (2) the real error underneath
  that turned out to be a missing CUDA DLL
  (`cublas64_12.dll not found`), and — the subtler bug — the failed model
  object was staying cached and getting reused on every later attempt,
  hanging instead of failing the same clean way each time. Fixed by
  dropping the cached model on any failure, and by reverting `stt.device`
  from `"cuda"` back to `"cpu"` (works with zero extra setup; CUDA is a
  documented, revisitable optimization, not a blocker — see
  `docs/DECISIONS.md`). Also reworked how everything launches:
  `spawn_backend_processes()` in `lib.rs` now spawns GPT-SoVITS and the
  orchestrator itself as hidden child processes when the Tauri app starts
  (TCP-polls GPT-SoVITS's port instead of a blind timeout, kills both on
  tray Quit, needed a `PYTHONIOENCODING`/`PYTHONUTF8` fix the user found
  themselves for a Windows console-encoding crash), replacing the old
  three-terminal `start-luna.bat` with a single `npm run tauri dev` —
  confirmed compiling and running end-to-end on the user's machine.
  Confirmed on the user's machine: a full voice turn actually completing
  end-to-end on CPU, mic button and F9 push-to-talk both.
  See `docs/MODELS.md` for the STT API shapes and `docs/DECISIONS.md` for
  the device/lazy-load/hotkey/CUDA/launcher choices and the full bug
  trail. Also folds in the model swap to `qwen3.5:9b` (see
  `docs/DECISIONS.md`), done as part of this same push since it surfaced
  from the same real-hardware testing round.
- ✅ **Phase 3 — Persistent memory.** SQLite facts/episodes with
  `sqlite-vec` for semantic recall over past-episode summaries (embedding
  via Ollama's `nomic-embed-text`, `/api/embed` request shape checked
  against current docs rather than assumed), a consolidation job that
  distills each session into candidate facts + one episode summary on
  disconnect, and recall injected into the LLM call each turn as an
  ephemeral system message (never written into persisted session
  history, so it can't grow stale or leak into consolidation's own input).
  Plus an explicit "forget that" feature (`memory/forget.py`) — regex-
  gated, small-model-classified, deletes on the spot rather than waiting
  for session-end consolidation — scoped to what was actually asked for
  (explicit forget language), not automatic contradiction detection,
  which stays an open limitation. Sandbox-verified for real, not just
  stub-shaped, unlike prior phases' backend integrations — sqlite-vec is
  pure-C with no GPU/network dependency, so the DB layer (schema, CRUD,
  the actual vec0 nearest-neighbor query, forget's deletion path) has a
  real committed test suite (`orchestrator/memory/test_memory.py`, 29
  tests, the first committed tests in this repo) rather than only ad hoc
  sandbox verification. Two real sqlite-vec bugs found and fixed this
  way, not anticipated from docs alone: a bound `LIMIT ?` parameter isn't
  accepted on a vec0 KNN query (needs `k = ?` instead), and `facts`
  needed an `id DESC` tiebreaker alongside `created_at DESC` since
  `datetime('now')` only has 1-second resolution. `app.py`'s wiring
  (recall + forget injection, consolidation firing on disconnect)
  verified end-to-end through a real WebSocket connection with
  recall/consolidation/LLM/TTS stubbed. Confirmed on the user's actual
  machine: cross-session recall working naturally in conversation.
  Also fixed as part of this phase: tray Quit (and Ctrl+C, and Task
  Manager) hard-killing the orchestrator process was silently discarding
  every session's consolidation, since `TerminateProcess` gives Python's
  `finally` block no chance to run — found while answering an unrelated
  question about the right way to close the app, not anticipated up
  front. Fixed with a `/shutdown` HTTP handshake (graceful-then-kill),
  Python half verified end-to-end against a real running server, Rust
  half unverified (no toolchain in this sandbox) — see
  `docs/DECISIONS.md` for the full trail, including a test that initially
  passed for the wrong reason before being caught and fixed. Not
  verified: a real Ollama instance actually serving `nomic-embed-text`
  (the client's request/response handling is verified against a stub
  matching current docs, not a real server), and whether `qwen3.5:9b`
  reliably follows the consolidation/forget JSON formats on real
  conversations rather than the synthetic transcripts tested here — both
  parsers are deliberately forgiving specifically because this was a
  real open question, not an assumption.
- ⬜ **Phase 4 — Vision tools + Task Guide Mode.** `capture_screen` +
  `read_clipboard` + OCR fallback, tool-calling loop live. On-demand "look at
  my screen" works for coding help, and the scheduled-capture /
  off-task-chide loop works end-to-end for at least one flagship scenario
  (the Flappy Bird walkthrough is a good test case).
- ⬜ **Phase 5 — Camera + game-assist polish.** Gated camera tool, light
  game-context awareness (e.g. active-window detection), expression/emotion
  mapping refined.
- ⬜ **Phase 6 — Personality & perf pass.** Optional split into two-pass
  planner/persona, voice tuning (refining the GPT-SoVITS voice integrated in
  Phase 2.5 — retraining/re-recording reference audio, emotional range —
  not integrating it fresh; also where a text-normalization pass for
  non-standard interjections like "Tch" would go, since that's a
  pronunciation problem more than a training problem — see
  `docs/DECISIONS.md`), memory quality tuning, profile resource usage
  with a game running to confirm she doesn't cost FPS. Persona rewrite
  (roommate-tsundere framing, flustered-at-flirtation, anti-repetition —
  see `docs/DECISIONS.md`) already done ad hoc, ahead of the rest of this
  phase.
- 🔶 **Phase 7 — VRM avatar migration.** Replaced the Live2D rendering
  stack (`pixi-live2d5` + Cubism) with `three` + `@pixiv/three-vrm` --
  `public/live2d/`, `public/cubism5/`, `vendor/pixi-live2d5/`, and the
  Cubism Core script tag are all gone. `src/main.ts` now sets up a
  Three.js scene/camera/renderer, loads a `.vrm` from `public/vrm/luna.vrm`
  (gitignored -- the user's own model, not source), and drives a simple
  randomized blink loop since VRM doesn't idle-animate on its own the way
  Live2D's authored motion groups did. `src/lipsync.ts` rewritten around
  VRM's `expressionManager` (the `aa`/`ih`/`ou`/`ee`/`oh` viseme-like
  presets) instead of Cubism parameters -- architecturally different, not
  a mechanical port, since `VRMExpressionManager` has no Cubism-style
  snapshot/restore-per-frame cycle (confirmed by reading
  `@pixiv/three-vrm-core`'s actual bundled source, not assumed just
  because it seemed different), so a single shared `requestAnimationFrame`
  loop driving `setValue()` each frame works correctly here, unlike the
  old Live2D code which needed a specific model event hook to avoid being
  silently overwritten. The loading pipeline itself was verified for
  real: downloaded an official VRM1 sample model from `pixiv/three-vrm`'s
  own repo, ran the exact loader code path in a plain Node script,
  confirmed it parses, resolves humanoid bones, and finds the
  `aa`/`blink` expressions the code depends on. Not verified: the actual
  visual result against a real user-designed model -- no browser, no
  GPU, no real `.vrm` file in the sandbox this was built in, so camera
  framing (`CAMERA_POSITION`/`CAMERA_FOV_DEGREES` in `src/main.ts`) is a
  hand-tuned guess, not measured against anything real; see `README.md`'s
  "Putting your VRoid model in" for the full setup walkthrough and what
  to adjust. HUD/input shell (`#hud`, status dot, input box, buttons)
  deliberately untouched -- confirmed it doesn't need to change for this
  migration, only the canvas/rendering code underneath it does.
- ⬜ **Phase 8 — Emotion system + expression control.** Finally uses the
  `emotion` field that's been sitting unused in the `speak` WebSocket
  message since Phase 1 (`ws-client.ts`'s `SpeakMessage.emotion`) to drive
  VRM blendshapes/facial expressions (bored, angry, embarrassed, happy,
  sad, confused, etc.), gradually shifting based on the conversation
  rather than snapping per-line. Some triggers hardcoded (e.g. "confused"
  on a request outside what she can actually do) rather than left entirely
  to the LLM self-reporting emotional state, which a small local model
  won't do reliably as structured output. Depends on Phase 7 (VRM) being
  done first — mapping emotions to Live2D parameters would be
  throwaway work otherwise.
- ⬜ **Phase 9 — UI overhaul.** Replace the plain input box/HUD with
  something more visually considered — color, less utilitarian chrome.
  Pure `index.html`/`style.css` work, no protocol or backend changes, no
  dependency on any other phase — can happen independently, any time.
- ⬜ **Phase 10 — Environments.** Two of the three requested (VR explicitly
  scoped out by the user themselves as currently unachievable): (1) desktop
  companion mode — draggable corner presence, reacting to cursor
  pokes/touches (Talking Tom-style); (2) a fuller sandbox scene she stands
  in, with selectable backgrounds (classroom, home, park, etc.) instead of
  a blank canvas. Both easier on a 3D VRM scene/camera than Live2D's flat
  compositing — depends on Phase 7.

## Open decisions

Resolved:
- GPU/VRAM: RTX 3060 12GB, i5-14400F, 32GB DDR5-4800 → Qwen3.5-9B (re-picked
  from the original Qwen3-VL-8B once Qwen3.5 shipped — `docs/MODELS.md`,
  `docs/DECISIONS.md`).
- Name: **Luna**.
- OS: **Windows**, confirmed during Phase 1 build.
- Live2D rendering library: `pixi-live2d5` (vendored), see `docs/DECISIONS.md`.
- Voice reference source for TTS cloning: user has a sample in hand. Rights
  to it are on the user to confirm — not something this doc can verify.
- STT: in scope after all, via faster-whisper (Phase 2.5) — see the scope
  section above.

Still open:
- Task Guide Mode tuning: screenshot interval while a task is active, and how
  aggressive the nagging should be (fixed, or a tone dial the user can turn
  down when they're not in the mood to be chided).
- Live2D model source for anything beyond local prototyping (free sample vs.
  purchased vs. commissioned) and its license terms.
