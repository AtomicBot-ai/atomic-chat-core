/**
 * vLLM's memory, decided by core (change `add-vllm-runtime`, task 3.3, design D9; spec `vllm-runtime`,
 * "Память vLLM задаёт core"). vLLM takes a share of the card's *total* memory (`--gpu-memory-
 * utilization`, 0.92 by default) and, before it starts, refuses to run when the card's free memory —
 * measured after its own CUDA context exists — is below that share; so on any desktop whose card holds
 * a display and a browser, its default fails at start. Core instead:
 *
 * - gives vLLM (unless the memory share setting fixes it) the share of the card that is free right
 *   before the container is created, less a margin larger than vLLM's own CUDA context: `min(0.95, (free − 1.5 GiB) / total)` (on a card with
 *   the host's memory, never more than half of it). Within that share vLLM places the weights and
 *   activations and gives the rest to the KV cache, sized by vLLM itself — it knows every model's KV
 *   shape, hybrid ones (Qwen3.5's linear attention) included. Core passes `--kv-cache-memory-bytes`
 *   only when the KV cache size setting fixes it. (Core sized the KV cache in bytes at first, from the
 *   attention layers only; for Qwen3.5 that was a third of what vLLM needs, and every load failed —
 *   Windows acceptance, 2026-10-06. The 1.5 GiB margin comes from the same run: the context took 0.87
 *   GiB under WSL on an RTX 4070 Laptop, more than the first 512 MiB.)
 * - checks, before any container, that the weights, an estimate of the KV cache (context × concurrent
 *   requests × the model's per-token KV bytes over its attention layers, or the KV cache size setting)
 *   and vLLM's own overhead fit the free memory — the same rule the compatibility check
 *   (`POST /models/vllm/check`) applies. It is an estimate for the verdict and the refusal before a
 *   container; it no longer sizes anything vLLM runs with.
 *
 * The overhead (~2 GiB: CUDA context, activations, sampler, graphs) and the margins are first
 * estimates; the live run of task 6.1 records the numbers (`summary.json`).
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
/** Counted as needed in the memory check: what other processes may still take meanwhile. */
export const VLLM_FREE_MEMORY_MARGIN_BYTES = 512 * MiB
/**
 * Left out of the share vLLM is given: more than vLLM's own CUDA context, which already holds memory
 * when vLLM checks the share at start (0.87 GiB under WSL on an RTX 4070 Laptop, 2026-10-06).
 */
export const VLLM_START_CHECK_MARGIN_BYTES = 1536 * MiB
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

/** The tokens the KV cache estimate covers: context × requests (two contexts on unified memory). */
export function vllmKvTokens(settings: VllmSettings, unifiedMemory: boolean): number {
  return unifiedMemory
    ? settings.context_length * VLLM_UNIFIED_KV_CONTEXTS
    : settings.context_length * settings.max_num_seqs
}

/**
 * The KV cache the memory check counts: the KV cache size setting when set, else an estimate from the
 * model's attention layers — and whether the model's shape sized it. vLLM sizes its own KV cache
 * unless the setting fixes it, so this only feeds the check's verdict.
 */
export function vllmKvCacheBytes(
  checkpoint: { configJson: JsonObject; hfQuantConfigJson: JsonObject | null; weightBytesTotal?: number },
  settings: VllmSettings,
  gpu: GpuFacts,
  unifiedMemory: boolean
): { bytes: number; basis: KvReserveBasis } {
  if (settings.kv_cache_memory_gib !== null) {
    return { bytes: Math.round(settings.kv_cache_memory_gib * GiB), basis: 'config' }
  }
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
 * The weights vLLM puts on the card: weights offloaded to the CPU (`cpu_offload_gb`, GiB as vLLM counts
 * them) leave it, except on a card with the host's memory, where they stay in the same memory.
 */
function vllmWeightsOnCard(checkpoint: CheckpointMemoryInputs, settings: VllmSettings, unified: boolean) {
  const offloadedBytes = unified
    ? 0
    : Math.min(checkpoint.weightBytesTotal, Math.round(settings.cpu_offload_gb * 1024 ** 3))
  return { weightsOnCard: checkpoint.weightBytesTotal - offloadedBytes, offloadedBytes }
}

/**
 * vLLM's memory rule on `gpu`: weights on the card + KV cache in bytes + its own overhead (CUDA context
 * included) + a margin for what other processes may take meanwhile; on a card with the host's memory,
 * whatever of `MemAvailable` lies beyond half the host's memory counts as needed too.
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
  const { weightsOnCard, offloadedBytes } = vllmWeightsOnCard(checkpoint, settings, unified)
  const neededBytes =
    weightsOnCard + kv.bytes + VLLM_ENGINE_OVERHEAD_BYTES + VLLM_FREE_MEMORY_MARGIN_BYTES + systemReserve
  return {
    neededBytes,
    kvReserveBasis: kv.basis,
    details:
      `weight_bytes=${checkpoint.weightBytesTotal}` +
      (offloadedBytes > 0 ? ` cpu_offload_bytes=${offloadedBytes}` : '') +
      ` kv_cache_bytes=${kv.bytes} kv_reserve_basis=${kv.basis} ` +
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
  let available = freeMemoryBytes(gpu, host) - VLLM_START_CHECK_MARGIN_BYTES
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
    kvCacheMemoryBytes:
      settings.kv_cache_memory_gib === null ? null : Math.round(settings.kv_cache_memory_gib * GiB),
    gpuMemoryUtilization: settings.gpu_memory_utilization ?? vllmGpuMemoryUtilization(gpu, host),
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
