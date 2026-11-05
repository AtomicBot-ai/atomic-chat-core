---
date: 2026-11-05
title: "Reclaim dead-owner takeover mutexes immediately"
---

# 2026-11-05 — Reclaim dead-owner takeover mutexes immediately

- **Context:** When recovering a stale `instance.lock`, `tryRecoverStale` creates `instance.lock.takeover` and writes `${process.pid}\n` into it. Previously, a competing starter that saw `EEXIST` on `instance.lock.takeover` checked only whether the file was older than `TAKEOVER_MUTEX_TTL_MS` (30 s) and never inspected the PID inside it. Because `InstanceLock.acquire` retries across a ~1 s window (`20 * 50 ms`), a restart within 30 seconds of a process that crashed while holding `instance.lock.takeover` exhausted all attempts and failed with `CORE_START_FAILED`.
- **Decision:** Before touching the shared takeover file, a recovering starter publishes a unique empty file with its PID, portable start time (when available) and a UUID in the name. It enters recovery only when it sees no other live claim. Simultaneous claimants compare names: the lower name waits and the higher withdraws and retries. The winner keeps its claim through the last unlink. A dead process or a reused PID permits cleanup of that exact claim name. Within the claim, a complete PID line belonging to a dead process permits immediate cleanup of the takeover file. Other legacy files retain the 30-second age fallback.
- **Consequences:** A delayed claimant cannot remove a successor's takeover file based on an earlier observation. The exclusive takeover file still coordinates with older binaries. Normal acquisition and attachment do no extra I/O. Stale recovery adds a temporary file and a directory scan; the next recovery removes abandoned claims with a provably dead owner.
- **Owner:** `team`.
- **Links:** `src/lock/instance-lock.ts`, `src/lock/instance-lock.test.ts`, Sentry `ATOMIC-CHAT-CORE-1S` (issue `7770972167`).
