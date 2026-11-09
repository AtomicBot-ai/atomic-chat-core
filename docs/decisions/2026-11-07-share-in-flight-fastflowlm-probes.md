---
date: 2026-11-07
title: "Share in-flight FastFlowLM hardware probes"
---

# 2026-11-07 — Share in-flight FastFlowLM hardware probes

- **Context:** A catalog sends one compatibility request per model. Each request independently queued a full hardware probe behind the shared FLM build lock. On Windows a single probe takes several seconds, so a catalog burst delayed readiness requests by a minute.
- **Decision:** Concurrent read-only callers share the same pending probe, including while it waits for the build lock. Drop the shared promise on success or failure. Model loading keeps its independent fresh probe inside its own exclusive lock.
- **Consequences:** A catalog batch pays for one device inspection; readiness polling joins it. Build mutations remain exclusive, and subsequent requests inspect fresh facts. No completed result or failure is cached.
- **Alternatives:** A time-based cache could hide a changed driver or environment during preparation. Removing the lock would race installation and native device access. Coalescing only atc requests would leave other core clients with the same queue.
- **Owner:** team.
- **Links:** `src/runtime/fastflowlm/probe.ts`, `src/core/create.ts`.
