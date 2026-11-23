---
date: 2026-11-23
title: "Map every engine's context overflow to one error"
---

# 2026-11-23 — Map every engine's context overflow to one error

- **Context:** Compaction and growth can only react to an overflow they can recognize. Before this
  change, an overflow was reliably detected only on llama.cpp, MLX, vLLM, SGLang, TensorRT-LLM, and
  GenieX when not streaming. The gaps:
  - TensorRT-LLM's raw wording ("max_num_tokens") never says "context".
  - Strata, FastFlowLM and Foundry Local had no mapping (`mapError: () => null`).
  - GenieX opened its stream before prefill, so its overflow arrived as a late SSE error frame.
  - LiteRT-LM answered a prompt that did not fit with a 200 and `finish_reason: length`.
  - On `/v1/messages`, only llama.cpp's shape became Anthropic's `prompt is too long`. That is
    the error that makes Claude Code compact. Every other engine gave Claude Code an OpenAI error
    it does not act on.
- **Decision:** Every engine's prompt overflow is the OpenAI error with
  `code: 'context_length_exceeded'`. On `/v1/messages` it is Anthropic's 400
  `prompt is too long: N tokens > M maximum`, or a message without numbers when the engine names
  none.
  - `errors.ts` reads every known wording itself, plus any body whose `code` is
    `context_length_exceeded`. It accepts these at status 400, 413, 500 and 503, and pulls both
    numbers out (`contextOverflowSizes`).
  - FastFlowLM's two 400 wordings come from its pinned upstream source.
  - Strata and Foundry Local use the shared matcher. They are marked unverified until a live
    capture.
  - The GenieX and LiteRT-LM hosts open a stream at the first token. An overflow before it is
    the same 400 with or without streaming. Once an answer has started, LiteRT-LM still reports
    `finish_reason: length`.
- **Consequences:**
  - The compaction safety net works on every routed engine.
  - Claude Code compacts on vLLM, SGLang, TensorRT-LLM and the others, as it already did on
    llama.cpp.
  - A GenieX or LiteRT-LM stream that fails before its first token is now a JSON error instead
    of a 200 with an error frame.
  - Neither host exposes `/tokenize`. GenieX's C API has no tokenizer. LiteRT-LM's cannot render
    the chat template without a new FFI binding.
  - Watch for live wordings from Strata and Foundry Local and record them.
- **Owner:** `team`.
- **Links:** `src/server/public/errors.ts`, `src/runtime/fastflowlm/policy.ts`,
  `src/runtime/geniex/host/server.ts`, `src/runtime/litert-lm/host/server.ts`,
  `src/runtime/strata/strata-http.ts`, `src/runtime/foundry-local/runtime.ts`;
  `2026-11-23-compact-overflowing-chat-history-on-every-engine.md`.
