---
date: 2026-11-24
title: "Tag LiteRT-LM host load failure modes with finite diagnostic codes"
---

# 2026-11-24 — Tag LiteRT-LM host load failure modes with finite diagnostic codes

- **Context:** `LiteRtLmRuntime.startHost` spawns `litert-host serve` through `spawnAndAwaitReady` and turns every non-ready process exit in `hostError` (`src/runtime/litert-lm/runtime.ts`) into `AtomicCoreError('LITERT_LM_HOST_ERROR', ...)`. Exit code 3 (`EXIT.load`) produces `'The LiteRT-LM library does not load on this computer.'`; any other non-ready exit (usage 2, library-call 4, a native crash) produces `'The LiteRT-LM host stopped before the model was ready.'`. The affected `atomic-chat-core@0.19.0` and `@0.20.4` events carry neither the host's stderr nor a diagnostic version, so loaded models fail on Windows, Linux and macOS while the failing branch stays invisible (`ATOMIC-CHAT-CORE-4V`).
- **Decision:** Add a bounded diagnostic observer mapping the two exact `LITERT_LM_HOST_ERROR` messages in `src/runtime/litert-lm/runtime.ts` to finite `diagnostic_code` tags (`LITERTLM_HOST_LIBRARY_LOAD_FAILED` and `LITERTLM_HOST_STOPPED_BEFORE_READY`) and keep allowlisted `diagnostic_cause_code` extraction enabled.
- **Consequences:** Future LiteRT-LM `model_load` events carry finite tags distinguishing a native library load failure from a post-load host exit, without exposing raw messages, paths or stderr output, and without altering error contracts, classification, grouping or event volume. The observer does not fix the load failure and cannot name its cause; remove these temporary rules once an event carries the host's own reason as `engine_errors` or core attaches the host exit code to load failures.
- **Owner:** `team`
- **Links:** Issue `ATOMIC-CHAT-CORE-4V` (`7807098165`), `src/runtime/litert-lm/runtime.ts`, `src/runtime/litert-lm/host/run.ts`, `src/telemetry/diagnostics.ts`, `src/telemetry/sentry-agent-diagnostics.ts`.
