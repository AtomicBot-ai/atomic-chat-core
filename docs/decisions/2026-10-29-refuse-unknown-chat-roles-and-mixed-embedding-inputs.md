---
date: 2026-10-29
title: "Refuse unknown chat roles and mixed embedding inputs before a local engine"
---

# 2026-10-29 — Refuse unknown chat roles and mixed embedding inputs before a local engine

- **Context:** QA of app 2.2.29 (core 0.20.4) reproduced two 200s for requests OpenAI refuses. B14:
  `/v1/chat/completions` with `"role": "not-a-real-role"` to LFM2.5 2.6B and Qwen2.5 0.5B got a reply:
  llama.cpp hands any role string to the chat template, and a template that does not know the role drops
  the message (others render it, or fail), so the model answered whatever was left. B13: `/v1/embeddings`
  to nomic-embed-text-v1.5 with `["alpha", 7, "omega"]` or `["test", 7]` got one vector: llama.cpp reads
  an array of strings and numbers as one prompt of text and token ids. Until now only an empty `messages`
  array was refused before the engine (ADR 2026-10-21-answer-an-unknown-model-and-an-empty-conversation-with-openai-errors).
- **Decision:** The public server checks the shape itself before any local engine sees the body
  (`src/server/public/validate.ts`) and answers 400 `invalid_request_error` with `param`:
  - `/chat/completions` to a local session: each message is an object (`invalid_type`, `messages[i]`)
    with a `role` (`missing_required_parameter`, `messages[i].role`) that is `system`, `developer`,
    `user`, `assistant` or `tool` (`invalid_value`, `messages[i].role`, in OpenAI's wording). The
    deprecated `function` is not accepted: neither the app nor the core sends it, and the GenieX and
    LiteRT-LM hosts already refuse it.
  - `/responses` to a local session (the llama.cpp translation and the MLX passthrough): a `message`
    item, or an item without a `type`, whose `role` is not `user`, `assistant`, `system` or `developer`
    (`invalid_value`, `input[i].role`). An item without a role is still the translation's `user`.
  - `/embeddings`, to the embedding module (before an idle module is started) and to a local session:
    `input` is a string, one input item, or an array that is all token ids, all token id arrays, or all
    strings and input items (the module's multimodal batch, `["caption", {content: [...]}]`, stays valid).
    Anything else — elements of two of those forms, a boolean or `null` element, a token that is not a
    non-negative integer, an `input` that is neither a string, an object nor an array — is `invalid_type`
    or `invalid_value` with `param: input`, the message naming the element at fault (`input[1] is a
    number, but input[0] is a string`).
  - Unchanged: a body without `messages` or `input`, an empty `input` (the route or the engine judges it
    as before), what is inside an input item (`checkEmbeddingRequest`), remote providers and the ChatGPT
    subscription (they validate their own requests), Anthropic `/messages`. The unknown-model 404 and a
    declared session's policy refusals still come first.
- **Consequences:** Every local engine answers the same structured 400 before it is asked. A client that
  relied on llama.cpp's own extensions — a mixed single prompt (`[12, "text", 34]`), strings beside token
  arrays, a role outside OpenAI's set (`function`, `ipython`) — now gets a 400 instead of
  engine-specific behaviour; allowing one of them back is a one-line change in `validate.ts`.
- **Owner:** team
- **Links:** `src/server/public/validate.ts`, `forward.ts`, `responses.ts`, `embedding.ts`;
  `test/e2e/public-server.test.ts`, `test/e2e/embedding.test.ts`, `test/contract/embedding.test.ts`;
  QA 2.2.29 B13 (E012, E016, E017) and B14 (A008, X004, X011).
