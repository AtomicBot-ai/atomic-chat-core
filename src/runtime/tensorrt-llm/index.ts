/**
 * The `tensorrt-llm` provider (openspec change `add-tensorrt-llm-linux`).
 *
 * `compatibility.ts` is the network-free verdict behind `POST /atomic/v1/models/tensorrt-llm/check`
 * (spec `tensorrt-llm-models`) and the GPU-selection rule the load path reuses; `quant-format.ts` is
 * the conf-README naming rule it checks against. `adapter.ts` (task 2.13) is the `ManagedTextAdapter`
 * the engine-neutral load lifecycle (`../managed-text/`) plugs into. Task 2.14 adds the provider
 * itself: `runtime.ts` (the `LocalRuntime`), `settings.ts` (stored settings → adapter settings),
 * `route-policy.ts` (what the public server must refuse or map for a session), `installation.ts`
 * (the ready installation and its pinned descriptor), `host-facts.ts` (cards and SELinux, per load)
 * and `model-dir.ts` (the minimal model lookup the full `ModelRegistry` of task 2.16 extends).
 *
 * Public API of this module is exported from this file only.
 */
export * from './compatibility.js'
export * from './quant-format.js'
export * from './adapter.js'
export * from './settings.js'
export * from './route-policy.js'
export * from './installation.js'
export * from './host-facts.js'
export * from './model-dir.js'
export * from './runtime.js'
