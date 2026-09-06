# Models

Recommendation: **use one multimodal model (a VLM) for both conversation and
vision**, rather than routing between a separate text model and a separate
vision model — simpler infra, one thing to tune the persona prompt against,
one thing to keep loaded in VRAM. Serve it through **Ollama or a llama.cpp
server** (OpenAI-compatible endpoint + tool calling), so the model is a config
value, not something wired deep into the code.

## Locked default for this build

**RTX 3060 12GB, i5-14400F, 32GB DDR5-4800 → Qwen3.5-9B**, replacing the
original Qwen3-VL-8B pick once Qwen3.5 actually shipped (see
`docs/DECISIONS.md` for the re-pick reasoning — natively multimodal rather
than vision-bolted-on, benchmarks ahead of Qwen3-VL even at larger sizes).
At Q4_K_M that's ~6.6GB VRAM, close enough to the original pick's
footprint that everything below still applies — but on a 12GB card that
pool is also shared with GPT-SoVITS and, during Task Guide Mode, whatever
game is in the foreground. Worth designing for from the start rather than
discovering it later:

- Run GPT-SoVITS on CPU. She only speaks in short bursts, so the latency hit
  is acceptable, and it frees the full 12GB for the LLM + game.
- Idle/unload the model when the foreground app is a game and no request is
  pending, waking on the next scheduled screenshot check or text input rather
  than sitting resident the whole time.
- If a demanding game visibly starves the 3060, add a lighter "game mode"
  quant (Q4_K_S or smaller) as a separate profile from the "coding session,
  no game open" config.

**Caveat that comes with Qwen3.5 specifically:** it's a hybrid-thinking
model, and `orchestrator/config.yaml`'s `llm.api_style: "ollama_native"` +
`llm.think: false` exist specifically to keep its reasoning phase off —
see `docs/DECISIONS.md` for why the plain OpenAI-compatible endpoint
can't be trusted to do this reliably. If a future model swap moves away
from a thinking model, `api_style` can go back to `"openai"` and `think`
can be `null`.

## Full tier table (for reference / if hardware changes)

| VRAM tier | Model | Notes |
|---|---|---|
| ~8 GB | Qwen3-VL-4B (or Gemma 3 4B) | Entry tier; both are multimodal, Gemma 3 has slightly broader day-one runtime support |
| ~12 GB (recommended default) | **Qwen3.5-9B** | Natively multimodal (not vision-bolted-on like the Qwen3-VL generation it replaces here), beats Qwen3-VL on vision benchmarks even at larger sizes, Apache-2.0, ~6.6 GB at Q4_K_M. Hybrid-thinking — see the caveat above. |
| ~16 GB | Gemma 4 12B | Native text+image(+audio) input, 256K context — also hybrid-thinking, and as of mid-2026 has its *own* open bug where the OpenAI-compatible endpoint doesn't expose non-thinking content correctly at all (see `docs/DECISIONS.md`'s links); check current status before picking it for this role |
| ~24 GB | Qwen3.6-27B (dense) | Strongest coding/reasoning at this size, but tight to *also* keep an 8B VLM loaded concurrently — either use it as the sole model (its own vision variant if available) or swap models on vision calls rather than co-resident |
| ~32 GB | Qwen3.6-35B-A3B (MoE, 3B active) | Best all-round pick most people can actually run at this tier; MoE keeps it snappy for real-time banter despite the total size |
| 48 GB+ | Llama 4 Scout / Qwen3-Coder-Next / Nemotron-tier | Room to run a big conversational model and a big VLM concurrently if wanted |

Re-checked once already, going into the model swap documented above (see
`docs/DECISIONS.md`) — this table reflects that check, current as of
around when Phase 2 wrapped. Worth another pass before Phase 4/5's vision
work actually starts exercising the model's multimodal side for real,
since this space moves in weeks, not months.

## TTS

**GPT-SoVITS** as the primary pick — few-shot voice cloning (a handful of
seconds to a minute of reference audio), multilingual, this is what most
existing local AI-vtuber/waifu projects use for exactly this use case.
**Style-Bert-VITS2** is a solid alternative with stronger emotional-style
control if the extra setup is worth it. Whatever reference voice is used for
cloning should be one you actually have the rights to use.

Phase 1/2 ship **pyttsx3** (SAPI5 on Windows) instead, on purpose — zero
model download, just to prove the audio pipeline works before investing in a
cloned voice. Real voice work has been pulled forward (see
`docs/ROADMAP.md`'s Phase 2.5) now that a reference sample is in hand.

GPT-SoVITS is run as its own local API server (not embedded in the
orchestrator process) — `orchestrator/tts.py`'s GPT-SoVITS backend will
call it over HTTP the same way any other local backend does. Confirmed the
actual request/response shape by reading a real reference implementation
(`rayenfeng/riko_project` on GitHub, MIT-licensed, itself credits
`RVC-Boss/GPT-SoVITS` for the API server and `SYSTRAN/faster-whisper` for
ASR — same picks as below): `POST http://127.0.0.1:9880/tts` with
`{text, text_lang, ref_audio_path, prompt_text, prompt_lang}`, raw WAV
bytes back. `prompt_text` has to be an accurate transcript of what's
actually said in the reference audio — GPT-SoVITS uses it as part of the
voice-cloning conditioning, it's not just a label. Reference audio itself
should be a single clean clip, no long silences, per the same source.

## STT

Was out of scope for v1 (text input only) — see `docs/ROADMAP.md`'s scope
section for that original call and the note on why it changed.
**faster-whisper** (CTranslate2-based, not the original `openai-whisper`
package) is the pick if/when added: substantially lower resource use for
the same accuracy, which matters more here than usual since it has to
share the 3060 with an LLM that's already sized to nearly fill it. Also
confirmed against the same `riko_project` reference: `faster_whisper.
WhisperModel(model_size, device, compute_type)`, `.transcribe(path)`
returns segments to join into text — about as simple as local STT gets.

## Embeddings (Phase 3 memory recall)

**nomic-embed-text** via Ollama — 768-dim, Apache-2.0, ~274MB. Picked
over a heavier/higher-quality alternative (e.g. `mxbai-embed-large`)
specifically because it's small enough to sit in VRAM alongside
`qwen3.5:9b` with room to spare, same reasoning as the STT/LLM VRAM
budget above, and because reusing the Ollama instance already running
for the LLM means zero new server processes — `ollama pull
nomic-embed-text` is the only new setup step, no new Python ML
dependency to manage.

Confirmed the actual request/response shape against current Ollama docs
before writing `orchestrator/memory/embeddings.py` (same standard
`docs/DECISIONS.md`'s `think`-flag investigation already held itself to
— don't assume, check): `POST {base_url}/api/embed` with
`{"model": "nomic-embed-text", "input": ["text"]}` (a list, even for one
string), `{"embeddings": [[...]]}` back. Deliberately not the older
`/api/embeddings` (singular `prompt`/`embedding` fields) — current docs
mark that legacy and it's a common source of silent 404s on newer
installs.

Swappable via `orchestrator/config.yaml`'s `memory.embedding` block, but
the vector width (`memory.embedding.dimension`) is baked into the
`episode_vectors` sqlite-vec table at creation time — swapping models
after episodes already exist needs either a fresh DB or reverting the
model, see `orchestrator/memory/db.py`'s dimension-mismatch check (prints
a clear startup warning rather than letting this surface as a cryptic
sqlite-vec error mid-turn).
