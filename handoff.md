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
| 10 | Environments (the apartment) | 🔶 — see below, this is where this session's work lives |
| 11 | Work Mode (shell can act, not just advise) | ⬜ not started, fully scoped/approved |

**Phase 10, specifically — where this session's work sits:** the full
apartment rebuild (round 10) is unchanged in structure this round — five
real rooms in an L-shaped plan, real walls with punched openings, doors
that open on approach, image-based lighting + a GTAO/bloom/SMAA post
chain, spectator + first-person visitor camera modes, a scene-state
channel, and a 20-rectangle navmesh. What changed this round (round 11)
is the fix-up pass on the *first real screenshots* of that build — see
below. Full round-10 writeup still in `docs/DECISIONS.md`'s "Round 10"
entry; this round's is the "Round 11" entry right after it.

## What this round did (round 11)

The user's first real screenshots surfaced two concrete issues, both
flagged with specific leads in the previous handoff, both fixed this
round:

1. **Day-mode lighting was blown out.** `src/apartment/index.ts`'s
   `MODES.day` had `sunI`, `hemiI`, and `envI` all elevated well above
   every other mode's levels *simultaneously* (each roughly 1.7-2x
   dawn's numbers), plus a boosted `exposure` on top — and `day` is the
   mode the scene boots into, so it was the first thing anyone saw.
   Brought down: `sunI` 3.1→2.0, `hemiI` 0.95→0.68, `envI` 1.0→0.68,
   `exposure` 1.05→0.95, `bloom` 0.26→0.32 (day is still the brightest
   mode, just no longer compounding). `sandbox.ts`'s boot-time
   `renderer.toneMappingExposure` placeholder was synced to match.
2. **No ceiling hide/show toggle in spectator mode.** The ceiling
   meshes already existed in `shell.ts` (one `PlaneGeometry` per room)
   but had no visibility switch. Added: `ShellResult.ceilings`,
   `ApartmentHandle.setCeilingsVisible()`/`ceilingsVisible()`, a
   dev-panel "ceiling" row, and a `KeyH` shortcut — scoped specifically
   to spectator mode (visitor mode always forces ceilings back on,
   since standing in a room with no ceiling overhead reads as broken).

**Verification this round:** both production builds clean (`tsc
--noEmit` plus `index.html` and `sandbox.html` via the usual one-off
Vite config), and — new this round — `buildApartment()` actually
executed in Node against real `three` (PMREM/IBL faked out since it's
unrelated round-10 code; everything else genuine), confirming the new
day-mode numbers land on the real light objects, a night→day transition
lerps to them over 90 frames without `NaN`, and the ceiling toggle hides/
shows exactly 5 meshes (one per room). Full account, including exactly
what the harness stubbed and why: `docs/DECISIONS.md`'s "Round 11"
entry.

**Not verified, same as every round: how any of it actually looks.** No
GPU/browser in this sandbox. The lighting fix is reasoned from the
numbers and the ACES curve, not screenshotted; the ceiling toggle's
mechanism is confirmed correct, but nobody has flown around with it on
a real screen yet.

## Repo/git housekeeping

This sandbox has no direct push access to the user's GitHub — work
leaves as a git bundle, applied on the user's machine via `git fetch
<bundle> main-mirror:main-mirror && git merge main-mirror && git push
origin main` (their confirmed preferred syntax; bundle handed over at
a `C:\Users\User\Downloads\<filename>` path). This round's bundle
contains one commit on top of whatever `main` looked like at clone
time, touching `src/apartment/index.ts`, `src/apartment/shell.ts`,
`src/sandbox.ts`, `handoff.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`,
and `CLAUDE.md`.

## Recent issues

None open right now — both of last round's reported issues (above) are
fixed this round. Next real-machine look is the natural way to find
what's next.

## Outstanding stuff

From `docs/ROADMAP.md`'s "Still open" list, current as of this write-up:
- Full-apartment work still ahead: true per-room *polygon* navmesh
  (current one is a verified-but-still-rectangle-union approximation),
  and sit/cook/read *animation* (she currently stands at a named anchor
  facing a direction — there's no dedicated pose yet).
- The TV console's placement trades an ideal sofa sightline for actually
  fitting against a wall without blocking the kitchen archway (see round
  10's `DECISIONS.md` entry) — worth a second look now that day-mode
  lighting is fixed and there's a less-blown-out render to judge it by.
- General "does the furniture layout/lighting actually read right" —
  still genuinely unverified beyond this round's arithmetic-level fix;
  the first real look at the *corrected* lighting hasn't happened yet.
- Task Guide Mode tuning: screenshot interval while a task is active, how
  aggressive the nagging should be.
- Phase 4: retest on the real machine (the actual app, not an isolated
  call) after the `SYSTEM_PROMPT` fix.
- Voice reference rights for TTS cloning — on the user to confirm, not
  something any session can verify.
- Phases 5, 6, 11 — not started.

## Future goal

Immediate: get this round's two fixes (lighting, ceiling toggle) in
front of the user's actual screen — that's the only thing that can turn
"reasoned" into "confirmed" for either of them. Expect either
confirmation or a further nudge on exact brightness/mood, same
first-run-territory pattern as every round of this apartment work so
far.

Medium-term: close the Phase 10 gaps above (polygon navmesh,
sit/cook/read animation, the TV placement second look), get Phase 4
actually confirmed end-to-end on the real machine, then pick up Phase
5/6/11 in whatever order the user prioritizes.

Overarching: a genuinely useful always-on desktop companion — Task Guide
Mode as the core loop, eventually extending into Work Mode (Phase 11)
for actual web-task execution in the shell, while the sandbox/companion
room stays permanently observe-only (that boundary was an explicit,
deliberate line the user drew, not an oversight).

## Docs map, for anything this snapshot doesn't cover

`CLAUDE.md` (rolling status log + working agreement) → `docs/ROADMAP.md`
(phase-by-phase scope/status) → `docs/DECISIONS.md` (why non-obvious
things are the way they are) → `docs/ARCHITECTURE.md` (system design) →
`docs/MODELS.md` (which LLM/TTS to run) → `README.md` (human setup/run
instructions). This file is the fastest of the six to read and the
least authoritative — treat it accordingly.
