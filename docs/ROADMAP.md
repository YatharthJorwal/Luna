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
- 🔶 **Phase 4 — Vision tools + Task Guide Mode.** `capture_screen` +
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
  firing" entries for the full step-by-step. **Retest on the user's real
  machine (the actual app, not an isolated call) still pending** — that's
  the only thing keeping this at 🔶 instead of ✅. The scheduled-capture/
  off-task-chide loop (Task Guide Mode's other half) isn't built yet.
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
- 🔶 **Phase 9 — UI overhaul.** Two independent pieces landed together:
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
  genuine `app.py`); frontend only structurally verified (`tsc`/
  `vite build` clean, markup confirmed in the built output) — same
  "no GPU/browser in this sandbox" limit as everything else. Full
  reasoning: `docs/DECISIONS.md`'s "Phase 9: pastel reskin + persistent
  conversation-log panel" entry.
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
  **Round 6, fully closed:** the user confirmed on their real machine
  that walking reads as fixed overall now — not just the facing
  direction, but the wall-clamp and slower turn-rate changes too. The
  only open item this round left behind is closed; see
  `docs/DECISIONS.md`.
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
  **Round 8: first real apartment render dropped in**, as a standalone
  linked-to page — turned out to be a dead end within one message once
  actually opened from inside the Tauri shell (`target="_blank"` there
  just reopens the shell's own bound window rather than reaching an
  arbitrary route), so it didn't last as the plan. See round 9.
  **Round 9: the apartment replaces `buildStudio()` as the sandbox's
  real scene**, not a linked page — `src/apartment.ts` ports the same
  four-room geometry into an ESM module against this project's own
  `three` (the r128-vs-`^0.185.1` API gap flagged in round 8 is now
  actually resolved, not just noted), and `boot()` builds it directly
  into the character-bearing scene. This is step 1 of the round-7 plan
  above (room geometry), done as a port of the existing asset rather
  than a from-scratch Blender build. Also done this round, ahead of
  where the round-7 plan expected it: a first-pass per-room navmesh —
  point 2 of that plan, "even a flat convex-hull check to start" — as a
  small union of hand-derived clear-floor rectangles chained through
  their overlaps, replacing `WanderController`'s old free-roam square.
  It is not a true navmesh (no polygon geometry, no obstacle avoidance
  within a room) and doesn't attempt point 3 (sit/cook/read anchors) or
  point 4 (the scene-state channel to `persona.py`) at all — those
  remain open below. Full reasoning on the scale conversion, the two
  three.js properties that don't inherit a parent group's scale, and the
  r128-vs-modern light-falloff change, in `docs/DECISIONS.md`.
  **Round 10: full rebuild, not an iteration on round 9.** Every point
  round 9 left open is addressed: `src/apartment/` (four modules) replaces
  the single-file port with a real L-shaped floor plan authored in metres
  from the start (no more dollhouse-unit scale conversion), walls with
  actual punched openings and four doors that open/close on approach,
  furniture rebuilt on rounded/lathed primitives (mesh count 387 → 1173,
  triangle count ~175k, both verified by running the build, not
  estimated), image-based lighting + a GTAO/bloom/SMAA post chain
  (`src/postfx.ts`), a first-person visitor mode alongside spectator
  (`src/camera-modes.ts`, Tab toggles), the scene-state channel to
  `persona.py` that round 9 explicitly left unbuilt (point 4 of the
  round-7 plan, now done), and a proper look-at rig so she tracks the
  camera. The navmesh went from 14 hand-eyeballed rectangles to 20,
  rebuilt after a verification script cross-checked every rectangle
  against furniture.ts's actual placement coordinates and found two real
  bugs (a console sitting inside an open archway; a rectangle overlapping
  the wardrobe) before any of it shipped — full account in
  `docs/DECISIONS.md`. What round 7's plan still calls for and this round
  still doesn't do: sit/cook/read *animation* (she stands at an anchor
  facing a direction, no dedicated poses yet) and true per-room polygon
  navmesh geometry rather than rectangles.
  **Round 11: the first two bugs from actually looking at it, both fixed.**
  Round 10's apartment got its first real screenshots this round, and two
  concrete issues came back: `MODES.day` in `src/apartment/index.ts` was
  stacking sun/hemisphere/environment intensity all above dusk's levels
  simultaneously, plus a boosted exposure on top, reading as a blown-out
  white wash on the mode the scene boots into — brought down to still be
  the brightest mode without three lights and exposure all compounding at
  once. And spectator (flying) mode had no way to hide the per-room ceiling
  planes that already existed in `shell.ts` — added a `setCeilingsVisible`
  toggle (dev-panel row + `KeyH`), scoped to spectator specifically:
  visitor mode always forces ceilings back on. Both verified by actually
  executing `buildApartment()` in Node against real `three` (PMREM/IBL
  stubbed out as unrelated and unchanged; everything else — geometry,
  lighting state machine, the ceiling array — real) rather than just
  type-checked.
  **Round 12: the procedural room replaced entirely with a prebuilt
  model.** Round 11's fix didn't fix the real problem — the *next*
  screenshots showed a UV-checker bathtub texture, a floating disconnected
  towel, a toilet with no bowl, a blown-out mirror. Hand-authored
  procedural geometry and canvas textures, built by someone who can't see
  the result, don't converge. `src/apartment/shell.ts`, `furniture.ts`,
  and `materials.ts` — the entire procedural room — are deleted.
  `src/apartment/index.ts` now loads a prebuilt `.glb` apartment (a
  Sketchfab download the user provided) through the same `GLTFLoader`
  already used for the VRM avatar (VRM is a glTF extension; no new
  dependency). `floorplan.ts` is reduced to one placeholder room/navmesh
  sized to the model's real measured bounding box, since the file has no
  per-room data worth reading (generic `Object_0`, `Object_1`, ... mesh
  names) — a real capability loss (no room-level scene-state, no doors,
  no wall-aware collision) stated plainly rather than hidden, until
  someone who can see the loaded model can point out real room
  boundaries. The round-11 ceiling toggle is gone with `shell.ts`.
  Verification went further than any prior round: the actual 40MB file
  was loaded through the real `GLTFLoader` (not faked) over a throwaway
  local HTTP server, confirming 445 meshes / ~271,754 triangles / 82
  materials — matching a direct `gltf-transform inspect` of the file
  exactly — assembled into a real `THREE.Scene` at the right position and
  scale. Texture *pixel* content still can't be checked (no image decoder
  in Node); full account, including the licensing caveat on the model
  itself (Sketchfab-sourced, webcomic-themed, license not independently
  verified), in `docs/DECISIONS.md`'s round-12 entry.
  **Round 13: first real usage of the round-12 model, six real bugs found
  with evidence.** A video + screenshots came back showing: Luna nearly
  black in every frame, a blown-out TV with bloom ring artifacts, no wall
  or furniture collision ("we clip"), and a "walking in void" patch. Since
  the original `.glb` was still in the sandbox, this round diagnosed from
  the actual file and actual shader source rather than guessing: Luna's
  MToon shader has no `envmap_fragment` include at all (confirmed in
  `@pixiv/three-vrm-materials-mtoon`'s own source) and blends toward a
  black `shadeColor` wherever hemi+sun are too low, so round 12's dim night
  ambient (chosen for the *room's* mood) was independently starving her of
  light with no relation to anything wrong in the room. Fixed with a
  dedicated short-range point light that follows her, decoupled from room
  mood lighting. Separately, parsing the file's own glTF JSON directly
  found that `Porcelain_-_White`/`Couch_Beige` (toilet/sofa) have no real
  `baseColorFactor` at all — rendering at glTF's spec-default pure white —
  and `Gold` (door hardware) is fully metallic at 0.15 roughness, all
  fixed by name. Bloom radius (0.7 → 0.35) was too wide for this model's
  small bright props, causing the ring-artifact halos. Real wall/furniture
  collision added via `three-mesh-bvh` (an established addon, not
  hand-rolled) — merges the whole model into one collision mesh at load
  time; `camera-modes.ts`'s existing sliding-movement code needed zero
  changes since it was already written against an interface, not a
  rectangle directly. A real bug (the first collision-height set was
  catching the floor slab itself, blocking 90% of the building) was found
  and fixed by actually running the query against the real file rather
  than reasoning about the numbers. Also: eye height lowered, dust motes
  made more prominent, and a plain explanation of why literal ray-traced
  reflections aren't feasible in WebGL (real-time hardware ray tracing
  needs `WebGPURenderer`, not `WebGLRenderer`) with `THREE.SSRPass` named
  as the realistic next step if wanted. Full account, including every
  exact material value the fixes are based on:
  `docs/DECISIONS.md`'s round-13 entry.
  **Round 14: round 13's own fixes shipped two new, worse bugs, both
  found from the field.** Walking into any wall repeatedly teleported to
  one of a handful of fixed spots elsewhere in the building (Luna too —
  "even luna is stuck"), and she rendered as a solid white glowing
  silhouette at night. Root causes, both traced to an exact line rather
  than re-guessed: `WalkableArea.clamp()`'s last-resort fallback stepped
  toward the building's *centre* in big fractional jumps, reasoning it'd
  rarely run — but `CharacterController.moveClamped()` (Luna's own
  movement) called it on *every* blocked step with no sliding attempt
  first, and velocity smoothing made the visitor camera's supposedly-rare
  fallback common too. Fixed by searching a small ring (0.08–0.6m) around
  the blocked point instead of jumping toward the centre, and giving her
  movement the same axis-sliding the visitor camera already had.
  Separately, the round-13 fill light was positioned close enough to her
  own body (~0.2-0.3m) that physically-correct point-light falloff
  amplified it 8-25x — an order-of-magnitude miscalibration, not a subtle
  one. Fixed by moving it well above her head instead of at chest height,
  softening falloff, and cutting intensity 3-4x on top of that. Also
  added a general emissive-brightness cap (any material's peak emissive
  above a ceiling gets scaled down) after "many things are still
  glowing" suggested round 13's single-material fix wasn't broad enough,
  and lowered the spectator fly-speed ceiling (pre-existing, scroll-wheel
  adjustable, not touched by round 13, but 24 units/s across a real ~19m
  building reads as "lightspeed" regardless of how it got there). The
  clamp fix was verified against the real collision geometry, not just
  reasoned about: the exact class source, run against the real file's
  BVH, resolved every one of 67 real blocked test points to within 0.56m
  — nowhere near the multi-metre jumps possible before. Full account in
  `docs/DECISIONS.md`'s round-14 entry.
  **Round 15: round 14 confirmed working — pizza, doors, ceiling, and the
  "stuck" complaint.** First real confirmation that round 14's fixes hold
  up ("works properly"), followed by four smaller, specific asks: a pizza
  prop rendering as a solid black disc, Luna "walking into the wall for
  the last 10 minutes" (a pathfinding gap distinct from round 14's
  teleport bug), furniture boundaries, and door/ceiling functionality —
  both removed in round 12 for lack of any way to identify the meshes by
  name. Investigated each directly against the file: the pizza turned out
  to be a real UV-mapping bug in the source file itself (the mesh's UVs
  span nearly the whole texture atlas, sampling mostly the atlas's dark
  padding instead of the small centred pizza artwork) — fixed with a flat
  color sampled from the actual artwork's pixels rather than a texture
  remap with no way to verify the crop. The "stuck" complaint got
  stuck-detection added to `WanderController` (not real pathfinding, which
  would need per-room data this model still doesn't have — abandons an
  unreachable target after 3 seconds of no progress instead of pushing
  into a wall indefinitely). Doors and the ceiling were both re-
  investigated by scanning every mesh's actual world-space bounding box
  for door-panel and ceiling-panel shapes respectively: found 7 real
  door-shaped meshes at 5 locations (re-added as proximity-based
  disappear/reappear, not a hinge swing — geometry doesn't say which way
  a door should swing), and found no ceiling meshes at all — this model
  is genuinely roofless, an open-top "dollhouse" style scene, not a
  round-12 gap to close. A real bug was found and fixed the same way
  every collision issue in this project has been: door "open" checks
  were being overridden by nearby wall/frame geometry in the static BVH
  until the priority was flipped so being inside a door's box settles
  the question outright. Full account in `docs/DECISIONS.md`'s round-15
  entry. Still not verified: whether the stuck-detection timeout (3s)
  feels right in practice, or whether hiding both meshes at a paired
  door location (frame + panel, most likely, but unconfirmed) looks
  correct — no GPU/browser in this sandbox, same as always.
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

Resolved:
- GPU/VRAM: RTX 3060 12GB, i5-14400F, 32GB DDR5-4800 → Qwen3.5-9B (re-picked
  from the original Qwen3-VL-8B once Qwen3.5 shipped — `docs/MODELS.md`,
  `docs/DECISIONS.md`).
- Name: **Luna**.
- OS: **Windows**, confirmed during Phase 1 build.
- Live2D rendering library: `pixi-live2d5` (vendored), see `docs/DECISIONS.md`.
  **Superseded by Phase 7**: the whole Live2D/`pixi-live2d5` stack was
  replaced with `three` + `@pixiv/three-vrm` (the VRM avatar migration).
  Left here as the historical record of the Phase 1 decision, not as a
  description of the current renderer — see Phase 7's entry above.
- Voice reference source for TTS cloning: user has a sample in hand. Rights
  to it are on the user to confirm — not something this doc can verify.
- STT: in scope after all, via faster-whisper (Phase 2.5) — see the scope
  section above.
- Round 6's wall-clamp/turn-rate/facing-during-start changes: confirmed
  reading as fixed on the user's real machine, alongside the
  already-resolved facing/direction bug — see the round-6 entry above and
  `docs/DECISIONS.md`.

Still open:
- Task Guide Mode tuning: screenshot interval while a task is active, and how
  aggressive the nagging should be (fixed, or a tone dial the user can turn
  down when they're not in the mood to be chided).
- ~~Live2D model source for anything beyond local prototyping (free sample
  vs. purchased vs. commissioned) and its license terms.~~ Moot as of
  Phase 7: Live2D is gone entirely, replaced by the VRM avatar pipeline,
  and the user already has their own `.vrm` model in place
  (`public/vrm/luna.vrm`, gitignored, user-provided).
- Full-apartment room build: round 12 replaced the entire procedural
  system (round 7-11's hand-built walls/furniture/materials, the
  20-rectangle navmesh, the round-10 TV placement trade-off — all of it)
  with a prebuilt model loaded wholesale, because the procedural system
  was producing visibly broken results nobody building it could see (see
  `docs/DECISIONS.md`'s round-12 entry). Round 13 got the first real
  usage feedback and fixed six real bugs; round 14 found round 13's own
  fixes were themselves broken (a collision teleport bug, an overexposed
  fill light) and fixed those too — full account in `docs/DECISIONS.md`'s
  round-13/14 entries. Round 14 was then confirmed working, and round 15
  addressed four smaller asks: a real UV-mapping bug in the model
  rendering a pizza prop as solid black (fixed with a flat color sampled
  from the actual texture, not a guess), a pathfinding gap causing
  indefinite wall-sticking (mitigated with stuck-detection, not real
  pathfinding — see below), doors re-added by finding 7 real door-shaped
  meshes geometrically (opens by disappearing near someone, not a hinge
  swing — geometry doesn't say which way to swing), and confirmed this
  model has no ceiling meshes at all (genuinely roofless, not a gap).
  Full account in `docs/DECISIONS.md`'s round-15 entry. What's still
  open: real room boundaries and furniture-anchor locations are still
  unknown (no per-room data in the file — generic mesh names) and can
  only be worked out by someone who can see the loaded model point out
  where things are — round 15's geometric mesh-finding technique (used
  for doors/ceiling) could plausibly extend to finding furniture anchors
  too, but hasn't been tried. Real navmesh-graph pathfinding (as opposed
  to round 15's stuck-detection workaround) is still not implemented and
  would need that same room/furniture data. Sit/cook/read animation is
  still further off than before round 12. Also still unverified: whether
  round 15's stuck-detection timeout (3s) feels right in practice,
  whether hiding both meshes at a paired door location (frame + panel,
  presumed) looks correct, whether round 14's fill-light retune and
  broader emissive cap actually look right, whether the collision
  ring-search fallback feels natural to walk into, whether 54% of the
  footprint reporting collision-blocked is right or just
  plausible-sounding, and whether the model's licensing (a Sketchfab
  download, not independently confirmed as reusable — see
  `docs/DECISIONS.md`) is actually clear to keep building on. No
  GPU/browser in the sandbox any of this was built in, same as always.



