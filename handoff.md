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
| 10 | Environments (the apartment) | 🔶 — two rounds of real-usage bugfixes now, see below |
| 11 | Work Mode (shell can act, not just advise) | ⬜ not started, fully scoped/approved |

**Phase 10, specifically — where this session's work sits:** round 12
swapped the procedural apartment for a prebuilt `.glb`. Round 13 was the
first real-usage bugfix pass (lighting, materials, added real collision).
This round (14) found that round 13's own fixes were themselves broken —
a collision-fallback bug and a badly-miscalibrated light — both now fixed
and verified against the real file where possible. **Nothing from round
13 or 14 has been confirmed to actually look/feel right yet** — every
round so far has found new problems the moment it actually ran.

## What this round did (round 14)

The user ran round 13's build and reported, in one message: walking into
any wall repeatedly teleports to a fixed spot elsewhere in the building
("beside the TV... again and again"), other spots teleport elsewhere too
("like beside the couch"), Luna is stuck the same way, she's "fucking
ethereal" (a screenshot showed her as a solid white glowing silhouette at
night), the spectator camera "gained lightspeed," and "many things are
still glowing."

1. **The teleport bug (the serious one).** Traced to
   `WalkableArea.clamp()`'s last-resort fallback, which stepped toward the
   building's geometric centre in big fractional jumps when blocked,
   reasoning this would rarely run. It wasn't rare: `CharacterController.
   moveClamped()` (Luna's own per-step movement) called `clamp()`
   unconditionally on *every* blocked step, never trying to slide around
   an obstacle first the way the visitor camera does. Fixed both: `clamp()`
   now searches a small ring (0.08–0.6m) around the blocked point instead
   of jumping toward the centre, and Luna's movement gained the same
   axis-decomposed sliding attempt the visitor camera already had.
   **Verified against the real file**: extracted the literal `WalkableArea`
   class source and ran it against the real collision BVH — 67 real
   blocked points across the whole footprint all resolved within 0.56m,
   nowhere near the multi-metre jumps possible before.
2. **The ethereal glow.** The round-13 fill light was positioned close
   enough to her own body (chest height, ~0.35m in front — roughly
   0.2-0.3m from actual skin) that physically-correct point-light falloff
   amplified its intensity by roughly 8-25x. Night's `fillI: 11` was
   delivering something like 90-275 effective units at her skin, against
   a sun that never exceeds 1.7 in this system — an order-of-magnitude
   miscalibration, not a subtle one. Fixed: repositioned well above her
   head (2.3m vs 1.4m), softened falloff, extended reach, and cut every
   mode's intensity 3-4x on top of the repositioning. Deliberately erred
   toward under-lighting this time.
3. **"Many things are still glowing."** Round 13 only fixed one named
   emissive material. Rather than guess at more names without fresh
   evidence of which ones, added a general safety net: any material whose
   peak emissive brightness exceeds a ceiling gets scaled down
   automatically, regardless of name.
4. **Spectator "lightspeed."** Investigated and found this is pre-existing,
   scroll-wheel-adjustable behavior, untouched by round 13 — but 24
   units/s across this building's real ~19m width does read as
   "lightspeed" regardless of cause, so the ceiling was lowered to 14.

**Verification**: both production builds clean. The collision fix was
tested against the real file's actual BVH (see above) — not just reasoned
about. The fill-light fix is grounded in the actual falloff formula and
the actual reported failure, but — like every lighting number in this
project — not confirmed against a real render.

## Repo/git housekeeping

This sandbox has no direct push access to the user's GitHub — work
leaves as a git bundle, applied via `git fetch <bundle> main:main-mirror
&& git merge main-mirror && git push origin main` (confirmed correct
syntax — note `main:main-mirror`, not `main-mirror:main-mirror`; bundle
handed over at `C:\Users\User\Downloads\<filename>`). **Important:**
round 13's bundle added a new dependency (`three-mesh-bvh`) and the user
hit exactly the expected snag — merging a bundle updates `package.json`/
`package-lock.json` but doesn't run `npm install` for you. Worth
reminding on every bundle that changes dependencies: run `npm install`
after merging, before `npm run sandbox`. This round's bundle does not add
any new dependencies.

## Recent issues

Two serious ones from round 13 fixed this round (teleport bug, ethereal
glow) — see above. Both are verified as *not reproducing the exact
reported symptom* against real data where that was possible (the
collision one, concretely; the lighting one only as far as "the math that
caused it is now very different"). Neither has been re-confirmed by the
user running it again yet.

## Outstanding stuff

From `docs/ROADMAP.md`'s "Still open" list, current as of this write-up:
- **Confirm round 14's fixes actually work** — this is the priority.
  Does collision feel reasonable to walk around in now (not just
  "doesn't teleport")? Is Luna visible without looking artificially lit?
  Did the broader emissive cap actually catch what "many things...
  glowing" referred to?
- Real room boundaries, door positions, and furniture-anchor locations —
  still unknown, still needs someone who can see the loaded model to
  identify.
- Sit/cook/read animation — still blocked on the above.
- Confirming the model's actual Sketchfab license is one of the
  "fine to use" ones (CC0/CC-BY/CC-BY-SA), given the repo is public.
- If real-time reflections ever matter enough: `THREE.SSRPass` is the
  concrete next step, not attempted.
- Task Guide Mode tuning: screenshot interval, nagging aggressiveness.
- Phase 4: retest on the real machine after the `SYSTEM_PROMPT` fix.
- Voice reference rights for TTS cloning — on the user to confirm.
- Phases 5, 6, 11 — not started.

## Future goal

Immediate: get round 14's fixes in front of the user's actual screen.
Two rounds in a row now have shipped fixes that looked reasonable in code
and turned out wrong the moment they actually ran — worth being upfront
that this pattern may continue at least once more before the apartment
stabilizes, given the complete lack of any way to render or preview
anything from this sandbox.

Medium-term: once collision/lighting are actually confirmed stable, work
out real room boundaries/anchors/doors for the model (needs the user's
eyes), then pick back up sit/cook/read animation. Separately, get Phase 4
confirmed end-to-end on the real machine.

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
