/**
 * TensorRT-LLM as a managed engine (change `add-vllm-runtime`, design D3): its adapter, its settings,
 * its memory rule and checkpoint quirks for the shared check, its route policy, and its descriptor in
 * conf. Registered by core like any other managed engine.
 */
import { TENSORRT_LLM_DESCRIPTOR_SOURCE, TENSORRT_LLM_ENGINE_ID } from '../environment/index.js'
import type { ManagedEngineSpec } from '../managed-engines/spec.js'
import { tensorrtLlmAdapter, type TensorrtLlmSettings } from './adapter.js'
import { tensorrtLlmCheckEngine } from './compatibility.js'
import { tensorrtLlmRoutePolicy } from './route-policy.js'
import { tensorrtLlmSettings } from './settings.js'

export const TENSORRT_LLM_ENGINE: ManagedEngineSpec<TensorrtLlmSettings> = {
  engine_id: TENSORRT_LLM_ENGINE_ID,
  provider: TENSORRT_LLM_ENGINE_ID,
  label: 'TensorRT-LLM',
  descriptor: TENSORRT_LLM_DESCRIPTOR_SOURCE,
  adapter: tensorrtLlmAdapter,
  settings: tensorrtLlmSettings,
  check: (settings) =>
    tensorrtLlmCheckEngine({
      contextLength: settings.context_length,
      kvCacheFreeGpuMemoryFraction: settings.kv_cache_free_gpu_memory_fraction,
    }),
  routePolicy: tensorrtLlmRoutePolicy,
}
