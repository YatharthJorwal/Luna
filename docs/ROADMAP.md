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
- **Work Mode** (shell only, explicit toggle, off by default — Phase 11):
  a gated agentic tool harness that can act, not just advise — Playwright
  browser automation, plus the vision tools below. Reverses the
  "observe and advise, not act" line further down this list, deliberately,
  well after that line was first written — see `docs/DECISIONS.md`.
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
- No auto-playing games. Taking control of input devices is otherwise no
  longer categorically out of scope — see Work Mode above and Phase 11 —
  but it's narrow (Playwright browser automation, not general OS input),
  gated behind an explicit toggle, and shell-only; the sandbox/companion
  room stays observe-only with no exceptions.
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
  **Follow-up (Phase 10 round 6):** `graceful_shutdown_then_kill()` above
  only fires from a tray-Quit click or window-close event -- a terminal
  Ctrl+C on `npm run tauri dev` kills the Tauri parent directly
  (confirmed from the user's own log: `STATUS_CONTROL_C_EXIT`), bypassing
  it entirely and orphaning the orchestrator child, still bound to the
  port, with stale state. Fixed with a PID-file takeover in
  `orchestrator/app.py` itself instead of trying to catch a raw console
  Ctrl+C on the Rust/Windows side (real, fiddly, hard-to-verify-without-
  a-Windows-machine territory) -- actually tested in this sandbox against
  a simulated stale process, not just read. Also: `npm run sandbox`
  (`vite --open /sandbox.html` alone) never started the orchestrator at
  all, confirmed from the user's own report and log -- new
  `scripts/dev-sandbox.mjs` launches both together now, actually run and
  SIGINT-tested here too. Full writeup in `docs/DECISIONS.md`'s round-6
  entry.
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
- 🔶 **Phase 4 — Vision tools + Task Guide Mode.** Round 1 built and
  sandbox-verified: `capture_screen` and `read_clipboard` live as real
  tools, wired through a genuine tool-calling loop in `app.py`'s
  `_run_turn` (`llm.stream_reply_with_tools`, `tools/` package). "Look
  at my screen" / "what's on my clipboard" now works as an on-demand
  ask mid-conversation -- the model decides whether to call a tool,
  the orchestrator runs it and hands the result back, up to
  `MAX_TOOL_ROUNDS` (3) chained calls before giving up gracefully
  (`TOOL_STUCK_LINE`). `capture_screen` returns a *text description*,
  never raw pixels, via a small internal one-shot VLM call
  (`llm.describe_image`) -- matches `docs/ARCHITECTURE.md`'s "pull, not
  push" vision-tools section exactly. Not gated by Conversation/Work
  Mode -- that's Phase 11, still ahead of this in the build order but
  documented first; these two tools are simply always available for
  now, same as Phase 4 was originally scoped before Phase 11 existed.

  **Sandbox-verified for real:** 21 new tests (`test_llm.py`'s
  `_normalize_tool_calls` parsing, `tools/test_tools.py`'s vision
  functions with `PIL.ImageGrab`/`pyperclip` mocked), plus three ad hoc
  end-to-end runs through the actual `app.py`/`_run_turn` code with a
  fake `llm.stream_reply_with_tools`: one confirming a full
  tool-call → result → final-reply round trip (including that the
  emotion tag and transcript log both come out right on the far side
  of a tool call), one confirming the `MAX_TOOL_ROUNDS` cap actually
  stops a model stuck re-calling a tool instead of hanging the turn,
  and one confirming plain no-tool-call turns and the LLM-unreachable
  fallback are both completely unaffected by any of this (regression
  check against Phase 2/9's existing behavior).

  **Not verified, real unknowns until tested on the user's machine:**
  whether Ollama actually emits `tool_calls` reliably through its
  *streaming* endpoint for `qwen3.5:9b` specifically (this has never
  talked to a real Ollama instance at all) -- `llm.py`'s own docstrings
  flag the fallback plan (a non-streaming detect-then-stream shape) if
  the streaming path doesn't hold up in practice; whether
  `PIL.ImageGrab.grab()` and `pyperclip.paste()` behave as expected on
  the user's real Windows machine/multi-monitor setup (this sandbox has
  no display at all); and whether `qwen3.5:9b` actually reaches for
  these tools sensibly rather than over- or under-calling them --
  tuning that is real Round 2/3 territory once there's actual usage to
  react to.

  **Not built yet (later rounds):** `ocr_region` (explicitly a fallback
  for imprecise VLM OCR per `docs/ARCHITECTURE.md`, not needed for the
  core loop above to work); `capture_camera` (needs its own permission +
  indicator design, per the same doc); and the actual flagship half of
  this phase -- Task Guide Mode's *scheduled* `capture_screen` polling
  and off-task chiding while a task is active. Round 1 only covers
  on-demand tool calls the model makes mid-conversation; nothing here
  runs on a timer yet.
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
- 🔶 **Phase 9 — UI overhaul.** Original scope was pure `index.html`/
  `style.css` work with "no protocol or backend changes" -- that grew by
  one real feature during the actual build, at the user's request: a
  persistent conversation-log panel, which needed a small backend/
  protocol addition after all (see below). Built:
  1. **Pastel/lavender reskin** of the existing HUD -- swapped
     `style.css`'s color variables (cooler violet-on-near-black →
     warmer pink/lavender family) and the caption glow's hardcoded
     colors to match; no structural/layout changes, same transparent-
     stage-is-the-star philosophy as before. **Not verified**: how this
     actually reads on screen -- no browser/GPU in this sandbox, same
     caveat as every other visual change in this project.
  2. **Persistent conversation-log panel.** A new `#log-button` in the
     HUD toggles a floating card (`#log-panel`) listing every turn as
     `{user_name}: ...` / `Luna: ...` pairs, oldest-first, with a
     "Clear Log" button. Backend: a new `transcript_log` SQLite table
     (`memory/db.py`), CRUD in `memory/store.py`, and two new WebSocket
     message types (`get_log`/`clear_log`, answered with `log` --
     see `ws-client.ts`'s protocol comment) -- deliberately separate
     from Phase 3's facts/episodes tables and never read by recall.py
     or written by consolidation.py, since this is a plain verbatim
     record for the user's own review, not something fed back into her
     memory/context. `app.py`'s `_run_turn` now tracks a `spoken_parts`
     list alongside the existing `reply_parts` (they diverge on
     purpose: `reply_parts` feeds LLM history and excludes the
     LLM-unreachable fallback line; `spoken_parts` is everything
     actually sent to `_send_speak`, unconditionally, including that
     fallback line and a partial reply if the turn was stopped
     mid-sentence) and logs one row per turn regardless of how it
     ended. A new `session.user_name` config field (`config.yaml`)
     labels the user's own lines. **Sandbox-verified for real, not just
     reasoned about:** 5 new committed tests in
     `memory/test_memory.py` (roundtrip, blank-input skip, a real
     user-line-with-blank-reply case, clear, clear-on-empty-db — all
     passing alongside the existing 29), plus two ad hoc end-to-end
     WebSocket runs through the actual `app.py` code (real
     `TestClient` websocket, real SQLite writes): one exercising
     `get_log`/`clear_log` directly, one running a full stubbed
     `_run_turn` (fake `llm.stream_reply`/`synthesize`, real everything
     else) confirming the logged text matches exactly what was sent via
     `speak`. Frontend: `npx tsc --noEmit` and a full `npm run build`
     both pass clean with the new markup/CSS/TS in place, and the log
     panel's markup/CSS variables were confirmed present in the actual
     built `dist/` output. **Not verified**: any of it actually working
     in a real browser -- clicking the button, the panel's live
     appearance, scroll behavior -- same no-GPU-no-browser caveat as
     the reskin above; this is "logically checked and type-safe", not
     "seen working."
  Known gaps, not built: the STT-failure fallback line and the
  observer-surface-busy decline are never logged (both happen before
  `_run_turn`, with no corresponding user turn to pair against in the
  requested `user: / assistant:` shape); no export/search over the log
  beyond scrolling it; no pagination (unlikely to matter soon for a
  single-user local app, per store.py's own reasoning).
- 🔶 **Phase 10 — Environments.** Two of the three requested (VR explicitly
  scoped out by the user themselves as currently unachievable): (1) desktop
  companion mode — draggable corner presence, reacting to cursor
  pokes/touches (Talking Tom-style); (2) a fuller sandbox scene she stands
  in, with selectable backgrounds (classroom, home, park, etc.) instead of
  a blank canvas. Both easier on a 3D VRM scene/camera than Live2D's flat
  compositing — depends on Phase 7.
  **Groundwork for (2), round 2:** the sandbox now has a real box room
  (floor, four walls, a ceiling — no fog, no infinite-looking horizon),
  a free-flying spectator camera (WASD + Space/Shift to fly, right-drag to
  look, middle-drag to pan — not tied to the character at all), and her
  movement is no longer player input: `WanderController` (an explicit,
  labeled placeholder for real AI-driven navigation) picks where she walks
  and when she stands still, same locomotion-and-clip machinery as round
  1 otherwise (`walk.vrma` if present, procedural sine-wave walk if not).
  The bigger change: the sandbox now has a *live* connection to the same
  orchestrator the shell does — full chatbox/mic/captions/emotion-driven
  expression (`src/sandbox-hud.ts`, ported from main.ts's own HUD, not
  imported — kept in sync with the `teasing`-emotion/composite-blend and
  individually-fading-caption work landed on `main.ts` in between) — with
  both windows aware of each other so they can't both drive a conversation
  at once (`ws-client.ts`'s `surface`/`surface_status`, `app.py`'s
  driver/observer/promotion logic). This is the one piece that genuinely
  required touching the shell: `main.ts` and `ws-client.ts` both needed a
  small, explicit patch (identify which surface each is, handle being
  locked out if the other connects first) — `index.html`/`style.css`/
  `src-tauri/`/`persona.py` are still untouched. See `docs/DECISIONS.md`'s
  "Phase 10 (partial), round 2" entry for the full reasoning and what's
  verified vs. not. Still open for this phase: the desktop companion mode
  (1) entirely, room/background selection for (2), real
  orchestrator-driven navigation to replace `WanderController`, a real
  sourced walk cycle to replace the procedural placeholder,
  shared/continuous conversation history across a driver-observer
  handoff, and on-machine confirmation of the round-2 scene/lighting
  work (this was built in the same no-GPU/no-browser sandbox every prior
  rendering phase was).
  **Round 3, gesture clips:** the "others — idle, shy, joy, sad as actual
  body language" half of the walk-cycle item above is now partly
  underway — the user supplied eleven real `.vrma` gesture files
  (`Angry`/`Blush`/`Clapping`/`Goodbye`/`Jump`/`LookAround`/`Relax`/`Sad`/
  `Sleepy`/`Surprised`/`Thinking`, more to come). `CharacterController`
  loads all of them best-effort and plays a matching one-shot body
  gesture (`playGesture()`) alongside the facial expression blend
  whenever a turn ends carrying one of five of the six emotion tags —
  see `docs/DECISIONS.md`'s gesture-clips entry for the full mapping,
  the `happy`→Blush stand-in, and what's still unwired
  (`Clapping`/`Goodbye`/`Jump` have no trigger yet — `LookAround`/
  `Sleepy`/`Thinking` picked up a trigger in round 4 below). Not ported
  to `main.ts` (the desktop shell) — that file has no `AnimationMixer` at
  all yet; separate follow-up work. Not verified on-machine — no
  GPU/browser in this sandbox, same caveat as the round-2 lighting/scene
  work above.
  **Round 4 (first real test results):** the user's first on-machine run
  of round 3 surfaced two real bugs, both fixed — a gesture holding its
  final pose forever instead of releasing back to normal (missing
  fade/stop after `clampWhenFinished`), and "moonwalking" (root
  translation wasn't scaled by the same `speedFraction` the leg
  animation was, so her body kept gliding at full speed while her legs
  visually slowed near a target). Also added: occasional idle-variety
  gestures (`lookAround`/`sleepy`/`thinking`, random 8-20s interval)
  while she's just standing still, via a new `IdleGestureScheduler`. See
  `docs/DECISIONS.md` for the full trail. Moonwalk fix not yet
  re-confirmed on-machine.
  **Round 5 ("go big"):** adopted the user's much larger "Hanami" VRMA
  pack wholesale (Overte/Quaternius, Apache-2.0/CC0, properly attributed
  in `public/vrm-animations/NOTICE.md` + `LICENSES/`) — real measured
  walk-cycle speed and phase-locked start/loop/stop replacing round 4's
  guessed-constant patch, five-variant idle + idle-talking pools (the
  "during dialogues, idles" ask), and emotion gestures swapped to the
  pack's fitted `happy`/`sad`/`angry`/`relaxed` clips (the user's own
  `Surprised.vrma` stays — the pack has no equivalent). Two of the user's
  round-3 clips (`Angry.vrma`/`Sad.vrma`) were removed: superseded by the
  swap, and case-collided with the pack's `angry.vrma`/`sad.vrma` on
  Windows. Full writeup, including everything explicitly deferred
  (`world.json` read at runtime instead of hardcoded, turn clips, alt-idle
  stance, seated domain, nod/shake/raise-hand/think), in
  `docs/DECISIONS.md`. Not verified on-machine — no GPU/browser in this
  sandbox, same caveat as every round before this one.
  **Round 6:** first on-machine run of round 5 surfaced three more
  reports — wall clipping, "kinda awkward," and a persisting "walks
  backward" complaint. Wall clipping had a real, provable cause (the
  arrival-phase grace stride had no bounds check) and is fixed with a
  hard position clamp. "Kinda awkward" got one concrete fix (facing now
  turns during the walk-start wind-up, not just once the loop begins)
  and one reasoned-but-unverified tuning change (turn rate slowed from
  an effectively-instant snap to a ~0.8s about-face). The facing
  formula itself was re-derived twice against three.js's own rotation
  convention and no error was found through static analysis — rather
  than ship a fourth guess, `CharacterController` gained a temporary
  on-screen diagnostic comparing computed facing against her actual
  frame-to-frame travel direction, to get real numbers instead of more
  guesses. Also: room lighting brightened via a layer-scoped light that
  can only affect room geometry, never the character (protecting the
  round-2 MToon fix), and a separate orchestrator dev-workflow fix (see
  Phase 2.5 below). Full writeup in `docs/DECISIONS.md`. Verified in
  this sandbox beyond the usual static checks: the pidfile takeover and
  the sandbox launcher script were both actually run and tested here,
  not just read. Not verified: whether the wall-clamp/turn-rate changes
  actually read as fixed, and the facing/direction complaint is
  explicitly still open pending the diagnostic's real numbers.
  **Result:** the user ran it -- facing and travel direction matched
  (417°≡57° vs 58°), ruling out a facing/direction bug entirely. A
  second diagnostic (`debugFootTraceText`, each foot's real world-space
  height range over time) was added to chase the likely real cause
  instead: a foot-plant/gait-quality problem, not a direction one. See
  `docs/DECISIONS.md`.
  **Resolved:** a third diagnostic and a proposed facing-formula flip
  followed (full trail in `docs/DECISIONS.md`, including a detour where
  the flip was reported as "not working" but had actually never been
  applied). Once genuinely tested, the flip was the real fix — **the
  user confirmed she walks forward now.** All three temporary
  diagnostics (`debugFacingTravelText`, `debugFootTraceText`,
  `debugHipsWorldFacingText`) and their on-screen readouts have been
  removed; `directionToFacingAngle()` (the actual fix) stays.
  **Round 6 closed.** The user confirmed on-machine that the remaining
  round-6 tuning (wall clamp, walk-start facing, turn rate, idle-variety
  gestures) all read correctly in motion on top of the already-resolved
  direction fix — she walks properly, idles occasionally, does basic
  gestures, and doesn't clip through walls. Called "a great start."
  Richer animation variety (more gesture types, refined gait) is
  explicitly deferred until the user sources additional custom
  animation packs — not a bug backlog, just paused pending assets.
  **Round 7 (planning only, full apartment) — not built yet, renumbered
  from a parallel session.** The user ran a separate planning
  conversation in parallel with this session's round-5 build work, off
  the same round-4 base — that session never touched code, only these
  two docs, and independently landed on "round 5" for something
  unrelated to this session's round 5. Reconciled by renumbering that
  work to round 7, after this round 6. User wants the box room replaced
  with a real multi-room apartment (kitchen+dining, living room,
  bedroom, bathroom, hobby/work room — reference moodboard,
  MiSide-inspired but explicitly not to be copied 1:1) with her able to
  walk between rooms and do room-appropriate things (sit on the couch,
  cook, read) rather than just wander a blank box. Planned approach,
  sequenced smallest-first:
  1. Room geometry via Blender, but as **asset-pack assembly, not
     freehand modeling** — the user is a Blender layman and this
     sandbox has no GPU/browser to render-check lighting or materials
     blind, so hand-sculpting furniture here would be guessing at
     something nobody can see. CC0/free low-poly furniture packs
     (Kenney-style) arranged into the room layouts, exported `.glb`,
     loaded via `GLTFLoader` the same way the VRM already loads —
     no new rendering pipeline needed, just a second asset type. One
     room first (living room), not all five at once.
  2. Replace `WanderController`'s free-roam bounding box with a
     per-room floor polygon (a navmesh, or even a flat convex-hull
     check to start) so wall clipping is a data problem (define the
     walkable area) rather than a physics problem — deliberately not
     pulling in a physics engine (Rapier/Cannon) for this, nothing
     here needs collision response, just "is this point inside the
     room."
  3. Named anchor transforms per interactive object (couch = sit spot
     + facing, stove = stand spot + facing), authored alongside the
     furniture in Blender or hand-placed after import. Orchestrator
     picks an anchor + activity; she walks to it (existing locomotion)
     then blends into a pose there. The actual sit/cook/read poses are
     new animation clips — this is expected to be the biggest time
     cost in the whole plan, bigger than the room build itself.
  4. A scene-state message alongside the existing surface-awareness
     channel (`ws-client.ts`'s `surface`/`surface_status`) — current
     room, current anchor/activity — fed into `persona.py`'s context,
     so she can talk about "sitting on the couch" because the app told
     her that, not because the LLM guessed it.
  First-person camera (parented to a head bone) is feasible and cheap
  in three.js, but scoped as a spectator/debug view only, *not* the
  channel her situational awareness runs through — see
  `docs/DECISIONS.md`'s round-7 entry for why text scene-state was
  picked over feeding her rendered frames.
  **Paused, not cancelled**, for the same reason round 6's extra
  animation variety is paused: step 3 above (sit/cook/read poses) needs
  animation clips the user is deferring buying. See "Shell-polish vs.
  apartment-build" below for the full reasoning and the room-vs-
  interactions split this suggests if the user wants to make partial
  progress here without waiting on that purchase.
- ⬜ **Phase 11 — Agentic tool harness (Work Mode).** The single biggest
  scope change in this project's history: reverses the original
  "observe-and-advise only, never touches the mouse/keyboard" stance
  from `docs/ARCHITECTURE.md`'s Task Guide Mode spec and the
  "explicitly out of scope" list above — a decision the user made
  deliberately, not an oversight (`docs/DECISIONS.md`). Sequenced after
  Phase 9 (UI) and Phase 4 (vision/OCR), per the user. **Shell only** —
  the sandbox/companion-room experience stays observe-only and
  tool-free by design; none of this reaches `src/sandbox.ts`.

  Two modes, one toggle, shell-side only:
  1. **Conversation Mode (default).** Talking, companionship, memory
     recall/write. No screen capture, no OCR, no camera, no browser
     tool, no cursor. Deliberately the leanest tool surface — both for
     `qwen3.5:9b`'s limited context budget and because this is meant
     to feel like companionship, not a work session.
  2. **Work Mode (explicit opt-in).** `capture_screen` + `ocr_region` +
     `read_clipboard` (Phase 4) plus a new browser-automation tool
     (Playwright) become available: navigate, click, type, read page
     text. Memory recall is off by default in this mode, per the
     user's own framing (save context for the actual task); memory
     *writing* (consolidation) stays on in the background either way.
     Camera stays behind its existing separate permission regardless
     of mode — this doesn't loosen that.

  A third, orthogonal toggle — **Smart Mode** — controls reasoning
  depth, independent of which mode above is active: off is a fast
  single-pass reply/tool-call; on runs a slower plan → act → observe →
  reflect loop before answering, for tasks that need more than one
  tool call chained together. Off by default, same context-budget
  reasoning as Conversation Mode's narrower tool list.

  **Tool-calling format:** Hermes-style function calling (the ChatML
  `<tool_call>`/JSON-arguments schema NousResearch's Hermes line
  popularized, since adopted more broadly) rather than a bespoke
  protocol. **Not verified against this project's actual model:**
  whether `qwen3.5:9b`'s real chat template follows this schema
  reliably — same "logically checked, not confirmed" territory as
  everything else built in this sandbox; needs an on-machine test once
  built, with a forgiving-parse fallback (same philosophy as
  `consolidation.py`/`forget.py`) if it doesn't.

  **Scope of "her own cursor," v1:** a Playwright-controlled browser
  instance — she can navigate, click, and fill forms *inside that
  browser window*, not drive the whole Windows desktop. Meaningfully
  safer than general OS-level input control (a library like
  `pyautogui`/`nut.js` operating real screen coordinates across
  arbitrary apps) and covers most "look this up / fill this form / do
  this web task" asks on its own. Full desktop-wide control is a real
  v2 idea, not this phase — a materially bigger risk surface (a wrong
  coordinate can click anything, not just something inside a
  sandboxed browser tab) and deserves its own design pass.

  **Safety scaffolding, built in from the start:** a visible indicator
  whenever Work Mode's browser tool is actually driving something
  (mirrors the existing camera-indicator precedent below); a short
  list of action types that pause for the user's confirmation before
  firing (anything that submits/sends/pays/deletes) unless the user
  has explicitly told her to proceed without asking for that task; a
  visible log of what she actually did, since this is a brand-new
  trust surface; and a hard stop/abort the user can hit mid-task. None
  of this is built yet — flagged now so it's designed in from the
  first line of code, not retrofitted later.

  **Also folds in, since it's the same shell-focused stretch of work:**
  Phase 10(1)'s still-unbuilt "desktop companion mode" — light idle
  motion in the shell (occasional look-around, noticing the user's
  cursor nearby, an idle pout) layered on the existing lipsync/
  expression system, explicitly **no locomotion** — she's stationary
  in the shell; walking stays sandbox-only (Phase 10(2)/round 6-7).

## Shell-polish vs. apartment-build (current planning discussion)

**Update:** resolved by the user — sequence is Phase 9 → Phase 4 →
Phase 11 (see above), with Phase 10(1)'s shell idle-motion folded into
the Phase 11 push since both land in the same file/system. Apartment
build (round 7) stays paused. Original discussion kept below for the
reasoning trail.

With round 6 closed, two directions were on the table for what comes
next, and neither is a small ask.

**Option A — the apartment build (round 7 above).** A MiSide-style
multi-room apartment with real object interaction (sit, cook, read,
sleep, bathe, watch TV, play games). The user has SweetHome3D
installed but found it hard to use solo as a 3D-modeling beginner —
open to Claude building the room geometry step-by-step instead, with
the user verifying texture/color/atmosphere choices by eye each round
(the usual "not verified — no GPU/browser here" caveat applies to
every visual call made this way, same as every rendering phase before
this one). The real blocker, already flagged in the round-7 planning
note above: the *interaction* half of this (sit/cook/read/sleep/bathe/
play/watch-TV poses) needs bespoke animation clips the user doesn't
have yet and is deferring purchasing for now. The room-geometry half
doesn't strictly need those clips — she could walk and idle in a
nicer room today — but a room full of furniture she can't actually use
is a smaller win than it sounds, and risks real asset-sourcing/
placement effort now for a payoff (the interactions) that's blocked on
a future purchase.

**Option B — shell polish**, several independent pieces of different
size and risk:
- UI overhaul (Phase 9 above) — pastel/waifu-themed chatbox, replacing
  the current utilitarian HUD. Pure HTML/CSS, no protocol changes,
  lowest-risk item on this list, already scoped as its own
  independent phase before this discussion.
- A "hide" toggle for the desktop shell (distinct from the sandbox) —
  minimize/restore without fully quitting, for real (non-sandbox)
  localhost runs. Small and contained: Tauri window-visibility +
  tray-menu work, similar in size to the launcher rework already done
  in Phase 2.5.
- On-demand screen vision + OCR, with an explicit on/off toggle rather
  than an always-on stream — this *is* Phase 4 above (`capture_screen`
  + `read_clipboard` + OCR fallback + tool-calling loop), not a new
  idea: the on/off framing the user asked for (so it doesn't run
  forever and eat RAM) is exactly what this doc's "explicitly out of
  scope" section already commits to ("no continuous/always-on camera
  or screen streaming into context"). This is also the direction the
  flagship Task Guide Mode behavior depends on (`CLAUDE.md`) — building
  it moves the project toward its own stated centerpiece feature, not
  just a nice-to-have.
- Giving her a cursor via Playwright — flagged, not started. Taken
  literally (Luna moving the mouse / executing actions herself), this
  runs directly against `CLAUDE.md`'s own non-negotiable framing: she
  never touches the mouse/keyboard or executes anything herself,
  observe-and-advise only. Building real input control would be
  reversing a constraint the user set for the project themselves, not
  just adding a feature on top of it — worth an explicit confirm before
  any code gets written. (A cursor/highlight *indicator* drawn on top
  of the screen — showing where she means without actually moving
  anything — would fit the existing constraint and might be what was
  actually meant.)

**Current recommendation:** Phase 4 (vision + OCR + Task Guide Mode)
first — it's both the smallest step toward the project's own stated
flagship behavior, and the one item on the shell-polish list that
isn't pure polish. Phase 9's UI overhaul and the shell hide toggle are
good lower-risk companions that can slot in before, after, or
alongside it. The apartment build (Option A) stays parked until the
animation-pack question resolves; if the user wants partial progress
meanwhile, splitting out just the room-geometry half (SweetHome3D
layout → export → load into the existing sandbox, no new interaction
poses yet) is possible without waiting on that purchase.

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
- Round 6 tuning (wall clamp, turn rate, walk-start facing, idle-variety
  gestures): confirmed reading correctly in motion on the user's
  machine — round 6 is closed. See the round-6-closed entry above.
- What comes next: **Phase 9 → Phase 4 → Phase 11**, in that order, per
  the user — see the Phase 11 entry and "Shell-polish vs.
  apartment-build" above. Apartment build (round 7) stays paused.
- Cursor via Playwright: clarified — real action, not just a visual
  indicator, deliberately reversing the earlier observe-and-advise-only
  stance. Scoped to browser automation (not general OS input), gated
  behind Work Mode, shell-only. Tracked as Phase 11's actual build, not
  an open decision anymore.

Still open:
- Task Guide Mode tuning: screenshot interval while a task is active, and how
  aggressive the nagging should be (fixed, or a tone dial the user can turn
  down when they're not in the mood to be chided).
- Live2D model source for anything beyond local prototyping (free sample vs.
  purchased vs. commissioned) and its license terms. (Largely moot since the
  Phase 7 VRM migration, kept here for the record.)
- Full-apartment room build (Phase 10 round 7): paused, not cancelled,
  pending the user sourcing sit/cook/read/sleep/bathe/watch-TV/play-game
  animation clips — see "Shell-polish vs. apartment-build" above.
- Shell hide/minimize toggle for real (non-sandbox) localhost runs: not
  built yet.
