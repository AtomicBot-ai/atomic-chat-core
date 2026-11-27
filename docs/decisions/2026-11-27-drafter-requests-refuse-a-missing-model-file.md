---
date: 2026-11-27
title: "Refuse a missing drafter model file as MODEL_FILE_NOT_FOUND"
---

# 2026-11-27 — Refuse a missing drafter model file as MODEL_FILE_NOT_FOUND

- **Context:** The drafter routes (`GET`/`POST` under `/atomic/v1/drafters`) report HTTP 500 with a raw
  Node `ENOENT` error whenever an installed model's GGUF described by `model.yml` is absent from disk.
  `DrafterService.context` stat'ed the resolved model path without catching the filesystem error, so the
  refusal never reached the caller-visible `AtomicCoreError` envelope and telemetry classified the event
  as `component=http`, `failure_category=unknown`. The rest of the module already reports a missing
  drafter file as `MODEL_FILE_NOT_FOUND`.
- **Decision:** `DrafterService.context` catches `ENOENT`/`ENOTDIR` from the model-file `stat` and throws
  `AtomicCoreError('MODEL_FILE_NOT_FOUND', 'The model file is missing.', path)`. Every other filesystem
  error (`EACCES`, `EIO`, ...) still surfaces unchanged. The existing code → status mapping (404) and
  failure classification (expected/not-found) apply as they already do for the other drafter paths.
- **Consequences:** The drafter panel receives a typed, actionable refusal instead of a scrubbed
  `unknown` 500, and the event stops being reported as an unexplained failure. The trigger that removed
  the file on the user's machine (deletion, moved data folder, disconnected drive) remains outside the
  core's observation and is not masked: the message names the missing model file.
- **Owner:** team
- **Links:** `src/drafters/service.ts` (`context`), `src/drafters/missing-model-file.test.ts`,
  `src/server/http.ts` (`statusForCode`), `src/telemetry/diagnostics.ts` (`MODEL_FILE_NOT_FOUND`).
