---
date: 2026-09-17
title: "Serialize sidecar load and unload before releasing a model claim"
---

# 2026-09-17 — Serialize sidecar load and unload before releasing a model claim

- **Context:** Stage 5 introduced MLX and Foundation Models sidecars. An unload arriving while a sidecar was still loading could return success before its process was published, and the core would release the model claim while the child subsequently became live.
- **Decision:** Serialize core acquire/unload transitions per provider and model. The sidecar table also waits for any in-flight load before unloading, deduplicates simultaneous unloads and waits for an active unload before starting a replacement load. Release a model claim only after a successful runtime unload.
- **Consequences:** A queued unload stops the child that a preceding load publishes, rather than acknowledging an absent model. Unrelated model IDs can still transition concurrently; provider-specific runtime load queues retain their own ordering. Shutdown waits for both model transitions and sidecar terminations before releasing claims. No wire route or persisted data format changes.
- **Owner:** team.
- **Links:** `src/core.ts`, `src/runtime/sidecar.ts`, `src/runtime/sidecar.test.ts`, `test/e2e/stage5-sidecars.test.ts`.
