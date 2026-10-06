/**
 * The `tensorrt-llm` provider (openspec change `add-tensorrt-llm-linux`).
 *
 * `compatibility.ts` is TensorRT-LLM's memory rule and checkpoint quirks plugged into the shared
 * check skeleton (`../managed-models/`, change `add-vllm-runtime`), behind
 * `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`); the shared naming rule
 * and the GPU-selection rule the load path reuses are re-exported from there. `adapter.ts` (task 2.13) is the `ManagedTextAdapter`
 * the engine-neutral load lifecycle (`../managed-text/`) plugs into. Task 2.14 adds the provider
 * itself: `runtime.ts` (the `LocalRuntime`), `settings.ts` (stored settings → adapter settings),
 * `route-policy.ts` (what the public server must refuse or map for a session), `installation.ts`
 * (the ready installation and its pinned descriptor), `host-facts.ts` (cards, SELinux and
 * `MemAvailable`/`MemTotal`, per load) and `model-dir.ts` (the single-model lookup `runtime.ts`'s
 * load path uses). Task 2.16 wires the pure check in: `registry.ts` (the full model listing scan),
 * `check.ts` (the route handler behind `compatibility.ts`'s pure verdict) and `prelaunch.ts` (the
 * file-and-compatibility re-check `runtime.ts`'s load path runs before a container is created).
 * Task 2.24 adds `delete.ts`: a deleted model's engine caches and folder, with the bytes freed.
 *
 * Public API of this module is exported from this file only.
 */
export * from './compatibility.js'
export * from '../managed-models/quant-format.js'
export * from './adapter.js'
export * from './kv-cache.js'
export * from './settings.js'
export * from './route-policy.js'
export * from './installation.js'
export * from './host-facts.js'
export * from './model-dir.js'
export * from './registry.js'
export * from './check.js'
export * from './prelaunch.js'
export * from './engine.js'
export * from './delete.js'
export * from './location.js'
export * from './guest-files.js'
