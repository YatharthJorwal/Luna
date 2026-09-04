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
  Phase 2.5 and `docs/DECISIONS.md` for when/why this changed). Built and
  sandbox-verified as of Phase 2.5; awaiting on-machine confirmation.

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
- 🔶 **Phase 2 — Brain online.** Wire the local LLM/VLM server in (see
  `docs/MODELS.md` for the pick), single-pass tsundere persona prompting,
  streamed text → TTS → lip-sync. Real conversation, session-only memory, no
  tools yet. Built and verified end-to-end in the sandbox (real LLM client
  against a stub OpenAI-compatible server, sentence chunking, session
  history, LLM-unreachable fallback, frontend playback queue) — confirmed
  running on the user's machine against a real local LLM (`qwen3-vl:8b`
  initially); two real bugs found on that first run (lipsync never moved,
  slight audio overlap between chunks) and fixed — see `docs/DECISIONS.md`.
- 🔶 **Phase 2.5 — Voice input/output upgrade.** Pulled forward from Phase 6
  mid-build once a usable voice reference sample was in hand. GPT-SoVITS
  backend in `orchestrator/tts.py` is built, verified against a stub server
  matching the real API contract, and confirmed working end-to-end on the
  user's machine (`tts.engine: "gpt_sovits"`, real `ref_audio_path`/
  `prompt_text` filled in) — falls back to pyttsx3 automatically if the
  server's unreachable. STT via faster-whisper is built and running on
  CUDA (`stt.device: "cuda"`, the user's 3060): mic capture in the
  frontend (`src/mic.ts`, click-to-toggle via the mic button *or* an F9
  global push-to-talk hotkey — `tauri-plugin-global-shortcut` in
  `src-tauri/src/lib.rs`, one real compile error found and fixed on first
  `cargo build`, see `docs/DECISIONS.md`) sends audio to the orchestrator
  (`orchestrator/stt.py`) over a `user_audio` WebSocket message,
  transcribed and fed into the same turn-handling path `user_text`
  already used. A real bug found from an actual on-machine symptom (mic
  recorded fine, nothing ever came back — no error, just silence) is
  fixed: `stt.py` had no error handling at all, unlike `llm.py`/`tts.py`,
  so a backend failure (most likely the CUDA cuBLAS/cuDNN DLL gap) was
  silently killing the WebSocket connection. Now wrapped in `STTError`,
  caught in `app.py`, logged to the orchestrator terminal and spoken as an
  in-character fallback line instead. Also reworked how everything
  launches: `spawn_backend_processes()` in `lib.rs` now spawns GPT-SoVITS
  and the orchestrator itself as hidden child processes when the Tauri app
  starts (TCP-polls GPT-SoVITS's port instead of a blind timeout, kills
  both on tray Quit), replacing the old three-terminal `start-luna.bat`
  with a single `npm run tauri dev`. That block hasn't been through a real
  `cargo build` yet — next real-machine round is confirming it compiles
  and that a full voice turn actually completes end-to-end. See
  `docs/MODELS.md` for the STT API shapes and `docs/DECISIONS.md` for the
  device/lazy-load/hotkey/CUDA/launcher choices made building all of this.
  Also folds in the model swap to `qwen3.5:9b` (see `docs/DECISIONS.md`),
  done as part of this same push since it surfaced from the same
  real-hardware testing round.
- ⬜ **Phase 3 — Persistent memory.** SQLite facts/episodes, consolidation job,
  recall injected into the system prompt each turn.
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
  not integrating it fresh), memory quality tuning, profile resource usage
  with a game running to confirm she doesn't cost FPS.

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
