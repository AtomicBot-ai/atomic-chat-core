---
date: 2026-09-28
title: "tensorrt-llm's output-length setting is enforced by the session gateway, not argv"
---

# 2026-09-28 — tensorrt-llm's output-length setting is enforced by the session gateway, not argv

- **Context:** Spec `tensorrt-llm-runtime` ("Выбор карты и настройки провайдера") requires an output-
  length-limit provider setting. Task 2.13's first pass wired that setting straight into
  `trtllm-serve`'s `--max_num_tokens` flag. Review round 1 (`findings-2.13-r1.md`, item 1) found
  this was wrong on the pinned `v1.2.1` pytorch backend (this descriptor's default, per
  `commands/serve.py`): `llmapi/llm.py`'s `_check_arguments` compares `--max_num_tokens` against the
  *prompt* length alone (`prompt_len/cp_size + query_len > max_num_tokens`), never the output. With
  the setting's own default (4096) below the context-length default (8192), that flag was silently
  halving the usable prompt window, and the `context_length_exceeded` mapping built on top of it
  reported the wrong number. `trtllm-serve` 1.2.1 has no server-side flag that caps a request's
  *output* length at all — `SamplingParams.max_tokens` is a per-request field, decided inside
  `base_worker.py`'s `_deduce_max_tokens` from `max_seq_len` minus the prompt, with no ceiling of its
  own. Enforcing the setting therefore has to happen somewhere that sees each request, and the only
  such place already in this design is the per-session gateway (design D11) — which design's own
  Risks/Trade-offs list documents as "только копирование байтов без парсинга" (only copies bytes,
  never parses), specifically to keep it fast and engine-neutral.
- **Decision:** `--max_num_tokens` is set to `context_length` (a correct, if generic, prompt-side
  guard — not the output setting). The output-length setting is enforced instead by an optional,
  engine-neutral `rewriteRequestBody?(route, body, settings)` hook on `ManagedTextAdapter`
  (`src/runtime/managed-text/adapter.ts`). The lifecycle binds it to the load's own settings and
  passes it into `startManagedGateway` (`gateway.ts`); the gateway applies it only to `POST` requests
  with a non-empty body, under a byte cap (`MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES`, `413` over it),
  and only once the body parses as JSON (a parse failure answers `400` without forwarding). The
  response — streamed or not, on every route — is never touched by this hook or by anything new this
  decision adds. The `tensorrt-llm` adapter implements it for exactly `POST /v1/chat/completions` and
  `POST /v1/completions`: it clamps `max_tokens` (both routes) and `max_completion_tokens` (chat
  only) to `min(request value, settings.max_output_tokens)`, or fills in the setting when the field
  is absent or not a valid positive number. Every other route returns the body unchanged.
- **Consequences:** The gateway is no longer *unconditionally* a byte-copying proxy — for the two
  routes above it now parses and re-serializes the request body (never the response), which is the
  deliberate, scoped deviation this record exists to explain. Everything else about it is unchanged:
  no rewriter configured (any adapter that leaves the hook undefined, or a non-POST/non-JSON
  request) proxies exactly as before, and the existing 1000+-chunk streaming test still exercises the
  untouched path. `context_length_exceeded` mapping (adapter.ts) had to gain a third case for this
  same reason: with `--max_num_tokens` now equal to `context_length`, the *reachable* pytorch-backend
  overflow signal in practice is `base_worker.py`'s `_deduce_max_tokens` raising when
  `max_seq_len - prompt - query <= 0`, not only `_check_arguments`'s prompt-vs-`max_num_tokens`
  check. `TensorrtLlmSettings` gained a cross-field rule (`max_output_tokens < context_length`) so a
  setting that could never produce a satisfiable clamp is rejected at validation time rather than
  silently starving every request of output. A future adapter that needs no such enforcement pays
  nothing for this: the hook is optional and the gateway's fast path is untouched when it is absent.
- **Owner:** `team` (openspec change `add-tensorrt-llm-linux`, task 2.13 fix round 1).
- **Links:** `.superpowers/sdd/tasks/findings-2.13-r1.md` (item 1, the controller's ruling);
  `src/runtime/managed-text/adapter.ts` (`rewriteRequestBody`); `src/runtime/managed-text/gateway.ts`
  (`MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES`, `proxyToUpstream`); `src/runtime/managed-text/lifecycle.ts`
  (binding into `startManagedGateway`); `src/runtime/tensorrt-llm/adapter.ts`
  (`tensorrtLlmRewriteRequestBody`, `mapTensorrtLlmContextLengthError`'s `_deduce_max_tokens` case);
  design.md D11 (the "copies bytes without parsing" Risk this deviates from), spec
  `tensorrt-llm-runtime` ("Выбор карты и настройки провайдера", "Переполнение контекста без
  авто-роста").
