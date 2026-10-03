# Handoff

> Read once at the start of a session, then stop consulting it. It's a snapshot
> and goes stale on purpose. If it disagrees with `docs/ROADMAP.md` or
> `docs/DECISIONS.md`, those win. `CLAUDE.md` has the standing rules.

## Do this first

The user runs `hf.co/Abiray/Qwen3.5-9B-abliterated-GGUF:Q6_K` (tools, thinking,
completion, vision confirmed; `ollama ps` 7.3 GB, 100% GPU, ctx 8192; warm-up
loads it in 28 s). Their first messages failed with an HTTP 500 that the
previous bundle finally logged: the GGUF's Jinja template forbids a system
message after the first, and `_run_turn` splices the per-turn context in as
one. This bundle folds it into the user turn (`llm.fold_system_messages`).
Sandbox-verified only (282 pytest incl. a mock strict-template server, 13
`npm run test:fe`, `tsc`, `vite build`). Ask whether it merged, then collect:

1. Does chat work now? Any `LLM call failed (...)` line is the real error.
2. Does she still *use* the injected context -- memory facts, and especially a
   screen description after "look at my screen" -- now that it sits in the user
   turn? Does she ever echo the `[Context for this reply...]` bracket?
3. The first look on this model: `[luna] vision:` line (`load=`, `prompt_eval=`,
   `gen=`). The image path on a Jinja-template multimodal model is unverified.
4. Reasoning text leaking into replies (`think: false` unverified on this GGUF);
   `tool-calling:` lines (`calibration=` near 0.8).
5. With Minecraft running: `ollama ps` still `100% GPU`, `nvidia-smi` < 12288 MiB.
6. Still unconfirmed live: OCR quieter at 240 s, "use OCR" not starting a task,
   "I'm done" stopping one, mouth at 0.8.

## State

Phases 0-4, 7, 8, 9 and 9.5 done and confirmed on the user's machine (see the
9.5 entry in `docs/ROADMAP.md` for the list). Phase 10 (sandbox apartment) is
frozen by their decision -- don't touch `sandbox.ts`, `src/apartment/`,
`camera-modes.ts`, `postfx.ts` unless asked. Phases 5 (game-context
awareness), 6 and 11 not started. **Agent Mode (Phase 11) and Live Voice Chat
(Phase 12) are the two disabled "Soon" rows in the `+` menu.**

## Two planned phases (neither started; both are planning conversations)

- **Phase 13, Living avatar** (the user's idea, shell body: natural idles,
  breathing, gaze, expression cycles, occasional yawn / look-around / pout).
  `docs/ROADMAP.md` Phase 13 has the layered design and seven small steps.
  Start with step 0 (the VRM report above) and step 1 (procedural breathing and
  sway, no clips). Notes worth knowing: the last emotion currently stays on
  her face until the next tagged reply; the sandbox already plays curated VRMA
  clips but the user found some idles weird, so clips need an audition/keep
  list first; `sandbox.ts` stays frozen unless they allow extracting its loader.
  Its `listening | thinking | speaking` state is the same signal Phase 12 needs.

## Next: Phase 12, Live Voice Chat -- a planning conversation first

The user's framing: it continues the "continuity" thread (she already speaks
unprompted, so voice has to coexist with that). `docs/ROADMAP.md` Phase 12 has
what exists today, what is reusable, and six decisions to settle before code:
half-duplex vs barge-in, mic privacy (default off, visible indicator, mute
hotkey, nothing saved to disk), where VAD runs, echo of her own voice, a
single "who may speak next" arbiter shared with Task Guide and OCR, and STT on
CPU vs GPU. **Propose answers and let the user choose; don't start code.**
The one safe first step, once they agree, is per-stage latency logging (end of
speech -> transcript -> first LLM token -> first TTS audio) -- GPT-SoVITS is
the likely bottleneck and sets how "live" it can feel.

## Queue after that

- **Agent Mode (Phase 11):** planning conversation *before any code* -- it
  reverses "observe-and-advise only"; needs a confirmation design that can't be
  bypassed by on-screen text, a clear definition of "modifying," and a cursor
  mechanism. The user wants hard confirmation on file changes.
- Upload gaps (PDF, Word, mp4 are deliberately unsupported); Phase 5
  game-context awareness; Phase 6.
- Tuning: OCR frequency at 240 s, Task Guide interval/tone, and her habit of
  embellishing past the vision description (e.g. carrying "cake" into the next
  screen's answer). Not bugs.

## Hard-won lessons (details in `docs/DECISIONS.md`)

- **qwen3.5:9b is reliable at "read a short prompt, emit one JSON object" and
  unreliable at "decide mid-reply whether to act" or "follow a don't-repeat-
  yourself rule."** Proven four times now (`set_active_task`, camera
  re-invocation, `capture_screen`, OCR commenting on an unchanged screen five
  times running). Decide in Python (classifier, regex gate, similarity check),
  keep the prompt as the fallback. Don't try prompt-strengthening first.
- `done_reason='length'` far below `max_tokens` means the **context window**,
  not the output cap. Anything that appends to history on a timer needs a bound
  by size, not by count.
- The sandbox has no cargo, GPU, browser, or Ollama. Rust, vision, TTS, VRAM and
  timing are only verified on the user's machine -- say "unverified" plainly.
  A crate added to `Cargo.toml` leaves `Cargo.lock` stale here; the user's first
  build rewrites it, and that dirty tree can abort the next merge (commit the
  lockfile first). `Cargo.toml` can also look modified from LF/CRLF alone.
- Orphaned GPT-SoVITS recurred three times; the OS-level fix (Job Object +
  startup sweep) is confirmed. The user closes Luna with End Task / Ctrl+C.
- New config keys must have code defaults: a missing key in the user's own
  `config.yaml` was a startup `KeyError` once. This round's keys all default.
- A "make it look like X" request with no attachment: build the smallest
  literal thing, not an embellished one.

## Working notes

- Merge routine, three PowerShell lines per bundle, repo at
  `D:\AI\Project Luna\luna-phase1\luna`, bundles in `C:\Users\User\Downloads\`:
  `git fetch "C:\Users\User\Downloads\luna.bundle" main:main-mirror`, then
  `git merge main-mirror`, then `git push origin main`. No direct push from the
  sandbox; work ships as a git bundle. Re-pull `origin/main` before building
  the next one -- the user commits on their side too (`Cargo.lock`).
- The user wants **lean docs**: decisions + why + lessons only, no per-session
  narrative. `CLAUDE.md` stays short. Don't let them re-bloat.
- Tests: `orchestrator/` pytest (282 passing), `npm run test:fe` (13, pure
  frontend logic via esbuild + node:test, no new deps), `npx tsc --noEmit`,
  `npx vite build`. `ws_endpoint`'s message loop has no direct
  tests (long-standing gap), but the ambient-comment path now has app-level
  tests with faked capture/VLM/LLM/TTS (`test_app_ambient.py`).
- The sandbox's `orchestrator/config.yaml` is a gitignored copy of the example,
  only there so tests can import `config.py`.

## Ask the user, don't assume

Did the bundle merge and push? Anything in `orchestrator.log` that looks wrong
(paste the `tool-calling:` lines and any `WARNING`)? Did the app start with no
config error? Which Live Voice Chat decisions do they want to make first?
