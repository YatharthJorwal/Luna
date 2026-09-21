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

## The freeze, read this part first

The user has explicitly paused the sandbox/apartment work (Phase 10) as of
round 15: **"we've done enough in sandbox... next goal is to freeze the
sandbox development and pursue tauri shell phases which havent been
done."** Fifteen rounds of `sandbox.ts`/`src/apartment/`/`postfx.ts`/
`camera-modes.ts` work is not the priority right now — don't pick it back
up unless the user explicitly asks to. The next session's job is Tauri
shell work: Phase 4's retest and remaining build, Phase 5, Phase 6, Phase
9's frontend confirmation, Phase 11. See "What's next" below for specifics.

Before this freeze, a project-wide audit checked for stale docs and real
bugs across the *whole* repo, not just the sandbox work — see "Audit
findings" below. Three doc-staleness issues were found and fixed; one
real, unresolved issue (a personal file path committed to public git
history) was found and flagged for the user to decide on, not fixed
unilaterally.

## Current state

**The product:** a fully local, offline-capable desktop companion —
Tauri shell, a 3D VRM avatar (three.js + `@pixiv/three-vrm`), a Python
orchestrator driving a local LLM/TTS/STT stack, persistent SQLite memory,
and on-demand vision tools. Flagship behavior is Task Guide Mode: she
watches what you're doing and nudges you back on track, she doesn't act
for you (except the shell's Work Mode, a deliberate later exception —
Phase 11).

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
| **4** | **Vision tools + Task Guide Mode** | 🔶 **— next priority, see below** |
| **5** | **Camera + game-assist polish** | ⬜ **— not started** |
| **6** | **Personality & perf pass** | ⬜ **— not started** |
| 7 | VRM avatar migration (replaced Live2D) | ✅ |
| 8 | Emotion system + expression control | ✅ |
| **9** | **UI overhaul (pastel reskin + conversation log)** | 🔶 **— backend done, frontend needs on-machine confirmation** |
| 10 | Environments (the sandbox apartment) | 🔶 — **frozen as of round 15, see below** |
| **11** | **Work Mode (shell can act, not just advise)** | ⬜ **— not started, fully scoped/approved** |

## What's next: Tauri shell phases

In rough priority order (Phase 4 first — it's the closest to actually
finishing, and Task Guide Mode is the flagship feature):

1. **Phase 4 retest + finish.** The vision-tools tool-calling loop
   (`capture_screen`/`read_clipboard`, `stream_reply_with_tools()`) was
   built, and a real bug (a stale `SYSTEM_PROMPT` line silently blocking
   all tool use) was found and fixed — but **never retested on the user's
   real machine after that fix**, in the actual running app rather than
   an isolated call. That retest is the single most valuable next thing
   to confirm. Separately, and not yet built at all: **the scheduled-
   capture/off-task-chide loop** — the actual "watches your screen every
   so often while a task is active and nudges you back" behavior. Right
   now the tools exist and the model can call them, but nothing
   periodically triggers a check or tracks "is a task currently active."
   That's Task Guide Mode's other, larger half.
2. **Phase 9's frontend**, if not already confirmed: backend (the
   `transcript_log` table, `get_log`/`clear_log` WebSocket messages) has
   real pytest coverage and ad hoc end-to-end runs against genuine
   `app.py`. The frontend (pastel reskin, conversation-log panel UI) is
   only `tsc`/`vite build` clean and markup-confirmed — nobody's looked
   at it rendered. Quick to confirm once you're looking at the real app.
3. **Phase 5** (camera tool, game-context awareness) and **Phase 6**
   (personality/perf pass, voice tuning) — not started, ordering between
   them is open, whichever serves what you're actually running into first
   is fine.
4. **Phase 11 (Work Mode)** — fully scoped and user-approved already (see
   `docs/ROADMAP.md`'s Phase 11 entry for the exact safety scaffolding
   agreed on), just not started. The bigger scope change of the group —
   probably comes after 4/5/6 are in reasonable shape, but that's a
   sequencing call for whoever picks this up, not a hard rule.

## Audit findings (from the freeze checkpoint)

A project-wide check before freezing sandbox work — `tsc --noEmit` clean,
all `orchestrator/` Python compiles clean, `src-tauri/`'s Rust read
manually (still no toolchain in this sandbox to actually compile it).

**Fixed** (doc staleness — `docs/DECISIONS.md`'s freeze-checkpoint entry
has the full detail):
- `docs/ROADMAP.md`'s top-level Scope section still described Live2D as
  in-scope, with no mention Phase 7 replaced it with VRM. Annotated in
  place.
- `docs/ARCHITECTURE.md`'s directory-layout description of `apartment/`
  described round 10's deleted hand-authored system, not the current
  GLB-loading one. Corrected.
- `CLAUDE.md`'s docs-map example citation pointed at a superseded round-9
  decision. Swapped for a current one.

**Flagged, not fixed — needs the user's decision, not this audit's:**
`orchestrator/config.yaml` is tracked in git (not gitignored) with a real
personal Windows path and voice-reference transcript in
`tts.gpt_sovits.ref_audio_path`/`prompt_text` — not a placeholder. This
repo is public. `.gitignore`'s own comment already treats this exact
value as if it should be personal/local-only (grouped with
`launcher.local.txt`/`start-luna.bat`, which *are* gitignored), but the
mechanism was never applied to `config.yaml` itself. Separately,
`docs/ROADMAP.md` already has an open item that rights to that reference
sample are unconfirmed — this connects that open question to it now being
in public git history, which hadn't been explicitly connected before.
**This needs the user to decide**: gitignore `config.yaml` going forward
and add a `.example` template (the `launcher.local.txt.example` pattern
already exists to copy), scrub it from history too, or decide it's fine
as-is — not something to act on unilaterally.

**Checked and fine, recorded so it isn't re-litigated:**
- `Cargo.toml` declares `serde`/`serde_json`; neither is used anywhere in
  `src-tauri/src/*.rs`. Not a bug (Cargo doesn't fail on unused deps),
  just worth a look next time a real `cargo build` happens.
- `capabilities/default.json` only grants `core:default` — fine today
  (the global-shortcut plugin is Rust-side only, `toggle_click_through`
  is unused from the frontend), but worth checking against whatever new
  `#[tauri::command]`s Phase 5/6/9/11 add, since that's when a missing
  capability would first surface as a runtime permission error.
- `README.md`'s run instructions match `spawn_backend_processes()`'s
  actual behavior — correctly kept in sync already.
- No other committed secrets/personal paths found beyond the
  `config.yaml` item above.

## Phase 10 (frozen): sandbox apartment status, for reference

Round 12 replaced the entire procedural apartment (hand-built walls/
furniture/materials) with a prebuilt `.glb` model
(`public/apartment/twokinds_modern_trio_apartment.glb`, gitignored,
Sketchfab-sourced, **licensing not independently confirmed as reusable —
still an open item if this work ever resumes**). Rounds 13-15 were real-
usage bugfix passes: lighting (her MToon shader doesn't read
`scene.environment` at all — confirmed from source, not guessed), a
wall/furniture collision system (`three-mesh-bvh`), a stuck-detection
workaround for the lack of real pathfinding, doors found and re-added by
geometric mesh-shape search (7 meshes at 5 locations, open by
disappearing rather than a hinge swing), and confirmation this specific
model has no ceiling geometry at all (genuinely roofless).

**Round 15's fixes (pizza texture, doors, stuck-detection) were sent as a
bundle but this session has no confirmation they were merged, tested, or
worked** — if picking sandbox work back up ever happens, check with the
user first rather than assuming round 15 landed cleanly.

If/when sandbox work resumes: real room boundaries and furniture-anchor
positions are still unknown (the model's mesh names are generic,
`Object_0`/`Object_1`/...) — round 15's geometric bounding-box search
technique (used successfully for doors and to confirm no ceiling exists)
could plausibly extend to finding furniture anchors too, untried. Full
history: `docs/DECISIONS.md`'s round 9 through round-15 entries, in
order.

## Repo/git housekeeping

No direct push access to the user's GitHub from this sandbox — work
leaves as a git bundle, applied via `git fetch <bundle> main:main-mirror
&& git merge main-mirror && git push origin main` (confirmed syntax —
`main:main-mirror`, not `main-mirror:main-mirror`; bundle handed over at
`C:\Users\User\Downloads\<filename>`). Reminder for any round that adds a
new dependency (three-mesh-bvh's round did): `npm install` after merging,
before running anything — a bundle merge updates `package.json`/
`package-lock.json` but doesn't install anything.

This freeze checkpoint's changes are docs-only (`docs/ROADMAP.md`,
`docs/ARCHITECTURE.md`, `CLAUDE.md`, `docs/DECISIONS.md`, this file) — no
source changes, so no new dependency, no build-affecting change.

## Ask the user, don't assume

Per the user's own instruction going into this freeze: **if anything in
this file or the docs seems out of sync with what's actually working on
their end, ask rather than assume the docs are right.** Concretely, worth
confirming at the start of the next session:
- Was round 15's bundle (pizza fix, doors, stuck-detection) actually
  merged and tested? This handoff assumes "sent, unconfirmed."
- Has Phase 4 already been retested since the `SYSTEM_PROMPT` fix, even
  informally? `docs/ROADMAP.md` currently says no.
- Is Phase 9's frontend already confirmed by actually looking at it,
  even if no one told this session? Currently marked "structurally
  verified only."
- Any local changes made directly on the user's machine (not through a
  bundle from this sandbox) that these docs wouldn't know about at all.

## Docs map, for anything this snapshot doesn't cover

`CLAUDE.md` (rolling status log + working agreement) → `docs/ROADMAP.md`
(phase-by-phase scope/status) → `docs/DECISIONS.md` (why non-obvious
things are the way they are) → `docs/ARCHITECTURE.md` (system design) →
`docs/MODELS.md` (which LLM/TTS to run) → `README.md` (human setup/run
instructions). This file is the fastest of the six to read and the
least authoritative — treat it accordingly.
