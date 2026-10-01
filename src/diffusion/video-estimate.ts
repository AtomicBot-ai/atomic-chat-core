/**
 * What a video request will cost on this machine before it runs: the memory it needs against the
 * budget of the pool it competes for, and a range of seconds. Pure: the loaded model's file sizes,
 * the request and the hardware facts come in; the estimate and the forecast the live ETA works from
 * (`video-eta.ts`) go out. The model and its first coefficients are in ADR
 * 2026-09-28-estimate-video-generation-before-and-during-the-job; the coefficients are guesses until
 * the live measurement replaces them.
 */

import type {
  DiffusionBackend,
  DiffusionOffloadPolicy,
  SystemInfo,
  VideoEstimate,
  VideoEstimateBasis,
  VideoMemoryPool,
  VideoMemoryVerdict,
} from '../contracts/index.js'
import { RESERVE_BYTES } from '../models/index.js'
import type { ModelFileBytes } from './types.js'
import { ENGINE_TILE_LATENT, engineDefaultLayout, tilesAlong, tilingLayout } from './video-tiling.js'
import type { DecodeLayout, VideoDecodeTiling } from './video-tiling.js'

export type { VideoDecodeTiling } from './video-tiling.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** Everything one family contributes to the estimate. Seconds are on the reference machine (speed 1). */
export interface VideoFamilyProfile {
  /** Pixels across, pixels down and frames per latent token: the VAE's compression with the patchify. */
  compression: { x: number; y: number; t: number }
  /** Activation bytes per latent token while sampling (flash attention on, as `speedFlags` sets it). */
  bytesPerToken: number
  /** Seconds per latent token per model pass: the MLPs and projections. */
  linearSeconds: number
  /** Seconds per latent token squared per model pass: self-attention. */
  attentionSeconds: number
  /** Seconds per decoded pixel-frame. */
  decodeSeconds: number
  /** Seconds for the text encoders and the job's fixed costs. */
  encodeSeconds: number
  /** Image pixels per latent pixel on a side in the VAE alone, without the transformer's patch. */
  vaeScale: number
}

/**
 * The families the catalog ships. LTX-2.3 22B: 4096-wide, 48 layers, VAE 32×32×8. Wan 2.2 TI2V 5B:
 * 3072-wide, 30 layers, VAE 16×16×4 with a 2×2 patch. Seconds follow from the FLOPs of one pass at
 * about 5 effective TFLOPS, what sd.cpp is taken to reach on the reference M3 Max.
 */
export const VIDEO_FAMILY_PROFILES: Readonly<Record<string, VideoFamilyProfile>> = {
  'ltx-2': {
    compression: { x: 32, y: 32, t: 8 },
    bytesPerToken: 128 * 1024,
    linearSeconds: 4.5e-3,
    attentionSeconds: 1.6e-7,
    decodeSeconds: 0.8e-6,
    encodeSeconds: 15,
    vaeScale: 32,
  },
  'wan2.2-ti2v-5b': {
    compression: { x: 32, y: 32, t: 4 },
    bytesPerToken: 100 * 1024,
    linearSeconds: 1.5e-3,
    attentionSeconds: 7.4e-8,
    decodeSeconds: 1.6e-6,
    encodeSeconds: 5,
    vaeScale: 16,
  },
}

/** A family the table does not know: the heavier numbers of the two, and the wider range. */
export const DEFAULT_VIDEO_FAMILY_PROFILE: VideoFamilyProfile = {
  compression: { x: 16, y: 16, t: 4 },
  bytesPerToken: 128 * 1024,
  linearSeconds: 4.5e-3,
  attentionSeconds: 1.6e-7,
  decodeSeconds: 1.6e-6,
  encodeSeconds: 15,
  vaeScale: 16,
}

/**
 * Bytes a single-graph VAE decode asks for per pixel-frame: the Wan 2.2 VAE wanted 27.6 GB from
 * Metal at 1280×704 × 121 frames (2026-09-23, see `VIDEO_VAE_TILING_PIXEL_FRAMES` in `args.ts`).
 */
export const BYTES_PER_PIXEL_FRAME = 250

/** The decoded clip itself, RGB in f32, which a tiled decode still holds whole. */
export const OUTPUT_BYTES_PER_PIXEL_FRAME = 12

/** The runtime, the graph allocator's slack and the text encoders' activations. */
export const OVERHEAD_BYTES = GIB

/** The share of unified memory Metal lets a process wire; the app's `MACOS_LOAD_CEILING`. */
export const UNIFIED_BUDGET_SHARE = 0.85

/** `fits` up to this share of the budget, `tight` up to all of it, `exceeds` past it. */
export const FITS_SHARE = 0.8

/** How far the heuristic range reaches either side of its middle: known hardware, unknown hardware or family. */
export const HEURISTIC_SPREAD = 2
export const UNKNOWN_SPREAD = 3
/** The range once this machine's own clips calibrated the middle. */
export const HISTORY_BAND: readonly [number, number] = [0.8, 1.25]

/** What the estimate reads about the loaded model and the request. */
export interface VideoEstimateInput {
  family: string
  backend: DiffusionBackend
  offload: DiffusionOffloadPolicy
  /** The session runs on the CPU backend after a ggml abort. */
  cpuFallback: boolean
  fileBytes: ModelFileBytes
  width: number
  height: number
  frames: number
  steps: number
  cfgScale: number
  /** The pixel-frames past which `args.ts` tiles the decode when the plan chose no tiling. */
  tilingPixelFrames: number
  /** The tiling the plan chose for the decode; absent: the threshold and sd.cpp's own tiles. */
  decodeTiling?: VideoDecodeTiling
  system: SystemInfo
}

/**
 * The parts of the time the live ETA works from, in seconds, already scaled by the history
 * multiplier when there is one. Kept with the job, never sent.
 */
export interface VideoForecast {
  encodeSeconds: number
  /** One sampling step (all its model passes), the middle of the range. */
  stepSeconds: number
  /** The top of the range for one step. */
  stepSecondsHigh: number
  decodeSeconds: number
  /** `encodeSeconds + steps × stepSeconds + decodeSeconds`: the middle of the job. */
  totalSeconds: number
}

export interface VideoCost {
  estimate: VideoEstimate
  forecast: VideoForecast
}

export const familyProfile = (family: string): VideoFamilyProfile =>
  VIDEO_FAMILY_PROFILES[family] ?? DEFAULT_VIDEO_FAMILY_PROFILE

/** Latent tokens the transformer attends over: `⌈W/sx⌉ · ⌈H/sy⌉ · (1 + (frames − 1)/st)`. */
export function latentTokens(
  profile: VideoFamilyProfile,
  width: number,
  height: number,
  frames: number
): number {
  const { x, y, t } = profile.compression
  const latentFrames = 1 + Math.ceil(Math.max(frames - 1, 0) / t)
  return Math.ceil(width / x) * Math.ceil(height / y) * latentFrames
}

/** Latent pixels across and down the decode's input: the frame over the VAE's own scale. */
export function decodeLatent(
  input: Pick<VideoEstimateInput, 'width' | 'height'>,
  profile: VideoFamilyProfile
): { width: number; height: number } {
  return {
    width: Math.max(Math.ceil(input.width / profile.vaeScale), 1),
    height: Math.max(Math.ceil(input.height / profile.vaeScale), 1),
  }
}

/**
 * Whether the decode of this request is tiled: as the plan chose; without one, past the pixel-frame
 * threshold, or always under `model` offload.
 */
export function decodeTiled(
  input: Pick<
    VideoEstimateInput,
    'width' | 'height' | 'frames' | 'offload' | 'tilingPixelFrames' | 'decodeTiling'
  >
): boolean {
  if (input.decodeTiling) return input.decodeTiling.tilesX > 1 || input.decodeTiling.tilesY > 1
  return input.offload === 'model' || input.width * input.height * input.frames > input.tilingPixelFrames
}

/**
 * The tiles the engine runs for this request: the plan's tiling, or sd.cpp's own 32-pixel tiles when
 * the threshold switches tiling on without one.
 */
export function decodeLayout(input: VideoEstimateInput, profile = familyProfile(input.family)): DecodeLayout {
  const latent = decodeLatent(input, profile)
  if (input.decodeTiling) return tilingLayout(latent.width, latent.height, input.decodeTiling)
  if (!decodeTiled(input))
    return { tiled: false, tilesX: 1, tilesY: 1, tileWidth: latent.width, tileHeight: latent.height, work: 1 }
  return engineDefaultLayout(latent.width, latent.height)
}

/**
 * The VAE decode's peak: the whole clip in one graph; or, tiled, one tile's graph across every frame
 * plus the decoded clip it is assembled into.
 */
export function vaeDecodePeakBytes(input: VideoEstimateInput, profile = familyProfile(input.family)): number {
  const pixelFrames = input.width * input.height * input.frames
  const layout = decodeLayout(input, profile)
  if (!layout.tiled) return pixelFrames * BYTES_PER_PIXEL_FRAME
  const tileWidth = Math.min(input.width, layout.tileWidth * profile.vaeScale)
  const tileHeight = Math.min(input.height, layout.tileHeight * profile.vaeScale)
  return (
    tileWidth * tileHeight * input.frames * BYTES_PER_PIXEL_FRAME + pixelFrames * OUTPUT_BYTES_PER_PIXEL_FRAME
  )
}

const sum = (values: Array<number | undefined>): number => values.reduce<number>((a, b) => a + (b ?? 0), 0)

/** The largest discrete GPU's memory in bytes; integrated GPUs share system RAM and do not count. */
export function discreteVramBytes(system: SystemInfo): number {
  let best = 0
  for (const gpu of system.gpus) {
    if (gpu.vulkan_info?.device_type === 'IntegratedGpu') continue
    best = Math.max(best, gpu.total_memory)
  }
  return best * MIB
}

/** Which pool a session competes for: Metal's unified memory, a discrete GPU's, or system RAM. */
export function memoryPool(
  input: Pick<VideoEstimateInput, 'backend' | 'cpuFallback' | 'system'>
): VideoMemoryPool {
  if (input.cpuFallback || input.backend === 'cpu') return 'system'
  if (input.backend === 'metal') return input.system.os_type === 'macos' ? 'unified' : 'system'
  return discreteVramBytes(input.system) > 0 ? 'vram' : 'system'
}

export function verdictOf(required: number, budget: number): VideoMemoryVerdict {
  if (required <= budget * FITS_SHARE) return 'fits'
  return required <= budget ? 'tight' : 'exceeds'
}

const clampNonNegative = (value: number): number => Math.max(value, 0)

/**
 * The memory verdict. The weights stay resident (sd-server keeps every file loaded); on top of them
 * the peak of the phase that needs most. Under `group` and `model` offload the parameters live in
 * RAM and each model is copied to the device while it runs, so on unified memory the running
 * model counts twice, and a discrete GPU holds only the running model and its activations; `model`
 * also decodes on the CPU. Undefined when the machine's memory is unknown.
 */
export function estimateVideoMemory(input: VideoEstimateInput): VideoEstimate['memory'] | undefined {
  const profile = familyProfile(input.family)
  const totalBytes = input.system.total_memory * MIB
  if (totalBytes <= 0) return undefined
  const files = input.fileBytes
  const weights = sum(Object.values(files))
  const transformer = files.diffusionModel ?? 0
  const vae = files.vae ?? 0
  const sampling = latentTokens(profile, input.width, input.height, input.frames) * profile.bytesPerToken
  const decode = vaeDecodePeakBytes(input, profile)
  const pool = memoryPool(input)
  const systemBudget = clampNonNegative(totalBytes - RESERVE_BYTES)

  if (pool === 'system') {
    const required = weights + Math.max(sampling, decode) + OVERHEAD_BYTES
    return {
      requiredBytes: required,
      budgetBytes: systemBudget,
      pool,
      verdict: verdictOf(required, systemBudget),
    }
  }

  // What the device holds at the peak of each phase, and what stays in host RAM besides.
  let devicePeak: number
  let hostRequired: number
  if (input.offload === 'none') {
    devicePeak = weights + Math.max(sampling, decode)
    hostRequired = 0
  } else if (input.offload === 'group') {
    devicePeak = Math.max(transformer + sampling, vae + decode)
    hostRequired = weights
  } else {
    devicePeak = transformer + sampling
    hostRequired = weights + decode
  }

  if (pool === 'unified') {
    const budget = totalBytes * UNIFIED_BUDGET_SHARE
    const required = hostRequired + devicePeak + OVERHEAD_BYTES
    return { requiredBytes: required, budgetBytes: budget, pool, verdict: verdictOf(required, budget) }
  }

  const vramBudget = clampNonNegative(discreteVramBytes(input.system) - RESERVE_BYTES)
  const device = {
    requiredBytes: devicePeak + OVERHEAD_BYTES,
    budgetBytes: vramBudget,
    pool: 'vram' as const,
  }
  const host = { requiredBytes: hostRequired, budgetBytes: systemBudget, pool: 'system' as const }
  const share = (side: { requiredBytes: number; budgetBytes: number }): number =>
    side.budgetBytes > 0 ? side.requiredBytes / side.budgetBytes : Number.POSITIVE_INFINITY
  const worse = hostRequired > 0 && share(host) > share(device) ? host : device
  return { ...worse, verdict: verdictOf(worse.requiredBytes, worse.budgetBytes) }
}

interface TilingOption {
  tiling: VideoDecodeTiling
  peak: number
  work: number
  tiles: number
}

/** Less recomputed overlap first, then fewer graphs, then the smaller peak. */
const cheaper = (a: TilingOption, b: TilingOption): boolean =>
  a.work !== b.work ? a.work < b.work : a.tiles !== b.tiles ? a.tiles < b.tiles : a.peak < b.peak

/**
 * How to tile the clip's VAE decode on this machine. One graph over the frame when the whole job
 * then fits (the estimate's `fits`, at most 80 % of the budget), since every tile recomputes its
 * overlap; otherwise the tiling with the least work among those that fit, from one tile per axis
 * down to as many as sd.cpp's own 32-pixel tiles make; and when none fits, the one with the smallest
 * peak. Undefined, so the pixel-frame threshold and sd.cpp's own tiles decide as before, under
 * `model` offload (the engine decodes on the CPU, tiled by its own flag), on the CPU fallback, and
 * when the machine's memory is unknown.
 */
export function planDecodeTiling(input: VideoEstimateInput): VideoDecodeTiling | undefined {
  if (input.offload === 'model' || input.cpuFallback) return undefined
  const profile = familyProfile(input.family)
  const latent = decodeLatent(input, profile)
  const mostX = tilesAlong(latent.width, Math.min(ENGINE_TILE_LATENT, latent.width))
  const mostY = tilesAlong(latent.height, Math.min(ENGINE_TILE_LATENT, latent.height))
  let fitting: TilingOption | undefined
  let smallest: TilingOption | undefined
  for (let tilesX = 1; tilesX <= mostX; tilesX++) {
    for (let tilesY = 1; tilesY <= mostY; tilesY++) {
      const candidate: VideoEstimateInput = { ...input, decodeTiling: { tilesX, tilesY } }
      const memory = estimateVideoMemory(candidate)
      if (!memory) return undefined
      const layout = decodeLayout(candidate, profile)
      const option: TilingOption = {
        tiling: { tilesX, tilesY },
        peak: vaeDecodePeakBytes(candidate, profile),
        work: layout.work,
        tiles: layout.tilesX * layout.tilesY,
      }
      if (memory.verdict === 'fits' && (!fitting || cheaper(option, fitting))) fitting = option
      if (
        !smallest ||
        option.peak < smallest.peak ||
        (option.peak === smallest.peak && cheaper(option, smallest))
      )
        smallest = option
    }
  }
  return (fitting ?? smallest)?.tiling
}

/** How fast a machine generates against the reference (Apple M3 Max), and whether the table knew it. */
export interface MachineSpeed {
  speed: number
  known: boolean
}

/**
 * Apple Silicon by chip, the lower GPU bin of each (a 30-core M3 Max, not the 40-core), as the
 * ratio of GPU FP32 throughput to the 40-core M3 Max. M5 figures are extrapolated from Apple's own
 * claims, not measured.
 */
export const APPLE_SILICON_SPEED: Readonly<Record<string, number>> = {
  'm1': 0.18,
  'm1 pro': 0.32,
  'm1 max': 0.55,
  'm1 ultra': 1.1,
  'm2': 0.25,
  'm2 pro': 0.4,
  'm2 max': 0.75,
  'm2 ultra': 1.5,
  'm3': 0.29,
  'm3 pro': 0.4,
  'm3 max': 0.75,
  'm3 ultra': 1.5,
  'm4': 0.24,
  'm4 pro': 0.52,
  'm4 max': 1.03,
  'm5': 0.45,
  'm5 pro': 1.0,
  'm5 max': 2.0,
}
/** An Apple chip the table does not name: the slowest row. */
export const APPLE_SILICON_FLOOR = 0.18

/** Discrete GPUs by the class of their memory (GiB, at least), CUDA; the smallest class is the floor. */
export const DISCRETE_GPU_SPEED: ReadonlyArray<readonly [number, number]> = [
  [30, 7],
  [22, 4],
  [14, 3],
  [10, 2],
  [7, 1.2],
  [0, 0.6],
]
/** sd.cpp's kernels off CUDA: slower on the same silicon. */
export const BACKEND_SPEED_FACTOR: Readonly<Partial<Record<DiffusionBackend, number>>> = {
  cuda: 1,
  rocm: 0.7,
  vulkan: 0.6,
}
/** The CPU backend, per physical core. */
export const CPU_CORE_SPEED = 0.006
/** A CPU whose core count the probe did not read is taken to have this many. */
export const CPU_FLOOR_CORES = 4

/** `Apple M3 Max` → `m3 max`; anything else → undefined. */
export function appleChip(cpuName: string): string | undefined {
  const match = /\bapple\s+(m\d+)(?:\s+(pro|max|ultra))?\b/i.exec(cpuName)
  if (!match) return undefined
  const [, chip, tier] = match
  return `${(chip as string).toLowerCase()}${tier ? ` ${tier.toLowerCase()}` : ''}`
}

/** The machine's speed for this backend. Unknown hardware gets the slowest row of its class. */
export function machineSpeed(
  input: Pick<VideoEstimateInput, 'backend' | 'cpuFallback' | 'system'>
): MachineSpeed {
  const { system } = input
  if (input.cpuFallback || input.backend === 'cpu') {
    const cores = system.cpu.core_count
    return cores > 0
      ? { speed: cores * CPU_CORE_SPEED, known: true }
      : { speed: CPU_FLOOR_CORES * CPU_CORE_SPEED, known: false }
  }
  if (input.backend === 'metal') {
    const chip = appleChip(system.cpu.name)
    const speed = chip === undefined ? undefined : APPLE_SILICON_SPEED[chip]
    return speed === undefined ? { speed: APPLE_SILICON_FLOOR, known: false } : { speed, known: true }
  }
  const factor = BACKEND_SPEED_FACTOR[input.backend] ?? 1
  const vram = discreteVramBytes(system)
  const floor = DISCRETE_GPU_SPEED[DISCRETE_GPU_SPEED.length - 1] as readonly [number, number]
  if (vram <= 0) return { speed: floor[1] * factor, known: false }
  const row = DISCRETE_GPU_SPEED.find(([gib]) => vram >= gib * GIB) ?? floor
  return { speed: row[1] * factor, known: true }
}

/**
 * What every step costs whatever its size: the graph rebuilt and allocated, the kernels launched.
 * Wall-clock seconds, not scaled by the machine: it keeps a tiny request's step from being forecast
 * at a few milliseconds.
 */
export const STEP_OVERHEAD_SECONDS = 0.3

/**
 * The VAE decode on the Metal device against the table's `decodeSeconds`. ggml's Metal backend has no
 * `IM2COL_3D`, so every 3-D convolution of a video VAE runs the direct `kernel_conv_3d`. The one decode
 * measured, a Wan 2.2 TI2V 5B clip at 704×1280 and 25 frames at 250 s per 32×32-latent tile, is about ten
 * times the table on an M3 Pro to M4 Pro class Mac (ADR 2026-09-30-keep-the-video-eta-past-its-forecast).
 */
export const METAL_DECODE_FACTOR = 10

/** Whether the decode runs on the Metal device: not on the CPU fallback, and not under `model` offload. */
const decodesOnMetal = (input: Pick<VideoEstimateInput, 'backend' | 'cpuFallback' | 'offload'>): boolean =>
  input.backend === 'metal' && !input.cpuFallback && input.offload !== 'model'

/** Model passes per step: classifier-free guidance runs the model twice. */
export const passesPerStep = (cfgScale: number): number => (cfgScale > 1 ? 2 : 1)

/** The heuristic middle of the job, split into the parts the live ETA uses. */
export function heuristicParts(input: VideoEstimateInput): {
  encodeSeconds: number
  stepSeconds: number
  decodeSeconds: number
  known: boolean
} {
  const profile = familyProfile(input.family)
  const { speed, known } = machineSpeed(input)
  const tokens = latentTokens(profile, input.width, input.height, input.frames)
  const pass = profile.linearSeconds * tokens + profile.attentionSeconds * tokens * tokens
  const pixelFrames = input.width * input.height * input.frames
  const decode =
    ((profile.decodeSeconds * pixelFrames * decodeLayout(input, profile).work) / speed) *
    (decodesOnMetal(input) ? METAL_DECODE_FACTOR : 1)
  return {
    encodeSeconds: profile.encodeSeconds / speed,
    stepSeconds: (pass * passesPerStep(input.cfgScale)) / speed + STEP_OVERHEAD_SECONDS,
    decodeSeconds: decode,
    known: known && VIDEO_FAMILY_PROFILES[input.family] !== undefined,
  }
}

/** The heuristic middle of the whole job in seconds; what the history multiplier is measured against. */
export function heuristicSeconds(input: VideoEstimateInput): number {
  const parts = heuristicParts(input)
  return parts.encodeSeconds + Math.max(input.steps, 1) * parts.stepSeconds + parts.decodeSeconds
}

const wholeSeconds = (value: number): number => Math.max(Math.round(value), 1)

/**
 * The estimate and the forecast for `input`. With `multiplier` (this machine's clips ran that many
 * times the heuristic) the middle moves and the range narrows to `HISTORY_BAND`. Undefined when the
 * machine's memory is unknown, which leaves nothing to compare against.
 */
export function estimateVideoCost(input: VideoEstimateInput, multiplier?: number): VideoCost | undefined {
  const memory = estimateVideoMemory(input)
  if (!memory) return undefined
  const parts = heuristicParts(input)
  const k = multiplier ?? 1
  const basis: VideoEstimateBasis = multiplier === undefined ? 'heuristic' : 'history'
  const [below, above] =
    basis === 'history'
      ? HISTORY_BAND
      : parts.known
        ? [1 / HEURISTIC_SPREAD, HEURISTIC_SPREAD]
        : [1 / UNKNOWN_SPREAD, UNKNOWN_SPREAD]
  const encodeSeconds = parts.encodeSeconds * k
  const stepSeconds = parts.stepSeconds * k
  const decodeSeconds = parts.decodeSeconds * k
  const totalSeconds = encodeSeconds + Math.max(input.steps, 1) * stepSeconds + decodeSeconds
  const low = wholeSeconds(totalSeconds * below)
  const seconds =
    memory.verdict === 'exceeds' ? null : { low, high: Math.max(wholeSeconds(totalSeconds * above), low) }
  return {
    estimate: { memory, seconds, basis },
    forecast: {
      encodeSeconds,
      stepSeconds,
      stepSecondsHigh: stepSeconds * above,
      decodeSeconds,
      totalSeconds,
    },
  }
}
