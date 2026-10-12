/**
 * TensorRT-LLM's part of the managed compatibility check (spec `tensorrt-llm-models`, "Проверка
 * совместимости без сети"; change `add-vllm-runtime`, design D7). The skeleton — GGUF, the curated
 * digest, the shared naming rule, architecture, format matrix, compute capability, the memory line —
 * is `../managed-models/compatibility.ts`, the same for every managed engine. What is TensorRT-LLM's
 * own lives here as the two hooks of `tensorrtLlmCheckEngine`:
 *
 *   - `memoryNeed`: weights plus an allowance for the engine's own layout of them, plus the KV
 *     reserve divided by `kv_cache_free_gpu_memory_fraction` (`trtllm-serve`'s semantics: it spends
 *     only that fraction of what is free after the weights), bounded by tokens on a unified-memory
 *     card, plus the runtime and the activation peak;
 *   - `checkpointProblems`: shapes of supported architectures this image's loader cannot read
 *     (Nemotron-H with dense MLP layers, a DeepseekV3Gate MoE without its correction bias).
 *
 * `checkModelCompatibility`, `checkModelCompatibilityFiles` and `checkModelMemory` keep their
 * signatures — `MemorySizingInputs` is the provider's settings — and are the skeleton with this
 * engine plugged in. The skeleton's helpers are re-exported so this module's callers are unchanged.
 */

import type { GpuFacts, ModelCompatibility, RuntimeDescriptor } from '../../contracts/index.js'
import {
  checkCheckpoint,
  checkCheckpointFiles,
  checkCheckpointMemory,
  freeMemoryBytes,
  isUnifiedMemory,
  kvCacheBytes,
  positiveNumberField,
  type CheckpointMemoryInputs,
  type CheckpointProblem,
  type FilesCheckResult,
  type HostMemory,
  type KvReserveBasis,
  type ManagedCheckEngine,
  type MemoryNeed,
  type ModelCheckInput,
  type ResolvedCheckpoint,
} from '../managed-models/compatibility.js'
import type { JsonObject } from '../managed-models/quant-format.js'
import { TENSORRT_LLM_ENGINE_ID } from '../environment/index.js'
import {
  TENSORRT_LLM_CUDA_GRAPHS_RESERVE_BYTES,
  tensorrtLlmCudaGraphsOn,
  type TensorrtLlmCudaGraphsSetting,
  type TensorrtLlmLaunchPlan,
} from './cuda-graphs.js'
import { tensorrtLlmUnifiedKvMaxTokens } from './kv-cache.js'

export * from '../managed-models/compatibility.js'

const CORRECTION_BIAS_GATED_ARCHITECTURES: ReadonlySet<string> = new Set([
  'DeepseekV3ForCausalLM',
  'DeepseekV32ForCausalLM',
  'GlmMoeDsaForCausalLM',
  'Glm4MoeForCausalLM',
])

const CORRECTION_BIAS_TENSOR = 'e_score_correction_bias'

const NEMOTRON_H_ARCHITECTURE = /^NemotronH/

/**
 * A checkpoint whose architecture is supported but whose own shape the engine image cannot load —
 * what the architecture name alone cannot tell (Windows acceptance machine, 2026-10-03):
 *
 * - Nemotron-H with dense MLP layers: a `-` in `hybrid_override_pattern`. The `transformers` 5.5.4
 *   in the 1.3.0rc29 image maps that pattern through `M`/`E`/`*` only and fails with
 *   `KeyError: '-'` before TensorRT-LLM (which does support `-`) is reached
 *   (NVIDIA-Nemotron-3-Nano-4B, Nano-9B-v2). Drop this once a descriptor's image ships a
 *   `transformers` that knows `-`.
 * - A `DeepseekV3Gate` architecture with MoE layers (`n_routed_experts > 0`) whose tensors have no
 *   `e_score_correction_bias` (PrimeIntellect/GLM-0.5B, saved in its training framework's own
 *   layout — `mlp.router.gate.weight`, `mlp.expert_bias` — not the Hugging Face one TensorRT-LLM
 *   reads): `AssertionError` while the weights load. Needs `weight_names`; without them it is not
 *   checked.
 *
 * `null` when none applies.
 */
export function tensorrtLlmCheckpointProblems(
  architecture: string,
  configJson: JsonObject,
  weightNames: readonly string[] | undefined
): CheckpointProblem | null {
  if (NEMOTRON_H_ARCHITECTURE.test(architecture)) {
    const pattern = configJson.hybrid_override_pattern
    if (typeof pattern === 'string' && pattern.includes('-')) {
      return {
        message:
          'This engine release cannot load Nemotron-H checkpoints with dense MLP layers ("-" in hybrid_override_pattern).',
        details: `architecture=${architecture} hybrid_override_pattern=${pattern}`,
      }
    }
  }
  if (
    CORRECTION_BIAS_GATED_ARCHITECTURES.has(architecture) &&
    weightNames !== undefined &&
    weightNames.length > 0 &&
    (positiveNumberField(configJson, 'n_routed_experts') ?? 0) > 0 &&
    !weightNames.some((name) => name.endsWith(CORRECTION_BIAS_TENSOR))
  ) {
    return {
      message: `This checkpoint has no ${CORRECTION_BIAS_TENSOR} tensors, which ${architecture} needs in its MoE router on this engine.`,
      details: `architecture=${architecture} missing=${CORRECTION_BIAS_TENSOR}`,
    }
  }
  return null
}

export interface MemoryReserve {
  reserveBytes: number
  basis: KvReserveBasis
}

/**
 * Bytes reserved on top of the weights when checking whether a checkpoint fits a card's free memory.
 *
 * On a discrete card, `KV_bytes / kv_cache_free_gpu_memory_fraction` (task 2.16w round 1, finding 6
 * (RULING), superseding the placeholder `weights × (1 − fraction)` rule): `trtllm-serve` spends only
 * that fraction of whatever memory remains free *after* weights load on the KV cache, keeping the
 * rest as headroom, so guaranteeing `KV_bytes` of real cache capacity needs `KV_bytes / fraction` of
 * free memory left over once weights are loaded — the ADR this formula documents derives that
 * division in full.
 *
 * On a unified-memory card (`unifiedMemory`, design D13) the launch bounds the KV cache by tokens,
 * `kv_cache_config.max_tokens = tensorrtLlmUnifiedKvMaxTokens(contextLength)` (`kv-cache.ts`), and
 * TensorRT-LLM uses the smaller of that bound and the fraction; the reserve is therefore the KV for
 * exactly that many tokens, not divided by the fraction, so the check and the launch agree
 * (docs/decisions/2026-09-29-tensorrt-llm-unified-memory-kv-cache-bounded-by-tokens.md).
 *
 * `basis: 'config'` when `kvCacheBytes` had what it needed; `basis: 'weight_fraction'` — the older,
 * cruder `weights × (1 − fraction)` rule, the same on either kind of card — only when `config.json`
 * lacked the architecture fields the real formula needs, and the returned `basis` says so, so a
 * verdict computed from the fallback is never silently indistinguishable from one computed from the
 * checkpoint's real shape.
 */
export function kvCacheReserveBytes(
  weightBytesTotal: number,
  configJson: JsonObject,
  hfQuantConfigJson: JsonObject | null,
  contextLength: number,
  kvCacheFreeGpuMemoryFraction: number,
  unifiedMemory: boolean
): MemoryReserve {
  const kvTokens = unifiedMemory ? tensorrtLlmUnifiedKvMaxTokens(contextLength) : contextLength
  const kvBytes = kvCacheBytes(configJson, hfQuantConfigJson, kvTokens)
  if (kvBytes !== undefined) {
    return {
      reserveBytes: unifiedMemory ? kvBytes : Math.ceil(kvBytes / kvCacheFreeGpuMemoryFraction),
      basis: 'config',
    }
  }
  return {
    reserveBytes: Math.ceil(weightBytesTotal * (1 - kvCacheFreeGpuMemoryFraction)),
    basis: 'weight_fraction',
  }
}

/**
 * What `trtllm-serve` holds outside torch on any card: the CUDA context, cuBLAS/cuDNN workspaces,
 * NCCL buffers. Measured 1.14–1.62 GiB on an RTX 4070 Laptop (Windows live acceptance, 2026-10-03,
 * "Memory used outside torch"), then 1.6–1.8 GiB on an RTX 5090 Laptop (2026-10-09, the logged
 * figure less the 0.32 GiB other processes held); the check takes the high end with headroom.
 */
export const TENSORRT_LLM_RUNTIME_OVERHEAD_BYTES = 2 * 1024 ** 3

/**
 * The share of the checkpoint's weight bytes added for the engine's own layout of them, which is not
 * the checkpoint's: the 1.3.0rc29 loader keeps Qwen3.5's linear-attention `in_proj_qkvz` in bf16
 * whatever the checkpoint stores (`_add_qkvz_bf16_workaround`), and skips `mtp.*` layers. Measured on
 * the RTX 5090 Laptop (2026-10-09): Qwen3.8-27B-NVFP4 held 21.71 GiB for 20.42 GiB of files (+6.3%),
 * NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 18.23 GiB for 20.08 (−9.2%, 2.49 GiB of MTP unread).
 * 5% refuses the first on that card's 23.57 GiB free, which otherwise spilled into shared memory
 * under WDDM and never got ready, and still passes the second, which loads.
 */
export const TENSORRT_LLM_WEIGHT_LAYOUT_ALLOWANCE = 0.05

/** Bytes added to the checkpoint's weights for the engine's own layout of them. */
export function weightLayoutAllowanceBytes(weightBytesTotal: number): number {
  return Math.ceil(Math.max(weightBytesTotal, 0) * TENSORRT_LLM_WEIGHT_LAYOUT_ALLOWANCE)
}

/**
 * Bytes of activation peak per prompt token per MLP intermediate element: the engine profiles a
 * warmup of `max_num_tokens` tokens (the launch sets it to the context length), and the peak grows
 * with both. Measured 0.91 GiB at 8192 tokens and 0.46 GiB at 4096 tokens for an
 * `intermediate_size` of 14336 (ministral/Ministral-3b-instruct, same acceptance machine): ≈ 8.4.
 */
const ACTIVATION_BYTES_PER_TOKEN_ELEMENT = 8.5

/** The MLP width that sizes the activations: `intermediate_size`, a VLM's `text_config` one, else 4 × hidden. */
function intermediateSize(rootConfigJson: JsonObject): number | undefined {
  const textConfig =
    typeof rootConfigJson.text_config === 'object' && rootConfigJson.text_config !== null
      ? (rootConfigJson.text_config as JsonObject)
      : undefined
  for (const config of [rootConfigJson, textConfig]) {
    if (config === undefined) continue
    const intermediate = positiveNumberField(config, 'intermediate_size')
    if (intermediate !== undefined) return intermediate
    const hidden = positiveNumberField(config, 'hidden_size')
    if (hidden !== undefined) return 4 * hidden
  }
  return undefined
}

/**
 * The engine's own memory beyond weights and KV cache: the runtime overhead plus the activation
 * peak of a `contextLength`-token prefill. Without it a checkpoint whose weights fit an 8 GB card
 * passed the check and then left the KV cache 224 tokens (Ministral-3b bf16, 8.20 GiB peak on an
 * 8.00 GiB card), and every request failed mid-stream.
 */
export function engineOverheadBytes(configJson: JsonObject, contextLength: number): number {
  const intermediate = intermediateSize(configJson) ?? 0
  return Math.ceil(
    TENSORRT_LLM_RUNTIME_OVERHEAD_BYTES + contextLength * intermediate * ACTIVATION_BYTES_PER_TOKEN_ELEMENT
  )
}

/** What sizes the KV-cache reserve: the provider's settings, resolved by the caller (`check.ts`, `runtime.ts`). */
export interface MemorySizingInputs {
  /** The session's context length: stored provider settings, a load's own overrides, or the
   * adapter's default. */
  contextLength: number
  kvCacheFreeGpuMemoryFraction: number
  /** The provider's `cuda_graphs`. Only `on` adds the graphs' memory: `auto` turns them off where
   *  they would not fit (`tensorrtLlmLaunchPlan`), `off` never captures them. Absent is `auto`. */
  cudaGraphs?: TensorrtLlmCudaGraphsSetting
}

/** TensorRT-LLM's memory rule on `gpu`: its weights as the engine lays them out, plus that card's own kind of KV reserve, plus the engine. */
export function tensorrtLlmMemoryNeed(
  gpu: GpuFacts,
  checkpoint: { weightBytesTotal: number; configJson: JsonObject; hfQuantConfigJson: JsonObject | null },
  memory: MemorySizingInputs
): MemoryNeed {
  const unified = isUnifiedMemory(gpu)
  const reserve = kvCacheReserveBytes(
    checkpoint.weightBytesTotal,
    checkpoint.configJson,
    checkpoint.hfQuantConfigJson,
    memory.contextLength,
    memory.kvCacheFreeGpuMemoryFraction,
    unified
  )
  const overheadBytes = engineOverheadBytes(checkpoint.configJson, memory.contextLength)
  const layoutBytes = weightLayoutAllowanceBytes(checkpoint.weightBytesTotal)
  const cudaGraphsBytes = memory.cudaGraphs === 'on' ? TENSORRT_LLM_CUDA_GRAPHS_RESERVE_BYTES : 0
  const neededBytes =
    checkpoint.weightBytesTotal + layoutBytes + reserve.reserveBytes + overheadBytes + cudaGraphsBytes
  // The token bound the launch writes, on a card where it writes one (adapter.ts).
  const kvTokens =
    unified && reserve.basis === 'config'
      ? ` kv_max_tokens=${tensorrtLlmUnifiedKvMaxTokens(memory.contextLength)}`
      : ''
  return {
    neededBytes,
    kvReserveBasis: reserve.basis,
    details: `weight_bytes=${checkpoint.weightBytesTotal} weight_layout_bytes=${layoutBytes} kv_reserve_bytes=${reserve.reserveBytes} kv_reserve_basis=${reserve.basis}${kvTokens} engine_overhead_bytes=${overheadBytes}${cudaGraphsBytes > 0 ? ` cuda_graphs_bytes=${cudaGraphsBytes}` : ''} needed_bytes=${neededBytes}`,
  }
}

/**
 * The launch plan `beforeCreate` hands the adapter (`ManagedEngineSpec.launchPlan`), from the card
 * re-probed once the previous sessions stopped and the memory check passed: `auto` captures CUDA
 * graphs only when they fit in what the card has free beyond everything else the check counts.
 */
export function tensorrtLlmLaunchPlan(
  memory: MemorySizingInputs,
  checkpoint: CheckpointMemoryInputs,
  gpu: GpuFacts,
  host: HostMemory
): TensorrtLlmLaunchPlan {
  const setting = memory.cudaGraphs ?? 'auto'
  if (setting !== 'auto') return { cudaGraphs: setting === 'on' }
  const withoutGraphs = tensorrtLlmMemoryNeed(gpu, checkpoint, { ...memory, cudaGraphs: 'off' })
  const headroomBytes = freeMemoryBytes(gpu, host) - withoutGraphs.neededBytes
  return { cudaGraphs: tensorrtLlmCudaGraphsOn('auto', gpu.total_vram_bytes, headroomBytes) }
}

/** The skeleton's hooks for TensorRT-LLM, sized by the provider's settings. */
export function tensorrtLlmCheckEngine(memory: MemorySizingInputs): ManagedCheckEngine {
  return {
    engineId: TENSORRT_LLM_ENGINE_ID,
    checkpointProblems: tensorrtLlmCheckpointProblems,
    memoryNeed: (gpu, checkpoint) => tensorrtLlmMemoryNeed(gpu, checkpoint, memory),
  }
}

/** Every check above the memory line, for TensorRT-LLM (see `checkCheckpointFiles`). */
export function checkModelCompatibilityFiles(
  input: ModelCheckInput,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemory: HostMemory,
  memory: MemorySizingInputs
): FilesCheckResult {
  return checkCheckpointFiles(input, descriptor, gpus, hostMemory, tensorrtLlmCheckEngine(memory))
}

/** The memory line alone, for TensorRT-LLM (see `checkCheckpointMemory`). */
export function checkModelMemory(
  resolved: ResolvedCheckpoint,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemory: HostMemory,
  memory: MemorySizingInputs
): ModelCompatibility {
  return checkCheckpointMemory(resolved, descriptor, gpus, hostMemory, tensorrtLlmCheckEngine(memory))
}

/** The full verdict for TensorRT-LLM (see `checkCheckpoint`). */
export function checkModelCompatibility(
  input: ModelCheckInput,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemory: HostMemory,
  memory: MemorySizingInputs
): ModelCompatibility {
  return checkCheckpoint(input, descriptor, gpus, hostMemory, tensorrtLlmCheckEngine(memory))
}
