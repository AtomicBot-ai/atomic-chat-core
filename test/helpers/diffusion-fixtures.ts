/**
 * Sample values for the diffusion tests: the recipe and server spec the plugin's Rust tests used
 * (`gallery.rs`, `jobs.rs` at app commit `767ff6350`), and a painted PNG of any size.
 */
import type { ImageGenerateRequest, ImageRecipe } from '../../src/contracts/index.js'
import { encodePng } from '../../src/diffusion/png.js'
import type { ServerSpec } from '../../src/diffusion/index.js'

/** `format!("{:032x}", n)`: a job id as the plugin's tests made them. */
export const jobId = (n: number): string => n.toString(16).padStart(32, '0')

export function sampleRecipe(overrides: Partial<ImageRecipe> = {}): ImageRecipe {
  return {
    jobId: jobId(7),
    index: 0,
    prompt: 'a cat, photo',
    negativePrompt: 'blurry',
    width: 64,
    height: 48,
    steps: 8,
    cfgScale: 1.0,
    guidance: 3.5,
    seed: 100,
    batchSeed: 100,
    batchSize: 2,
    samplingMethod: 'euler',
    flowShift: null,
    workflow: 'create',
    strength: null,
    model: {
      modelId: 'z-image:q4_k_m',
      family: 'z-image',
      displayName: 'Z-Image Turbo',
      filename: 'z-image-turbo-Q4_K_M.gguf',
    },
    engine: { kind: 'sd-cpp', backend: 'metal', tag: 'master-849', offload: 'none', cpuFallback: false },
    createdAtMs: 1_700_000_000_000,
    durationMs: 1234,
    ...overrides,
  }
}

export function sampleSpec(overrides: Partial<ServerSpec> = {}): ServerSpec {
  return {
    binaryDir: '/nonexistent',
    engine: 'sd-cpp',
    backend: 'cpu',
    backendId: 'test-cpu',
    tag: 'test-tag',
    modelId: 'z-image:q4_k_m',
    family: 'z-image',
    modality: 'image',
    displayName: 'Z-Image Turbo',
    files: { diffusionModel: '/models/z-image/z-image-turbo-Q4_K_M.gguf' },
    defaults: { steps: 4, cfgScale: 1.0, samplingMethod: 'euler', width: 512, height: 512 },
    ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
    offload: 'none',
    extraArgs: [],
    startupTimeoutMs: 5_000,
    cpuFallback: false,
    ...overrides,
  }
}

export function sampleRequest(overrides: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest {
  return {
    prompt: 'a cat',
    width: 512,
    height: 512,
    steps: 4,
    cfgScale: 1.0,
    seed: 1234,
    batchSize: 2,
    ...overrides,
  }
}

/** An RGB PNG whose pixels depend on their position, like the plugin's `png_bytes`. */
export function paintedPng(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set([x % 256, y % 256, 128], (y * width + x) * 3)
  return encodePng({ width, height, channels: 3, data })
}
