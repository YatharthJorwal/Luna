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
| 10 | Environments (the apartment) | 🔶 — real first-usage bugfixes this round, see below |
| 11 | Work Mode (shell can act, not just advise) | ⬜ not started, fully scoped/approved |

**Phase 10, specifically — where this session's work sits:** round 12
swapped the procedural apartment for a prebuilt `.glb` model. This round
(13) is the first real-usage feedback on that model — a video and
screenshots came back showing real problems, all diagnosed from the
actual file/shader source rather than guessed, and fixed. See "What this
round did" below for the full list.

## What this round did (round 13)

The user sent a 47-second video (`ffmpeg`-extracted frames were actually
looked at) plus screenshots of the round-12 apartment running for real,
with a direct list of complaints: white furniture glowing absurdly by
day, weird/very-dark lighting on Luna at night, no wall or furniture
collision ("yes we clip"), a "walking in void" patch, a request to lower
visitor eye height, make the dust particles more "dreamy," and a question
about literal ray-traced reflections.

Because the original `.glb` upload was still sitting in this sandbox from
earlier in the conversation, this round diagnosed from real evidence —
the actual glTF JSON (parsed by hand) and the actual
`@pixiv/three-vrm-materials-mtoon` shader source — rather than reasoning
from first principles the way rounds 11/12 had to.

1. **Luna's darkness (the big find).** Her MToon shader has no
   `envmap_fragment` include at all — confirmed in the installed
   package's own source, not assumed — so she never benefits from
   `scene.environment`/IBL, only hemisphere + directional light, and
   blends toward a `shadeColor` that defaults to pure black wherever that
   light is too low. Round 12 deliberately kept night hemi/sun dim for
   the *room's* mood. That was independently starving her of light, with
   zero relation to anything wrong in the room. Fixed with a dedicated
   `THREE.PointLight` (`lunaFill` in `apartment/index.ts`) that follows
   her position every frame, short-range so it doesn't bleed onto nearby
   walls/furniture — decoupled from room mood lighting entirely.
2. **White-material glow.** Parsed the file's raw glTF JSON directly:
   `Porcelain_-_White` (toilet/sink) and `Couch_Beige`/`Couch_BeigeDark`
   (sofa) have **no `baseColorFactor` at all** — rendering at glTF's
   spec-default pure white despite their names. `Gold` (door hardware) is
   fully metallic at 0.15 roughness — near-mirror. Fixed by name in a new
   `fixupMaterials()` — five materials out of 82, each traced to an exact
   number in the file.
3. **Bloom ring artifacts** (the blown-out TV, a lamp's halo in one
   frame). `postfx.ts`'s bloom radius (0.7, tuned for round 10/11's
   softer procedural lights) was too wide for this model's small bright
   props. Narrowed to 0.35, threshold nudged up.
4. **Real wall/furniture collision** — the single biggest addition. Added
   `three-mesh-bvh` (an established three.js addon) to build one
   collision mesh from the whole loaded model at load time;
   `ApartmentHandle.collidesAt(x,z)` queries it. `camera-modes.ts`'s
   existing sliding-movement code needed *zero* changes to start using
   real collision, since it was already written against an interface
   (`Clampable`) rather than the rectangle implementation directly.
   **A real bug was found and fixed by actually running this against the
   real file**: the first height-sample set was catching the floor slab
   itself as an obstruction, blocking 90% of the whole building; fixed
   (54% blocked after) once the absurd number prompted checking the
   geometry.
5. **Smaller fixes**: eye height 1.62m → 1.5m; dust motes bigger/more
   numerous/more opaque; confirmed windows already show "nothing
   outside" (true already, no change needed); explained plainly that
   literal ray-traced reflections aren't feasible in `WebGLRenderer`
   (would need `WebGPURenderer`) and named `THREE.SSRPass` as the
   realistic next step if ever wanted, rather than silently building
   something else and calling it ray tracing.

**Verification**: both production builds clean. Beyond that, extended
round 12's real-`GLTFLoader`-over-local-server harness to actually
exercise the new collision system and material fixups against the real
file — this is what caught the floor-slab collision bug, and confirmed
each material correction lands on the real loaded material instance
(not just compiles). **Still not verified, same as always: how any of it
actually looks or feels to walk around in** — no GPU/browser in this
sandbox. Full account with every exact material value:
`docs/DECISIONS.md`'s round-13 entry.

## Repo/git housekeeping

This sandbox has no direct push access to the user's GitHub — work
leaves as a git bundle, applied on the user's machine via `git fetch
<bundle> main:main-mirror && git merge main-mirror && git push origin
main` (confirmed correct syntax — note it's `main:main-mirror`, not
`main-mirror:main-mirror`, since the bundle's ref is always named `main`;
bundle handed over at a `C:\Users\User\Downloads\<filename>` path). This
round's bundle touches `src/apartment/index.ts` (material fixups,
collision, fill light, revised `MODES`), `src/camera-modes.ts` (eye
height), `src/postfx.ts` (bloom), `src/sandbox.ts` (collision wiring),
`package.json`/`package-lock.json` (added `three-mesh-bvh`), and these
docs. It does **not** touch the `.glb` model itself.

## Recent issues

None open from round 12 in the "did it load" sense — it did, and got far
enough to generate real, specific, fixable feedback, which is what this
round addressed. What's genuinely unknown right now: whether any of
round 13's fixes actually look/feel right, since none of it has been
re-run by the user yet as of this writeup.

## Outstanding stuff

From `docs/ROADMAP.md`'s "Still open" list, current as of this write-up:
- **Confirm round 13's fixes actually work** — lighting (Luna visible?
  white materials toned down without looking wrong? TV not blown out?),
  collision (does 54%-blocked feel right, any getting-stuck spots?), the
  smaller stuff (eye height, motes).
- Real room boundaries, door positions, and furniture-anchor locations —
  still unknown, still needs someone who can see the loaded model to
  identify. Round 13's collision system knows about real geometry but
  still has no concept of "rooms."
- Sit/cook/read animation — still further off than pre-round-12, since
  there are no known real furniture positions to animate toward.
- Confirming the model's actual Sketchfab license is one of the
  "fine to use" ones (CC0/CC-BY/CC-BY-SA), given the repo is public.
- If real-time reflections ever matter enough to be worth the cost:
  `THREE.SSRPass` is the concrete next step, not attempted this round.
- Task Guide Mode tuning: screenshot interval, nagging aggressiveness.
- Phase 4: retest on the real machine after the `SYSTEM_PROMPT` fix.
- Voice reference rights for TTS cloning — on the user to confirm.
- Phases 5, 6, 11 — not started.

## Future goal

Immediate: get round 13's fixes in front of the user's actual screen.
Lighting and collision are both "reasoned from real evidence this time,"
which is a step up from round 12's blind guess, but neither has been
seen rendered by anyone yet.

Medium-term: once there's real feedback on round 13, work out real room
boundaries/anchors/doors for the model (needs the user's eyes), then
pick back up sit/cook/read animation. Separately, get Phase 4 confirmed
end-to-end on the real machine.

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
