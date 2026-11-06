---
date: 2026-11-06
title: "Tag generic llama.cpp process load errors with a finite diagnostic code"
---

# 2026-11-06 — Tag generic llama.cpp process load errors with a finite diagnostic code

- **Context:** When `llama-server` exits with code 1 and no signal before reporting readiness during `model_load`, `spawnAndAwaitReady` (`src/runtime/shared/process.ts`) delegates to `classifyProcessOutput` (`src/runtime/llamacpp/errors.ts`), which returns `AtomicCoreError('LLAMA_CPP_PROCESS_ERROR', ...)` in two non-crash branches: a CLI argument rejection matching `ARGUMENT_REJECTED_MESSAGE` or an unclassified process exit producing `GENERIC_PROCESS_ERROR_MESSAGE` (`'The model process encountered an unexpected error.'`). Because `buildEvent` in `src/telemetry/envelope.ts` replaces `error.message` with `'runtime load: unknown'` and strips `error.details`, Sentry events such as `ATOMIC-CHAT-CORE-8R` (`7832522574`) cannot distinguish an unclassified engine exit from a rejected CLI flag.
- **Decision:** Add a bounded diagnostic observer rule mapping `GENERIC_PROCESS_ERROR_MESSAGE` in `src/runtime/llamacpp/errors.ts` to `diagnostic_code: 'LLAMA_CPP_GENERIC_PROCESS_ERROR'` while preserving allowlisted `diagnostic_cause_code` extraction.
- **Consequences:** Future `LLAMA_CPP_PROCESS_ERROR` events during `model_load` carry `diagnostic_code=LLAMA_CPP_GENERIC_PROCESS_ERROR` when `llama-server` exits with an unclassified error and omit the tag when it rejects a CLI argument or crashes, without exposing raw stderr/stdout or paths and without changing error contracts or event volume. Remove or replace this rule once Sentry events partition these failure modes and the underlying issue is resolved.
- **Owner:** `team`
- **Links:** Issue `ATOMIC-CHAT-CORE-8R` (`7832522574`), `src/runtime/llamacpp/errors.ts`, `src/telemetry/diagnostics.ts`, `src/telemetry/sentry-agent-diagnostics.ts`.
