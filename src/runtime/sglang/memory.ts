/**
 * SGLang's memory, decided by core (change `add-sglang-runtime`, task 2.3, design D4; spec
 * `sglang-runtime`, "Память SGLang задаёт core"). SGLang sizes its budget from the memory it finds
 * free at start-up, once its own CUDA context exists: it keeps `--mem-fraction-static` of it for the
 * weights and the KV cache, and the rest is its room for activations and CUDA graphs
 * (`mem_cache/kv_cache_configurator.py::_profile_available_bytes`). Its own default share is computed
 * from the card's *total* memory, so on a card a desktop already holds part of, that room comes out
 * smaller than SGLang meant. Core instead:
 *
 * - gives SGLang (unless the share setting fixes it) `f = (F − R) / F`, clamped to [0.5, 0.95], where
 *   `F` is what the card has free right before the container is created and `R` the room SGLang needs
 *   (2 GiB with CUDA graphs, 1.25 GiB without): SGLang then keeps about `R` whatever other processes
 *   took. On a card with the host's memory the static share holds at most half of the host's memory:
 *   `(min(F, half the host) − R) / F`. Within its share SGLang sizes the KV cache itself — hybrid
 *   models' linear-attention state included — and core passes `--max-total-tokens` only from the
 *   setting.
 * - checks, before any container, that the weights, an estimate of the KV cache (context × parallel
 *   requests × the model's per-token KV bytes over its attention layers, or the KV token limit) and
 *   SGLang's own overhead fit the free memory — the same rule `POST /models/sglang/check` applies. It
 *   is an estimate for the verdict and the refusal before a container; it sizes nothing SGLang runs
 *   with.
 *
 * The reserve, the overhead (~2 GiB: CUDA context, activations, graphs) and the margin are first
 * estimates; the live run of task 4.1 records the numbers (`summary.json`, `rulings/core.md`).
 */
import type { GpuFacts } from '../../contracts/index.js'
import {
  checkpointIsMultimodal,
  freeMemoryBytes,
  isUnifiedMemory,
  kvCacheQuantAlgo,
  readKvCacheShape,
  supportsFp8KvCache,
  totalMemoryBytes,
  type CheckpointMemoryInputs,
  type HostMemory,
  type JsonObject,
  type KvReserveBasis,
  type ManagedCheckEngine,
  type MemoryNeed,
} from '../managed-models/index.js'
import type { SglangLaunchPlan } from './adapter.js'
import type { SglangSettings } from './settings.js'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

/** SGLang's room for activations and CUDA graphs captured up to the parallel requests (design D4, D5). */
export const SGLANG_RUNTIME_RESERVE_BYTES = 2 * GiB
/** The same room with CUDA graphs off. */
export const SGLANG_RUNTIME_RESERVE_NO_GRAPHS_BYTES = 1.25 * GiB
/** What SGLang holds beyond weights and KV cache: CUDA context, activations, graphs. */
export const SGLANG_ENGINE_OVERHEAD_BYTES = 2 * GiB
/** Counted as needed in the memory check: what other processes may still take meanwhile. */
export const SGLANG_FREE_MEMORY_MARGIN_BYTES = 512 * MiB
export const SGLANG_MIN_MEM_FRACTION_STATIC = 0.5
export const SGLANG_MAX_MEM_FRACTION_STATIC = 0.95
/** Without the model's KV shape: a quarter of the weights, at least 1 GiB (vLLM's rule). */
const FALLBACK_KV_WEIGHT_SHARE = 0.25
const FALLBACK_KV_MIN_BYTES = GiB

/**
 * The KV cache the memory check counts: the KV token limit when set, else context × parallel
 * requests, × the bytes per token over the model's attention layers — and whether the model's shape
 * sized it. Without a shape: a quarter of the weights, at least 1 GiB.
 */
export function sglangKvCacheBytes(
  checkpoint: { configJson: JsonObject; hfQuantConfigJson: JsonObject | null; weightBytesTotal?: number },
  settings: SglangSettings,
  gpu: GpuFacts
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
    (settings.kv_cache_dtype === 'fp8' && supportsFp8KvCache(gpu.compute_capability)) ||
    kvCacheQuantAlgo(checkpoint.configJson, checkpoint.hfQuantConfigJson)?.toUpperCase() === 'FP8'
  const perToken = 2 * shape.numHiddenLayers * shape.numKeyValueHeads * shape.headDim * (fp8 ? 1 : 2)
  const tokens = settings.max_total_tokens ?? settings.context_length * settings.max_running_requests
  return { bytes: perToken * tokens, basis: 'config' }
}

/**
 * SGLang's memory rule on `gpu`: weights + KV cache estimate + its own overhead + a margin for what
 * other processes may take meanwhile; on a card with the host's memory, whatever of `MemAvailable`
 * lies beyond half the host's memory counts as needed too.
 */
export function sglangMemoryNeed(
  gpu: GpuFacts,
  checkpoint: CheckpointMemoryInputs,
  settings: SglangSettings,
  host: HostMemory
): MemoryNeed {
  const unified = isUnifiedMemory(gpu)
  const kv = sglangKvCacheBytes(checkpoint, settings, gpu)
  const systemReserve = unified
    ? Math.max(0, freeMemoryBytes(gpu, host) - totalMemoryBytes(gpu, host) / 2)
    : 0
  const neededBytes =
    checkpoint.weightBytesTotal +
    kv.bytes +
    SGLANG_ENGINE_OVERHEAD_BYTES +
    SGLANG_FREE_MEMORY_MARGIN_BYTES +
    systemReserve
  return {
    neededBytes,
    kvReserveBasis: kv.basis,
    details:
      `weight_bytes=${checkpoint.weightBytesTotal} kv_cache_bytes=${kv.bytes} kv_reserve_basis=${kv.basis} ` +
      `engine_overhead_bytes=${SGLANG_ENGINE_OVERHEAD_BYTES} free_margin_bytes=${SGLANG_FREE_MEMORY_MARGIN_BYTES}` +
      (unified ? ` system_reserve_bytes=${systemReserve}` : '') +
      ` needed_bytes=${neededBytes}`,
  }
}

/** `--mem-fraction-static` from the card as it stands now (see the file banner). */
export function sglangMemFractionStatic(settings: SglangSettings, gpu: GpuFacts, host: HostMemory): number {
  const free = freeMemoryBytes(gpu, host)
  if (free <= 0) return SGLANG_MIN_MEM_FRACTION_STATIC
  const reserve =
    settings.cuda_graphs === 'off' ? SGLANG_RUNTIME_RESERVE_NO_GRAPHS_BYTES : SGLANG_RUNTIME_RESERVE_BYTES
  // On the host's memory, half of it stays the system's (the same rule as TensorRT-LLM's and vLLM's);
  // SGLang still measures all of the available memory as free, so the share is of that.
  const budget = isUnifiedMemory(gpu) ? Math.min(free, totalMemoryBytes(gpu, host) / 2) : free
  const share = (budget - reserve) / free
  const clamped = Math.min(SGLANG_MAX_MEM_FRACTION_STATIC, Math.max(SGLANG_MIN_MEM_FRACTION_STATIC, share))
  return Math.floor(clamped * 10_000) / 10_000
}

/** The launch plan `beforeCreate` hands the adapter, from the card re-probed right before the container. */
export function sglangLaunchPlan(
  settings: SglangSettings,
  checkpoint: CheckpointMemoryInputs,
  gpu: GpuFacts,
  host: HostMemory
): SglangLaunchPlan {
  return {
    memFractionStatic: settings.mem_fraction_static ?? sglangMemFractionStatic(settings, gpu, host),
    multimodal: checkpointIsMultimodal(checkpoint.configJson),
  }
}

/** The check skeleton's hooks for SGLang: its memory rule, and no checkpoint quirks of its own. */
export function sglangCheckEngine(settings: SglangSettings): ManagedCheckEngine {
  return {
    engineId: 'sglang',
    checkpointProblems: () => null,
    memoryNeed: (gpu, checkpoint, host) => sglangMemoryNeed(gpu, checkpoint, settings, host),
  }
}
