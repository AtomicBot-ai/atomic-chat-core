---
date: 2026-09-29
title: "tensorrt-llm: guided decoding is enabled per family, and every non-text response_format is gated"
---

# 2026-09-29 — tensorrt-llm: guided decoding is enabled per family, and every non-text response_format is gated

- **Context:** The pinned descriptor declares `structured_output: true` for almost every model family,
  and the provider reported that capability to the app and to `:1337`, which then let
  `response_format` through. But `trtllm-serve` 1.2.1 only enforces a `response_format` when the LLM
  API option `guided_decoding_backend` is set (`llmapi/llm_args.py`: `Optional[Literal["xgrammar",
  "llguidance"]]`, default `None`), and the launch never set it — an advertised capability that did
  not work (spec `tensorrt-llm-runtime`, "Возможности модели объявляются, а не угадываются"). Both
  gates (`server/public/policy.ts` and the session gateway's rewriter in
  `runtime/tensorrt-llm/adapter.ts`) also only recognised `json_schema`/`json_object`, so the engine's
  own `json`/`regex`/`ebnf`/`structural_tag` types (`serve/openai_protocol.py`'s `ResponseFormat`)
  reached a family that declares no structured output (final review I-2).
- **Decision:** When the family entry declares `structured_output: true`, the adapter's launch
  writes `llm-api-options.yaml` containing `guided_decoding_backend: xgrammar` and passes
  `--extra_llm_api_options /atomic/heartbeat/llm-api-options.yaml` (the v1.2.1 flag, alias
  `--config`, in `commands/serve.py`). The file is core-owned: the managed-text lifecycle writes an
  adapter's `ManagedEngineLaunch.files` into the generation directory
  (`heartbeats/<generation>/`), which is already mounted read-only into the container and removed
  with the generation, so no fifth mount is needed. A family that declares no structured output gets
  neither the flag nor the file. Both gates now refuse every `response_format` whose `type` is not
  `text` — including a missing or unknown type — when the family does not declare structured output.
  `xgrammar` rather than `llguidance`: it is the backend both TensorRT-LLM backends implement.
- **Consequences:** The capability the app sees is now backed by an engine setting. Whether
  `xgrammar` produces schema-valid output for a real model on the pinned image is not provable
  without a GPU: live test 2.19 must send a `response_format: json_schema` request and validate the
  answer; if it does not hold, the conservative fallback is to report `structured_output: false`
  until it does. A client that sent `response_format: {}` or an unknown type to a family without
  structured output now gets `unsupported_capability` instead of whatever the engine made of it.
- **Owner:** `team`.
- **Links:** `src/runtime/tensorrt-llm/adapter.ts` (`buildTensorrtLlmLaunch`,
  `TENSORRT_LLM_API_OPTIONS_FILE`, `asksForStructuredOutput`), `src/runtime/managed-text/adapter.ts`
  (`ManagedEngineLaunch.files`, `ManagedLaunchContext.generationFilesPath`),
  `src/runtime/managed-text/lifecycle.ts` (`writeLaunchFiles`), `src/server/public/policy.ts`,
  `docs/contracts.md` (the per-generation directory).
