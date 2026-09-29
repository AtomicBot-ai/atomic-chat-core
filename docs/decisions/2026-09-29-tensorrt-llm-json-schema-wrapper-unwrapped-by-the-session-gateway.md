---
date: 2026-09-29
title: "tensorrt-llm: the session gateway unwraps OpenAI's json_schema wrapper to the bare schema"
---

# 2026-09-29 — tensorrt-llm: the session gateway unwraps OpenAI's json_schema wrapper to the bare schema

- **Context:** The first real live run (Ubuntu 26.04, RTX 4070 Laptop, image
  `nvcr.io/nvidia/tensorrt-llm/release@sha256:cb4d8af8…faf5d7` = TRT-LLM 1.2.1, `Qwen/Qwen3-1.7B`,
  guided decoding initialised with XGRAMMAR per the per-family record below) failed live test 2.19's
  structured-output check. `serve/openai_protocol.py` in 1.2.1 explains why:
  `ResponseFormat` (lines 104–111) has `schema` and `json_schema`, both `Optional[dict]`, and
  `_response_format_to_guided_decoding_params` (lines 193–223) maps `type == "json"` to
  `GuidedDecodingParams(json=response_format.schema)` but `type == "json_schema"` to
  `GuidedDecodingParams(json=response_format.json_schema)` (lines 206–211) — the WHOLE field is the
  schema. OpenAI clients send `{"type":"json_schema","json_schema":{"name":…,"strict":…,"schema":S}}`,
  so the grammar is built from an object whose keywords are `name`/`strict`/`schema`, none of which
  constrains anything, and the model may answer with any JSON value. The engine's own Responses path
  (lines 226–235) confirms the intended shape: it builds `ResponseFormat(json_schema=<the bare
  schema>)`. Both `CompletionRequest` (line 288) and `ChatCompletionRequest` (line 550) take this
  `ResponseFormat`. Reproduced directly against `trtllm-serve` with core's own launch arguments: the
  OpenAI wrapper gave JSON strings (`"label"`, `"text"`); `json_schema: <bare schema>` and
  `{"type":"json","schema":S}` gave conforming objects, with thinking on and off. Through core, the
  2.19 answer was the same failure — a JSON string (`"Yes, I can help with that. …"`, violation `$
  should be object, is string`) — so the core path forwarded `response_format` intact and lost
  nothing; the wrapper grammar was simply applied as the engine defines it.
- **Decision:** `tensorrtLlmRewriteRequestBody` (the session gateway's request rewrite, which both
  `:1337` and a direct `SessionInfo.port` client pass through) translates on `/v1/chat/completions`
  and `/v1/completions`: when `response_format.type` is `json_schema` and `json_schema.schema` is an
  object, `json_schema` becomes that inner schema (`name`, `strict`, `description` are dropped — the
  engine has no use for them). A `json_schema` without an object `schema` key is taken as a bare
  schema already and passes unchanged. A `json_schema` that is missing or not an object is refused
  with an OpenAI-shaped `400 invalid_request_error` (`AtomicCoreError('INVALID_ARGUMENT')`, the same
  path as an invalid `max_tokens`) instead of the engine's own `ValueError`. Every other format type
  passes unchanged. The per-family capability gate still runs first.
- **Consequences:** An OpenAI client's structured-output request now reaches xgrammar as the schema
  it meant; live test 2.19 re-runs to confirm it on the real host. `strict: false` is not honoured
  as "loose" — the engine always enforces whatever schema it gets. A bare schema whose top level
  happens to carry an object-valued `schema` property would be misread as a wrapper; `schema` is not
  a JSON Schema keyword, so no real schema is expected to. A session the core did not start (one the
  app registered as external) is not behind this gateway and still receives the wrapper as sent. If
  a later pinned TRT-LLM release reads `json_schema.schema` itself, this rewrite becomes a no-op for
  the wrapper case and should be revisited with the descriptor bump.
- **Owner:** `team`.
- **Links:** `src/runtime/tensorrt-llm/adapter.ts` (`unwrapJsonSchemaFormat`,
  `tensorrtLlmRewriteRequestBody`), `src/runtime/tensorrt-llm/adapter.test.ts`,
  `test/e2e/tensorrt-llm-provider.test.ts`, `src/runtime/managed-text/gateway.ts`
  (`readAndRewriteBody`), `docs/contracts.md` (the `tensorrt-llm` public-server row); record
  `2026-09-29-tensorrt-llm-guided-decoding-is-enabled-per-family.md`.
