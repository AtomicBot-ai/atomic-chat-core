/**
 * What every managed engine shares about the models it runs (change `add-vllm-runtime`): the one
 * quantization naming rule (`quant-format.ts`, design D6), the compatibility check skeleton with
 * each engine's hooks (`compatibility.ts`, D7) and the check route behind
 * `POST /atomic/v1/models/:provider/check` (`check.ts`).
 *
 * Public API of this module is exported from this file only.
 */
export * from './quant-format.js'
export * from './compatibility.js'
export * from './check.js'
