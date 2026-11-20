---
date: 2026-11-20
title: "Code Strata process-journal root failures as IO errors"
---

# 2026-11-20 — Code Strata process-journal root failures as IO errors

- **Context:** `StrataProcessJournal.open` in `src/runtime/strata/strata-process-journal.ts` prepares
  its root before it reads any record. The three calls that do this —
  `mkdir(root, { recursive: true, mode: 0o700 })`, `lstat(root)` and `realpath(root)` — were
  unguarded, while every later filesystem step in the same method maps failures through `corrupt()`
  to `AtomicCoreError('IO_ERROR', …)`. `wireStrata` in `src/core/strata.ts` opens that journal
  directly, so a system error escaped core startup as a plain `Error`. In production
  (`atomic-chat-core@0.24.4` and `0.24.7`, Windows x64) that surfaced as the fatal
  `core startup: unknown` with `error_code=ENOENT` and an unmapped `ENOENT` cause. Opening the
  journal must stay fatal — it is the durable GPU-ownership evidence — but an untyped Error must
  not cross the core boundary. ADR `2026-11-12-wrap-model-claim-filesystem-failures-as-coded-io-errors`
  fixed the same class for model claims.
- **Decision:** Wrap only the root preparation in that method. An existing `AtomicCoreError` (from
  `corrupt()`) is rethrown unchanged so its message and code survive; any other failure becomes
  `AtomicCoreError('IO_ERROR', 'Strata process journal is unavailable; GPU ownership remains
  blocked.', undefined, { cause })`, keeping the native filesystem error as `cause`. Nothing else
  changes: no route, no classification table, no severity, no reporting frequency.
- **Consequences:** A journal root that cannot be prepared still aborts startup, and the GPU claim
  is still treated as blocked, but the refusal now crosses the boundary with a code from
  `ERROR_CODES`. `errorChain` follows `cause`, so `cause_code` stays `ENOENT`. Telemetry sees the
  event's `error_code` tag change from `ENOENT` to `IO_ERROR` and the exception type from `Error`
  to `IO_ERROR`; `failure_category`/`failure_reason` stay `unknown` because `ENOENT` and
  `IO_ERROR` both have no mapping, so the rendered message is still `core startup: unknown`. Watch
  for new `IO_ERROR` startup reports on hosts whose data folder is read-only, missing or replaced
  during startup; the Windows host state that produced the dangling journal root is a separate
  operational question.
- **Owner:** team.
- **Links:** `src/runtime/strata/strata-process-journal.ts`,
  `src/runtime/strata/strata-process-journal-open.test.ts`,
  `docs/decisions/2026-11-12-wrap-model-claim-filesystem-failures-as-coded-io-errors.md`,
  `docs/decisions/2026-11-03-preserve-filesystem-cause-on-instance-lock-io-errors.md`,
  Sentry ATOMIC-CHAT-CORE-D1.
