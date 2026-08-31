# Models

Recommendation: **use one multimodal model (a VLM) for both conversation and
vision**, rather than routing between a separate text model and a separate
vision model — simpler infra, one thing to tune the persona prompt against,
one thing to keep loaded in VRAM. Serve it through **Ollama or a llama.cpp
server** (OpenAI-compatible endpoint + tool calling), so the model is a config
value, not something wired deep into the code.

## Locked default for this build

**RTX 3060 12GB, i5-14400F, 32GB DDR5-4800 → Qwen3-VL-8B.** At Q4 that's
~6GB VRAM, comfortable on its own — but on a 12GB card that pool is also
shared with GPT-SoVITS and, during Task Guide Mode, whatever game is in the
foreground. Worth designing for from the start rather than discovering it
later:

- Run GPT-SoVITS on CPU. She only speaks in short bursts, so the latency hit
  is acceptable, and it frees the full 12GB for the LLM + game.
- Idle/unload the model when the foreground app is a game and no request is
  pending, waking on the next scheduled screenshot check or text input rather
  than sitting resident the whole time.
- If a demanding game visibly starves the 3060, add a lighter "game mode"
  quant (Q4_K_S or smaller) as a separate profile from the "coding session,
  no game open" config.

## Full tier table (for reference / if hardware changes)

| VRAM tier | Model | Notes |
|---|---|---|
| ~8 GB | Qwen3-VL-4B (or Gemma 3 4B) | Entry tier; both are multimodal, Gemma 3 has slightly broader day-one runtime support |
| ~12 GB (recommended default) | **Qwen3-VL-8B** | Leads its size class on multimodal reasoning (MMMU) and document/screenshot reading (DocVQA), Apache-2.0, ~6 GB at Q4. Best default starting point. |
| ~16 GB | Gemma 4 12B | Native text+image(+audio) input, 256K context |
| ~24 GB | Qwen3.6-27B (dense) | Strongest coding/reasoning at this size, but tight to *also* keep an 8B VLM loaded concurrently — either use it as the sole model (its own vision variant if available) or swap models on vision calls rather than co-resident |
| ~32 GB | Qwen3.6-35B-A3B (MoE, 3B active) | Best all-round pick most people can actually run at this tier; MoE keeps it snappy for real-time banter despite the total size |
| 48 GB+ | Llama 4 Scout / Qwen3-Coder-Next / Nemotron-tier | Room to run a big conversational model and a big VLM concurrently if wanted |

This table is a snapshot from when Phase 0 was scoped -- worth re-checking
current best-in-class local models before Phase 2, since this space moves in
weeks, not months.

## TTS

**GPT-SoVITS** as the primary pick — few-shot voice cloning (a handful of
seconds to a minute of reference audio), multilingual, this is what most
existing local AI-vtuber/waifu projects use for exactly this use case.
**Style-Bert-VITS2** is a solid alternative with stronger emotional-style
control if the extra setup is worth it. Whatever reference voice is used for
cloning should be one you actually have the rights to use.

Phase 1 ships **pyttsx3** (SAPI5 on Windows) instead, on purpose — zero
model download, just to prove the audio pipeline works before investing in a
cloned voice. Swap it out in `orchestrator/tts.py` when you get to real voice
work; nothing else in the pipeline needs to change (see
`docs/ROADMAP.md`).

## STT

Not needed for v1 (text input only). If added later: whisper.cpp /
faster-whisper, local, well-trodden.
