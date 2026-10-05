---
date: 2026-09-29
title: "tensorrt-llm sessions carry a route policy to the public server"
---

# 2026-09-29 — tensorrt-llm sessions carry a route policy to the public server

- **Context:** The `tensorrt-llm` provider (task 2.14, spec `tensorrt-llm-runtime`) must look like a
  local backend on `:1337`, but unlike llama.cpp it serves only three declared routes, has tool calls
  only when the pinned descriptor names a parser for the model's family (design D9), and never grows
  its context — a restart of a multi-minute container mid-conversation is worse than an honest
  `context_length_exceeded`. The public server's forwarder treated every local session alike: forward
  any model-bearing route, grow the context and replay on an overflow, recreate on a compute error. The
  session gateway (task 2.11) already refuses undeclared routes, but only as a bare `404`/`405` after
  the request left `:1337`, and it knows nothing of `tools` or `autoIncreaseCtx`.
- **Decision:** A `LocalRuntime` may expose `routePolicy(modelId)` (`SessionRoutePolicy`: declared
  routes, whether `tools` are allowed, an engine-error mapper). `LocalSessions` attaches it to the
  `LocalTarget` the public server routes to; a target with a policy has an undeclared route or `tools`
  without a parser refused on `:1337` with an OpenAI-shaped `400` naming what is missing, its errors
  mapped by the policy (`trtllm-serve`'s overflow → `context_length_exceeded` with both numbers), and is
  never grown or recreated. A target without one keeps the server's behaviour byte for byte, so the
  Rust proxy replay and llama.cpp/MLX are unaffected. The provider also: (1) reloads a ready model whose
  load key (validated settings, descriptor, image, card, model directory) changed instead of returning
  the old session; (2) reports a missing saved `gpu_id` as `gpu_substituted` on every
  `session:load-progress` event of that load; (3) reads installation records from the shared root
  itself (`installations/<id>/installation.json`) until the setup operation (task 2.6) exposes its own
  store; (4) shares the `ATOMIC_MANAGED_TEST_HOST` e2e hook and folder layout with the managed
  environment's probe.
- **Consequences:** Clients get a clear, OpenAI-compatible reason instead of a silent drop or a gateway
  `404`; `autoIncreaseCtx` is never called for this provider.
- **Fix round 1 (findings-2.14-r1.md) — the session port holds the same line.** The app talks to
  `SessionInfo.port` (the session gateway) directly, not through `:1337`, so the policy alone left
  that path relaying `trtllm-serve`'s raw overflow text and forwarding `tools` to a model with no
  parser. Now: (1) the adapter contract gains an optional, engine-neutral `mapErrorResponse(route,
  status, body)`; the gateway reads (capped at 1 MiB) **only** a non-2xx answer on a declared POST
  route and returns the mapped OpenAI error (`tensorrt-llm`: `context_length_exceeded` with both
  numbers). A 2xx answer is never read — it streams through as before. This narrows, for error answers
  only, the "response is never touched" statement of ADR
  2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway. (2) The lifecycle hands the
  request rewriter the session's capabilities; `tensorrt-llm`'s rewriter refuses tool calls (`tools`,
  a `tool_choice` other than `none`) without a parser and JSON `response_format` without structured
  output, by throwing `ManagedRequestRefusal` → `400 unsupported_capability`, the same code and wording
  `:1337` uses (which now checks `tool_choice` and `response_format` too). (3) An optional adapter
  `restartKey` narrows what a reload compares: for `tensorrt-llm`, the context and KV fraction; a new
  output cap or load timeout joins the running session and the gateway reads the new cap at once.
  (4) `/v1/messages` to a session that does not declare it goes straight to the chat translation, with
  the overflow mapped there too. (5) `/muse-code/models` advertises such a session's own tool support,
  context and output cap. (6) An unknown SELinux state (`docker info` not answering) refuses the load
  instead of reading as "off"; a container runtime that failed to initialise is reported as that, with
  its cause, not as "Docker is not installed". A future managed engine gets the same
  treatment by returning a policy, with no `provider ===` branch in the forwarder. An externally
  registered `tensorrt-llm` session gets the static policy (declared routes, error mapping) with tool
  gating left to the engine, since nothing describes a session this core did not start. When task 2.6
  merges, `listInstallations` can be replaced by its `InstallationStore` without changing the record
  format, and its `unloadEngineSessions` binds to `TensorrtLlmRuntime.unloadAll`.
- **Owner:** `team`
- **Links:** `src/runtime/tensorrt-llm/{runtime,route-policy,installation,host-facts,model-dir,settings}.ts`,
  `src/server/public/policy.ts`, `src/core/{sessions,tensorrt-llm,create}.ts`,
  `src/runtime/managed-text/lifecycle.ts`, `test/e2e/tensorrt-llm-provider.test.ts`; ADRs
  2026-09-28-managed-text-lifecycle-owns-load-stages-cache-and-stop,
  2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway.
