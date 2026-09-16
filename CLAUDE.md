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
**Round 6's last open item is now closed too: the user confirmed on
their real machine that walking reads as fixed** — direction, the wall
clamp, and the slower turn-rate together, not just the facing flip in
isolation. The "walks backward"/"moonwalk"/"kinda awkward" saga that ran
across rounds 4-6 is fully done.
**Round 7 is planning-only** (a separate, parallel conversation's work,
reconciled/renumbered into these docs) — a full multi-room apartment via
CC0 asset-pack furniture, a per-room navmesh, named sit/cook/read
anchors, and a text scene-state channel to `persona.py` rather than a
first-person camera feed. Nothing in round 7 is built yet.
**Round 8: a real apartment render exists now**, dropped into
`public/apartment/index.html` as its own standalone page (linked from
the sandbox's info panel) — four rooms (kitchen, living/dining, bedroom,
bathroom), pastel dollhouse look, day/noon/evening/night lighting
presets. Deliberately kept standalone rather than merged into
`sandbox.ts`'s own scene: it's built against Three.js r128 loaded from a
CDN `<script>` tag with its own global `THREE`, not this project's
bundled ESM `three` (`^0.185.1`), and some APIs it uses
(`renderer.outputEncoding`/`THREE.sRGBEncoding`) don't exist on the
newer version — porting it into the real scene is real work for later,
not a drop-in.
**Round 8 lasted about one message.** The standalone page turned out to
be a dead end in practice: opened from inside the actual Tauri shell,
`target="_blank"` doesn't reach an arbitrary route — it just reopens the
shell's own bound window. Splitting "the apartment" and "the character"
into two unconnected pages was never going to let her actually live in
it anyway, so round 9 is the real thing.
**Round 9: the apartment is the sandbox's scene now, not a linked-to
page.** `public/apartment/` is deleted; `src/apartment.ts` ports the
same geometry into a real ESM module against this project's own `three`,
and `sandbox.ts`'s old `buildStudio()` box is gone — `boot()` calls
`buildApartment(scene)` directly. Three porting issues came up that
weren't obvious from the diff (full reasoning in `docs/DECISIONS.md`,
short version here):
- **Scale.** The apartment is authored ~2.4x life size (6-unit ceilings).
  Scaled the room down to meet her (`APARTMENT_SCALE`), not her up —
  every locomotion constant in this file is tuned in metres, and scaling
  a VRM up risks its gravity-tuned spring bones.
- **Two three.js properties don't inherit a parent group's scale**:
  a light's shadow-camera frustum extents, and point-light `distance`.
  Checked against the actual three.js source in `node_modules`, not
  assumed — both needed a manual post-scale pass.
- **Light falloff changed between r128 and this three version.** r128's
  default was a bounded `(1-d/cutoff)^decay`; modern three is unbounded
  `1/d^decay`, which turns every lamp into a hot spot at the authored
  decay of 2. Forcing `decay = 0` restores the bounded falloff the
  original intensities were tuned against.
The old free-roam square `WanderController` is gone too, replaced with a
small rectangle-union navmesh (`WalkableArea` + a rewritten
`WanderController`) built from a hand-derived table of clear-floor
patches in `apartment.ts` — real per-room navmesh work was explicitly
future scope as of round 7's plan; this doesn't do sit/cook/read anchors
or true polygon geometry, just enough rectangles, chained through their
overlaps, that she can reach all four rooms without a path ever cutting
through a wall or a piece of furniture. Checked three ways beyond
`tsc --noEmit`, none of which needed a GPU: the rect table was parsed
back out of the file and checked for connectivity/containment; the
apartment module was actually executed in Node (stubbed 2D canvas, no
WebGL needed) and its scene graph inspected; and the real
`WalkableArea`/`WanderController` classes were extracted verbatim from
this file and run through 40 simulated minutes of wandering with a
deliberate overshoot on every step, and never once left walkable floor.
**Still not verified: how any of this actually looks.** No GPU/browser
in this sandbox, same as every round before this one — the furniture
clearances in the room table were read out of coordinates in the
builders, not off a render, and the lighting numbers are reasoned from
reading the three.js source, not seen. Expect to nudge both once this
is on screen.
**A second session is working on the shell/UI in parallel** — this
session's work stays scoped to the sandbox (`sandbox.html`,
`src/sandbox.ts`, `src/sandbox.css`, `src/apartment.ts`,
`src/sandbox-hud.ts`) and these docs, not
`index.html`/`src/main.ts`/`src/style.css`.

**Round 10: the apartment was rebuilt from scratch, not touched up.**
`src/apartment.ts` is gone; `src/apartment/` is four modules now
(`floorplan.ts` the layout as data, `materials.ts` the palette/textures/
geometry primitives, `shell.ts` the walls and doors, `furniture.ts` the
five rooms, `index.ts` ties it together). Two new top-level modules:
`src/postfx.ts` (the render pipeline) and `src/camera-modes.ts`
(spectator + first-person visitor). Highlights, full reasoning in
`docs/DECISIONS.md`:
- **A real L-shaped floor plan in metres**, not one long strip: living/
  dining, kitchen, bedroom, bathroom around a central hallway, walls
  with actual punched openings (piers, lintels, reveals, architraves),
  four doors that swing open on approach and shut behind whoever passed
  through.
- **Furniture rebuilt on rounded/lathed/sagging-cushion primitives**
  instead of bare boxes — verified mesh count 387 → 1173, ~175k
  triangles, not eyeballed.
- **Image-based lighting** (`RoomEnvironment` + PMREM), ACES filmic tone
  mapping, VSM soft shadows, and a post chain (GTAO / bloom / SMAA)
  behind a high/medium/low switch — the honest answer to "make it ray
  traced": real path tracing isn't on the table in a browser, this is
  the screen-space approximation stack that the offline-render look
  actually comes from.
- **First-person visitor mode alongside spectator** (Tab toggles):
  eye-height, head-bob, clamped to the same navmesh she uses, slides
  along walls rather than stopping dead.
- **She's aware of the apartment.** A `scene_state` message
  (`ws-client.ts` → `app.py`) tells the orchestrator which room she's
  in, the nearest named anchor, the time of day, and whether/where a
  visitor is standing — spliced into the prompt the same way the
  memory blocks already are, per-turn, never stored in history.
- **She looks at the camera** when it's close and roughly in front of
  her, via VRM's own lookAt rig — gated on distance and facing so she
  doesn't crane round to stare at a camera behind her head.
- **The navmesh was rewritten from 14 rectangles to 20** after a script
  cross-checked every rectangle against the *actual* furniture placement
  coordinates and found two real bugs before any of it shipped: the TV
  console was sitting inside the open kitchen archway (moved, and
  shrunk — a full-width console genuinely does not fit anywhere on that
  wall without blocking either the archway or the balcony doors, a
  real room-planning constraint, not a nav-mesh nitpick), and a
  rectangle overlapped half a metre of the wardrobe (fixed by widening
  the bed/desk gap, which was too narrow to route through at all). A
  two-simulated-hour run of the real `WanderController` afterward
  reaches all five rooms and all nine named anchors with zero frames
  spent off walkable floor.
**Still not verified: how any of it looks.** No GPU/browser in this
sandbox, unchanged from every round before this one. The furniture
layout is now geometrically self-consistent (checked by script, not
eyeballed) but not aesthetically judged by anyone with eyes on a
render — the TV's position in particular trades an ideal sofa sightline
for actually fitting against a wall, which is worth a second look once
this is on screen.
Full writeup for rounds 6-10 in `docs/DECISIONS.md`.
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
