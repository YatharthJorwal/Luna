# Luna — Local AI Desktop Companion

A fully local, offline-capable desktop pet: a 3D VRM avatar, a real LLM
brain, a tsundere personality, persistent long-term memory, and on-demand
screen/camera vision. She's less a chatbot and more **a guide who lives on
the PC** — tell her what you're trying to do, she gives you the next
concrete step, and keeps half an eye on the screen while that task is
active to nudge you back if you wander off (Task Guide Mode — the flagship
behavior, see `docs/ARCHITECTURE.md`). She never touches the mouse/keyboard
or executes anything herself in Conversation Mode: observe-and-advise only
there — Work Mode is a deliberate, later exception with its own safety
scaffolding, see `docs/ROADMAP.md`'s Phase 11 and `docs/DECISIONS.md`.

**Non-negotiable constraint: 100% local.** No cloud LLM calls, no cloud TTS,
no telemetry. Everything — inference, voice, memory — runs on the user's own
machine. This overrides convenience every time.

## Current status

**This section is a short, current summary — not a running narrative log.**
The full phase-by-phase status lives in `docs/ROADMAP.md`; the full
reasoning behind every non-obvious choice, bug, and real-machine finding
(round by round, phase by phase) lives in `docs/DECISIONS.md`. Both get
updated every session that touches them. When you finish a session, update
*those* files with the detail, and update this section only if the
one-paragraph summary below is now wrong — don't append another
paragraph of narrative here. (This section used to be ~485 lines of exactly
that; every bit of it already existed in `docs/DECISIONS.md`/
`docs/ROADMAP.md` in equal or greater detail, so it was cut rather than
migrated — nothing was lost, check either file if something here seems to
reference history you can't find.)

**Where things stand:** Phases 0-4, 7, 8, and 9 are done and confirmed on
the user's real machine (Windows, RTX 3060 12GB). Phase 4's scheduled-
capture/off-task-chide loop (Round 2) is built and unit-tested but **not
yet functionally verified end-to-end** — real-machine testing was blocked
by an unrelated infra issue (a stale GPT-SoVITS process squatting on its
port from a prior session; see `docs/DECISIONS.md`'s most recent entries).
Phase 10 (the sandbox apartment) is frozen as of round 15 by explicit user
decision, in favor of the Tauri shell phases. Phases 5, 6, and 11 haven't
been started. `handoff.md` (regenerated at the end of sessions that change
enough to be worth re-summarizing) has the fastest current on-ramp,
including open questions worth confirming with the user rather than
assuming.

## Docs map

- `handoff.md` — snapshot for orienting a **new session at its start only**:
  current state, the near-term goal, recent issues, outstanding work. Not a
  live document — don't edit it mid-session as things change; regenerate it
  at the end of a session instead. If it disagrees with `docs/ROADMAP.md` or
  `docs/DECISIONS.md`, those two are the source of truth, not `handoff.md`.
- `docs/ARCHITECTURE.md` — system design: the three tiers, why Tauri, why a
  Python orchestrator, personality architecture, memory design, vision
  tools, full Task Guide Mode spec, directory layout.
- `docs/MODELS.md` — which LLM/VLM/TTS to actually run, locked to the user's
  hardware, plus a fallback table if hardware changes.
- `docs/ROADMAP.md` — in/out of scope, phase-by-phase plan and status, open
  decisions still needing input.
- `docs/DECISIONS.md` — why non-obvious things in the code are the way they
  are, especially fixes forced by reality during implementation (e.g. why
  the apartment now loads a single prebuilt model instead of building the
  room procedurally — Phase 10 round 12's entry). Read this before assuming
  something looks like a mistake.
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
- Keep this file's own "Current status" section a short summary, not a
  log — durable narrative/history goes in `docs/DECISIONS.md`, phase
  status in `docs/ROADMAP.md`. This file grew to 500+ lines once by not
  following that; don't let it happen again.
