---
date: 2026-11-12
title: "An audio shutdown refusal is not an engine crash"
---

# 2026-11-12 — An audio shutdown refusal is not an engine crash

- **Context:** A model load that arrives after `AudioService.shutdown()` is refused before any await (`src/audio/service.ts`). The refusal reused `ENGINE_CRASHED`, the code for real engine deaths, so the telemetry classifier had no entry for it: the event went out as `unknown` at `error` level through the control route ([Sentry issue 7843928541](https://us.sentry.io/organizations/atomic-chat/issues/7843928541/)). Every intentional refusal looked identical to a crash.
- **Decision:** The four shutdown guards (`src/audio/service.ts`, `src/audio/jobs.ts`) throw a dedicated `AUDIO_UNAVAILABLE` code, listed in `AUDIO_ERROR_CODES` next to its siblings `EMBEDDING_UNAVAILABLE` and `DECISION_UNAVAILABLE`. `classifyFailure` maps it to `expected`/`busy`, so the control route stops reporting it at all and event-listener paths suppress it like every other designed refusal. Real engine deaths keep `ENGINE_CRASHED` and their crash classification; the refusal message is unchanged.
- **Consequences:** Sentry stops seeing intentional shutdown refusals as errors. Job records and control responses carry the new code; a client built before this change sees a code outside its known set and maps it defensively, as with any contract addition. Loads already in flight when shutdown starts keep `CANCELLED`.
- **Owner:** team
- **Links:** Sentry issue 7843928541, `src/audio/service.ts`, `src/audio/jobs.ts`, `src/telemetry/diagnostics.ts`
