# Handoff

> **Read this once, at the start of a session, to get oriented — then stop
> consulting it.** This is a snapshot, not a live document. It goes stale
> the moment more work happens, on purpose — regenerating it fresh at the
> end of a session that changed enough to be worth re-summarizing is the
> intended workflow, not editing it line-by-line as things change mid
> session. If anything here disagrees with `docs/ROADMAP.md` or
> `docs/DECISIONS.md`, **those two are the source of truth, not this
> file.** `CLAUDE.md`'s "Current status" section is the authoritative
> rolling log; this file is just a fast on-ramp to it.
>
> Two sessions have been working on this repo in parallel, scoped to
> different files (this one: `sandbox.ts`/`src/apartment/`/`postfx.ts`/
> `camera-modes.ts`/docs; the other: `index.html`/`src/main.ts`/
> `src/style.css`/orchestrator Phase 4+9 work). This file covers both,
> to the extent this session has visibility into the other's work —
> which is real but indirect (commits, `DECISIONS.md` entries the other
> session wrote, not first-hand testing).

## Current state

**The product:** a fully local, offline-capable desktop companion —
Tauri shell, a 3D VRM avatar (three.js + `@pixiv/three-vrm` — **not**
Live2D; that was fully replaced in Phase 7), a Python orchestrator
driving a local LLM/TTS/STT stack, persistent SQLite memory, and
on-demand vision tools. Flagship behavior is Task Guide Mode: she
watches what you're doing and nudges you back on track, she doesn't act
for you (except the shell's Work Mode, a deliberate later exception —
see Phase 11 below).

**Phase status** (✅ done and confirmed on the user's machine · 🔶 built
and sandbox-verified, awaiting on-machine confirmation · ⬜ not started —
full detail always in `docs/ROADMAP.md`):

| Phase | What | Status |
|---|---|---|
| 0–3 | Spec, shell MVP, LLM brain, voice I/O, persistent memory | ✅ |
| 4 | Vision tools (`capture_screen`/`read_clipboard`) + tool-calling loop | 🔶 built, one real bug found+fixed (stale `SYSTEM_PROMPT` line), **retest on real machine still pending** |
| 5 | Camera + game-assist polish | ⬜ |
| 6 | Personality/perf pass (persona rewrite already done ad hoc) | ⬜ |
| 7 | VRM avatar migration (replaced Live2D) | ✅ |
| 8 | Emotion system + expression control | ✅ |
| 9 | UI reskin + persistent conversation-log panel | 🔶 backend verified for real, frontend only structurally verified |
| 10 | Environments (the apartment) | 🔶 — see below, major rework this round |
| 11 | Work Mode (shell can act, not just advise) | ⬜ not started, fully scoped/approved |

**Phase 10, specifically — where this session's work sits:** the
procedural apartment (rounds 9-11: hand-built walls/furniture/materials,
navmesh, doors) is **gone**, replaced this round with a prebuilt `.glb`
model the user provided. This is a bigger structural change than any
prior round in this phase — read "What this round did" below in full
before touching apartment code.

## What this round did (round 12)

Round 11 fixed two specific reported bugs (day-mode overexposure, no
ceiling toggle). The *next* screenshots showed the real problem: a
UV-checker/barcode texture on the bathtub, a rolled towel floating
unattached near the ceiling, a toilet with no bowl, a mirror rendering
as a solid white blob. Hand-authored procedural geometry and canvas
textures, built by someone with no way to see the result, don't
converge by tuning numbers. The user's own conclusion — correct — was to
stop and swap in a real prebuilt asset, the same way the VRM avatar was
always a real external file rather than something built in code.

The user provided `public/apartment/twokinds_modern_trio_apartment.glb`,
a ~40MB Sketchfab download. This round:

1. **Deleted `src/apartment/shell.ts`, `furniture.ts`, `materials.ts`**
   — the entire procedural room-building system. Confirmed via grep
   first that nothing outside `apartment/index.ts` imported them.
2. **Rewrote `src/apartment/index.ts`**: `buildApartment()` is now
   `async` and loads the model through `GLTFLoader` — the same loader
   class already used for the VRM avatar (VRM is a glTF extension, no
   new dependency). Kept: image-based lighting (`RoomEnvironment` +
   `PMREMGenerator`), ACES tone mapping, the four-time-of-day state
   machine, the dust-mote particles. New `MODES` lighting table written
   from scratch (deliberately conservative — no light pushed near its
   max, unlike round 11's mistake — since this is an unfamiliar model
   with its own PBR textures and zero tuning history).
3. **Rewrote `src/apartment/floorplan.ts`**: the model has no per-room
   data worth reading (`gltf-transform inspect` shows generic
   `Object_0`, `Object_1`, ... mesh names, not `Kitchen_Counter`), so
   there's no reliable way to derive real rooms/doors/furniture
   positions from the file. Replaced the old nine-room plan with one
   placeholder room/navmesh sized to the model's real measured bounding
   box (19.1m x 10.9m, 2.78m ceiling), with four generic scattered
   anchors instead of real furniture positions.
4. **Removed the round-11 ceiling toggle** (built against `shell.ts`'s
   meshes, which no longer exist) and `doors`/`requestDoor`/`DoorLeaf`
   (confirmed unused anywhere else) — deleted rather than left as dead
   stubs.
5. **Rewrote camera spawn points and the sun's shadow-camera frustum**
   in `sandbox.ts` for the new, much larger real footprint. Spectator
   now starts pulled back and above the whole building (safe — can't
   spawn embedded in unknown geometry); visitor mode spawns at the
   footprint's centre.
6. **Added `.gitignore`/`public/apartment/README.txt`**, mirroring
   `public/vrm/`'s existing pattern: the model file is gitignored
   (large, personal, and licensing isn't fully settled — see below),
   the setup note is committed.

**Verification went further than any prior round.** Rather than faking
the asset pipeline, this round loaded the *actual* file through three's
real `GLTFLoader`, over a throwaway local HTTP server (needed because
`FileLoader` uses `fetch`, which needs an absolute URL). Three small
environment-only Node polyfills got it running (`ProgressEvent` stub,
`self = globalThis`, plus round 11's PMREMGenerator fake/canvas stub).
Result: **445 meshes, ~271,754 triangles, 82 materials** — matching a
direct `gltf-transform inspect` of the file exactly — assembled into a
real `THREE.Scene` at the right position/scale (bounding box matched to
within centimetres). Both the file's `extensionsUsed`
(`KHR_texture_transform`, `KHR_materials_transmission`) resolved with
stock `GLTFLoader`, no extra decoder needed. **Still not verified: any
pixel of any texture** — Node has no image decoder (11 non-fatal
"couldn't load texture" warnings logged, expected). Whether anything
actually looks right is still completely open.

**Licensing flagged, not resolved:** the model's filename/material
names (`DJ_Dragon_Poster`, `Sims_Screen`, `Dorditos`, `squirrelmart_*`)
read like a fan-made scene tied to the *TwoKinds* webcomic. The user was
told plainly (Sketchfab's per-listing license matters — CC0/CC-BY/
CC-BY-SA fine, "Standard"/CC-BY-NC means personal-use-only, shouldn't
sit in a repo already on public GitHub) and chose to proceed. Not
independently verified from this end.

## Repo/git housekeeping

This sandbox has no direct push access to the user's GitHub — work
leaves as a git bundle, applied on the user's machine via `git fetch
<bundle> main-mirror:main-mirror && git merge main-mirror && git push
origin main` (their confirmed preferred syntax; bundle handed over at a
`C:\Users\User\Downloads\<filename>` path). This round's bundle touches
`src/apartment/index.ts` (rewritten), `src/apartment/floorplan.ts`
(rewritten), deletes `src/apartment/shell.ts`/`furniture.ts`/
`materials.ts`, edits `src/sandbox.ts`, adds `.gitignore`/
`public/apartment/README.txt`, and updates `handoff.md`,
`docs/DECISIONS.md`, `docs/ROADMAP.md`, `CLAUDE.md`. It does **not**
contain the `.glb` model itself — that's gitignored and the user already
has it locally at `public/apartment/twokinds_modern_trio_apartment.glb`.

## Recent issues

None open from round 11 — both of its fixes are superseded by this
round's full replacement rather than carried forward. The open question
now is simply: does the new model actually look right once the user
runs it? That's untested from this end (see Verification above).

## Outstanding stuff

From `docs/ROADMAP.md`'s "Still open" list, current as of this write-up:
- **The actual look of the new model** — nobody has seen it rendered
  yet. Run `npm run sandbox`, fly around in spectator, and report back
  what needs adjusting (lighting numbers most likely, given they're a
  from-scratch guess for a model nobody's tuned against).
- Real room boundaries, door positions, and furniture-anchor locations
  for the new model — needs the user's own eyes on the loaded scene to
  identify, since the file's mesh names are generic. Currently one
  placeholder room, no doors, generic wander anchors.
- Confirming the model's actual Sketchfab license is one of the
  "fine to use" ones (CC0/CC-BY/CC-BY-SA), given the repo is public.
- Sit/cook/read animation — further off than before, since there are no
  known real furniture positions to animate toward yet.
- Task Guide Mode tuning: screenshot interval while a task is active,
  how aggressive the nagging should be.
- Phase 4: retest on the real machine after the `SYSTEM_PROMPT` fix.
- Voice reference rights for TTS cloning — on the user to confirm.
- Phases 5, 6, 11 — not started.

## Future goal

Immediate: get the new apartment model in front of the user's actual
screen and find out what it really looks like — lighting, whether the
model's own textures/emissive materials read the way its creator
intended, whether the scale/orientation feels right walking around in
it. That's the only way any of this round's numbers go from "reasoned"
to "confirmed."

Medium-term: once there's real visual feedback, work out real room
boundaries/anchors/doors for the new model (a back-and-forth this
session can't do alone — needs the user's eyes), then pick back up
sit/cook/read animation and the rest of Phase 10's original scope
against the new geometry. Separately, get Phase 4 confirmed end-to-end
on the real machine.

Overarching: a genuinely useful always-on desktop companion — Task Guide
Mode as the core loop, eventually extending into Work Mode (Phase 11)
for actual web-task execution in the shell, while the sandbox/companion
room stays permanently observe-only (an explicit, deliberate line the
user drew, not an oversight).

## Docs map, for anything this snapshot doesn't cover

`CLAUDE.md` (rolling status log + working agreement) → `docs/ROADMAP.md`
(phase-by-phase scope/status) → `docs/DECISIONS.md` (why non-obvious
things are the way they are) → `docs/ARCHITECTURE.md` (system design) →
`docs/MODELS.md` (which LLM/TTS to run) → `README.md` (human setup/run
instructions). This file is the fastest of the six to read and the
least authoritative — treat it accordingly.
