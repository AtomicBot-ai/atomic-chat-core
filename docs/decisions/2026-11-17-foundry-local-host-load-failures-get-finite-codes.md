---
date: 2026-11-17
title: "Tag Foundry Local host load failures with finite diagnostic codes"
---

# 2026-11-17 — Tag Foundry Local host load failures with finite diagnostic codes

- **Context:** `FOUNDRY_LOCAL_HOST_ERROR` events from `atomic-chat-core@0.23.4` carried the generic exception value `runtime load: unknown`, `failure_category=unknown`, `failure_reason=unknown` and no exit code or signal. `hostError` in `src/runtime/foundry-local/runtime.ts` collapses four distinct host outcomes into one error code: exit 5 becomes `FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED`, exit 3 becomes "The Foundry Local library does not load on this computer.", and every other exit or signal death becomes "The Foundry Local host stopped before the model was ready.". `loadFailureReport` does not tag the host exit code or stderr, so an event cannot separate a native library that fails to load on Windows from a library call that failed after loading. The GenieX host already had the identical pair of codes; Foundry Local had none.
- **Decision:** Add two exact-message rules to the bounded diagnostic observer (`src/telemetry/sentry-agent-diagnostics.ts`, generated): "The Foundry Local library does not load on this computer." → `FOUNDRY_LOCAL_LIBRARY_NOT_LOADED` and "The Foundry Local host stopped before the model was ready." → `FOUNDRY_LOCAL_HOST_STOPPED_EARLY`, sourced from `src/runtime/foundry-local/runtime.ts`. Cause codes stay enabled. Nothing else changes: no new report, no severity, consent, throttling, grouping or exit-behavior change, and the error the caller receives is byte-identical.
- **Consequences:** The next released events from this path separate "the native library cannot load on this machine" from "the library loaded and the host then stopped before readiness". The observer still cannot say whether the host died from a signal or exited with a code, because the report tags never carried them; adding those facts is a separate reporting decision. Both rules are removable once the split is established, or once the exit code and signal reach the report directly.
- **Owner:** team
- **Links:** Sentry `ATOMIC-CHAT-CORE-CM` (event `ced119d9c8434e5e9a41fa0e30013202`), `src/runtime/foundry-local/runtime.ts`, `src/runtime/foundry-local/host/run.ts`, `src/telemetry/diagnostics.ts`, `src/telemetry/sentry-agent-diagnostics.test.ts`
