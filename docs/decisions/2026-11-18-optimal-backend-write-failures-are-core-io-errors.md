---
date: 2026-11-18
title: "Report optimal-backend cache write failures as core IO_ERROR with their cause"
---

# 2026-11-18 — Report optimal-backend cache write failures as core IO_ERROR with their cause

- **Context:** `OptimalBackendStore.set` writes `<data>/atomic-core/optimal-backend.json` by creating a
  `<path>.tmp-<uuid>` file and renaming it into place. When the volume was full, the rename failed and
  the store rethrew the raw libuv error. `ControlServer.toCoreError` turned that into
  `{code: "ENOSPC", message: "ENOSPC: no space left on device, rename …"}` with HTTP 500 — a code
  outside the shared `ErrorBody` catalog — and the native cause was dropped, so the reporter and the
  app could not tell a full disk from an internal fault. Every sibling state writer
  (`SettingsStore.persist`, `InstanceLock.acquire`) already wraps filesystem failures as
  `AtomicCoreError('IO_ERROR', …, { cause })`, see
  `2026-11-06-preserve-cause-on-staged-engine-install-errors.md`.
- **Decision:** A failure to persist the optimal-backend cache is reported as
  `AtomicCoreError('IO_ERROR', 'Cannot write the optimal-backend cache at <path>', <native message>,
  { cause })`. The temporary file is still removed, the in-memory state and revision are still left
  unchanged, and the serialized write chain still continues.
- **Consequences:** The wire code is a catalog member, so the app can match on it, and the preserved
  cause lets `classifyFailure` report `operational`/`disk_full` for `ENOSPC` instead of an unexplained
  error. The HTTP status stays 500 (no `statusForCode` entry changed), nothing is retried or
  suppressed, and no other producer of this file is affected. A non-filesystem failure inside the
  write block is wrapped the same way, which is the intended single convention for this store.
- **Owner:** team
- **Links:** Sentry issue ATOMIC-CHAT-CORE-BE; `src/backend/optimal/optimal-store.ts`,
  `src/backend/optimal/optimal-store-write-failure.test.ts`.
