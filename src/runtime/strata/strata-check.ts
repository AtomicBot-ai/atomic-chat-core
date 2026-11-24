import { strataCudaProfile, strataProfileId } from '../../client/strata-contracts.js'
import type {
  StrataBackend,
  StrataMemoryMode,
  StrataModelDescriptor,
  StrataResourceEstimate,
} from '../../contracts/index.js'
import type { StrataSettings } from '../../settings/index.js'
import { planContextWindow } from '../llamacpp/index.js'

interface Inputs {
  backend: StrataBackend
  unified: boolean
  installed: boolean
  prepared: boolean
  previousBytes: number
  stagedBytes?: number
  memoryMode?: StrataMemoryMode
  minimumVramBytes?: number | undefined
}
const GiB = 2 ** 30
const QWEN36_CUDA_TEXT_CONTEXT = 4096
const QWEN36_CUDA_TEXT_VRAM = 8188 * 2 ** 20
const QWEN36_CUDA_EXTENDED_VRAM = 10 * GiB

/** What a Strata model's first GGUF shard says about its window (`StrataRegistry.contextFacts`). */
export interface StrataGgufFacts {
  /** `{arch}.context_length`: the longest window a load may ask for. */
  contextLimit: number
  /** KV-cache bytes a token of window costs, by the GGUF estimate; absent, the window is not grown. */
  kvBytesPerToken?: number
}

/**
 * The automatic window on a discrete card, by the GGUF's context plan: the profile's tested window
 * (`baseCtx`, which the profile's VRAM floor `floorBytes` holds), grown by as many tokens as the
 * GGUF's KV estimate fits in the card above that floor and the plan's 1 GiB reserve, never past the
 * GGUF's own limit. Strata's own buffers are not modelled beyond the floor, so the growth only spends
 * memory the floor leaves; without a KV estimate the tested window stands.
 */
export function strataPlannedContext(input: {
  baseCtx: number
  floorBytes: number
  gpuBytes: number
  gguf: StrataGgufFacts | undefined
}): number {
  const perToken = input.gguf?.kvBytesPerToken
  const limit = input.gguf?.contextLimit
  if (perToken === undefined || !(perToken > 0) || limit === undefined || !(limit > input.baseCtx))
    return input.baseCtx
  const plan = planContextWindow({
    device: { kind: 'gpu', freeVramBytes: input.gpuBytes },
    weightsBytes: input.floorBytes,
    trainedCtx: limit,
    kvBytesAt: (ctx) => Math.max(0, ctx - input.baseCtx) * perToken,
    floorCtx: input.baseCtx,
    offloadShare: 0,
    marginBytes: 0,
  })
  return plan?.recommendedCtx ?? input.baseCtx
}

/**
 * Use the tested text profile on smaller cards and reserve more for longer contexts and vision. With
 * the first shard's GGUF facts, an automatic window on a discrete card grows from the catalog's
 * tested one by what the card holds above the profile's VRAM floor (`strataPlannedContext`); a window
 * the user set stands.
 */
export function planStrataMemory(
  descriptor: StrataModelDescriptor,
  backend: StrataBackend,
  gpuBytes: number,
  settings: StrataSettings,
  gguf?: StrataGgufFacts
): { settings: StrataSettings; minimumVramBytes?: number } {
  if (backend !== 'cuda' || strataProfileId(descriptor) !== 'ud-q4-k-xl-mtp') {
    if (settings.context_length || gguf === undefined || backend === 'metal') return { settings }
    const floorBytes = estimateStrata(descriptor, {
      backend,
      unified: false,
      installed: true,
      prepared: true,
      previousBytes: 0,
    }).vram_bytes
    const context = strataPlannedContext({ baseCtx: descriptor.context_length, floorBytes, gpuBytes, gguf })
    return context === descriptor.context_length
      ? { settings }
      : { settings: { ...settings, context_length: context } }
  }
  const compact = gpuBytes < QWEN36_CUDA_EXTENDED_VRAM
  // Below 10 GiB the measured text profile stands (ADR 2026-11-16): a longer window needs the 10 GiB floor.
  const autoContext = compact
    ? Math.min(descriptor.context_length, QWEN36_CUDA_TEXT_CONTEXT)
    : strataPlannedContext({
        baseCtx: descriptor.context_length,
        floorBytes: QWEN36_CUDA_EXTENDED_VRAM,
        gpuBytes,
        gguf,
      })
  const context = settings.context_length || autoContext
  const vision = compact ? 'off' : settings.vision
  const extended = context > QWEN36_CUDA_TEXT_CONTEXT || (vision === 'auto' && descriptor.capabilities.vision)
  return {
    settings: { ...settings, context_length: context, vision },
    minimumVramBytes: extended ? QWEN36_CUDA_EXTENDED_VRAM : QWEN36_CUDA_TEXT_VRAM,
  }
}

export function strataRamModeBytes(d: StrataModelDescriptor): number {
  const readyPack = strataCudaProfile(strataProfileId(d))?.readyPack
  const weights = d.files
    .filter((file) =>
      readyPack ? ['ple', 'embedding', 'pack'].includes(file.role) : file.role === 'weights'
    )
    .reduce((sum, file) => sum + file.size, 0)
  return weights + 12 * GiB
}

/** Conservative planning estimates for the pinned recipes. Values are not hardware qualification. */
export function estimateStrata(d: StrataModelDescriptor, input: Inputs): StrataResourceEstimate {
  const profileId = strataProfileId(d)
  const readyPack = strataCudaProfile(profileId)?.readyPack
  const weights = d.files.filter((f) => f.role === 'weights').reduce((total, file) => total + file.size, 0)
  const download_bytes = input.installed ? 0 : d.requirements.download_bytes - (input.stagedBytes ?? 0)
  let derivative_bytes = 0
  let temporary_bytes = 0
  if (!input.prepared) {
    switch (d.family) {
      case 'qwen38':
        // Dense tensors can widen to F32. Non-Metal also packs experts from every shard.
        derivative_bytes = 64 * 2 ** 20
        if (!readyPack)
          derivative_bytes +=
            (d.inputs.drafting === 'dflash2' ? 522_458_112 : 0) +
            (input.backend === 'metal' ? 8 * GiB : weights + 8 * GiB)
        temporary_bytes = GiB
        break
      case 'qwen36':
        derivative_bytes = 64 * 2 ** 20
        temporary_bytes = 64 * 2 ** 20
        break
      case 'deepseek41':
        derivative_bytes = 256 * 2 ** 20
        temporary_bytes = 6 * GiB
        break
    }
  }
  // The pinned CUDA Q4 recipe keeps about 18.75 GiB of routed experts in host memory.
  // Round up the arena plus 12 GiB for the OS and runtime (31 GiB).
  const qwen36Q4Ram = input.backend === 'cuda' && profileId === 'ud-q4-k-xl-mtp' ? Math.ceil(18.75 + 12) : 32
  const qwen36Ram = profileId === 'q8-0-mtp' ? 52 : profileId === 'ud-q6-k-xl-mtp' ? 44 : qwen36Q4Ram
  const ram =
    readyPack && input.memoryMode === 'ram'
      ? strataRamModeBytes(d)
      : (readyPack ? 32 : d.family === 'qwen36' ? qwen36Ram : d.family === 'deepseek41' ? 16 : 10) * GiB
  // The tested 8 GB CUDA card reports 8188 MiB to NVML. Keep a floor for that card class.
  const qwen36Vram = input.backend === 'cuda' ? QWEN36_CUDA_TEXT_VRAM : 8 * GiB
  // One card must hold the DeepSeek Q8 dense weights; the 2-bit variants use a smaller dense set.
  const vram =
    profileId === 'unsloth-ud-q8-k-xl'
      ? 16_000 * 2 ** 20
      : d.family === 'deepseek41'
        ? 8 * GiB
        : d.family === 'qwen36'
          ? (input.minimumVramBytes ?? qwen36Vram)
          : 6 * GiB
  return {
    download_bytes,
    derivative_bytes,
    temporary_bytes,
    previous_installation_bytes: input.previousBytes,
    required_disk_bytes: download_bytes + derivative_bytes + temporary_bytes + input.previousBytes,
    ram_bytes: input.unified ? 0 : ram,
    vram_bytes: input.unified ? 0 : vram,
    unified_memory_bytes: input.unified ? ram + vram : 0,
  }
}

/** Free space already excludes existing installations. Unified memory is one shared budget. */
export function strataResourceRefusal(
  estimate: StrataResourceEstimate,
  capacity: { disk: number | undefined; ram: number; gpu: number }
): 'insufficient-disk' | 'insufficient-memory' | null {
  if (
    capacity.disk !== undefined &&
    capacity.disk < estimate.required_disk_bytes - estimate.previous_installation_bytes
  )
    return 'insufficient-disk'
  if (estimate.unified_memory_bytes) {
    if (Math.min(capacity.ram, capacity.gpu) < estimate.unified_memory_bytes) return 'insufficient-memory'
  } else if (capacity.ram < estimate.ram_bytes || capacity.gpu < estimate.vram_bytes) {
    return 'insufficient-memory'
  }
  return null
}
