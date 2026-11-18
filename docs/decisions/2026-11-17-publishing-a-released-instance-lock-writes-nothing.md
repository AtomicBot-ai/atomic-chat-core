---
date: 2026-11-17
title: "Publishing a released instance lock writes nothing"
---

# 2026-11-17 — Publishing a released instance lock writes nothing

- **Context:** `InstanceLock` opens `instance.lock` exclusively, writes a `starting` record and later
  rewrites it as `ready` once the control listener is bound. `release()` closes that descriptor and
  removes the file. Startup is not atomic with an in-process stop: the app-lease timer can decide to
  retire a core whose `createAtomicCore` has not reached `publish()` yet, and `AtomicCore.shutdown()`
  releases the lock. Startup then resumes and publishes on the closed handle, `handle.truncate(0)`
  throws `EBADF` ("file closed"), the throw escapes `createAtomicCore`, and the daemon reports a
  fatal `core startup: unknown` instead of finishing its intended clean stop. `EBADF` is not a
  reportable code, so telemetry could not name the cause either.
- **Decision:** Serialize publications on the open descriptor. `release()` stops accepting new
  publications and waits for the accepted writes to settle before closing and removing the lock.
  Concurrent releases share one close operation.
- **Consequences:** A mid-startup retire becomes the clean stop it was meant to be, on every host,
  instead of a fatal startup error. Acquire stays unchanged and a lock that was never released keeps
  publishing as before. Shutdown waits for the local record write, so it cannot close the descriptor
  between the write's truncate and write calls. A real write failure still reaches the caller that
  requested the publication, and release still closes the descriptor.
- **Owner:** team
- **Links:** `src/lock/instance-lock.ts`, `src/lock/instance-lock-publish.test.ts`,
  `src/core/create.ts`, `src/core/app-lease.ts`, `src/core/app-daemon.ts`
