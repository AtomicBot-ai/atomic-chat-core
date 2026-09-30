---
date: 2026-09-30
title: "GET /environments/descriptors/:id reads the descriptor cache only: 404 for an uncached id, 422 off Linux"
---

# 2026-09-30 — GET /environments/descriptors/:id reads the descriptor cache only: 404 for an uncached id, 422 off Linux

- **Context:** The NVIDIA notices, the curated checkpoints and the supported architectures exist only
  in the runtime descriptor. The core uses them internally, but no snapshot field or route returned
  them, so the app could not show the NVIDIA terms before consent or the curated model list (app gap
  G-app-2, tasks app 3.6/3.7 and cli 4.3/4.4). The owner chose a core route over having clients read
  conf directly. Task 2.22 (2) specified the route: cache only, 404 `MANAGED_METADATA_INVALID` for an
  unknown id, 422 `MANAGED_ADAPTER_UNAVAILABLE` off Linux.
- **Decision:**
  1. `GET /atomic/v1/environments/descriptors/:descriptorId` returns `RuntimeDescriptorSummary`
     `{descriptor_id, engine_id, notices, curated_models, supported_architectures}`, built by the pure
     `summarizeRuntimeDescriptor`. `notices` is copied verbatim and in order.
  2. The read is `EnvironmentService.descriptor(id)`. The service receives only
     `Pick<RuntimeDescriptorProvider, 'forInstallation'>`, the cache read that never calls `fetch` or
     `readFile`, so this route cannot reach the network by construction. The same cache holds both the
     id an installation pins and the id a probe just accepted, so one read covers both sources of an
     id.
  3. An id the cache does not hold (or a cached file that no longer parses) is 404 with code
     `MANAGED_METADATA_INVALID`. `statusForCode` maps that code to 400 everywhere else, because there
     it means a caller sent a malformed descriptor. Here the caller asked for something absent, so
     the route sets 404 itself and leaves the global mapping alone.
  4. Off Linux, the service throws 422 `MANAGED_ADAPTER_UNAVAILABLE` when there is no host recipe
     (`provisioner === null`) or no cache wired, and it does not look at the cache. `create.ts` wires
     `deps.environments` on every platform, so the route-level "no `deps.environments`" 422 never
     fires in a real core. Without the service-level check, a macOS core with a shared cache would
     return descriptors for an engine it can never run. `GET /environments` and the probe keep their
     current behavior off Linux: an empty list and an `unsupported` plan.
  5. The route is registered next to `/environments/operations/:operationId`, ahead of the
     `/environments/:environmentId/operations` POST. Because it is GET-only with two fixed segments,
     it cannot collide with that POST, where an environment named `descriptors` still means an
     environment.
- **Consequences:**
  - The addition is additive: control protocol 2 is unchanged. The control client gets
    `environmentDescriptor(id)`.
  - A client should call the route only with an id the core itself gave it. Because nothing is ever
    fetched, an id that was never cached stays 404 until a probe accepts it.
  - An installation whose pinned descriptor left the cache (the cache never deletes, so only by
    hand) returns 404 here, the same failure a load would hit.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), task 2.22 (2), design D16,
  ruling `app.md` G-app-2; `src/server/control/routes/environments.ts`,
  `src/runtime/environment/{service,descriptor,wiring}.ts`, `src/contracts/environment.ts`,
  `src/client/control-client.ts`, `test/e2e/managed-operations.test.ts` ("what the app shows before
  consent").
