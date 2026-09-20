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
| 10 | Environments (the apartment) | 🔶 — round 14's fixes confirmed working; round 15 was smaller-scope polish, see below |
| 11 | Work Mode (shell can act, not just advise) | ⬜ not started, fully scoped/approved |

**Phase 10, specifically — where this session's work sits:** round 14's
collision-teleport and fill-light fixes were confirmed working by the
user ("works properly") — the first real confirmation this whole
apartment effort has gotten since round 12's model swap. Round 15 (this
one) was four smaller, specific asks: a broken pizza texture, a
pathfinding gap, and re-investigating doors/ceiling geometrically now
that there's real experience finding things in this file's anonymous
mesh names.

## What this round did (round 15)

1. **Pizza rendering as a solid black disc**: a real bug in the source
   file. The mesh's UVs (read directly from the accessor data) span
   nearly the entire 2048x2048 texture atlas, but the actual pizza
   artwork occupies only a small centred region — most of the surface
   samples the atlas's dark padding. Extracted the real PNG from the
   file's binary chunk to confirm this visually. Fixed by dropping the
   broken texture and using a flat color sampled from the artwork's
   actual pixels (ImageMagick mean of the texture's centre region:
   warm orange, `~(0.84, 0.41, 0.05)`), rather than attempting a UV
   remap with no way to verify the crop lands right.
2. **"Walking into the wall for the last 10 minutes"**: a real
   pathfinding gap, distinct from round 14's teleport bug. Round 13 made
   wander *target selection* collision-aware but never checked whether
   the straight-line *route* to a target actually clears what's between
   here and there. Added stuck-detection to `WanderController`: if she
   hasn't moved 5cm in 3 seconds while walking toward a target, abandon
   it (and the rest of the queued path) for a fresh one. Not real
   pathfinding — that needs per-room data this model doesn't have — but
   turns "stuck indefinitely" into "picks something else after a few
   seconds."
3. **Furniture boundaries**: already covered by round 13's collision
   system (built from every mesh, furniture included). Read as the same
   underlying gap as #2, not a separate missing feature.
4. **Doors**: re-investigated geometrically. Scanned every mesh's real
   world-space bounding box (computed by hand from the glTF node
   hierarchy) for door-panel shapes and found 7 matching meshes at 5
   locations. Re-added as proximity-based disappear/reappear (opens
   within 1.3m of Luna or the visitor) — deliberately not a hinge swing,
   since geometry alone doesn't say which edge hinges or which way it
   opens. Door meshes are now excluded from the static collision BVH and
   checked separately, since their collision state changes at runtime.
   **A real bug found by running it**: nearby wall/frame geometry in the
   static BVH was still blocking an "open" door until door-box checks
   were moved to run *before* the BVH query rather than after.
5. **Ceiling show/hide**: searched the same way as doors and found
   *nothing* — this model has no ceiling meshes at all, confirmed by
   broadening the search and finding only full floor-to-ceiling walls,
   no horizontal caps anywhere. It's a genuinely roofless "dollhouse"
   scene. Not a gap to close — there's nothing to toggle.

**Verification**: both production builds clean. All geometric findings
(pizza UV range, 7 door meshes, zero ceiling meshes) came from directly
computing real per-node world-space bounding boxes against the actual
file, not a summary tool's output. The door system was confirmed
end-to-end against the real loaded model and collision BVH: blocked
before anyone approaches, unblocked while someone's there, blocked again
after they leave.

## Repo/git housekeeping

This sandbox has no direct push access to the user's GitHub — work
leaves as a git bundle, applied via `git fetch <bundle> main:main-mirror
&& git merge main-mirror && git push origin main` (confirmed syntax —
`main:main-mirror`, not `main-mirror:main-mirror`; bundle handed over at
`C:\Users\User\Downloads\<filename>`). **This round's bundle adds no new
dependencies** — no `npm install` needed after merging, unlike round 13's
bundle (which added `three-mesh-bvh` and briefly confused the user when
`npm run sandbox` failed to resolve it — worth a heads-up on any future
round that does add one).

## Recent issues

None open from round 14 — confirmed working. This round's fixes
(pizza, doors, stuck-detection) are new and unconfirmed as of this
writeup.

## Outstanding stuff

From `docs/ROADMAP.md`'s "Still open" list, current as of this write-up:
- **Confirm round 15's fixes** — does the pizza look right now (flat
  color, no more black disc)? Do doors actually open/close sensibly when
  walked up to? Does the stuck-detection timeout (3s) feel reasonable,
  or does she visibly "give up" too fast/slow?
- Real room boundaries and furniture-anchor locations are still unknown.
  Round 15's geometric mesh-finding approach (used for doors/ceiling)
  could plausibly extend to finding furniture anchors too — untried.
- Real navmesh-graph pathfinding (vs. round 15's stuck-detection
  workaround) still needs that same room/furniture data to be worth
  building.
- Sit/cook/read animation — still further off than pre-round-12.
- Confirming the model's Sketchfab license is one of the "fine to use"
  ones (CC0/CC-BY/CC-BY-SA), given the repo is public.
- If real-time reflections ever matter enough: `THREE.SSRPass` is the
  concrete next step, not attempted.
- Task Guide Mode tuning: screenshot interval, nagging aggressiveness.
- Phase 4: retest on the real machine after the `SYSTEM_PROMPT` fix.
- Voice reference rights for TTS cloning — on the user to confirm.
- Phases 5, 6, 11 — not started.

## Future goal

Immediate: get round 15's fixes in front of the user's actual screen —
pizza, doors, and whether the stuck-detection timeout feels right.

Medium-term: if round 15's geometric mesh-finding approach for doors
proves reliable in practice, consider extending it to find real
furniture positions too, which would finally unblock sit/cook/read
animation and more accurate room-level scene-state. Separately, get
Phase 4 confirmed end-to-end on the real machine.

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
