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
- **Decision:** `release()` marks the lock released before closing the descriptor, and `publish()`
  returns without writing when that flag is set. A released lock has no record to announce: its file
  is gone and may already belong to a new owner.
- **Consequences:** A mid-startup retire becomes the clean stop it was meant to be, on every host,
  instead of a fatal startup error. Acquire stays unchanged and a lock that was never released keeps
  publishing as before. The flag is set before `close()`, so a publish already in flight is the only
  remaining window, and it is no wider than the pre-existing ordering between the two calls. Callers
  can no longer detect a released lock from a throwing `publish()`; they never did, since the error
  was a bare `EBADF`.
- **Owner:** team
- **Links:** `src/lock/instance-lock.ts`, `src/lock/instance-lock-publish.test.ts`,
  `src/core/create.ts`, `src/core/app-lease.ts`, `src/core/app-daemon.ts`
