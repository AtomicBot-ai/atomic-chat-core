---
date: 2026-11-03
title: "Preserve filesystem cause on instance lock IO_ERRORs"
---

# 2026-11-03 — Preserve filesystem cause on instance lock IO_ERRORs

- **Context:** When `InstanceLock.acquire`, `readLockRecord`, or `tryRecoverStale` in
  `src/lock/instance-lock.ts` encountered a non-`EEXIST` / non-`ENOENT` filesystem error (`open`
  with `'wx'` or `readFile`), it wrapped the failure into `new AtomicCoreError('IO_ERROR', ...)`
  without passing `{ cause: e }`. Consequently, `classifyFailure` and `diagnosticTags` in
  `src/telemetry/diagnostics.ts` could not inspect the underlying `ErrnoException.code` (`ENOSPC`,
  `EACCES`, `EPERM`, `EBUSY`, `ENAMETOOLONG`, `EIO`, `ENODEV`) and classified every instance-lock
  filesystem failure as `category: 'unknown', reason: 'unknown'` without a `cause_code`.
- **Decision:** Pass `{ cause: e }` to `AtomicCoreError` whenever `src/lock/instance-lock.ts` wraps
  a filesystem error into `IO_ERROR`.
- **Consequences:** `ErrorBody` and `toJSON()` remain unchanged on the wire, while internal failure
  classification and telemetry retain the underlying OS errno code via `Error.cause` and classify
  operational disk errors (`disk_full`, `disk_permission`, `disk_file_locked`, `disk_path_too_long`,
  `disk_io`, `disk_device_lost`) accurately.
- **Owner:** team.
- **Links:** `src/lock/instance-lock.ts`, `src/lock/instance-lock.test.ts`,
  `docs/decisions/2026-11-03-keep-failure-diagnostics-outside-the-wire-contract.md`.
