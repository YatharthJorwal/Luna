# Roadmap

## Scope

### In scope (v1)
- Desktop-pet shell: transparent, click-through-able, always-on-top, draggable,
  system tray, low idle resource footprint (must coexist with a running game).
- Live2D character rendering with idle motion, lip-sync, and a small set of
  emotion-driven expressions. **Superseded by Phase 7**: shipped as a VRM
  avatar (`three` + `@pixiv/three-vrm`) instead — the feature itself (idle
  motion, lip-sync, expressions) is unchanged and shipped, just not on
  Live2D. Left here as the original Phase 0 spec, not a description of the
  current renderer — see Phase 7's entry and `docs/DECISIONS.md`.
- Text input box → she replies **by voice only** (TTS + lip-sync, Live2D or
  VRM depending on era — see the note above). No chat bubble transcript
  required as the primary UX, though logging internally is fine.
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
- ~~Live2D model asset itself is **not something Claude generates** — needs
  to be sourced (free sample for prototyping, purchased, or commissioned)
  and licensed properly by the user.~~ Moot as of Phase 7 — see the note
  above; the equivalent for the current VRM pipeline is `public/vrm/luna.vrm`
  (gitignored, user-provided, sourced from VRoid Studio per README.md).

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
  once a usable voice reference sample was in hand. GPT-SoVITS TTS
  (`orchestrator/tts.py`, falls back to pyttsx3 if unreachable) and STT via
  faster-whisper (`src/mic.ts` — click or F9 push-to-talk — through
  `orchestrator/stt.py`) both confirmed working end-to-end on the user's
  real machine, mic button and hotkey both, on CPU (STT device — a missing
  CUDA DLL was the blocker, revisitable later, not urgent). Launch also
  reworked here: `spawn_backend_processes()` in `lib.rs` now starts
  GPT-SoVITS and the orchestrator as hidden child processes automatically
  on `npm run tauri dev`, replacing the old three-terminal `start-luna.bat`;
  a later fix (PID-file takeover in `app.py`) closed a gap where a
  terminal Ctrl+C bypassed graceful shutdown and orphaned the orchestrator.
  Also folds in the model swap to `qwen3.5:9b`. Full bug trail (STT error
  handling, the CUDA DLL diagnosis, the launcher rework) in
  `docs/DECISIONS.md`; STT API shapes in `docs/MODELS.md`.
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
- ✅ **Phase 4 — Vision tools + Task Guide Mode.** `capture_screen` +
  `read_clipboard` + OCR fallback, tool-calling loop live. Built: a
  `stream_reply_with_tools()` loop, the two tools, a hard 3-round cap, and
  Ollama's tool-calling behavior confirmed for real against a live
  server. First real test then found tool-calling silently never firing
  at all — root-caused to a stale `SYSTEM_PROMPT` line written before
  these tools existed ("you can only observe and advise," contradicting
  the tool-calling capability offered in the same request), not a
  Pillow/hardware/model-capability issue as first suspected. Fixed, with
  a regression test guarding the old phrase can't silently come back. See
  `docs/DECISIONS.md`'s "Phase 4 Round 1" and "Tool-calling wasn't
  firing" entries for the full step-by-step. **Retested on the user's
  real machine post-fix: confirmed working.**
  **Round 2 — the scheduled-capture/off-task-chide loop, Task Guide
  Mode's other, larger half, is now built too.** New `task_guide.py`
  holds the single-active-task state machine and `check_task_progress()`,
  a VLM call comparing a screenshot against the tracked step via the
  same forgiving-JSON-parse pattern `forget.py` already uses.
  `app.py`'s `ws_endpoint` runs a per-driver-connection background loop
  (`_task_guide_loop`, polling every 15s, real screen checks gated by
  `config.yaml`'s `task_guide.capture_interval_seconds`) that calls
  `_run_task_guide_check` when a check is due: capture, compare, and if
  drifted, generate and speak an in-character chide through the same
  persona/chunking pipeline `_run_turn` uses for a real reply, recorded
  into `history` as her own unprompted turn. An idle timeout
  (`task_guide.idle_timeout_seconds`, default 30 minutes, reset by any
  real user turn) silently drops a tracked task rather than nagging
  someone who has stepped away — no chide, since nobody's there to hear
  it. Mutual exclusion against a real turn in flight is a simple skip
  (never run a screen check and a live reply concurrently on the same
  socket/history).
  **Starting/stopping tracking was originally the model's own
  `set_active_task` tool call (same mechanism as `capture_screen`/
  `read_clipboard`) but real testing showed that doesn't fire reliably
  for this model — moved to `maybe_update_task()`, a dedicated
  classification call structurally identical to `forget.py`'s
  `maybe_forget()`, run every turn and wired into `_run_turn` alongside
  it.** See `docs/DECISIONS.md`'s two "set_active_task never fired"
  entries for the full investigation (an Ollama tool-calling bug that
  turned out to already be fixed on the user's version, then a
  cross-framework test pointing at a genuine 9B model capability
  ceiling rather than anything prompt-fixable). The tool itself is left
  in place as a harmless redundant path. Full test coverage of the
  state machine, parsing, and the new classifier (`test_task_guide.py`,
  plus dispatch-level tests in `tools/test_tools.py`) — same "no
  display/no real Ollama in this sandbox" limit as everything else
  vision-related: the loop's timing, the VLM's actual on/off-task
  judgment quality, whether the new classifier actually fires
  reliably, and whether a chide reads as natural rather than naggy are
  all **not yet verified on the user's real machine.**
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
- ✅ **Phase 7 — VRM avatar migration.** Replaced the Live2D rendering
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
  **Confirmed on the user's real machine:** rendering, the loading
  pipeline, and camera framing all look correct (real screenshot,
  browser tab running the sandbox) -- the "not verified" gap noted above
  is closed.
- ✅ **Phase 8 — Emotion system + expression control.** Finally uses the
  `emotion` field that's been sitting unused in the `speak` WebSocket
  message since Phase 1 -- moved to `turn_end` instead (see
  `docs/DECISIONS.md`; delivered once per whole turn, not per sentence,
  since the client-side blend is what makes the transition read as
  gradual, not the tagging granularity). Mapped to the real standard VRM
  expression presets (`happy`/`angry`/`sad`/`relaxed`/`surprised`/
  `neutral`) at first, not the more colorful example categories this
  entry originally sketched -- those aren't real VRM presets a default
  VRoid Studio export has. Later in the same phase, the app-facing
  `relaxed` tag was renamed `teasing` (a better match for her actual
  default tsundere demeanor) and split from the underlying VRM preset
  name it drives: `teasing` now blends the model's own `relaxed` preset
  with a slice of `angry` for a sultrier, more knowing look, rather than
  a straight 1:1 handoff like the other five (see `docs/DECISIONS.md`). Hybrid trigger design per this entry's own original
  instinct: the LLM tags its own reply with a trailing `[emotion]`
  marker (forgiving parse, same philosophy as consolidation.py/
  forget.py's JSON parsing), and the two canned error-fallback lines get
  a hardcoded emotion instead of faking a tag for text the LLM never
  produced. Found and fixed a real pre-existing bug while wiring this up
  (unrelated to emotion itself): the STT-failure path never sent
  `turn_end` at all, which would leave the frontend's input permanently
  disabled after any failed transcription. Verified for real: tag
  extraction tested against realistic cases (valid tag, stray period,
  no tag, unrecognized tag, and a bracketed word appearing mid-sentence
  rather than at the true end), and the full flow driven through a real
  running server confirming the tag never leaks into spoken audio and
  `turn_end` carries the right emotion. **Confirmed on the user's real
  machine:** the expression blends actually look right in motion --
  closes the "not verified: how it looks in motion" gap noted above.
  Still open, not blocking: whether qwen3.5:9b reliably produces a
  recognizable tag across real conversations rather than the synthetic
  cases tested here.
- ✅ **Phase 9 — UI overhaul.** Two independent pieces landed together:
  a pastel reskin (pure `style.css` color-variable swap, no layout
  change) and a persistent conversation-log panel — scoped bigger than
  originally planned here ("no protocol or backend changes") because the
  user specifically asked for real persistence, not just a styling
  choice. The log panel got its own `transcript_log` SQLite table
  (deliberately separate from Phase 3's facts/episodes, so a raw
  verbatim record never leaks into memory consolidation or recall),
  new `get_log`/`clear_log` WebSocket messages, and a display-only
  `session.user_name` config field. Backend verified for real (5 new
  pytest cases plus two ad hoc end-to-end WebSocket runs through the
  genuine `app.py`). **Confirmed on the user's real machine:** the
  pastel reskin and conversation-log panel render and work correctly —
  closes the "frontend only structurally verified" gap noted above.
  Full reasoning: `docs/DECISIONS.md`'s "Phase 9: pastel reskin + persistent
  conversation-log panel" entry.
- 🔶 **Phase 10 — Environments.** Two of three requested pieces (VR was
  scoped out by the user as currently unachievable): (1) desktop companion
  mode (draggable corner presence, cursor interaction) — **not started**;
  (2) a fuller sandbox scene she stands in — **in progress, frozen as of
  round 15** in favor of the Tauri shell phases (4/9/11).

  **What's built for (2):** a live sandbox (`sandbox.html`) sharing the
  same orchestrator connection as the main shell, with its own
  driver/observer handoff so both windows can't drive a conversation at
  once (`ws-client.ts`'s `surface`/`surface_status`). She has real
  locomotion (`WanderController`, a placeholder for real AI-driven
  navigation — picks where she walks, not player input), a full VRMA
  gesture/idle-variety animation set (the "Hanami" pack, CC0/Apache-2.0,
  attributed in `public/vrm-animations/`), and stands inside a prebuilt
  `.glb` apartment (Sketchfab-sourced — **licensing not independently
  confirmed as reusable**, still open) with real wall/furniture collision
  (`three-mesh-bvh`), a day/dusk/night lighting system, and a
  spectator/first-person camera toggle (`src/camera-modes.ts`).

  **Confirmed working on the user's real machine:** walking direction/
  facing, wall-clamp collision, the round-13/14 lighting and collision
  fixes, and round 15's specific fixes (a pizza-prop texture bug, doors
  re-added by geometric mesh search, stuck-detection for the lack of real
  pathfinding, and confirming this model has no ceiling geometry at all —
  genuinely roofless, not a bug).

  **Still open:** the desktop companion mode (1) entirely; real per-room
  navmesh/boundaries and furniture-anchor data (the model's mesh names are
  generic — round 15's geometric bounding-box search technique could
  extend to finding these too, untried); sit/cook/read animations; a
  sourced (not procedural) walk cycle for edge cases; whether the
  stuck-detection timeout (3s) feels right in practice; and the model's
  licensing.

  Full round-by-round build trail (11 rounds, real bugs found and fixed
  at each stage from actual user screenshots/video, not guessed): see
  `docs/DECISIONS.md`'s Phase 10 entries, condensed but still in order.
- ⬜ **Phase 11 — Work Mode (reversing "observe-and-advise only" for the
  shell).** A real scope change, not a bug fix: the user deliberately
  approved letting Luna actually *do* web-based tasks in the shell when
  asked, rather than only ever describing them — recorded rather than
  silently overwriting the original constraint, since `CLAUDE.md`,
  `docs/ARCHITECTURE.md`, and this doc's own scope section all
  originally stated it unconditionally. Approved: a gated tool-calling
  harness (Hermes-style function calling) in the shell only, off by
  default (Conversation Mode), opt-in per session (Work Mode); "her own
  cursor" as a Playwright-driven browser instance she can navigate/
  click/type/read inside. Explicitly *not* approved (a v2 idea, not this
  phase): general OS-level input control across arbitrary desktop apps
  (`pyautogui`/`nut.js`-style real-screen-coordinate driving) — a
  materially larger risk surface than a sandboxed browser tab, deserving
  its own safety pass rather than riding in on this one. Required
  alongside the harness itself, not as a follow-up: a visible
  active-indicator, confirm-before-irreversible-action, an action log,
  and a hard abort. The sandbox/companion room is entirely unaffected —
  no tools, no camera, no OCR, no cursor there, ever; that boundary
  didn't move. Also decided alongside this: a third toggle, Smart Mode,
  independent of Conversation/Work Mode, controlling reasoning depth
  (single-pass vs. a slower plan→act→observe→reflect loop) as a
  context-budget lever, not a safety mechanism. Nothing in this phase is
  built yet — full reasoning in `docs/DECISIONS.md`'s "Reversing
  'observe-and-advise only' — Work Mode, Phase 11" entry.

## Open decisions

Resolved, kept brief since the phase entries above have the full story:
hardware is RTX 3060 12GB / i5-14400F / 32GB DDR5, model is
`qwen3.5:9b` (`docs/MODELS.md`); name is **Luna**; OS is **Windows**;
STT is in scope via faster-whisper (Phase 2.5); voice reference rights
for TTS cloning are on the user to confirm, not something this doc
tracks.

Still open:
- Task Guide Mode tuning: whether `capture_interval_seconds` (90s
  default) and the chide's tone feel right in real use — not yet
  meaningfully tested (see Phase 4's own entry).
- Phase 10 (sandbox apartment): see that phase's own entry above for
  the current full list — not repeated here to avoid the two going out
  of sync with each other.
