---
date: 2026-11-12
title: "Wrap model-claim filesystem failures as coded IO errors"
---

# 2026-11-12 — Wrap model-claim filesystem failures as coded IO errors

- **Context:** `acquireModelClaim` in `src/lock/model-claim.ts` creates the claims folder, the
  per-model claim directory and the claim record before a model load may start. Every one of those
  filesystem calls was unguarded, so a system error escaped the core with its own `code` — observed
  in production as ENOSPC ("runtime load: disk_full") and reproducible locally as EEXIST when a file
  occupies the claims folder. `src/server/http.ts` passes any string `code` through into `ErrorBody`,
  so a control-route load answer could carry a value outside `ERROR_CODES`. ADR
  2026-11-03-preserve-filesystem-cause-on-instance-lock-io-errors fixed the same class for
  `src/lock/instance-lock.ts`, but its sibling was not migrated.
- **Decision:** Translate those failures into `AtomicCoreError('IO_ERROR', …)` with the original
  error as `cause`, the same way the instance lock does. `EEXIST` from the claim-directory `mkdir`
  stays control flow (another claimant may own it); `readClaim` keeps its swallow-and-fallback
  behaviour because an unreadable record is handled by the staleness path.
- **Consequences:** A full volume still refuses the load safely and spawns no engine — only the
  error now crosses the core boundary with a code from `ERROR_CODES`. Telemetry is unchanged:
  `classifyFailure` still finds ENOSPC/EEXIST in the cause chain, so reason `disk_full`, warning
  level and the event fingerprint stay as they were. Watch for new `IO_ERROR` details on hosts with
  a read-only or full data folder.
- **Owner:** team.
- **Links:** `src/lock/model-claim.ts`, `src/lock/model-claim-io.test.ts`,
  `docs/decisions/2026-11-03-preserve-filesystem-cause-on-instance-lock-io-errors.md`,
  Sentry ATOMIC-CHAT-CORE-96.
