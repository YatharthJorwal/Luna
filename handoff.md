# Handoff

> Read once at the start of a session, then stop consulting it. It's a snapshot
> and goes stale on purpose. If it disagrees with `docs/ROADMAP.md` or
> `docs/DECISIONS.md`, those win. `CLAUDE.md` has the standing rules.

## Do this first (the user said they will run the latest bundle and report back)

1. **Merge may still be blocked.** The user's last `git merge` aborted because
   their working tree had local edits to `src-tauri/Cargo.toml` and
   `src-tauri/Cargo.lock` (cause unknown -- possibly the Tauri CLI rewriting
   the manifest, or a plain `cargo` lock update). Ask whether the merge went
   through and, if they saved it, what `git diff src-tauri/Cargo.toml` showed.
2. **Their local `orchestrator/config.yaml` needs two sections** the code now
   requires (missing = `KeyError` at startup; this already bit them once):
   `task_guide:` (`capture_interval_seconds: 90`, `idle_timeout_seconds: 1800`)
   and `ocr_watch:` (`comment_interval_seconds: 240`). Templates are in
   `config.example.yaml`.
3. **Collect results on what was built but never verified on their machine:**
   - *Orphaned processes (Rust, never compiled):* the Tauri terminal should print
     `[luna] kill-on-close job object ACTIVE`; after End Task / Ctrl+C,
     `netstat -ano | findstr ":9880 :8765"` should be empty. A
     `startup sweep: killed stale python process` line means it cleared an old
     orphan. If `cargo` errors, get the message -- `install_kill_on_close_job`,
     `kill_stale_listeners`, `is_python_process` are the new unverified code.
   - *`look_intent.py`:* "look at my screen" should log `[luna] look: screen -> ...`.
   - *Task classifier:* "use OCR" / "I'm playing X" must no longer start a task.
   - *The open bug below.*

## Open bug (top priority once the above is checked)

**Her replies cut off mid-sentence on their own; the user did not press stop.**
Not root-caused. Diagnostics were added (`done=` / `done_reason=` in the
per-turn log line, a WARNING on abnormal stream end, a catch-all that prints a
traceback in `_run_turn`). Have them reproduce it, then read `orchestrator.log`:
`WARNING: LLM reply ended abnormally` = Ollama/model side (suspect: ambient
vision calls from Task Guide / Continuous OCR competing with chat on one GPU);
`turn failed with an unexpected error` + traceback = this app. Full reasoning in
`docs/DECISIONS.md` ("Open bug"). Don't re-theorize before reading those lines.

## State

Phases 0-4, 7, 8, 9 done and confirmed on the user's machine. Phase 10 (sandbox
apartment) is frozen by their decision -- don't touch `sandbox.ts`,
`src/apartment/`, `camera-modes.ts`, `postfx.ts` unless asked. Phases 6 and 11
not started; Phase 5 camera built and user-tested, game-context awareness not.

Quick-action menu (the `+` button), all tested by the user except as noted:
Temp Chat (works), Camera (works; red-dot tray indicator), Upload Image/File
(works, attach-then-send), Continuous OCR (works; commented correctly on a
wallpaper), Conversation Log + Cycle Test Expression (moved in from the HUD).
**Live Voice Chat and Agent Mode are still disabled "Soon" rows.** New logo and
the small flat status dot (colors sampled from the user's reference) are in.

## Queue, roughly in order

- **Agent Mode:** planning conversation *before any code* -- it reverses the
  "observe-and-advise only" constraint in `CLAUDE.md`; needs a confirmation
  design that can't be bypassed by on-screen text, a clear definition of
  "modifying," and a cursor mechanism. The user wants hard confirmation on file
  changes (example task: "open browser and pull some cat pics").
- **Live Voice Chat:** a new architecture (voice-activity detection instead of
  push-to-talk, and she initiates speech). Not a toggle.
- **Upload gaps:** PDF, Word, and video (mp4) are deliberately unsupported.
- Task Guide / OCR interval tuning; temp-mode resets on websocket reconnect
  (known gap); Phase 5 game-context awareness; Phases 6 and 11.

## Hard-won lessons (details in `docs/DECISIONS.md`)

- **qwen3.5:9b is reliable at "read a short prompt, emit one JSON object" and
  unreliable at "decide mid-reply whether to call a tool."** Proven three times
  (`set_active_task`, camera re-invocation, `capture_screen`). Where intent is
  unambiguous, decide in Python (classifier or regex gate), keep native
  tool-calling only as a fallback. Don't try prompt-strengthening first again.
- The sandbox has no cargo, GPU, browser, or Ollama. Rust, vision, TTS and
  anything timing-related are only ever verified by the user's real machine --
  say "unverified" plainly, and don't reason your way to "confirmed."
- Orphaned GPT-SoVITS on port 9880 recurred three times; the fix is OS-level
  (Job Object + startup sweep), not more detection. The user closes Luna with
  End Task / Ctrl+C, not tray Quit.
- A "make it look like X" request with no attachment: build the smallest literal
  thing, not an embellished one (the orb cost an extra round).

## Working notes

- The user's merge routine is three PowerShell lines per bundle, in this form:
  `git fetch "C:\Users\User\Downloads\<name>.bundle" main:main-mirror`, then
  `git merge main-mirror`, then `git push origin main`. Repo is at
  `D:\AI\Project Luna\luna-phase1\luna`. There is no direct push from the sandbox;
  work ships as a git bundle in `/mnt/user-data/outputs`.
- The user wants **lean docs**: decisions + why + lessons only, no per-session
  narrative. `CLAUDE.md` stays short; history goes in `DECISIONS.md`, status in
  `ROADMAP.md`. Both were trimmed once already (about 5,800 -> about 2,900 lines
  combined) -- don't let them re-bloat.
- Tests: `orchestrator/` pytest (161 passing), `npx tsc --noEmit`, `npx vite
  build`. The frontend has no test runner; `ws_endpoint`'s message loop has no
  direct tests (a known, long-standing gap, not a regression).
- The sandbox's `orchestrator/config.yaml` is a gitignored local copy of the
  example, only there so tests import `config.py`.

## Ask the user, don't assume

Did the last bundle merge and push? Did the app build (any Rust error text)? Did
the confirm recipe in README's troubleshooting section show what it should? Any
local edits made on their machine that these docs wouldn't know about?
