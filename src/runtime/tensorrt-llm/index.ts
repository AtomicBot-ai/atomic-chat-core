/**
 * TensorRT-LLM model compatibility: the network-free verdict behind
 * `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`, design D12/D13/D17/D18).
 * `compatibility.ts` is the check and the GPU-selection rule task 2.14 reuses for the load path;
 * `quant-format.ts` is the conf-README naming rule it checks against. `adapter.ts` (task 2.13) is
 * the `tensorrt-llm` `ManagedTextAdapter` the engine-neutral load lifecycle (`../managed-text/`)
 * plugs into. Only the pure check and adapter live here — the `ModelRegistry`, the HTTP routes and
 * the pre-launch file/size check are wired up once the provider (task 2.14) exists.
 *
 * Public API of this module is exported from this file only.
 */
export * from './compatibility.js'
export * from './quant-format.js'
export * from './adapter.js'
