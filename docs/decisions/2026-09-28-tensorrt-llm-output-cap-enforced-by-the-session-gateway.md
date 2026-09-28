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
  (`src/runtime/managed-text/adapter.ts`). The lifecycle binds it to the load's own settings, through
  `adapter.rewriteRequestBody(...)` rather than a detached reference (so an implementation that
  relies on `this` still works), and passes it into `startManagedGateway` (`gateway.ts`) alongside two
  more adapter-declared lists, `routes` and `rewritableRoutes` (round 2 addition — see below). The
  gateway applies the rewrite only to a `POST` request whose route is both declared and listed as
  rewritable, with a non-empty body, under a byte cap enforced while the body streams in
  (`MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES`, `413` over it — round 2 fixed this from "checked after
  the whole body was already buffered" to "checked while reading, stopping immediately"), and only
  once the body parses as JSON (a parse failure, or the hook's own throw, answers `400` instead of
  forwarding). The response — streamed or not, on every route — is never touched by this hook or by
  anything else this decision adds.

  The `tensorrt-llm` adapter implements the hook for exactly `POST /v1/chat/completions` and
  `POST /v1/completions` (its `rewritableRoutes`). **Round 1's original rule here — write both
  `max_tokens` and `max_completion_tokens` on the chat route — was itself wrong** and is corrected by
  this same record rather than superseded by a new one, since it never shipped: TRT-LLM 1.2.1's
  `ChatCompletionRequest` (`openai_protocol.py`, `extra="forbid"`) has a *single* field,
  `max_completion_tokens`, whose `validation_alias` is `max_tokens` — sending both as separate
  top-level keys makes pydantic reject the whole request with `400 extra_forbidden` (review round 2,
  `findings-2.13-r2.md` item 1, reproduced with `pydantic` directly against this model). The corrected
  rule writes exactly **one** of the two keys: `max_completion_tokens` if the client sent it, else
  `max_tokens` if the client sent that, else `max_tokens` (the route's own default with nothing
  sent); if the client sent both, the lower of the two (each capped) wins, under
  `max_completion_tokens`. `/v1/completions` only ever had `max_tokens`, so it has no such collision.
  A present but invalid value (not a positive integer; `null` counts as not sent) makes the hook throw
  rather than silently substitute the setting, which the gateway turns into an OpenAI-shaped `400`
  using the thrown message. Every other route's body returns unchanged.

  **Round 2 addition:** the gateway also enforces the adapter's declared `routes` outright — a route
  the adapter never listed answers `404` and is never forwarded to the upstream at all, closing off
  whatever else the engine's own HTTP server happens to expose that the adapter never intended
  reachable (`trtllm-serve`'s `/update_weights`, `/release_memory`, `/resume_memory`,
  `/kv_cache_events`, `/steady_clock_offset`, and `/v1/responses`, which this slice does not support —
  `findings-2.13-r2.md` item 3). Route matching happens on the percent-decoded path, and an encoded
  slash (`%2f`/`%2F`) — the classic path-confusion trick — makes a path unmatchable outright rather
  than being decoded and compared. `readiness.path` (e.g. `/health`) is deliberately not part of
  `routes`: the lifecycle probes it directly against the container, never through the gateway a
  caller's traffic goes over.
- **Consequences:** The gateway is no longer *unconditionally* a byte-copying proxy — for a declared,
  rewritable `POST` route it now parses and re-serializes the request body (never the response), and
  for an undeclared route it answers `404` without ever opening a connection to the upstream at all.
  Both are the deliberate, scoped deviations this record exists to explain; everything else is
  unchanged: no rewriter configured (any adapter that leaves the hook undefined, or a non-rewritable
  route, or a non-POST method) proxies exactly as before, and the existing 1000+-chunk streaming test
  still exercises that untouched path. Every managed-text adapter now has to declare `routes` (a new,
  required field on `ManagedTextAdapter`, checked at registration — an adapter with no declared routes
  fails to register at all, rather than the gateway silently 404ing every request from an engine whose
  author forgot to list any); this is a real cost for a future adapter, paid once, in exchange for the
  gateway never having to guess what an engine additionally exposes. `context_length_exceeded` mapping
  (adapter.ts) had to gain a third case for the `--max_num_tokens`-tracks-`context_length` change:
  `base_worker.py`'s `_deduce_max_tokens`, which raises when `max_seq_len - prompt - query <= 0` — a
  narrow boundary case, not the common one, since `_check_arguments`'s prompt-vs-`max_num_tokens`
  check (now effectively prompt-vs-`context_length`) already catches every overflow before it, except
  the exact point where prompt and query land precisely on the limit. `TensorrtLlmSettings` gained a
  cross-field rule (`max_output_tokens < context_length`) so a setting that could never produce a
  satisfiable clamp is rejected at validation time rather than silently starving every request of
  output. A future adapter that needs none of this pays nothing for it: `rewriteRequestBody` and
  `rewritableRoutes` are optional and the gateway's fast path is untouched when they are absent; only
  `routes` is mandatory, and declaring it is a small, one-time, security-relevant cost.
- **Owner:** `team` (openspec change `add-tensorrt-llm-linux`, task 2.13, fix rounds 1-2).
- **Links:** `.superpowers/sdd/tasks/findings-2.13-r1.md` (item 1, the controller's original ruling)
  and `.superpowers/sdd/tasks/findings-2.13-r2.md` (items 1-3, the correction and the route-gating
  ruling); `src/runtime/managed-text/adapter.ts` (`ManagedTextAdapter.routes`/`rewritableRoutes`/
  `rewriteRequestBody`); `src/runtime/managed-text/gateway.ts`
  (`MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES`, `readCappedBody`, `decodedRoute`, `proxyToUpstream`);
  `src/runtime/managed-text/lifecycle.ts` (binding into `startManagedGateway`);
  `src/runtime/tensorrt-llm/adapter.ts` (`tensorrtLlmRewriteRequestBody`,
  `mapTensorrtLlmContextLengthError`'s `_deduce_max_tokens` case, `TENSORRT_LLM_ROUTES`/
  `TENSORRT_LLM_REWRITABLE_ROUTES`); design.md D11 (the "copies bytes without parsing" Risk this
  deviates from), spec `tensorrt-llm-runtime` ("Выбор карты и настройки провайдера", "Переполнение
  контекста без авто-роста", "Возможности модели объявляются, а не угадываются" — the "публичный
  сервер MUST отвечать понятной ошибкой на маршрут, который провайдер не объявил" clause this
  record's `routes` gate implements at the gateway layer).
