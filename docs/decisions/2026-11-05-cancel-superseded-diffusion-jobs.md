---
date: 2026-11-05
title: "Cancel superseded diffusion jobs before dropping their session"
---

# 2026-11-05 — Cancel superseded diffusion jobs before dropping their session

- **Context:** Sentry `ATOMIC-CHAT-CORE-A` reports `sd-server was stopped during generation`.
  Owner shutdown removed the session without marking the active local job cancelled. A request
  could also finish asynchronous validation, video preparation, or input reads after its model
  had been unloaded or replaced and then register or execute against the wrong session.
- **Decision:** Mark the active local job cancelled before owner shutdown removes the session,
  and wait under the load lock for an aborted spawn to clean up. Check the captured model spec
  and owner lifecycle around asynchronous startup work; check the active job identity around
  input resolution. Superseded work uses the existing `CANCELLED` outcome. Keep native crashes,
  out-of-memory failures, and recovery on the CPU/offload fallback paths visible as before.
- **Consequences:** Expected owner/model lifecycle changes no longer emit a false crash or
  start a replacement engine for an obsolete request. Shutdown can wait for an aborted load's
  cleanup rather than return while its child can still appear. Remote video recovery is unchanged:
  shutdown aborts its observation but does not cancel the provider's persistent job. New error
  codes, stored formats, dependencies, and public API fields are unnecessary.
- **Owner:** team.
- **Links:** <https://atomic-chat.sentry.io/issues/7765040896/>;
  `src/diffusion/{jobs,service}.test.ts`; `test/e2e/diffusion.test.ts`;
  desktop acceptance in `docs/app-e2e.md`.
