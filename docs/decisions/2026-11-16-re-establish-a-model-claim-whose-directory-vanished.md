---
date: 2026-11-16
title: "Re-establish a model claim whose directory vanished"
---

# 2026-11-16 — Re-establish a model claim whose directory vanished

- **Context:** `acquireModelClaim` in `src/lock/model-claim.ts` creates the per-model claim directory
  before the engine starts and writes the record again as `ready` only after `runtime.load` resolved
  (`src/core/sessions.ts:112`). `writeClaim` wrapped every failure of that second write as
  `IO_ERROR`, so a directory removed during the multi-minute start answered a load that had actually
  succeeded as failed — observed in production as `IO_ERROR ... runtime load` with an `ENOENT` cause
  on Windows. Worse, `acquireNow` keeps the handle when `runtime.findSession(modelId)` is true, so
  every later load or attach of the same resident model repeated the write on the same dead path and
  failed identically until the model was unloaded. Nothing in the core removes a live claim
  directory: only `ModelClaimHandle.release()` does, serialized against the load or awaited by
  `releaseAll()` after the runtimes stop.
- **Decision:** Stage updates under a unique name and check the existing record's claim ID before
  replacing it. If the directory is removed after that check, the staged file disappears with it.
  On `ENOENT`, use the same exclusive claim-directory creation as initial acquisition and retry the
  write once. An incumbent or a process that wins creation makes the update return
  `CORE_ALREADY_RUNNING`; other filesystem failures retain their coded `IO_ERROR` and errno cause.
- **Consequences:** A load whose engine is up keeps its claim recorded and returns its session
  instead of failing, and later attaches no longer inherit a broken handle. The retry is bounded to
  one attempt, so a path that keeps disappearing surfaces as the same `IO_ERROR` instead of looping.
  Telemetry is unchanged: the event keeps its `IO_ERROR` code and its `ENOENT` cause when the retry
  also fails. Watch for claim directories being deleted by other tools on a host — the record now
  heals, but the deletion itself remains outside the claim protocol.
- **Owner:** team.
- **Links:** `src/lock/model-claim.ts`, `src/lock/model-claim-recovery.test.ts`,
  `docs/decisions/2026-11-12-wrap-model-claim-filesystem-failures-as-coded-io-errors.md`,
  Sentry ATOMIC-CHAT-CORE-CC.
