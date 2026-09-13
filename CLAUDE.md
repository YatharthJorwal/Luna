# Luna — Local AI Desktop Companion

A fully local, offline-capable desktop pet: a Live2D body, a real LLM brain,
a tsundere personality, persistent long-term memory, and on-demand
screen/camera vision. She's less a chatbot and more **a guide who lives on
the PC** — tell her what you're trying to do, she gives you the next
concrete step, and keeps half an eye on the screen while that task is
active to nudge you back if you wander off (Task Guide Mode — the flagship
behavior, see `docs/ARCHITECTURE.md`). Observe-and-advise only by default
(Conversation Mode); an explicit, gated **Work Mode** (shell only, Phase 11
in `docs/ROADMAP.md`) lets her act too — e.g. drive a browser via
Playwright for real tasks. This reverses this doc's original framing,
deliberately, per the user (`docs/DECISIONS.md`). The sandbox/companion
room stays observe-only regardless of mode.

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
(faster-whisper, currently on CPU: mic capture in `src/mic.ts` —
click-to-toggle or F9 global push-to-talk via
`tauri-plugin-global-shortcut`, confirmed compiling and working on the
user's machine — → `user_audio` WebSocket message → transcription in
`orchestrator/stt.py` → the same turn-handling path `user_text` already
used). Two real bugs found on the user's machine and fixed: `stt.py` had
no error handling at all (now wrapped in `STTError`, spoken as an
in-character fallback line), and underneath that, a missing CUDA DLL
(`cublas64_12.dll`) plus a subtler bug where the failed model object
stayed cached and hung on reuse instead of failing cleanly again — fixed
by dropping the cached model on any failure, and by reverting
`stt.device` to `"cpu"` for now (CUDA is a documented, revisitable
optimization, not a blocker). Launching also got reworked on request:
`src-tauri/src/lib.rs`'s `spawn_backend_processes()` starts GPT-SoVITS and
the orchestrator itself, hidden, when the Tauri app launches — `npm run
tauri dev` replaces the old three-terminal `start-luna.bat`, confirmed
compiling and running end-to-end (needed a `PYTHONIOENCODING`/
`PYTHONUTF8` fix the user found themselves for a Windows console-encoding
crash). Not yet confirmed: a full voice turn actually completing now that
STT is on CPU with the model-reuse bug fixed — next real-machine round.
Since confirmed on the user's real machine, from an actual screenshot:
the VRM avatar migration (Phase 7) and the emotion/expression system
(Phase 8), both previously sandbox-verified only. The full-body sandbox
(Phase 10) render/scene itself looks correct too, though the phase's
other open items (companion mode, backgrounds, real navigation) remain
unbuilt. **Current animation system (round 5, "go big"):** the sandbox
now uses the "Hanami" VRMA pack (Overte/Quaternius, Apache-2.0/CC0,
attribution in `public/vrm-animations/NOTICE.md`) for a real
measured-speed, phase-locked walk cycle (replacing the earlier
guessed-constant approach), five-variant idle + idle-talking loops, and
`happy`/`sad`/`angry`/`relaxed` emotion gestures. The user's own
`Surprised`/`Clapping`/`Goodbye`/`Jump`/`LookAround`/`Sleepy`/`Thinking`
clips fill the roles the pack doesn't cover. Not ported to the desktop
shell (`main.ts` has no `AnimationMixer` yet).
**Round 6 (first real bug reports, now resolved):** wall clipping (hard
position clamp) and a facing bug during the walk-start wind-up were
fixed directly. The "walks backward"/"moonwalk" complaint took several
diagnostic rounds to actually pin down — three separate diagnostics
(facing-vs-travel, foot-height, hips-bone-world-orientation) all came
back "internally consistent" without catching the real bug, because they
each checked a value against itself rather than against the rendered
result. The actual fix: this model's true forward axis was the opposite
of the usual three.js/VRM1 "-Z is forward" convention every earlier round
assumed (`directionToFacingAngle()` in `src/sandbox.ts`). **Confirmed on
the user's real machine: she walks forward now.** All three temporary
diagnostics and their on-screen readouts have been removed. Full trail
in `docs/DECISIONS.md` — worth reading if a similarly "everything checks
out but it still looks wrong" bug comes up again, since the general
lesson (a self-referential diagnostic can't catch a bug in the shared
assumption both sides were built on) applies beyond this one case.
Also fixed: the orchestrator not resetting on Ctrl+C (PID-file takeover
in `app.py`, actually tested against a simulated stale process) and
`npm run sandbox` never starting the orchestrator at all (new
`scripts/dev-sandbox.mjs`, actually run and SIGINT-tested).
**Round 7 is planning-only** (a separate, parallel conversation's work,
reconciled/renumbered into these docs) — a full multi-room apartment via
CC0 asset-pack furniture, a per-room navmesh, named sit/cook/read
anchors, and a text scene-state channel to `persona.py` rather than a
first-person camera feed. Nothing in round 7 is built yet. **Round 6 is now confirmed closed by
the user** (walks properly, idles, does basic gestures, no wall
clipping — "a great start"); richer animation variety is deferred
until custom animation packs are purchased, and round 7 is paused for
the same reason. Sequencing decided for what comes next: **Phase 9
(UI) → Phase 4 (vision/OCR) → Phase 11 (Work Mode / agentic tool
harness)**. The "cursor via Playwright" question from last round is
resolved — real action, deliberately reversing the observe-and-advise
constraint above, scoped to browser automation, gated behind Work
Mode, shell-only. Full spec: `docs/ROADMAP.md`'s Phase 11 entry.
**Phase 9 (UI overhaul) is now underway**: pastel/lavender reskin plus
a persistent conversation-log panel (grew Phase 9's original "no
backend changes" scope by one real feature -- a `transcript_log` table
and `get_log`/`clear_log` WebSocket messages, see
`docs/ROADMAP.md`). Sandbox-verified for real (committed tests,
`tsc`/`vite build` both clean) but **not yet confirmed in an actual
browser** — no GPU/browser here, same as every prior visual change.
**Confirmed working by the user on their machine.**
**Phase 4 Round 1 is also built** (started once Phase 9 was confirmed):
a real tool-calling loop in `_run_turn`, with `capture_screen` (returns
a text description via an internal VLM call, never raw pixels) and
`read_clipboard` as the first two tools. Sandbox-verified for real (21
new tests, three ad hoc end-to-end runs including the tool-loop-stuck
safety cap and a regression check against plain no-tool-call turns).
**Real unknowns, not yet tested on the user's machine**: whether Ollama
actually streams `tool_calls` reliably for `qwen3.5:9b`, and whether
`PIL.ImageGrab`/`pyperclip` behave as expected on Windows — see
`docs/ROADMAP.md`'s Phase 4 entry for the fallback plan if the
streaming approach doesn't hold up. Task Guide Mode's own scheduled-
capture/off-task-chide loop (the actual flagship half of Phase 4) is
still not built — Round 1 only covers on-demand tool calls.
Full writeup for both rounds in `docs/DECISIONS.md`.
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
- Tool availability is mode-gated (Conversation Mode vs. Work Mode) and
  shell-only, per Phase 11 (`docs/ROADMAP.md`) — the sandbox/companion room
  never gets tool-calling, OCR, or browser/cursor control, by design.
- Prefer editing/extending an existing tool over adding a new overlapping one.
- When a fix or design choice isn't obvious from the diff alone, add it to
  `docs/DECISIONS.md` in the same change, not as an afterthought.
