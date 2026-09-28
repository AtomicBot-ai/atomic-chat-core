import { describe, expect, it } from 'vitest'
import type { GpuInfo, SystemInfo } from '../contracts/index.js'
import { RESERVE_BYTES } from '../models/index.js'
import { VIDEO_VAE_TILING_PIXEL_FRAMES } from './args.js'
import {
  appleChip,
  BYTES_PER_PIXEL_FRAME,
  decodeTiled,
  discreteVramBytes,
  estimateVideoCost,
  estimateVideoMemory,
  familyProfile,
  heuristicParts,
  heuristicSeconds,
  latentTokens,
  machineSpeed,
  memoryPool,
  OUTPUT_BYTES_PER_PIXEL_FRAME,
  OVERHEAD_BYTES,
  passesPerStep,
  STEP_OVERHEAD_SECONDS,
  vaeDecodePeakBytes,
  verdictOf,
  VIDEO_FAMILY_PROFILES,
} from './video-estimate.js'
import type { VideoEstimateInput } from './video-estimate.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

function mac(gib: number, chip = 'Apple M3 Pro'): SystemInfo {
  return {
    cpu: { name: chip, core_count: 12, arch: 'aarch64', extensions: [], extensions_known: true },
    os_type: 'macos',
    os_name: 'macOS 15',
    total_memory: gib * 1024,
    gpus: [],
  }
}

function gpu(vramGib: number, deviceType = 'DiscreteGpu'): GpuInfo {
  return {
    name: 'GPU',
    total_memory: vramGib * 1024,
    vendor: 'NVIDIA',
    uuid: 'u',
    driver_version: '581.42',
    nvidia_info: { index: 0, compute_capability: '8.9' },
    vulkan_info: { index: 0, device_type: deviceType, api_version: '1.3.0', device_id: 1 },
  }
}

function pc(ramGib: number, gpus: GpuInfo[], cores = 16): SystemInfo {
  return {
    cpu: {
      name: 'AMD Ryzen 9',
      core_count: cores,
      arch: 'x86_64',
      extensions: ['avx2'],
      extensions_known: true,
    },
    os_type: 'linux',
    os_name: 'Ubuntu',
    total_memory: ramGib * 1024,
    gpus,
  }
}

/** LTX-2.3 Distilled Q4_K_M as the catalog ships it: about 26 GB of files. */
const LTX_Q4_FILES = {
  diffusionModel: 14_326_856_736,
  vae: 1_452_256_522,
  audioVae: 364_853_140,
  llm: 7_432_229_248,
  embeddingsConnectors: 2_312_144_712,
}

/** Wan 2.2 TI2V 5B Q4_K_M with its VAE and umT5. */
const WAN_Q4_FILES = { diffusionModel: 3_433_116_000, vae: 1_409_400_960, t5xxl: 3_655_145_312 }

function ltx(overrides: Partial<VideoEstimateInput> = {}): VideoEstimateInput {
  return {
    family: 'ltx-2',
    backend: 'metal',
    offload: 'group',
    cpuFallback: false,
    fileBytes: LTX_Q4_FILES,
    width: 768,
    height: 512,
    frames: 121,
    steps: 8,
    cfgScale: 1,
    tilingPixelFrames: VIDEO_VAE_TILING_PIXEL_FRAMES,
    system: mac(64, 'Apple M3 Max'),
    ...overrides,
  }
}

function wan(overrides: Partial<VideoEstimateInput> = {}): VideoEstimateInput {
  return ltx({
    family: 'wan2.2-ti2v-5b',
    fileBytes: WAN_Q4_FILES,
    width: 768,
    height: 512,
    frames: 49,
    steps: 15,
    cfgScale: 5,
    ...overrides,
  })
}

describe('the memory model', () => {
  it('counts latent tokens with each family’s compression', () => {
    // LTX-2: 32×32 pixels and 8 frames per token (121 frames → 16 latent frames).
    expect(latentTokens(familyProfile('ltx-2'), 768, 512, 121)).toBe(24 * 16 * 16)
    // Wan 2.2: 32×32 (VAE 16 with a 2×2 patch) and 4 frames (73 → 19).
    expect(latentTokens(familyProfile('wan2.2-ti2v-5b'), 1280, 704, 73)).toBe(40 * 22 * 19)
    // A size off the grid rounds up.
    expect(latentTokens(familyProfile('ltx-2'), 770, 500, 9)).toBe(25 * 16 * 2)
    expect(familyProfile('something-new')).toBe(familyProfile('another'))
    expect(familyProfile('ltx-2')).toBe(VIDEO_FAMILY_PROFILES['ltx-2'])
  })

  it('tiles the decode past the threshold or under model offload, and then pays for one tile and the clip', () => {
    const small = ltx({ width: 256, height: 256, frames: 9 })
    expect(decodeTiled(small)).toBe(false)
    expect(vaeDecodePeakBytes(small)).toBe(256 * 256 * 9 * BYTES_PER_PIXEL_FRAME)
    expect(decodeTiled({ ...small, offload: 'model' })).toBe(true)
    const big = wan({ width: 1280, height: 704, frames: 73 })
    expect(decodeTiled(big)).toBe(true)
    expect(vaeDecodePeakBytes(big)).toBe(
      512 * 512 * 73 * BYTES_PER_PIXEL_FRAME + 1280 * 704 * 73 * OUTPUT_BYTES_PER_PIXEL_FRAME
    )
    // A tile larger than the frame is the frame.
    expect(vaeDecodePeakBytes(ltx({ width: 1216, height: 704, frames: 121 }))).toBe(
      1024 * 704 * 121 * BYTES_PER_PIXEL_FRAME + 1216 * 704 * 121 * OUTPUT_BYTES_PER_PIXEL_FRAME
    )
  })

  it('judges LTX-2 on a 16 GB Mac as exceeding unified memory', () => {
    const memory = estimateVideoMemory(ltx({ system: mac(16) }))
    expect(memory).toMatchObject({ pool: 'unified', verdict: 'exceeds', budgetBytes: 16 * GIB * 0.85 })
    expect(memory?.requiredBytes).toBeGreaterThan(26e9)
    const cost = estimateVideoCost(ltx({ system: mac(16) }))
    expect(cost?.estimate.seconds).toBeNull()
    expect(cost?.estimate.basis).toBe('heuristic')
  })

  it('grows with the frame count and the size', () => {
    const at = (frames: number, width = 768) =>
      estimateVideoMemory(wan({ frames, width, offload: 'none' }))?.requiredBytes as number
    expect(at(25)).toBeLessThan(at(49))
    expect(at(49)).toBeLessThan(at(121))
    expect(at(49, 512)).toBeLessThan(at(49, 1024))
  })

  it('draws the verdict at 80 % and 100 % of the budget', () => {
    expect(verdictOf(80, 100)).toBe('fits')
    expect(verdictOf(80.01, 100)).toBe('tight')
    expect(verdictOf(100, 100)).toBe('tight')
    expect(verdictOf(100.01, 100)).toBe('exceeds')
    expect(verdictOf(1, 0)).toBe('exceeds')
  })

  it('picks the pool from the backend and the machine', () => {
    expect(memoryPool({ backend: 'metal', cpuFallback: false, system: mac(16) })).toBe('unified')
    expect(memoryPool({ backend: 'metal', cpuFallback: true, system: mac(16) })).toBe('system')
    expect(memoryPool({ backend: 'cpu', cpuFallback: false, system: pc(32, [gpu(24)]) })).toBe('system')
    expect(memoryPool({ backend: 'cuda', cpuFallback: false, system: pc(32, [gpu(24)]) })).toBe('vram')
    // An integrated GPU shares system RAM: no VRAM pool of its own.
    expect(
      memoryPool({ backend: 'vulkan', cpuFallback: false, system: pc(32, [gpu(2, 'IntegratedGpu')]) })
    ).toBe('system')
    expect(memoryPool({ backend: 'cuda', cpuFallback: false, system: pc(32, []) })).toBe('system')
    expect(discreteVramBytes(pc(32, [gpu(8), gpu(24), gpu(4, 'IntegratedGpu')]))).toBe(24 * GIB)
  })

  it('weighs system RAM without the reserve for the CPU backend', () => {
    const input = wan({ backend: 'cpu', system: pc(32, []) })
    const memory = estimateVideoMemory(input)
    const weights = WAN_Q4_FILES.diffusionModel + WAN_Q4_FILES.vae + WAN_Q4_FILES.t5xxl
    const sampling =
      latentTokens(familyProfile(input.family), 768, 512, 49) * familyProfile(input.family).bytesPerToken
    expect(memory).toEqual({
      requiredBytes: weights + Math.max(sampling, vaeDecodePeakBytes(input)) + OVERHEAD_BYTES,
      budgetBytes: 32 * GIB - RESERVE_BYTES,
      pool: 'system',
      verdict: 'fits',
    })
  })

  it('checks both sides of a discrete GPU and reports the one that decides', () => {
    // Everything on a 24 GB card: the device decides.
    const none = estimateVideoMemory(wan({ backend: 'cuda', offload: 'none', system: pc(64, [gpu(24)]) }))
    expect(none).toMatchObject({ pool: 'vram', budgetBytes: 24 * GIB - RESERVE_BYTES, verdict: 'fits' })
    // Offloaded to 16 GB of RAM: the weights live there and the host decides.
    const group = estimateVideoMemory(ltx({ backend: 'cuda', offload: 'group', system: pc(16, [gpu(24)]) }))
    expect(group).toMatchObject({ pool: 'system', verdict: 'exceeds' })
    // A small card: the running transformer and its activations do not fit on it.
    const small = estimateVideoMemory(ltx({ backend: 'cuda', offload: 'model', system: pc(128, [gpu(8)]) }))
    expect(small).toMatchObject({ pool: 'vram', verdict: 'exceeds' })
  })

  it('counts the running model twice on unified memory under offload', () => {
    // Whichever phase peaks, the model running in it is resident and copied to the device.
    for (const frames of [9, 49, 121]) {
      const none = estimateVideoMemory(wan({ frames, offload: 'none' }))?.requiredBytes as number
      const group = estimateVideoMemory(wan({ frames, offload: 'group' }))?.requiredBytes as number
      expect(group - none).toBeGreaterThanOrEqual(Math.min(WAN_Q4_FILES.diffusionModel, WAN_Q4_FILES.vae))
    }
  })

  it('has nothing to say when the machine’s memory is unknown', () => {
    expect(estimateVideoMemory(ltx({ system: mac(0) }))).toBeUndefined()
    expect(estimateVideoCost(ltx({ system: mac(0) }))).toBeUndefined()
  })
})

describe('the time model', () => {
  it('reads the Apple chip from the CPU name', () => {
    expect(appleChip('Apple M3 Max')).toBe('m3 max')
    expect(appleChip('Apple M1')).toBe('m1')
    expect(appleChip('apple m4 pro')).toBe('m4 pro')
    expect(appleChip('Intel(R) Core(TM) i9')).toBeUndefined()
  })

  it('rates the machine by class, and unknown hardware at the bottom of its class', () => {
    expect(machineSpeed({ backend: 'metal', cpuFallback: false, system: mac(36, 'Apple M3 Max') })).toEqual({
      speed: 0.75,
      known: true,
    })
    expect(machineSpeed({ backend: 'metal', cpuFallback: false, system: mac(36, 'Apple M9 Hyper') })).toEqual(
      {
        speed: 0.18,
        known: false,
      }
    )
    expect(machineSpeed({ backend: 'cuda', cpuFallback: false, system: pc(64, [gpu(24)]) })).toEqual({
      speed: 4,
      known: true,
    })
    expect(
      machineSpeed({ backend: 'vulkan', cpuFallback: false, system: pc(64, [gpu(24)]) }).speed
    ).toBeCloseTo(2.4, 9)
    expect(machineSpeed({ backend: 'cuda', cpuFallback: false, system: pc(64, []) })).toEqual({
      speed: 0.6,
      known: false,
    })
    expect(machineSpeed({ backend: 'cpu', cpuFallback: false, system: pc(64, [], 16) }).speed).toBeCloseTo(
      0.096,
      9
    )
    expect(machineSpeed({ backend: 'metal', cpuFallback: true, system: pc(64, [], 0) })).toEqual({
      speed: 0.024,
      known: false,
    })
  })

  it('runs the model twice a step under classifier-free guidance', () => {
    expect([passesPerStep(1), passesPerStep(0), passesPerStep(5)]).toEqual([1, 1, 2])
    const single = heuristicParts(wan({ cfgScale: 1 })).stepSeconds - STEP_OVERHEAD_SECONDS
    expect(heuristicParts(wan({ cfgScale: 5 })).stepSeconds - STEP_OVERHEAD_SECONDS).toBeCloseTo(
      single * 2,
      9
    )
    // However small the request, a step costs its fixed overhead.
    expect(heuristicParts(wan({ width: 32, height: 32, frames: 5 })).stepSeconds).toBeGreaterThan(
      STEP_OVERHEAD_SECONDS
    )
  })

  it('grows with frames and with steps', () => {
    expect(heuristicSeconds(wan({ frames: 25 }))).toBeLessThan(heuristicSeconds(wan({ frames: 49 })))
    expect(heuristicSeconds(wan({ steps: 10 }))).toBeLessThan(heuristicSeconds(wan({ steps: 20 })))
    const seconds = (frames: number) => estimateVideoCost(wan({ frames }))?.estimate.seconds
    expect(seconds(25)?.high).toBeLessThanOrEqual(seconds(49)?.high as number)
  })

  it('gives a range of whole seconds, ×2 either way on known hardware and ×3 on unknown', () => {
    const known = estimateVideoCost(wan())
    const seconds = known?.estimate.seconds
    expect(seconds).not.toBeNull()
    expect(seconds?.low).toBeGreaterThan(0)
    expect(seconds?.low).toBeLessThanOrEqual(seconds?.high as number)
    expect(Number.isInteger(seconds?.low) && Number.isInteger(seconds?.high)).toBe(true)
    const mid = known?.forecast.totalSeconds as number
    expect(seconds?.low).toBe(Math.round(mid / 2))
    expect(seconds?.high).toBe(Math.round(mid * 2))
    expect(known?.forecast.stepSecondsHigh).toBeCloseTo((known?.forecast.stepSeconds as number) * 2, 9)

    const unknown = estimateVideoCost(wan({ system: mac(64, 'Apple M9') }))
    const umid = unknown?.forecast.totalSeconds as number
    expect(unknown?.estimate.seconds).toEqual({ low: Math.round(umid / 3), high: Math.round(umid * 3) })
    // An unknown family widens the range as unknown hardware does.
    const family = estimateVideoCost(wan({ family: 'hunyuan-video' }))
    const fmid = family?.forecast.totalSeconds as number
    expect(family?.estimate.seconds?.high).toBe(Math.round(fmid * 3))
  })

  it('splits the middle into the parts the live ETA uses', () => {
    const cost = estimateVideoCost(wan({ steps: 15 }))
    const f = cost?.forecast
    expect(f?.totalSeconds).toBeCloseTo(
      (f?.encodeSeconds as number) + 15 * (f?.stepSeconds as number) + (f?.decodeSeconds as number),
      9
    )
    expect(f?.totalSeconds).toBeCloseTo(heuristicSeconds(wan({ steps: 15 })), 9)
  })

  it('moves the middle by the history multiplier and narrows the range', () => {
    const plain = estimateVideoCost(wan()) as NonNullable<ReturnType<typeof estimateVideoCost>>
    const history = estimateVideoCost(wan(), 2) as NonNullable<ReturnType<typeof estimateVideoCost>>
    expect(history.estimate.basis).toBe('history')
    expect(history.forecast.totalSeconds).toBeCloseTo(plain.forecast.totalSeconds * 2, 9)
    expect(history.estimate.seconds).toEqual({
      low: Math.round(history.forecast.totalSeconds * 0.8),
      high: Math.round(history.forecast.totalSeconds * 1.25),
    })
    expect(history.forecast.stepSecondsHigh).toBeCloseTo(history.forecast.stepSeconds * 1.25, 9)
  })

  it('never answers zero seconds', () => {
    const tiny = estimateVideoCost(
      wan({
        width: 32,
        height: 32,
        frames: 5,
        steps: 1,
        cfgScale: 1,
        backend: 'cuda',
        system: pc(64, [gpu(32)]),
      })
    )
    expect(tiny?.estimate.seconds?.low).toBeGreaterThanOrEqual(1)
  })
})
