import { strataCudaProfile } from '../../client/strata-contracts.js'
import type {
  StrataBackend,
  StrataMemoryMode,
  StrataModelDescriptor,
  StrataResourceEstimate,
} from '../../contracts/index.js'
import type { StrataSettings } from '../../settings/index.js'

interface Inputs {
  backend: StrataBackend
  unified: boolean
  installed: boolean
  prepared: boolean
  previousBytes: number
  memoryMode?: StrataMemoryMode
  minimumVramBytes?: number | undefined
}
const GiB = 2 ** 30
const QWEN36_CUDA_TEXT_CONTEXT = 4096
const QWEN36_CUDA_TEXT_VRAM = 8188 * 2 ** 20
const QWEN36_CUDA_EXTENDED_VRAM = 10 * GiB

/** Use the tested text profile on smaller cards and reserve more for longer contexts and vision. */
export function planStrataMemory(
  descriptor: StrataModelDescriptor,
  backend: StrataBackend,
  gpuBytes: number,
  settings: StrataSettings
): { settings: StrataSettings; minimumVramBytes?: number } {
  if (backend !== 'cuda' || descriptor.variant_id !== 'ud-q4-k-xl-mtp') return { settings }
  const compact = gpuBytes < QWEN36_CUDA_EXTENDED_VRAM
  const autoContext = compact
    ? Math.min(descriptor.context_length, QWEN36_CUDA_TEXT_CONTEXT)
    : descriptor.context_length
  const context = settings.context_length || autoContext
  const vision = compact ? 'off' : settings.vision
  const extended = context > QWEN36_CUDA_TEXT_CONTEXT || (vision === 'auto' && descriptor.capabilities.vision)
  return {
    settings: { ...settings, context_length: context, vision },
    minimumVramBytes: extended ? QWEN36_CUDA_EXTENDED_VRAM : QWEN36_CUDA_TEXT_VRAM,
  }
}

export function strataRamModeBytes(d: StrataModelDescriptor): number {
  const readyPack = strataCudaProfile(d.variant_id)?.readyPack
  const weights = d.files
    .filter((file) =>
      readyPack ? ['ple', 'embedding', 'pack'].includes(file.role) : file.role === 'weights'
    )
    .reduce((sum, file) => sum + file.size, 0)
  return weights + 12 * GiB
}

/** Conservative planning estimates for the pinned recipes. Values are not hardware qualification. */
export function estimateStrata(d: StrataModelDescriptor, input: Inputs): StrataResourceEstimate {
  const weights = d.files.filter((f) => f.role === 'weights').reduce((total, file) => total + file.size, 0)
  const download_bytes = input.installed ? 0 : d.requirements.download_bytes
  let derivative_bytes = 0
  let temporary_bytes = 0
  if (!input.prepared) {
    switch (d.family) {
      case 'qwen38':
        // Dense tensors can widen to F32. Non-Metal also packs experts from every shard.
        derivative_bytes = 64 * 2 ** 20
        if (!strataCudaProfile(d.variant_id)?.readyPack)
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
  const qwen36Q4Ram =
    input.backend === 'cuda' && d.variant_id === 'ud-q4-k-xl-mtp' ? Math.ceil(18.75 + 12) : 32
  const qwen36Ram = d.variant_id === 'q8-0-mtp' ? 52 : d.variant_id === 'ud-q6-k-xl-mtp' ? 44 : qwen36Q4Ram
  const readyPack = strataCudaProfile(d.variant_id)?.readyPack
  const ram =
    readyPack && input.memoryMode === 'ram'
      ? strataRamModeBytes(d)
      : (readyPack ? 32 : d.family === 'qwen36' ? qwen36Ram : d.family === 'deepseek41' ? 16 : 10) * GiB
  // The tested 8 GB CUDA card reports 8188 MiB to NVML. Keep a floor for that card class.
  const qwen36Vram = input.backend === 'cuda' ? QWEN36_CUDA_TEXT_VRAM : 8 * GiB
  // One card must hold the DeepSeek Q8 dense weights; the 2-bit variants use a smaller dense set.
  const vram =
    d.variant_id === 'unsloth-ud-q8-k-xl'
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
