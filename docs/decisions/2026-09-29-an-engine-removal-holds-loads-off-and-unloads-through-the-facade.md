---
date: 2026-09-29
title: "An engine removal holds its loads off and unloads through the facade"
---

# 2026-09-29 — An engine removal holds its loads off and unloads through the facade

- **Context:** The record 2026-09-29-tensorrt-llm-provider-shares-the-setup-operations-handle-store-and-host
  (item 2 and its Consequences) had a removal unload the engine's models through
  `TensorrtLlmRuntime.unloadAll()`, straight on the lifecycle, and left loads unserialised with the
  removal. Its description of what that leaves open was also inexact: the removal's own journal
  sweep stops most containers a racing load creates, so the real gaps were narrower but still there
  (final review M-1, ledger 288): (a) a load arriving between the unload and the record's deletion —
  the record still `ready` — could create a container on an installation being removed, whose image
  `containersUsingImage` then keeps while the record is deleted under a running session; (b) the
  unload bypassed `LocalSessions`, so the cross-process model claim of each unloaded model stayed
  held by this core, and the other scope's core was refused that model until this one exited.
- **Decision:** `unloadEngineSessions` now returns a `release` with its count. For `tensorrt-llm`,
  `tensorrtLlmSessionUnloader` first calls `TensorrtLlmRuntime.holdOffLoads()` — from then on every
  load is refused with `MANAGED_OPERATION_CONFLICT`, checked at the start of a load and again right
  before the lifecycle registers it — then unloads every model the provider reports holding a card
  (`residentModels()`) through the facade: `cancelLoad` first, so a pending acquire gives up rather
  than the unload queuing behind it, then `unload`, which releases the model's claim once the stop
  is confirmed. The Linux removal calls `release` when it ends, however it ends; an unload that fails
  (`MANAGED_STOP_UNCONFIRMED`) lifts the hold itself and fails the removal with nothing removed.
  `unloadAll()` is gone. This supersedes item 2 and the load-vs-removal paragraph of the
  Consequences of the record named above.
- **Consequences:** No load of the engine can start a container while its removal runs, and a
  removed model can be loaded by the other scope's core at once. A load refused during a removal
  says so and can be retried after it; once the removal has marked the record `removing` or deleted
  it, a retry is refused as not installed / not ready instead. The hold is per core: a load in the
  other scope's core is not held off — cross-scope removal stays outside this slice (design).
- **Owner:** `team`.
- **Links:** `src/core/tensorrt-llm.ts` (`tensorrtLlmSessionUnloader`),
  `src/runtime/tensorrt-llm/runtime.ts` (`holdOffLoads`, `residentModels`),
  `src/runtime/environment/linux-provisioner.ts` (`UnloadEngineSessions`, `remove`),
  `src/core/create.ts`.

<!--
Supersedes: item 2 and the load-vs-removal part of the Consequences of
2026-09-29-tensorrt-llm-provider-shares-the-setup-operations-handle-store-and-host.md
-->
