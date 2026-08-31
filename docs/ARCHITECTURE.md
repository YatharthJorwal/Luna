# Architecture

Three tiers, talking over localhost only:

```
┌─────────────────────────────────────────────────────────────┐
│  SHELL (Tauri, Rust core + native webview)                    │
│  - transparent/click-through/always-on-top window management  │
│  - system tray, hotkeys                                       │
│  - PIXI.js 8 + pixi-live2d5 renders the model (vendored, see   │
│    vendor/pixi-live2d5/NOTES.md -- not on npm)                 │
│  - input textbox; plays back streamed audio; drives            │
│    lip-sync + expression from orchestrator events              │
└───────────────────────────▲────────────────────────────────────┘
                             │ WebSocket (localhost only)
┌───────────────────────────▼────────────────────────────────────┐
│  ORCHESTRATOR ("Waifu Core") — Python, FastAPI/WebSocket        │
│  - owns the agent loop: user msg → LLM (w/ tools) → tool exec   │
│    → persona pass → TTS → stream text+audio+emotion tag back    │
│  - owns tool implementations: capture_screen, capture_camera,   │
│    ocr_region, read_clipboard, memory_search, memory_write      │
│  - owns memory store + consolidation                            │
└──────┬───────────────────────┬──────────────────────┬──────────┘
       │ OpenAI-compatible API │ local HTTP            │ local disk
┌──────▼───────────┐   ┌───────▼────────┐   ┌──────────▼─────────┐
│ LLM/VLM engine     │   │ TTS engine     │   │ SQLite (+sqlite-vec)│
│ (llama.cpp server  │   │ (GPT-SoVITS or │   │ facts / episodes /  │
│  or Ollama)         │   │  Style-Bert-   │   │ embeddings           │
│                     │   │  VITS2 server) │   │                      │
└─────────────────────┘   └────────────────┘   └──────────────────────┘
```

Model/engine choices (which LLM, which TTS) are covered in `MODELS.md`, not
here -- this doc is about the shape of the system, not which model fills
each box.

## Why Tauri over Electron

The app has to sit alongside a running game without eating FPS/RAM. Tauri's
native webview + Rust core has a much smaller idle footprint than Chromium,
and transparent/always-on-top/click-through desktop-pet windows are a
well-trodden path on Tauri (BongoCat, CrabNebula's desktop-pet guide,
various `desktop-mascot` Tauri projects). Electron would work functionally,
it's just the wrong tradeoff for "runs while I game."

## Why a Python orchestrator instead of pure Rust

The LLM and TTS themselves run as their own local inference servers
(llama.cpp/Ollama, GPT-SoVITS), so Rust never touches raw ML code directly —
it just talks to two local HTTP/WS APIs. Everything Python owns (agent loop,
tool execution, memory, image/OCR glue) is business logic, not perf-critical,
and the local-AI tooling ecosystem (embeddings, OCR, screen capture, vector
search) is far more mature in Python. Rust stays focused on window/OS
integration, Python on gluing AI services together, and every piece stays
swappable — useful since local model recommendations keep changing.

## Personality architecture — keep the brain smart, make the *voice* tsundere

Do **not** fine-tune "tsundere" into the reasoning model — that tends to
degrade actual coding/reasoning quality. Instead, split into two passes:

1. **Core pass (neutral, smart):** the LLM answers/plans/uses tools normally,
   with a competent-assistant system prompt. This is where "actual smartness"
   lives — correctness of code fixes, game advice, tool selection.
2. **Persona pass (fast, small):** rewrites the neutral answer into her voice
   and emits an `emotion` tag (`annoyed`, `smug`, `soft`, `flustered`, …) used
   to drive Live2D expression + TTS style. Code blocks / exact values pass
   through untouched — only the narration around them gets stylized.

Phase 2 can collapse this into a single well-prompted pass for latency; split
it into two real passes in Phase 6 once quality/consistency matters more than
raw latency. Keep the seam in the code either way (a `persona.py` module the
core pass output flows through) so splitting later is a small change, not a
rewrite.

## Memory — durable across restarts, not just context

SQLite file in the app's local data dir (e.g. `~/.local/share/<app>/memory.db`
or platform equivalent), with `sqlite-vec` for embedding search.

- `facts` — durable user facts (preferences, current projects, games played,
  stack). Written either from explicit user statements ("remember that I...")
  or from periodic consolidation.
- `episodes` — rolling **summaries** of past sessions, not raw transcripts,
  each with an embedding for semantic recall ("that bug we fixed last week").
- Consolidation runs at session end (or periodically): the LLM distills the
  session into candidate facts/an episode summary and writes them. Never dump
  raw message logs into long-term memory — distill, don't transcribe.

## Vision tools — pull, not push

All vision is a tool call the model chooses to make, not a continuous feed:

- `capture_screen(region: "full" | "active_window" | {x,y,w,h})` — screenshot,
  fed to the VLM, returns a textual analysis (not raw pixels) to the reasoning
  pass. Don't store screenshots in long-term memory; a thumbnail + description
  is enough if anything.
- `read_clipboard()` — the more reliable path for coding help (paste a stack
  trace / snippet instead of relying on OCR of a screenshot).
- `ocr_region(...)` — fallback for precise text extraction the VLM's own OCR
  isn't nailing (dense game UI text, small fonts).
- `capture_camera()` — gated behind an explicit one-time user permission and a
  visible "camera active" indicator (tray icon state) whenever it's used, even
  though nothing is displayed back to the user.

## Task Guide Mode — the flagship behavior

This is the actual core loop of the app, not a side feature:

1. A task becomes "active" when the user states one ("help me build a Flappy
   Bird webapp in Python") or Luna infers one from context and confirms it.
2. She gives the next concrete step, not the whole plan dumped at once — she
   acts like a guide standing next to you, not a wiki page ("open Python and
   let's start with the game loop" — not a 12-step tutorial up front).
3. While a task is active, the orchestrator schedules `capture_screen` on an
   interval (start conservative — e.g. every 60–120s, or on foreground-window
   change — tune in Phase 4/6) instead of on every turn. Each capture is
   checked against "what should be on screen for the current step."
4. If a capture shows the user has drifted to something unrelated (different
   app, different site), she calls it out in character — a chide, not a
   lecture — and steers back to the step. This is one of the most natural
   expressions of the tsundere persona, so it should be wired through the
   same emotion-tag system above, not bolted on separately.
5. The task stays active until it's finished, the user says to drop/pause it,
   or an idle timeout is hit. Dropping a task is always a one-line command
   away — this should never feel like it's fighting the user.
6. **Hard boundary:** she never operates the mouse/keyboard, writes files, or
   runs code on the user's behalf. She can *tell* the user what to type; she
   never types it herself. This keeps the "computer-use" surface to read-only
   perception — simpler to build, and it sidesteps the much bigger reliability
   and safety surface that comes with an agent that actually acts on the
   machine.

## Directory layout

```
/                  Tauri app root (Rust core + web frontend)
  src-tauri/        Rust: window mgmt, tray, hotkeys, IPC
  src/              PIXI 8 + pixi-live2d5, input box, audio playback,
                      manual lipsync (lipsync.ts)
  vendor/pixi-live2d5/  vendored prebuilt copy (not on npm) -- see its NOTES.md
/orchestrator/      Python: FastAPI/WebSocket server
  agent/            agent loop, tool definitions, persona pass (Phase 2+)
  memory/           SQLite schema, consolidation job (Phase 3+)
  tools/            capture_screen, capture_camera, ocr, clipboard (Phase 4+)
/models/            gitignored — local model weights live outside the repo
/public/live2d/     the character model (Hiyori placeholder is committed --
                     see docs/DECISIONS.md; a real model wouldn't be)
```
