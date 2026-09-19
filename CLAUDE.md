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
**Round 12 replaced the procedural room entirely** (see below) — the
furniture-layout/TV-sightline concerns this paragraph used to describe
no longer apply to anything that exists in the codebase; kept as
history, not current status.

**Round 11: first real screenshots came back, two bugs fixed.** `MODES.day`
in `src/apartment/index.ts` was stacking sun/hemisphere/environment
intensity all above dusk's levels at once, plus a boosted exposure on
top, on the mode the scene boots into — read as a blown-out white wash
in the user's own screenshot, exactly as the numbers predicted. Brought
down (`sunI` 3.1→2.0, `hemiI` 0.95→0.68, `envI` 1.0→0.68, `exposure`
1.05→0.95, `bloom` 0.26→0.32) to still be the brightest time of day
without three lights and exposure compounding into one wash. Also added
a ceiling show/hide toggle for spectator (flying) mode — the per-room
ceiling planes already existed in `shell.ts` but had no visibility
switch — via `ApartmentHandle.setCeilingsVisible()`, a dev-panel row,
and a `KeyH` shortcut; scoped specifically to spectator (visitor mode
always forces ceilings back on, per the user's own framing of the ask).
Verified this round by actually running `buildApartment()` in Node
against real `three` (PMREM/IBL faked out since that's round 10's
unrelated, unchanged code; everything else — the real scene graph,
lighting state machine, ceiling array — genuine): the new day-mode
numbers land correctly on the real light objects, a 90-frame night→day
transition lerps to them without `NaN`, and toggling ceilings hides/
shows exactly 5 meshes (one per room), not just type-checks clean.
**Superseded by round 12 below** — `shell.ts` and the ceiling toggle no
longer exist.

**Round 12: the procedural apartment is gone, replaced with a prebuilt
model.** Round 11's fix didn't fix the real problem — the next
screenshots showed a UV-checker bathtub texture, a floating disconnected
towel, a toilet with no bowl, a blown-out mirror. That's hand-authored
procedural geometry and canvas textures built by someone who can't see
the result; it doesn't converge by tuning numbers. `src/apartment/
shell.ts`, `furniture.ts`, and `materials.ts` — the entire procedural
room — are deleted. `src/apartment/index.ts` now loads a prebuilt
`.glb` apartment (`public/apartment/twokinds_modern_trio_apartment.glb`,
a Sketchfab download the user provided) through the same `GLTFLoader`
already used for the VRM avatar — VRM is a glTF extension, so no new
dependency. `buildApartment()` is now `async` (loading a file
inherently is). `floorplan.ts` is reduced to one placeholder room/
navmesh sized to the model's real measured bounding box (19.1m x 10.9m,
2.78m ceiling — measured with `gltf-transform inspect`, not guessed),
since the file has no per-room data worth reading: generic `Object_0`,
`Object_1`, ... mesh names, not `Kitchen_Counter`. That's a real
capability loss stated plainly, not hidden — no room-level scene-state,
no doors, no wall-aware collision inside the footprint — until someone
who can see the loaded model can point out real room/furniture
positions. The round-11 ceiling toggle is gone with `shell.ts`. Camera
spawn points and the sun's shadow-camera frustum were resized for the
new, much larger real footprint.

Verified further than any prior round managed: rather than faking the
asset pipeline, this round loaded the *actual* 40MB file through
three.js's real `GLTFLoader`, over a throwaway local HTTP server (needed
because `GLTFLoader`'s `FileLoader` uses `fetch`, which requires an
absolute URL — a relative `/apartment/...` path has no origin to resolve
against outside a real page). Three small environment-only polyfills
got it running in Node (a `ProgressEvent` stub, `self = globalThis`, and
round 11's PMREMGenerator fake/canvas stub, for the same no-WebGL/no-
real-canvas reasons as before). Results: **445 meshes, ~271,754
triangles, 82 materials** — matching a direct `gltf-transform inspect`
of the file exactly — assembled into a real `THREE.Scene` at the right
position and scale (loaded bounding box matched the inspection to
within centimetres). Both of the file's two `extensionsUsed`
(`KHR_texture_transform`, `KHR_materials_transmission`) resolved with
stock `GLTFLoader`, no extra decoder needed; confirmed no Draco/meshopt
compression either, which would have needed one. The lighting state
machine and the new single-room `describe()` both ran against the real
loaded scene without throwing.

**What's still not verified: any pixel of any texture.** Node has no
image decoder — `GLTFLoader` logged 11 non-fatal "couldn't load texture"
warnings for embedded images it has no way to decode outside a browser,
expected and harmless, not evidence of a file problem. Whether any
material looks right, whether the model's own emissive "glow" materials
read the way its creator intended, whether this round's from-scratch
lighting numbers over- or under-expose it — none of that can be checked
from here. Also flagged, not resolved: the model's licensing (Sketchfab-
sourced, webcomic-themed material names, license not independently
confirmed — the user was told this plainly and chose to proceed; see
`docs/DECISIONS.md`'s round-12 entry for the exact wording).

**Round 13: first real usage of the round-12 model — six real bugs, found
with evidence rather than guessed.** A 47-second video plus screenshots
came back showing: Luna a near-total black silhouette in every frame, a
blown-out TV with visible bloom-ring artifacts, a clean clip through a
sofa, a "walking in void" patch, and — stated directly — "we clip,"
requesting real wall/furniture collision. Since the original `.glb` was
still sitting in this sandbox, this round diagnosed from the actual file
and actual shader source instead of reasoning from first principles:

- **Luna's darkness**: confirmed straight from
  `@pixiv/three-vrm-materials-mtoon`'s shader source that her MToon
  materials never sample `scene.environment` (`// #include
  <envmap_fragment>`, commented out) and blend toward a `shadeColor` that
  defaults to pure black wherever hemi+sun light is too low. Round 12's
  deliberately-dim night hemi/sun (chosen for the *room's* mood, to let
  its own emissive glow materials carry visual interest) was
  independently starving her of the only light she actually receives, with
  no relation to anything wrong in the room itself. Fixed with a
  dedicated, short-range `PointLight` that follows her every frame,
  decoupled entirely from room mood lighting — a character fill light,
  not a room light.
- **"Sofa/toilet/doorhinge glow absurdly"**: parsed the file's own glTF
  JSON by hand (not gltf-transform's summary — the raw material scalars).
  `Porcelain_-_White` and `Couch_Beige`/`Couch_BeigeDark` have **no
  `baseColorFactor` at all** — rendering at glTF's spec-default pure
  white despite names that say otherwise. `Gold` (door hardware) is fully
  metallic at 0.15 roughness — near-mirror. Fixed by name, five materials
  out of 82, each traced to an exact number in the file, not a blanket
  darkening pass.
- **Bloom ring artifacts**: `postfx.ts`'s `UnrealBloomPass` radius (0.7)
  was tuned for round 10/11's softer procedural lights; too wide for this
  model's small bright props (a screen, a bulb). Narrowed to 0.35,
  threshold nudged up.
- **"We clip" / real collision**: added via `three-mesh-bvh` (an
  established addon, not hand-rolled) — the whole model's geometry merged
  into one collision mesh at load time, queried by `collidesAt(x,z)`.
  `camera-modes.ts`'s existing sliding-movement code needed *zero* changes
  to start sliding along real walls, since it was already written against
  an interface (`Clampable`), not a rectangle implementation directly — a
  nice payoff from how round 10-12 structured that file. **A real bug
  found and fixed by actually running it**: the first height-sample set
  put a collision sphere's edge inside the floor slab itself, blocking 90%
  of the entire building; fixed (54% blocked after) purely by noticing the
  number was absurd and checking the geometry, not by reasoning about the
  code.
- **Smaller**: eye height 1.62m → 1.5m; dust motes made bigger/more
  numerous/more opaque ("dreamy" was explicitly asked for); confirmed
  windows already show "nothing outside" (no exterior world exists, no
  change needed); explained plainly why literal ray-traced reflections
  aren't feasible in `WebGLRenderer` (needs `WebGPURenderer`) and named
  `THREE.SSRPass` as the realistic next step if ever wanted.

Verification went further than round 12: the actual collision system ran
against the actual file (not faked), which is what caught the floor-slab
bug above; each material fixup was confirmed landing on the real loaded
material instance, not just compiling. **Still not verified, same as
always: how any of it looks or feels to walk around in** — no GPU/browser
in this sandbox. Full account, every exact material value, in
`docs/DECISIONS.md`'s round-13 entry.

Full writeup for rounds 6-13 in `docs/DECISIONS.md`.
Full phase-by-phase status: `docs/ROADMAP.md`.

## Docs map

- `handoff.md` — snapshot for orienting a **new session at its start only**:
  current state, the near-term goal, recent issues, outstanding work. Not a
  live document — don't edit it mid-session as things change; regenerate it
  at the end of a session instead, the same way this file's own "Current
  status" log gets appended to. If it disagrees with `docs/ROADMAP.md` or
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
  the apartment scene scales itself down to meet the character instead of
  scaling her up — Phase 10 round 9's entry). Read this before assuming
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
