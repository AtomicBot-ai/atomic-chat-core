---
date: 2026-10-07
title: "Embedding models are their own core module, served by name on /v1/embeddings"
---

# 2026-10-07 — Embedding models are their own core module, served by name on /v1/embeddings

- **Context:** The app wants users to download embedding models from a curated catalog (conf
  `models/embedding.json`, the decision catalog's shape) and serve them to API clients on the Local API
  Server's OpenAI-compatible `/v1/embeddings`, including multimodal ones: EmbeddingGemma 2
  (`gemma-embedding2`, ggml-org/llama.cpp#30054, first in b11454) and Qwen3-VL-Embedding put text, images
  and (Gemma) audio in one space through a projector. Until now embeddings existed only as an
  `isEmbedding` llama.cpp session the RAG path loads (`sentence-transformer-mini`, `--pooling mean` forced,
  the chat provider's batch settings, keyed by model id, never auto-loaded by `/v1/embeddings`). Such a
  session is unloaded by a chat model switch of its provider and cannot be reached by a client that names
  a model nobody loaded. llama.cpp serves multimodal embeddings from b11240 (#29556) as `input` items
  `{content: [parts]}`; an encoder without a KV cache needs one whole input, media tokens included, in one
  ubatch, and the server fetches an `http(s)` image URL itself.
- **Decision:** A module `src/embedding/` shaped like the decision module (ADR
  2026-09-30-the-decision-model-is-its-own-core-module), upstream llama.cpp only:
  - *One process, outside the sessions registry:* `settings.json` → `embedding` `{enabled, model_path,
    mmproj_path, model_id, ctx_size, pooling, image_max_tokens, threads, idle_unload_secs,
    startup_timeout_secs, engine_path}`; the app downloads the files and writes the section, the core only
    runs it. Same lifecycle as decision: serialized start/stop, restart with backoff, idle unload, a quiet
    rate-limited retry of `unsupported`, `embedding:state` / `embedding:error` events, `/atomic/v1/embedding/
    {status,config,load,unload,embed}`, and codes `EMBEDDING_NOT_CONFIGURED`, `EMBEDDING_ENGINE_UNSUPPORTED`,
    `EMBEDDING_MODEL_NOT_EMBEDDING` (409) and `EMBEDDING_UNAVAILABLE` (503).
  - *Gate:* the GGUF header says embedding (`isEmbeddingGguf`, now with `gemma-embedding2`), not decision and
    not a reranker (`pooling_type` 4); the floor is b11454 for `gemma-embedding2`, b11240 with a projector,
    none otherwise; the newest `llamacpp-upstream` pack at the floor, GPU first (`orderUpstreamCandidates`,
    reused from the decision module).
  - *Launch:* `-m <gguf> [--mmproj f] -a <id> -c n -b n -ub n --embedding [--pooling p] [--image-max-tokens n]
    [-t n] --host 127.0.0.1 --port p --no-webui`: batch = ubatch = context, so one input fits; `--pooling`
    only when set (else the GGUF's own, or `mean` for a file that names none); the context capped at the
    trained one (EmbeddingGemma 2's header says 262144). Not through the chat `args.ts`.
  - *Readiness:* `/health` 200, then one real `POST /v1/embeddings` of `["ping"]` (its length is the
    model's `dims`; 501 → unsupported build, another 4xx → the model refuses), then `/props.modalities` →
    `text` plus `image` / `audio` / `video`.
  - *Public API:* `POST /v1/embeddings` whose `model` equals the module's model id is served by the module
    (an idle module is started and waited on for up to 60 s); any other `model` goes to `serveForward` as
    before, with the body already read. The body passes through byte for byte after three checks (400 in the
    OpenAI shape): media only inline (`data:` or base64; links and `file://` refused so the engine never
    fetches what a client names), only the modalities the running model reads, and `dimensions` only equal to
    the model's (the engine would ignore it). The body cap is 64 MiB for inline media. The model is listed
    in `/v1/models` (`owned_by: "atomic-embedding"`) while the module is on, not in Muse Code's catalogue.
    The core never adds the models' query/document prompts; the app shows them for clients to copy.
- **Consequences:** An embedding model survives chat model switches and is reachable by name without a
  prior load. Only one runs at a time, like the decision model. The RAG path (`sentence-transformer-mini`
  as an `isEmbedding` session, `--pooling mean` forced in `runtime/llamacpp/args.ts`) is untouched; moving
  it onto this module is a separate decision. Reranking (`--reranking`, `/v1/rerank`) and Matryoshka
  truncation are not served. Verified live against ggml-org b11463 with EmbeddingGemma 2 Q8_0 + mmproj
  Q8_0 (text, image and audio), Qwen3-VL-Embedding-2B (text and image) and bge-m3
  (`test/live/embedding-upstream.test.ts`).
- **Owner:** team
- **Links:** `src/embedding/`, `src/contracts/embedding.ts`, `src/settings/embedding.ts`,
  `src/server/control/routes/embedding.ts`, `src/server/public/embedding.ts`; conf `models/embedding.json`;
  ggml-org/llama.cpp#29556, #30054, #30082.
