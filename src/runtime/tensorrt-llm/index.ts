/**
 * The `tensorrt-llm` provider (openspec change `add-tensorrt-llm-linux`).
 *
 * `compatibility.ts` is the network-free verdict behind `POST /atomic/v1/models/tensorrt-llm/check`
 * (spec `tensorrt-llm-models`) and the GPU-selection rule the load path reuses; `quant-format.ts` is
 * the conf-README naming rule it checks against. `adapter.ts` (task 2.13) is the `ManagedTextAdapter`
 * the engine-neutral load lifecycle (`../managed-text/`) plugs into. Task 2.14 adds the provider
 * itself: `runtime.ts` (the `LocalRuntime`), `settings.ts` (stored settings → adapter settings),
 * `route-policy.ts` (what the public server must refuse or map for a session), `installation.ts`
 * (the ready installation and its pinned descriptor), `host-facts.ts` (cards, SELinux and
 * `MemAvailable`, per load) and `model-dir.ts` (the single-model lookup `runtime.ts`'s load path
 * uses). Task 2.16 wires the pure check in: `registry.ts` (the full model listing scan),
 * `check.ts` (the route handler behind `compatibility.ts`'s pure verdict) and `prelaunch.ts` (the
 * file-and-compatibility re-check `runtime.ts`'s load path runs before a container is created).
 *
 * Public API of this module is exported from this file only.
 */
export * from './compatibility.js'
export * from './quant-format.js'
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
export * from './runtime.js'
