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

**Phase 10, specifically — where this session's work sits:** a full
apartment rebuild landed this round (round 10, on top of rounds 6–9).
Five real rooms (living/dining, kitchen, bedroom, bathroom, hallway) in
an L-shaped plan, real walls with punched openings, four doors that open
on approach, furniture built on rounded/lathed primitives (not bare
boxes — mesh count 387→1173, verified by actually running the build),
image-based lighting + a GTAO/bloom/SMAA post chain, spectator +
first-person visitor camera modes (Tab toggles), a scene-state channel
so she knows which room she's in and whether someone's visiting, and a
20-rectangle navmesh verified by simulating two hours of her wandering
against the real navigation code (not just read by eye) — she reaches
all five rooms and all nine named spots. Full writeup:
`docs/DECISIONS.md`'s "Round 10" entry.

**Just confirmed working on the user's real machine** (this session's
first actual screenshots, see below for what they showed) — this is the
first time any of the apartment work has been seen rendered, not just
verified computationally.

**Repo/git housekeeping:** rounds 8–10 of this session's work, plus the
other session's Phase 4/9 work, were just merged together on `main` via
a bundle handoff (this sandbox has no direct push access to the user's
GitHub). One real merge conflict in `orchestrator/app.py` — two features
(the other session's `get_log`/`clear_log` handlers, this session's
`scene_state` handler) landed at the same spot in the file — resolved by
keeping both. Verified: `tsc --noEmit`, both production builds, and
every orchestrator `.py` file parses clean post-merge.

## Recent issues (from the user's first real look, this session)

Reported directly, from actual screenshots on the real machine:

1. **The lighting is overexposed — "practically blinding."** Concrete
   lead, not a guess: `src/apartment/index.ts`'s `day` mode has
   `sunI: 3.1` (a `DirectionalLight` at more than triple `dawn`'s `1.5`),
   `hemiI: 0.95`, and `envI: 1.0` (full-strength image-based lighting)
   all compounding, then run through ACES Filmic tone mapping at
   `exposure: 1.05` (`renderer.toneMappingExposure`, set in
   `sandbox.ts`'s `boot()` and every frame after from
   `apartment.exposure()`). The user's own "Day" mode screenshot shows a
   near-totally-blown-out white render, consistent with this. Likely
   fix is turning down `day`'s `sunI`/`hemiI`/`envI` and/or `exposure`
   in that `MODES` table — hasn't been touched yet, flagged, not fixed.
2. **No ceiling hide/show toggle for the spectator ("flying") camera.**
   The user's stated plan, not yet built. A real ceiling mesh does exist
   per room (`shell.ts`'s floor/ceiling loop, one `PlaneGeometry` per
   room at `y = CEILING_H`), single-sided (`lib.ceiling` has no `side`
   set, defaults to `FrontSide`) — which is likely *why* the current
   dollhouse-style overhead screenshot already shows into the rooms
   without an obvious ceiling in the way: viewed from above/outside,
   that's the plane's backface, invisible by default. A toggle would
   need the ceiling meshes collected into `ShellResult` (same pattern
   `doors`/`glazing`/`daylightPanels` already use in that file) and a
   visibility switch wired to spectator mode specifically.

Neither was fixed this session — the explicit instruction this round was
"do one thing: make this handoff doc," so these are flagged, not acted
on. They're the natural first pick-up for next time.

## Outstanding stuff (beyond the two issues above)

From `docs/ROADMAP.md`'s "Still open" list, current as of this write-up:
- Full-apartment work still ahead: true per-room *polygon* navmesh
  (current one is a verified-but-still-rectangle-union approximation),
  and sit/cook/read *animation* (she currently stands at a named anchor
  facing a direction — there's no dedicated pose yet).
- The TV console's placement trades an ideal sofa sightline for actually
  fitting against a wall without blocking the kitchen archway (see round
  10's `DECISIONS.md` entry) — worth a second look now that there's a
  real render to judge it by.
- General "does the furniture layout/lighting actually read right" —
  everything about the apartment was verified computationally
  (geometry, connectivity, clearances) but not visually until this
  round's screenshots, and there's more to check now that it can
  actually be seen.
- Task Guide Mode tuning: screenshot interval while a task is active, how
  aggressive the nagging should be.
- Phase 4: retest on the real machine (the actual app, not an isolated
  call) after the `SYSTEM_PROMPT` fix.
- Voice reference rights for TTS cloning — on the user to confirm, not
  something any session can verify.
- Phases 5, 6, 11 — not started.

## Future goal

Immediate: the user is actively testing the apartment for the first
time now that it's confirmed running — expect feedback on the two issues
above plus whatever else the first real look-around turns up (this is
squarely "first-run territory," per this project's own established
pattern — expect small things, not fundamental breakage).

Medium-term: close the Phase 10 gaps above, get Phase 4 actually
confirmed end-to-end on the real machine, then pick up Phase 5/6/11 in
whatever order the user prioritizes.

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
