---
date: 2026-11-21
title: "Preserve the filesystem cause on settings write IO_ERRORs"
---

# 2026-11-21 — Preserve the filesystem cause on settings write IO_ERRORs

- **Context:** `SettingsStore.persist` in `src/settings/store.ts` wraps a failed `mkdir`,
  `writeFile` or `rename` into `new AtomicCoreError('IO_ERROR', ...)` without passing
  `{ cause: e }`. The OS errno (`EPERM`, `EACCES`, `EBUSY`, `ENOSPC`, `EIO`, …) on the thrown
  `ErrnoException` is therefore dropped before `classifyFailure` and `diagnosticTags` in
  `src/telemetry/diagnostics.ts` can see it: `errorChain` stops at the `AtomicCoreError`, every
  settings write failure is reported as `category: 'unknown', reason: 'unknown'` without a
  `cause_code`, and the control route surfaces it as `IO_ERROR: http request: unknown` even for
  an ordinary permission or file-lock condition (event ATOMIC-CHAT-CORE-DN, win32).
- **Decision:** Pass `{ cause: e }` to that `AtomicCoreError` in `SettingsStore.persist`.
  Message, `code`, `details` and error behaviour stay as they are.
- **Consequences:** `ErrorBody` and `toJSON()` remain byte-identical on the wire, while internal
  failure classification and telemetry retain the underlying OS errno through `Error.cause` and
  can report `disk_permission`, `disk_file_locked`, `disk_full`, `disk_path_too_long`,
  `disk_io` or `disk_device_lost` with the real `cause_code`. This makes the next occurrence
  diagnosable; it does not retry the write and does not make the failing Windows write succeed.
  The same repair was already applied to `src/lock/instance-lock.ts` and to engine installs.
- **Owner:** team.
- **Links:** `src/settings/store.ts`, `src/settings/store-persist-cause.test.ts`,
  `docs/decisions/2026-11-03-preserve-filesystem-cause-on-instance-lock-io-errors.md`,
  `docs/decisions/2026-11-06-preserve-cause-on-staged-engine-install-errors.md`.
