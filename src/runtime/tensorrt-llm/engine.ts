/**
 * TensorRT-LLM as a managed engine (change `add-vllm-runtime`, design D3): its adapter, its settings,
 * its memory rule and checkpoint quirks for the shared check, its route policy, and its descriptor in
 * conf. Registered by core like any other managed engine.
 */
import { TENSORRT_LLM_DESCRIPTOR_SOURCE, TENSORRT_LLM_ENGINE_ID } from '../environment/index.js'
import type { ManagedEngineSpec } from '../managed-engines/spec.js'
import { tensorrtLlmAdapter, type TensorrtLlmSettings } from './adapter.js'
import { tensorrtLlmCheckEngine, tensorrtLlmLaunchPlan, type MemorySizingInputs } from './compatibility.js'
import { tensorrtLlmRoutePolicy } from './route-policy.js'
import { tensorrtLlmSettings } from './settings.js'

function memorySizing(settings: TensorrtLlmSettings): MemorySizingInputs {
  return {
    contextLength: settings.context_length,
    kvCacheFreeGpuMemoryFraction: settings.kv_cache_free_gpu_memory_fraction,
    cudaGraphs: settings.cuda_graphs,
  }
}

export const TENSORRT_LLM_ENGINE: ManagedEngineSpec<TensorrtLlmSettings> = {
  engine_id: TENSORRT_LLM_ENGINE_ID,
  provider: TENSORRT_LLM_ENGINE_ID,
  label: 'TensorRT-LLM',
  descriptor: TENSORRT_LLM_DESCRIPTOR_SOURCE,
  adapter: tensorrtLlmAdapter,
  settings: tensorrtLlmSettings,
  check: (settings) => tensorrtLlmCheckEngine(memorySizing(settings)),
  // Whether `auto` captures CUDA graphs, decided on the card as it stands right before the container.
  launchPlan: (settings, checkpoint, gpu, host) =>
    tensorrtLlmLaunchPlan(memorySizing(settings), checkpoint, gpu, host),
  routePolicy: tensorrtLlmRoutePolicy,
}
