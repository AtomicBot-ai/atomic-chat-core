---
date: 2026-11-25
title: "Report synchronous spawn refusals as core IO_ERROR"
---

# 2026-11-25 — Report synchronous spawn refusals as core IO_ERROR

- **Context:** `spawnManaged` modelled a failed spawn only through the child's `error` event and
  `spawnFailure()`, and `spawnAndAwaitReady` turned that route into
  `AtomicCoreError('IO_ERROR', 'An input/output error occurred.', <runtime message>)`. Some runtimes
  refuse a spawn synchronously instead: Bun reports a failed `uv_spawn` by throwing
  `EUNKNOWN: unknown error, uv_spawn` before any child exists. That raw error escaped `spawnManaged`,
  passed `spawnAndAwaitReady` untouched, and left `spawnSession` unchanged because its `failed()`
  only annotates `AtomicCoreError`. The event therefore carried no code, no details and no
  `atomic-core-diag` stage line — only an opaque `Error: EUNKNOWN: unknown error, uv_spawn`.
- **Decision:** Wrap the `spawn()` call in `spawnManaged` and rethrow a synchronous refusal as
  `AtomicCoreError('IO_ERROR', 'An input/output error occurred.', <runtime message>, { cause })`.
  A refused spawn and an emitted spawn failure now reach callers in exactly the same shape.
- **Consequences:** Callers keep one error contract, and `loadFailureStage` maps `IO_ERROR` to the
  `spawn` stage, so the diagnostic line appears for both routes. The original error stays reachable
  as `cause`, so its runtime code is preserved for telemetry. This does not make the refused load
  succeed, and it does not change retry, reporting severity or any public contract: retries match
  only `MULTIMODAL_PROJECTOR_LOAD_FAILED` and MTP text, and `IO_ERROR` is neither expected nor
  operational for reporting. The OS-level reason a Windows host refused `uv_spawn` still needs a
  Windows reproduction with the real argv and error.
- **Owner:** team
- **Links:** ATOMIC-CHAT-CORE-40, `src/runtime/shared/process.ts`,
  `src/runtime/shared/spawn-throw.test.ts`
