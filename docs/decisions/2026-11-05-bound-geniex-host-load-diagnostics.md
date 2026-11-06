---
date: 2026-11-05
title: "Tag GenieX host load failure modes with finite diagnostic codes"
---

# 2026-11-05 — Tag GenieX host load failure modes with finite diagnostic codes

- **Context:** `GeniexRuntime.startHost` spawns `geniex-host serve` via `spawnAndAwaitReady` and translates non-ready process exits in `hostError` (`src/runtime/geniex/runtime.ts`) into `AtomicCoreError('GENIEX_HOST_ERROR', ...)`. Exit code 3 (`EXIT.load`) produces `'The GenieX library does not load on this computer.'`, whereas any other non-ready exit produces `'The GenieX host stopped before the model was ready.'`. At the telemetry boundary, `buildEvent` replaces the exception value with `'runtime load: unknown'`, making native library load failures indistinguishable from post-load model creation failures or crashes in Sentry (`ATOMIC-CHAT-CORE-84`).
- **Decision:** Add a bounded diagnostic observer mapping the two exact `GENIEX_HOST_ERROR` messages in `src/runtime/geniex/runtime.ts` to finite `diagnostic_code` tags (`GENIEX_HOST_LIBRARY_LOAD_FAILED` and `GENIEX_HOST_STOPPED_BEFORE_READY`) and enable allowlisted `diagnostic_cause_code` extraction.
- **Consequences:** Future `GENIEX_HOST_ERROR` events during `model_load` carry finite tags distinguishing native library load failures from post-load host exits without exposing raw messages, paths, or stderr output, and without altering error contracts, classification, or event volume. Remove or replace these temporary rules once new Windows arm64 events identify the failing stage and the underlying issue is resolved.
- **Owner:** `team`
- **Links:** Issue `ATOMIC-CHAT-CORE-84` (`7830930698`), `src/runtime/geniex/runtime.ts`, `src/telemetry/diagnostics.ts`, `src/telemetry/sentry-agent-diagnostics.ts`.
