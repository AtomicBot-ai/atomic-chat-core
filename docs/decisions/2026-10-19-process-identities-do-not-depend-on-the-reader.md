---
date: 2026-10-19
title: "Process identities do not depend on who reads them"
---

# 2026-10-19 — Process identities do not depend on who reads them

- **Context:** On macOS a process's start identity was the text `ps -o lstart=` prints, which follows
  the locale and time zone of the process running `ps`; on Windows it was `StartTime.Ticks`, local time.
  Whoever reads the identity later — another core started from a terminal with `LANG=ru_RU.UTF-8` or
  `en_GB`, the same laptop after a zone change — computed a different string for the same live process,
  read it as `mismatch` (a reused PID) and was allowed to take over. Reproduced: an owner started in the
  C locale was `stale` to a reader in `ru_RU`, and a second core then took its data folder while the
  first kept running. The same identity guards the child-process journal and managed-operation owners.
  `owner_started_at` (seconds since the epoch, written beside it since 0.10) was never consulted by
  the core; the desktop app's reader already decides by it.
- **Decision:** New identities are written as `darwin-utc:` (`ps` under `LC_ALL=C TZ=UTC`) and
  `win32-utc:` (UTC ticks); `processStartEpoch` reads `ps` the same way and parses it as UTC. A
  `darwin:`/`win32:` identity written by an earlier core still proves a match when equal, but a
  difference is `unknown`, never `mismatch`: the writer's locale and zone are unknown. The instance lock
  decides by `owner_started_at` first (a second of slack) and falls back to the start identity.
- **Consequences:** No reader's locale or zone can free a live owner's lock, journal entry or operation.
  A legacy identity whose owner is gone and whose PID was reused reads as `unknown` unless the record
  has `owner_started_at` (every lock since 0.10 does). The app's Rust reader is unaffected: it compares
  `owner_started_at` and treats an identity prefix it does not know as live. Download sidecars (`.url`,
  `.parts`, `.ranges`, `.ranges.next`) are no longer listed as diffusion model files.
- **Owner:** `team`.
- **Links:** `src/lock/process-identity.ts`, `src/lock/instance-lock.ts`, `src/diffusion/install.ts`;
  Atomic-Chat `src-tauri/src/core/atomic_core/lock.rs`.
