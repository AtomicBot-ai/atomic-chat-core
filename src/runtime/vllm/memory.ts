/**
 * vLLM's memory, decided by core (change `add-vllm-runtime`, task 3.3, design D9; spec `vllm-runtime`,
 * "Память vLLM задаёт core"). vLLM sizes its KV cache as a share of the card's *total* memory and,
 * before it starts, refuses to run when the card's free memory is below that share — so on any
 * desktop whose card holds a display and a browser, a fixed share fails at start. Core instead:
 *
 * - sizes the KV cache in bytes (`--kv-cache-memory-bytes`): the KV-cache token limit when one is set,
 *   otherwise the context length × the concurrent requests (on a card with the host's memory, two
 *   contexts, as for TensorRT-LLM), × the bytes one token takes in the model's KV shape (attention
 *   layers only) at the KV precision — FP8 when asked for on compute capability 8.9 and newer, or when
 *   the checkpoint's own KV cache is FP8, else two bytes;
 * - gives vLLM the share of the card that is free right before the container is created, less a
 *   margin: `min(0.95, (free − 512 MiB) / total)` (on a card with the host's memory, never more than
 *   half the host's memory), so vLLM's own start check passes by construction;
 * - checks, before any container, that the weights, that KV cache and vLLM's own overhead fit the
 *   free memory — the same rule the compatibility check (`POST /models/vllm/check`) applies.
 *
 * The overhead (~2 GiB: CUDA context, activations, sampler, graphs) and the margin are first
 * estimates; the live run of task 6.1 confirms or changes them, with the numbers in the change's
 * rulings.
 */
import type { GpuFacts } from '../../contracts/index.js'
import {
  freeMemoryBytes,
  isUnifiedMemory,
  kvCacheQuantAlgo,
  readKvCacheShape,
  totalMemoryBytes,
  type CheckpointMemoryInputs,
  type HostMemory,
  type JsonObject,
  type KvReserveBasis,
  type ManagedCheckEngine,
  type MemoryNeed,
} from '../managed-models/index.js'
import type { VllmLaunchPlan } from './adapter.js'
import type { VllmSettings } from './settings.js'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

/** What vLLM holds beyond weights and KV cache: CUDA context, activations, sampler, graphs. */
export const VLLM_ENGINE_OVERHEAD_BYTES = 2 * GiB
/** Left free on the card when the share is computed: what other processes may still take meanwhile. */
export const VLLM_FREE_MEMORY_MARGIN_BYTES = 512 * MiB
/** The highest share of a card vLLM is ever given. */
export const VLLM_MAX_GPU_MEMORY_UTILIZATION = 0.95
/** On a card with the host's memory: contexts the KV cache holds, as for TensorRT-LLM (design D9). */
export const VLLM_UNIFIED_KV_CONTEXTS = 2
/** Without the model's KV shape: a quarter of the weights, at least 1 GiB. */
const FALLBACK_KV_WEIGHT_SHARE = 0.25
const FALLBACK_KV_MIN_BYTES = GiB

/** Compute capability 8.9 (Ada) and newer. */
function supportsFp8Kv(computeCapability: string): boolean {
  const [major, minor] = computeCapability.split('.').map((part) => Number.parseInt(part, 10))
  if (major === undefined || Number.isNaN(major)) return false
  return major > 8 || (major === 8 && (minor ?? 0) >= 9)
}

/** The tokens the KV cache holds: the limit, else context × requests (two contexts on unified memory). */
export function vllmKvTokens(settings: VllmSettings, unifiedMemory: boolean): number {
  if (settings.kv_cache_max_tokens !== null) return settings.kv_cache_max_tokens
  return unifiedMemory
    ? settings.context_length * VLLM_UNIFIED_KV_CONTEXTS
    : settings.context_length * settings.max_num_seqs
}

/** The KV cache in bytes for this checkpoint, settings and card, and whether the model's shape sized it. */
export function vllmKvCacheBytes(
  checkpoint: { configJson: JsonObject; hfQuantConfigJson: JsonObject | null; weightBytesTotal?: number },
  settings: VllmSettings,
  gpu: GpuFacts,
  unifiedMemory: boolean
): { bytes: number; basis: KvReserveBasis } {
  const shape = readKvCacheShape(checkpoint.configJson)
  if (shape === undefined) {
    const weights = checkpoint.weightBytesTotal ?? 0
    return {
      bytes: Math.max(FALLBACK_KV_MIN_BYTES, Math.ceil(weights * FALLBACK_KV_WEIGHT_SHARE)),
      basis: 'weight_fraction',
    }
  }
  const fp8 =
    (settings.kv_cache_dtype === 'fp8' && supportsFp8Kv(gpu.compute_capability)) ||
    kvCacheQuantAlgo(checkpoint.configJson, checkpoint.hfQuantConfigJson)?.toUpperCase() === 'FP8'
  const perToken = 2 * shape.numHiddenLayers * shape.numKeyValueHeads * shape.headDim * (fp8 ? 1 : 2)
  return { bytes: perToken * vllmKvTokens(settings, unifiedMemory), basis: 'config' }
}

/**
 * vLLM's memory rule on `gpu`: weights + KV cache in bytes + its own overhead, held to the same share
 * the launch gives vLLM (`vllmGpuMemoryUtilization`): the margin left free counts as needed, and on a
 * card with the host's memory so does whatever of `MemAvailable` lies beyond half the host's memory —
 * so the check and the start agree on what fits.
 */
export function vllmMemoryNeed(
  gpu: GpuFacts,
  checkpoint: CheckpointMemoryInputs,
  settings: VllmSettings,
  host: HostMemory
): MemoryNeed {
  const unified = isUnifiedMemory(gpu)
  const kv = vllmKvCacheBytes(checkpoint, settings, gpu, unified)
  const systemReserve = unified
    ? Math.max(0, freeMemoryBytes(gpu, host) - totalMemoryBytes(gpu, host) / 2)
    : 0
  const neededBytes =
    checkpoint.weightBytesTotal +
    kv.bytes +
    VLLM_ENGINE_OVERHEAD_BYTES +
    VLLM_FREE_MEMORY_MARGIN_BYTES +
    systemReserve
  return {
    neededBytes,
    kvReserveBasis: kv.basis,
    details:
      `weight_bytes=${checkpoint.weightBytesTotal} kv_cache_bytes=${kv.bytes} kv_reserve_basis=${kv.basis} ` +
      `engine_overhead_bytes=${VLLM_ENGINE_OVERHEAD_BYTES} free_margin_bytes=${VLLM_FREE_MEMORY_MARGIN_BYTES}` +
      (unified ? ` system_reserve_bytes=${systemReserve}` : '') +
      ` needed_bytes=${neededBytes}`,
  }
}

/** A vision or audio part in the checkpoint: a multimodal architecture, or its encoder's config. */
function isMultimodal(configJson: JsonObject): boolean {
  const architectures = Array.isArray(configJson['architectures']) ? configJson['architectures'] : []
  return (
    architectures.some((name) => typeof name === 'string' && name.endsWith('ForConditionalGeneration')) ||
    ['vision_config', 'audio_config', 'vision_tower'].some((key) => key in configJson)
  )
}

/** `--gpu-memory-utilization` from the card as it stands now (see the file banner). */
export function vllmGpuMemoryUtilization(gpu: GpuFacts, host: HostMemory): number {
  const total = totalMemoryBytes(gpu, host)
  if (total <= 0) return VLLM_MAX_GPU_MEMORY_UTILIZATION
  let available = freeMemoryBytes(gpu, host) - VLLM_FREE_MEMORY_MARGIN_BYTES
  // On the host's memory, half of it stays the system's (the same rule as TensorRT-LLM's).
  if (isUnifiedMemory(gpu)) available = Math.min(available, total / 2)
  const share = Math.min(VLLM_MAX_GPU_MEMORY_UTILIZATION, available / total)
  return Math.max(0.01, Math.floor(share * 10_000) / 10_000)
}

/** The launch plan `beforeCreate` hands the adapter, from the card re-probed right before the container. */
export function vllmLaunchPlan(
  settings: VllmSettings,
  checkpoint: CheckpointMemoryInputs,
  gpu: GpuFacts,
  host: HostMemory
): VllmLaunchPlan {
  return {
    kvCacheMemoryBytes: vllmKvCacheBytes(checkpoint, settings, gpu, isUnifiedMemory(gpu)).bytes,
    gpuMemoryUtilization: vllmGpuMemoryUtilization(gpu, host),
    multimodal: isMultimodal(checkpoint.configJson),
  }
}

/** The check skeleton's hooks for vLLM: its memory rule, and no checkpoint quirks of its own. */
export function vllmCheckEngine(settings: VllmSettings): ManagedCheckEngine {
  return {
    engineId: 'vllm',
    checkpointProblems: () => null,
    memoryNeed: (gpu, checkpoint, host) => vllmMemoryNeed(gpu, checkpoint, settings, host),
  }
}
