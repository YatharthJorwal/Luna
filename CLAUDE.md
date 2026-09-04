# Luna — Local AI Desktop Companion

A fully local, offline-capable desktop pet: a Live2D body, a real LLM brain,
a tsundere personality, persistent long-term memory, and on-demand
screen/camera vision. She's less a chatbot and more **a guide who lives on
the PC** — tell her what you're trying to do, she gives you the next
concrete step, and keeps half an eye on the screen while that task is
active to nudge you back if you wander off (Task Guide Mode — the flagship
behavior, see `docs/ARCHITECTURE.md`). She never touches the mouse/keyboard
or executes anything herself: observe-and-advise only.

**Non-negotiable constraint: 100% local.** No cloud LLM calls, no cloud TTS,
no telemetry. Everything — inference, voice, memory — runs on the user's own
machine. This overrides convenience every time.

## Current status

Phase 1 and Phase 2 both confirmed running on the user's machine (Windows,
RTX 3060 12GB) — shell, tray, Live2D rendering, audio pipeline, and a real
local LLM brain all work end-to-end. Two real bugs surfaced on first
real-hardware testing of Phase 2 (lipsync never moved, slight audio
overlap between sentence chunks) and are fixed — see `docs/DECISIONS.md`
for both.

**In progress: Phase 2.5**, pulled forward from the original Phase 6 slot
— swapping the LLM to `qwen3.5:9b` (from the original `qwen3-vl:8b` pick;
see `docs/DECISIONS.md` for why, including a non-obvious protocol change
this forced in `orchestrator/llm.py`), plus real voice (GPT-SoVITS,
confirmed working end-to-end on the user's machine) and STT
(faster-whisper on CUDA: mic capture in `src/mic.ts` — click-to-toggle or
F9 global push-to-talk via `tauri-plugin-global-shortcut` — → `user_audio`
WebSocket message → transcription in `orchestrator/stt.py` → the same
turn-handling path `user_text` already used). Confirmed on the user's
machine: mic button + permission prompt. Not yet confirmed: an actual
transcribed turn completing (first attempt hit a missing-dependency
startup crash, being retried) and CUDA init on their 3060 (untestable in
this sandbox, no GPU here). See `docs/DECISIONS.md` for the device/
lazy-load/hotkey/CUDA choices made building it, including one open
question about the new `src-tauri/src/lib.rs` global-shortcut code that
can only be resolved by an actual `cargo build` on Windows.
Full phase-by-phase status: `docs/ROADMAP.md`.

## Docs map

- `docs/ARCHITECTURE.md` — system design: the three tiers, why Tauri, why a
  Python orchestrator, personality architecture, memory design, vision
  tools, full Task Guide Mode spec, directory layout.
- `docs/MODELS.md` — which LLM/VLM/TTS to actually run, locked to the user's
  hardware, plus a fallback table if hardware changes.
- `docs/ROADMAP.md` — in/out of scope, phase-by-phase plan and status, open
  decisions still needing input.
- `docs/DECISIONS.md` — why non-obvious things in the code are the way they
  are, especially fixes forced by reality during implementation (e.g. why
  `vendor/pixi-live2d5/` exists instead of a normal npm dependency). Read
  this before assuming something looks like a mistake.
- `README.md` — human setup/run instructions, not agent context.

## Working agreement

- Model/engine choices are config, never hardcoded — the LLM endpoint, model
  name, and TTS engine should all live in one config file so they can change
  without touching app logic.
- Don't add cloud calls of any kind without being asked explicitly.
- Keep the persona pass separable from the core reasoning pass in code, even
  while it's collapsed into one prompt for now (`docs/ARCHITECTURE.md`) —
  don't hard-couple them.
- Vision/audio work must never block the Tauri UI thread; long-running work
  belongs in the orchestrator, not the shell.
- Camera access always goes through the explicit permission + indicator path
  in `docs/ARCHITECTURE.md` — don't add a silent/continuous capture mode.
- Prefer editing/extending an existing tool over adding a new overlapping one.
- When a fix or design choice isn't obvious from the diff alone, add it to
  `docs/DECISIONS.md` in the same change, not as an afterthought.
