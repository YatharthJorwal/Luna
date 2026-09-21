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

## Read this part first

The sandbox/apartment freeze (Phase 10, since round 15) is still in effect
— don't touch `sandbox.ts`/`src/apartment/`/`camera-modes.ts`/`postfx.ts`
unless explicitly asked. The pivot to Tauri shell phases is underway:
**Phase 4 is now fully done** (both the tools/tool-calling loop from Round
1 and the scheduled-capture/off-task-chide loop from Round 2), **Phase 9
is fully done** (frontend confirmed on the user's real machine this
session). Next priorities are Phase 5, Phase 6, and Phase 11 — none
started yet. See "What's next" below.

This session also confirmed, by directly asking rather than assuming, that
every item the previous freeze-checkpoint handoff had flagged as
uncertain came back resolved: round 15's sandbox bundle was merged and
tested, Phase 4's vision-tools retest passed, and Phase 9's frontend looks
and works right. The previously-flagged `config.yaml`-tracked-in-git issue
is also already fixed on the user's end (gitignored, with
`config.example.yaml` as the template) — verified against the actual git
history, not just taken on faith.

## Current state

**The product:** a fully local, offline-capable desktop companion —
Tauri shell, a 3D VRM avatar (three.js + `@pixiv/three-vrm`), a Python
orchestrator driving a local LLM/TTS/STT stack, persistent SQLite memory,
and both on-demand and scheduled vision tools. Flagship behavior is Task
Guide Mode: she watches what you're doing and nudges you back on track
without being asked, and doesn't act for you (except the shell's Work
Mode, a deliberate later exception — Phase 11).

**Phase status** (✅ done and confirmed on the user's machine · 🔶 built,
partially verified, or awaiting on-machine confirmation · ⬜ not started —
full detail always in `docs/ROADMAP.md`):

| Phase | What | Status |
|---|---|---|
| 0 | Spec | ✅ |
| 1 | Shell MVP (Tauri window, tray, hotkey) | ✅ |
| 2 | LLM brain online | ✅ |
| 2.5 | Voice I/O (GPT-SoVITS TTS, faster-whisper STT) | ✅ |
| 3 | Persistent memory (SQLite + sqlite-vec) | ✅ |
| 4 | Vision tools + Task Guide Mode (tools + scheduled loop, both halves) | ✅ **— confirmed in sandbox this session, real-machine retest of Round 2 is the one open item, see below** |
| **5** | **Camera + game-assist polish** | ⬜ **— not started, next priority** |
| **6** | **Personality & perf pass** | ⬜ **— not started** |
| 7 | VRM avatar migration (replaced Live2D) | ✅ |
| 8 | Emotion system + expression control | ✅ |
| 9 | UI overhaul (pastel reskin + conversation log) | ✅ **— confirmed on the user's real machine this session** |
| 10 | Environments (the sandbox apartment) | 🔶 — **frozen as of round 15, see below** |
| **11** | **Work Mode (shell can act, not just advise)** | ⬜ **— not started, fully scoped/approved** |

## What's next

1. **Real-machine retest of Phase 4 Round 2** (the scheduled-capture/
   off-task-chide loop just built this session). Everything that doesn't
   need a real display or a live Ollama server has full pytest coverage
   (`orchestrator/test_task_guide.py`, plus dispatch tests in
   `tools/test_tools.py` — 90 tests total passing) — but the loop's
   actual timing, whether `qwen3.5:9b` reliably produces the requested
   on/off-task JSON, and whether the chide reads as natural rather than
   naggy are all genuinely unverified. See `docs/DECISIONS.md`'s "Phase 4
   Round 2" entry for the full design reasoning and open questions.
   **Before this can even run: the user's local `config.yaml` needs a new
   `task_guide:` section added** (copy from `config.example.yaml`'s
   template) — the orchestrator will fail to start with a `KeyError`
   without it. This is a breaking config change, not optional.
2. **Phase 5** (camera tool, game-context awareness) and **Phase 6**
   (personality/perf pass, voice tuning) — not started, ordering between
   them is open.
3. **Phase 11 (Work Mode)** — fully scoped and user-approved already (see
   `docs/ROADMAP.md`'s Phase 11 entry for the exact safety scaffolding
   agreed on), just not started.

## What was built this session

Phase 4 Round 2, in full — see `docs/DECISIONS.md`'s "Phase 4 Round 2"
entry for the complete design reasoning (why a tool instead of a tag
mechanism, why task state is module-level not per-connection, why the
loop is nested inside `ws_endpoint`, the idle-timeout-silently-drops
choice, etc.), and `docs/ROADMAP.md`'s Phase 4 entry for the summary.
Short version: `orchestrator/task_guide.py` (state machine + VLM-based
screen comparison), a third tool (`set_active_task`), a new
`task_guide:` config section, and `app.py`'s background loop that
actually runs the periodic check and speaks an in-character chide when
it finds drift.

This session's changes have been committed on `main` locally
(`4f0beb1`) and handed over as a bundle — same no-direct-push-access
workflow as every prior session, see "Repo/git housekeeping" below.

## Phase 10 (frozen): sandbox apartment status, for reference

Round 12 replaced the entire procedural apartment (hand-built walls/
furniture/materials) with a prebuilt `.glb` model
(`public/apartment/twokinds_modern_trio_apartment.glb`, gitignored,
Sketchfab-sourced, **licensing not independently confirmed as reusable —
still an open item if this work ever resumes**). Rounds 13-15 were real-
usage bugfix passes: lighting, a wall/furniture collision system
(`three-mesh-bvh`), a stuck-detection workaround for the lack of real
pathfinding, doors found and re-added by geometric mesh-shape search, and
confirmation this specific model has no ceiling geometry at all.
**Round 15's fixes (pizza texture, doors, stuck-detection) are confirmed
merged and tested on the user's machine** — no longer an open question,
unlike the previous handoff.

If/when sandbox work resumes: real room boundaries and furniture-anchor
positions are still unknown (the model's mesh names are generic,
`Object_0`/`Object_1`/...) — round 15's geometric bounding-box search
technique could plausibly extend to finding furniture anchors too,
untried. Full history: `docs/DECISIONS.md`'s round 9 through round-15
entries, in order.

## Repo/git housekeeping

No direct push access to the user's GitHub from this sandbox — work
leaves as a git bundle, applied via `git fetch <bundle> main:main-mirror
&& git merge main-mirror && git push origin main`. This session's bundle
covers only Phase 4 Round 2 (docs + `orchestrator/` — no frontend/Rust
changes, no new dependency, so no `npm install` needed after merging this
one).

Reminder for the user: after merging, add a `task_guide:` section to the
local (gitignored) `orchestrator/config.yaml` — see "What's next" above.

## Ask the user, don't assume

Per the working agreement established last freeze checkpoint: **if
anything in this file or the docs seems out of sync with what's actually
working on the user's end, ask rather than assume the docs are right.**
Concretely, worth confirming at the start of the next session:
- Has this session's bundle actually been merged and pushed?
- Has Phase 4 Round 2 (the scheduled-capture loop) been tried on the
  real machine yet, even informally? This handoff assumes "not yet."
- Was the `task_guide:` config section actually added to the user's real
  `config.yaml`? Without it the orchestrator won't start.
- Any local changes made directly on the user's machine (not through a
  bundle from this sandbox) that these docs wouldn't know about at all.

## Docs map, for anything this snapshot doesn't cover

`CLAUDE.md` (rolling status log + working agreement) → `docs/ROADMAP.md`
(phase-by-phase scope/status) → `docs/DECISIONS.md` (why non-obvious
things are the way they are) → `docs/ARCHITECTURE.md` (system design) →
`docs/MODELS.md` (which LLM/TTS to run) → `README.md` (human setup/run
instructions). This file is the fastest of the six to read and the
least authoritative — treat it accordingly.
