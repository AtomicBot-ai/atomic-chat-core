/**
 * `POST /atomic/v1/models/tensorrt-llm/check` (task 2.16 of change `add-tensorrt-llm-linux`, spec
 * `tensorrt-llm-models`): the shared managed check route (`../managed-models/check.ts`) with
 * TensorRT-LLM's settings — its saved card and its `kv_cache_free_gpu_memory_fraction`, which size
 * its memory rule (`tensorrtLlmCheckEngine`).
 */
import type { ModelCompatibility } from '../../contracts/index.js'
import { TENSORRT_LLM_ENGINE_ID } from '../environment/index.js'
import {
  checkManagedModel,
  type ManagedModelCheckEngine,
  type ModelCheckDeps,
} from '../managed-models/check.js'
import { tensorrtLlmCheckEngine } from './compatibility.js'
import { tensorrtLlmSettings } from './settings.js'

export {
  parseModelCheckInput,
  type ModelCheckDeps,
  type ModelCheckHostFacts,
} from '../managed-models/check.js'

/** TensorRT-LLM's side of the check route: its card and its memory rule from its stored settings. */
export const TENSORRT_LLM_MODEL_CHECK: ManagedModelCheckEngine = {
  engineId: TENSORRT_LLM_ENGINE_ID,
  gpuIdOf: (settings) => tensorrtLlmSettings(settings).gpu_id ?? null,
  checkEngineOf: (settings) => {
    const resolved = tensorrtLlmSettings(settings)
    return tensorrtLlmCheckEngine({
      contextLength: resolved.context_length,
      kvCacheFreeGpuMemoryFraction: resolved.kv_cache_free_gpu_memory_fraction,
      cudaGraphs: resolved.cuda_graphs,
    })
  },
}

export function checkTensorrtLlmModel(body: unknown, deps: ModelCheckDeps): Promise<ModelCompatibility> {
  return checkManagedModel(TENSORRT_LLM_MODEL_CHECK, body, deps)
}
