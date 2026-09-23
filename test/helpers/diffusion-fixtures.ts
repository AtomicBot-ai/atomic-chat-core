/**
 * Sample values for the diffusion tests: the recipe and server spec the plugin's Rust tests used
 * (`gallery.rs`, `jobs.rs` at app commit `767ff6350`), and a painted PNG of any size.
 */
import type {
  ImageGenerateRequest,
  ImageRecipe,
  VideoGenerateRequest,
  VideoRecipe,
} from '../../src/contracts/index.js'
import { encodePng } from '../../src/diffusion/png.js'
import type { ServerHandle, ServerSpec } from '../../src/diffusion/index.js'
import type { ExitInfo } from '../../src/runtime/llamacpp/index.js'

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

/** An LTX-2.3 distilled spec: 24 fps, frames 8k+1, the fixed eight-step sigma schedule. */
export function sampleVideoSpec(overrides: Partial<ServerSpec> = {}): ServerSpec {
  return sampleSpec({
    modelId: 'ltx-2:q4_k_m',
    family: 'ltx-2',
    modality: 'video',
    displayName: 'LTX-2.3 Distilled',
    files: {
      diffusionModel: '/models/ltx-2/ltx-2.3-22b-distilled-Q4_K_M.gguf',
      vae: '/models/shared/ltx-2.3-22b-distilled_video_vae.safetensors',
      audioVae: '/models/shared/ltx-2.3-22b-distilled_audio_vae.safetensors',
      llm: '/models/shared/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf',
      embeddingsConnectors: '/models/shared/ltx-2.3-22b-distilled_embeddings_connectors.safetensors',
    },
    defaults: {
      steps: 8,
      cfgScale: 1.0,
      samplingMethod: 'euler',
      width: 768,
      height: 512,
      sigmas: [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875],
      video: {
        fps: 24,
        frames: 121,
        frameStep: 8,
        frameOffset: 1,
        resolutionPresets: [
          [768, 512],
          [1216, 704],
          [704, 1216],
          [512, 768],
        ],
      },
    },
    ranges: { steps: [1, 50], dims: [256, 1216], dimMultiple: 32, frames: [9, 257] },
    ...overrides,
  })
}

export function sampleVideoRequest(overrides: Partial<VideoGenerateRequest> = {}): VideoGenerateRequest {
  return {
    prompt: 'a cat walking through a rainy alley',
    width: 768,
    height: 512,
    frames: 25,
    steps: 8,
    cfgScale: 1.0,
    seed: 1234,
    ...overrides,
  }
}

export function sampleVideoRecipe(overrides: Partial<VideoRecipe> = {}): VideoRecipe {
  return {
    jobId: jobId(9),
    prompt: 'a cat walking through a rainy alley',
    negativePrompt: null,
    width: 768,
    height: 512,
    frames: 25,
    frameCount: 25,
    fps: 24,
    steps: 8,
    cfgScale: 1.0,
    guidance: null,
    seed: 1234,
    samplingMethod: 'euler',
    flowShift: null,
    workflow: 'create',
    outputFormat: 'webm',
    model: {
      modelId: 'ltx-2:q4_k_m',
      family: 'ltx-2',
      displayName: 'LTX-2.3 Distilled',
      filename: 'ltx-2.3-22b-distilled-Q4_K_M.gguf',
    },
    engine: {
      kind: 'sd-cpp',
      backend: 'metal',
      tag: 'master-883-137f740',
      offload: 'group',
      cpuFallback: false,
    },
    createdAtMs: 1_700_000_000_000,
    durationMs: 65_000,
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

/** A `ServerHandle` without a process: the test decides when it "exits" and what it "prints". */
export interface FakeServer {
  handle: ServerHandle
  /** Lines the job runner is listening for, as the real handle would deliver them. */
  say(...lines: string[]): void
  /** The process is gone with this status. */
  exit(info: ExitInfo): void
  terminated: number[]
}

export function fakeServer(
  options: { port?: number; pid?: number; cancelGenerating?: boolean } = {}
): FakeServer {
  const tail: string[] = []
  let listener: ((line: string) => void) | undefined
  let exitInfo: ExitInfo | undefined
  let resolveExit!: (info: ExitInfo) => void
  const exited = new Promise<ExitInfo>((resolve) => (resolveExit = resolve))
  const terminated: number[] = []
  const exit = (info: ExitInfo) => {
    if (exitInfo) return
    exitInfo = info
    resolveExit(info)
  }
  const handle: ServerHandle = {
    pid: options.pid ?? 4242,
    port: options.port ?? 1,
    exe: '/engine/sd-server',
    capabilities: { cancelGenerating: options.cancelGenerating ?? false },
    tail: () => [...tail],
    setLineListener: (next) => (listener = next),
    exitStatus: () => exitInfo,
    exited,
    terminate: async (graceMs = 5_000) => {
      terminated.push(graceMs)
      exit({ code: null, signal: 'SIGTERM' })
      return exited
    },
  }
  return {
    handle,
    say: (...lines) => {
      for (const line of lines) {
        tail.push(line)
        listener?.(line)
      }
    },
    exit,
    terminated,
  }
}
