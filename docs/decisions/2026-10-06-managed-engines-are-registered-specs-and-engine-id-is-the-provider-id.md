---
date: 2026-10-06
title: "Managed engines are registered specs, and an engine id is its provider id"
---

# 2026-10-06 — Managed engines are registered specs, and an engine id is its provider id

- **Context:** change `add-vllm-runtime` adds vLLM as a second managed engine next to TensorRT-LLM. Around the engine-neutral managed-text lifecycle, core had TensorRT-LLM hard-wired: `wireTensorrtLlm`/`wireWindowsTensorrtLlm`, `TensorrtLlmRuntime`, an unloader and a deleter that recognised the provider by `instanceof`, one descriptor source. Four places already assumed that an engine's `engine_id` is its provider id (GPU residency leftovers, the models of an engine, the removal's unloader, a load's descriptor).
- **Decision:** a managed engine is a `ManagedEngineSpec` — `engine_id`, `provider`, `label`, its conf descriptor source, its `ManagedTextAdapter`, its settings reader, its hooks for the compatibility check (`memoryNeed`, `checkpointProblems`) and its route policy — registered in `ManagedEngineRegistry` (`src/runtime/managed-engines/`). Registration fails at startup when `engine_id` is not the provider id or the descriptor source is another engine's. `wireManagedEngine(spec, …)` builds every engine the same way on Linux and Windows; there is one runtime class, `ManagedTextRuntime(spec)`. The removal's unloader, the model deleter and "one model, one managed provider" find providers in the map of managed runtimes by engine id. The memory rule and the checkpoint quirks are part of the spec, not of the adapter: `adapter_contract_version` is a contract between a descriptor and a container launch, while the check runs with no Docker and no lifecycle.
- **Consequences:** a new managed engine is an adapter, a descriptor in conf and a spec registered in `managedEngineRegistry()` — no branch on an id in shared code. Messages name the engine from the spec. A spec registered under the wrong id is a startup crash, by design.
- **Owner:** `team`.
- **Links:** `src/runtime/managed-engines/{spec,runtime}.ts`, `src/core/managed-engines.ts`, `src/runtime/tensorrt-llm/engine.ts`; openspec change `add-vllm-runtime`, design D3, D11.
