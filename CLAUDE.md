# Project: Luna — Local AI Desktop Companion

A fully local, offline-capable desktop pet named **Luna**: a Live2D body, a
real LLM brain, a tsundere personality, persistent long-term memory, and
on-demand screen/camera vision. She's less a chatbot and more **a guide who
lives on the PC** — tell her what you're trying to do (build a Flappy Bird
webapp, grind a raid boss, whatever), she gives you the next concrete step,
and she keeps half an eye on the screen while that task is "active" to nudge
you back if you wander off. She never touches the mouse/keyboard or executes
anything herself — purely observe-and-advise, closer to a strict-but-caring
study buddy than an agent that acts for you.

**Non-negotiable constraint: 100% local.** No cloud LLM calls, no cloud TTS,
no telemetry. Everything — inference, voice, memory — runs on the user's own
machine. This drives most of the architecture decisions below.

---

## 1. Scope

### In scope (v1)
- Desktop-pet shell: transparent, click-through-able, always-on-top, draggable,
  system tray, low idle resource footprint (must coexist with a running game).
- Live2D character rendering with idle motion, lip-sync, and a small set of
  emotion-driven expressions.
- Text input box → she replies **by voice only** (TTS + Live2D lip-sync). No
  chat bubble transcript required as the primary UX, though logging internally
  is fine.
- Local LLM "brain" with tool-calling.
- Tsundere personality layer that doesn't degrade the model's actual
  reasoning/coding ability.
- **Task Guide Mode**: when a task is active, she takes screenshots on a
  schedule (not continuously) to check progress, and calls out — in
  character — when the user has drifted off-task, until the task is finished
  or the user explicitly says to drop it. This is the flagship behavior, not
  a side feature — see §2.1.
- Persistent memory that survives app restarts (not just session/context memory).
- Vision tools, invoked on demand by the model, not a continuous stream:
  - screen capture (full screen / active window / region)
  - clipboard read
  - OCR fallback for precise text reading
  - camera capture
- Coding-help and gaming-help as the two flagship use cases.

### Explicitly out of scope (v1)
- No continuous/always-on camera or screen streaming into context — vision is
  tool-call-gated, triggered by intent, not a live feed she "watches."
- No cloud fallback mode.
- No STT / voice input from the user (input is the text box; add later if wanted).
- No elaborate avatar customization, marketplace, monetization, or multi-character
  support. One character, done well.
- No auto-playing games or taking control of input devices — she can *see* and
  *advise*, not act on the user's behalf. (Revisit deliberately later if wanted.)
- Live2D model asset itself is **not something Claude generates** — needs to be
  sourced (Live2D free sample model for prototyping, purchased from Booth/the
  Live2D marketplace, or commissioned) and licensed properly by the user.

---

## 2. Architecture

Three tiers, talking over localhost only:

```
┌─────────────────────────────────────────────────────────────┐
│  SHELL (Tauri, Rust core + native webview)                    │
│  - transparent/click-through/always-on-top window management  │
│  - system tray, hotkeys                                       │
│  - PIXI.js 8 + pixi-live2d5 renders the model (vendored, see    │
│    vendor/pixi-live2d5/NOTES.md -- not on npm)                  │
│  - input textbox; plays back streamed audio; drives             │
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
│ LLM/VLM engine    │   │ TTS engine     │   │ SQLite (+sqlite-vec)│
│ (llama.cpp server │   │ (GPT-SoVITS or │   │ facts / episodes /  │
│  or Ollama)        │   │  Style-Bert-   │   │ embeddings           │
│                    │   │  VITS2 server) │   │                      │
└────────────────────┘   └────────────────┘   └──────────────────────┘
```

**Why Tauri over Electron:** the app has to sit alongside a running game without
eating FPS/RAM. Tauri's native webview + Rust core has a much smaller idle
footprint than Chromium, and transparent/always-on-top/click-through desktop-pet
windows are a well-trodden path on Tauri (see BongoCat, CrabNebula's desktop-pet
guide, various `desktop-mascot` Tauri projects) with Live2D rendering fine
inside the webview via `pixi-live2d5` (PixiJS 8) -- see
vendor/pixi-live2d5/NOTES.md for why this specific fork/version pin matters:
the more obvious `pixi-live2d-display` (and its lipsyncpatch fork) don't
support the Cubism Core version Live2D currently ships. Electron would be fine functionally, but it's
the wrong tradeoff for "runs while I game."

**Why a Python orchestrator instead of pure Rust:** the LLM and TTS themselves
run as their own local inference servers (llama.cpp/Ollama, GPT-SoVITS), so
Rust never touches raw ML code directly — it just talks to two local HTTP/WS
APIs. Everything Python owns (agent loop, tool execution, memory, image/OCR
glue) is business logic, not perf-critical, and the local-AI tooling ecosystem
(embeddings, OCR, screen capture, vector search) is far more mature in Python.
This keeps Rust focused on what it's good at (window/OS integration) and Python
focused on what it's good at (gluing AI services together), and keeps every
piece swappable — important since local model recommendations will keep
changing every few months.

### Personality architecture — keep the brain smart, make the *voice* tsundere

Do **not** fine-tune "tsundere" into the reasoning model — that tends to
degrade actual coding/reasoning quality. Instead, split into two passes:

1. **Core pass (neutral, smart):** the LLM answers/plans/uses tools normally,
   with a competent-assistant system prompt. This is where "actual smartness"
   lives — correctness of code fixes, game advice, tool selection.
2. **Persona pass (fast, small):** rewrites the neutral answer into her voice
   and emits an `emotion` tag (`annoyed`, `smug`, `soft`, `flustered`, …) used
   to drive Live2D expression + TTS style. Code blocks / exact values pass
   through untouched — only the narration around them gets stylized.

v1 (Phase 2) can collapse this into a single well-prompted pass for latency;
split it into two real passes in Phase 6 once quality/consistency matters more
than raw latency. Keep the seam in the code either way (a `persona.py` module
the core pass output flows through) so splitting later is a small change, not
a rewrite.

### Memory — durable across restarts, not just context

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

### Vision tools — pull, not push

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
  though nothing is displayed back to the user. Cheap to add, meaningfully
  better for trust, and avoids surprising behavior later.

### §2.1 Task Guide Mode — the flagship behavior

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
   same emotion-tag system in §2's persona pass, not bolted on separately.
5. The task stays active until it's finished, the user says to drop/pause it,
   or an idle timeout is hit. Dropping a task is always a one-line command
   away — this should never feel like it's fighting the user.
6. **Hard boundary:** she never operates the mouse/keyboard, writes files, or
   runs code on the user's behalf. She can *tell* the user what to type; she
   never types it herself. This keeps the "computer-use" surface to read-only
   perception — simpler to build, and it sidesteps the much bigger reliability
   and safety surface that comes with an agent that actually acts on the
   machine.

---

## 3. Model choices

Recommendation: **use one multimodal model (a VLM) for both conversation and
vision**, rather than routing between a separate text model and a separate
vision model — simpler infra, one thing to tune the persona prompt against,
one thing to keep loaded in VRAM. Serve it through **Ollama or a llama.cpp
server** (OpenAI-compatible endpoint + tool calling), so the model is a config
value, not something wired deep into the code.

**Locked default for this build (RTX 3060 12GB, i5-14400F, 32GB DDR5-4800):
Qwen3-VL-8B.** At Q4 that's ~6GB VRAM, comfortable on its own — but on a 12GB
card that pool is also shared with GPT-SoVITS and, during Task Guide Mode,
whatever game is in the foreground. Worth designing for from the start rather
than discovering it later:
- Run GPT-SoVITS on CPU. She only speaks in short bursts, so the latency hit
  is acceptable, and it frees the full 12GB for the LLM + game.
- Idle/unload the model when the foreground app is a game and no request is
  pending, waking on the next scheduled screenshot check or text input rather
  than sitting resident the whole time.
- If a demanding game visibly starves the 3060, add a lighter "game mode"
  quant (Q4_K_S or smaller) as a separate profile from the "coding session,
  no game open" config.

| VRAM tier | Model | Notes |
|---|---|---|
| ~8 GB | Qwen3-VL-4B (or Gemma 3 4B) | Entry tier; both are multimodal, Gemma 3 has slightly broader day-one runtime support |
| ~12 GB (recommended default) | **Qwen3-VL-8B** | Leads its size class on multimodal reasoning (MMMU) and document/screenshot reading (DocVQA), Apache-2.0, ~6 GB at Q4. Best default starting point. |
| ~16 GB | Gemma 4 12B | Native text+image(+audio) input, 256K context |
| ~24 GB | Qwen3.6-27B (dense) | Strongest coding/reasoning at this size, but tight to *also* keep an 8B VLM loaded concurrently — either use it as the sole model (its own vision variant if available) or swap models on vision calls rather than co-resident |
| ~32 GB | Qwen3.6-35B-A3B (MoE, 3B active) | Best all-round pick most people can actually run at this tier; MoE keeps it snappy for real-time banter despite the total size |
| 48 GB+ | Llama 4 Scout / Qwen3-Coder-Next / Nemotron-tier | Room to run a big conversational model and a big VLM concurrently if wanted |

**TTS:** GPT-SoVITS as the primary pick — few-shot voice cloning (a handful of
seconds to a minute of reference audio), multilingual, this is what most
existing local AI-vtuber/waifu projects use for exactly this use case.
Style-Bert-VITS2 is a solid alternative with stronger emotional-style control
if the extra setup is worth it. For getting the audio pipeline stood up in
Phase 1 before investing in a cloned voice, Kokoro-82M is a good lightweight
placeholder (fast, small, no cloning). Whatever reference voice is used for
cloning should be one you actually have the rights to use.

**STT:** not needed for v1 (text input only). If added later: whisper.cpp /
faster-whisper, local, well-trodden.

---

## 4. Directory layout (proposed)

```
/shell/            Tauri app (Rust core + web frontend)
  src-tauri/        Rust: window mgmt, tray, hotkeys, IPC
  src/              PIXI 8 + pixi-live2d5, input box, audio playback,
                      manual lipsync (lipsync.ts)
  vendor/pixi-live2d5/  vendored prebuilt copy (not on npm), see its NOTES.md
/orchestrator/      Python: FastAPI/WebSocket server
  agent/            agent loop, tool definitions, persona pass
  memory/           SQLite schema, consolidation job
  tools/            capture_screen, capture_camera, ocr, clipboard
/models/            gitignored — local model weights live outside the repo
/assets/live2d/     gitignored or licensed-assets-only — the character model
```

---

## 5. Roadmap

- **Phase 0 — Spec (this doc).**
- **Phase 1 — Shell MVP.** Tauri window (transparent, click-through, always-on-top,
  tray), Live2D model idles on screen, input box, a canned line plays through
  the TTS pipeline end-to-end. No LLM yet — this phase proves the shell + audio
  plumbing works.
- **Phase 2 — Brain online.** Wire the local LLM/VLM server in, single-pass
  tsundere persona prompting, streamed text → TTS → lip-sync. Real
  conversation, session-only memory, no tools yet.
- **Phase 3 — Persistent memory.** SQLite facts/episodes, consolidation job,
  recall injected into the system prompt each turn.
- **Phase 4 — Vision tools + Task Guide Mode.** `capture_screen` +
  `read_clipboard` + OCR fallback, tool-calling loop live. On-demand "look at
  my screen" works for coding help, and the scheduled-capture /
  off-task-chide loop from §2.1 works end-to-end for at least one flagship
  scenario (the Flappy Bird walkthrough is a good test case).
- **Phase 5 — Camera + game-assist polish.** Gated camera tool, light
  game-context awareness (e.g. active-window detection), expression/emotion
  mapping refined.
- **Phase 6 — Personality & perf pass.** Optional split into two-pass
  planner/persona, voice tuning, memory quality tuning, profile resource usage
  with a game running to confirm she doesn't cost FPS.

---

## 6. Working agreement for Claude Code sessions

- Model/engine choices are config, never hardcoded — the LLM endpoint, model
  name, and TTS engine should all live in one config file so they can change
  without touching app logic.
- Don't add cloud calls of any kind without being asked explicitly — the whole
  point of this project is that it's local.
- Keep the persona pass separable from the core reasoning pass in code, even
  while v1 collapses them into one prompt (see §2) — don't hard-couple them.
- Vision/audio work must never block the Tauri UI thread; long-running work
  belongs in the orchestrator, not the shell.
- Camera access always goes through the explicit permission + indicator path
  in §2 — don't add a silent/continuous capture mode.
- Prefer editing/extending an existing tool over adding a new overlapping one;
  keep the tool list small and each tool's contract explicit (JSON schema).
- Build/run commands: **TBD** — fill in once the repo is scaffolded in Phase 1.

---

## 7. Open decisions

Resolved:
- GPU/VRAM: RTX 3060 12GB, i5-14400F, 32GB DDR5-4800 → Qwen3-VL-8B is the
  locked default (see §3).
- Name: **Luna**.

Still open:
- Target OS — assumed **Windows** given the hardware profile; flag if that's
  wrong, since it changes the window-transparency implementation in the Tauri
  core (the macOS path needs explicit NSWindow config; Windows is simpler).
- Task Guide Mode tuning: screenshot interval while a task is active, and how
  aggressive the nagging should be (fixed, or a tone dial the user can turn
  down when they're not in the mood to be chided).
- Live2D model source (free sample vs. purchased vs. commissioned) and its
  license terms.
- Voice reference source for TTS cloning, and its rights.
