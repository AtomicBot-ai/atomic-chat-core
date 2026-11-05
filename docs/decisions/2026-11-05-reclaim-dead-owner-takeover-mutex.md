---
date: 2026-11-05
title: "Reclaim dead-owner takeover mutexes immediately"
---

# 2026-11-05 — Reclaim dead-owner takeover mutexes immediately

- **Context:** When recovering a stale `instance.lock`, `tryRecoverStale` creates `instance.lock.takeover` and writes `${process.pid}\n` into it. Previously, a competing starter that saw `EEXIST` on `instance.lock.takeover` checked only whether the file was older than `TAKEOVER_MUTEX_TTL_MS` (30 s) and never inspected the PID inside it. Because `InstanceLock.acquire` retries across a ~1 s window (`20 * 50 ms`), a restart within 30 seconds of a process that crashed while holding `instance.lock.takeover` exhausted all attempts and failed with `CORE_START_FAILED`.
- **Decision:** Check the PID written to `instance.lock.takeover` when `open(..., 'wx')` fails with `EEXIST`. If a complete PID line is present and that PID is no longer alive, treat the takeover mutex as stale immediately; keep `TAKEOVER_MUTEX_TTL_MS` as the fallback when the file is still unwritten or its PID is alive.
- **Consequences:** Starters immediately reclaim a `.takeover` mutex left behind by a crashed recovery attempt without waiting for the 30-second age fallback, while concurrent live starters remain serialized.
- **Owner:** `team`.
- **Links:** `src/lock/instance-lock.ts`, `src/lock/instance-lock.test.ts`, Sentry `ATOMIC-CHAT-CORE-1S` (issue `7770972167`).
