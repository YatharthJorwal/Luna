# Decisions

A running log of *why*, specifically for the things that would otherwise look
like unexplained weirdness in the codebase. Add to this whenever a decision
gets made that isn't obvious from the code alone -- especially ones forced by
reality during implementation, not planned in Phase 0.

## Live2D rendering: `pixi-live2d5` (vendored), not `pixi-live2d-display`

The obvious choice, `pixi-live2d-display` (and its `-lipsyncpatch` fork,
which was tried first), crashes on render against Cubism Core 6.0.1 — which
is the only version Live2D's site currently serves. This is a real, open
upstream bug: neither library has been updated for that Core release
(confirmed via https://github.com/guansss/pixi-live2d-display/issues/177 and
similar open issues).

Fix: `omniwaifu/pixi-live2d5` (https://github.com/omniwaifu/pixi-live2d5) is
a fork built and tested specifically against Core 6.0.1. It's not published
to npm, so it's vendored as a prebuilt local package at
`vendor/pixi-live2d5/` — see that folder's `NOTES.md` for exact rebuild
steps. This also forced PixiJS 7 → 8 (this fork's peer dependency).

Trade-off: this fork dropped the old library's `speak()`/auto-lipsync
convenience method (confirmed by reading its source — the hook exists in
`Cubism5InternalModel.ts` but is commented out). `src/lipsync.ts` drives it
manually instead, via a Web Audio `AnalyserNode` reading amplitude each frame
and pushing it into whichever parameters the model's own `model3.json`
declares under its `LipSync` group (not hardcoded to Hiyori's
`ParamMouthOpenY` specifically, so this keeps working if the model changes).

## Window: `maximizable: false`, `layout()` runs off the ticker, not a resize listener

A decorationless Tauri window's drag region still honors Windows' native
double-click-to-maximize gesture by default. Combined with our own
`window.addEventListener("resize", layout)` racing against PIXI's own
`resizeTo: window` plugin (both listen for resize independently, no
ordering guarantee between them), a maximize/restore cycle could reposition
Luna using stale renderer dimensions and send her off-window entirely.

Fix: `maximizable: false` in `tauri.conf.json` (she can still be dragged and
edge-resized, just not maximized), and `layout()` now runs every tick via
`app.ticker.add(layout)` instead of on a resize event — negligible cost,
can't race.

## Hiyori (Live2D's official free sample) is committed to the repo

Normally a Live2D model wouldn't belong in version control (see
`docs/ROADMAP.md`'s open decision on sourcing a real one), but Hiyori is
explicitly licensed by Live2D for exactly this kind of prototyping (Free
Material License) and there's nothing user-specific or sensitive about it —
committing it means the repo is immediately runnable after a clone (module
the Cubism Core file below). Swap it for a licensed/purchased/commissioned
model before this is anything more than a local dev build.

## `public/live2dcubismcore.min.js` is gitignored, always missing after a clone

Live2D's license terms don't allow third parties (including us) to
redistribute the Cubism Core runtime. It has to be downloaded fresh from
https://www.live2d.com/en/sdk/download/web/ after every fresh clone — see
the README's Prerequisites section. This is the #1 thing to check first if a
fresh clone renders a blank window.

## Git workflow: bundle-based handoff, not a shared remote

Claude doesn't have push access to the user's GitHub repo (or persistent
access to their machine at all) — each work session happens in a fresh
sandbox. Changes get committed there with real messages, then handed over as
a `git bundle` file the user clones or pulls from locally, and finally
pushes to GitHub themselves (`YatharthJorwal/Luna`). This preserves real
commit history end to end instead of flattening every update into one blob.

## pyttsx3 as the Phase 1 placeholder voice

Zero model download (uses SAPI5 on Windows already), which matters for
proving the shell/audio pipeline works before spending time on GPT-SoVITS
setup. Swap it for real TTS in `orchestrator/tts.py` when Phase 2/6 gets to
voice work — see `docs/MODELS.md`.
