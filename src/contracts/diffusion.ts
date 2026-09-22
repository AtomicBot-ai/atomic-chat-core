/**
 * Image generation on the wire. A field-for-field mirror of the app's
 * `web-app/src/services/diffusion/types.ts`, camelCase, including which optionals are absent and
 * which are `null` (ADR 2026-09-17-diffusion-speaks-the-apps-camelcase-and-error-codes-verbatim).
 * The same shapes are on disk: the recipe inside every PNG, `install.json`, `.flags.json`.
 *
 * Source of truth in the app: `src-tauri/plugins/tauri-plugin-atomic-diffusion/src/state.rs`.
 */

import type { DiffusionErrorCode } from './errors.js'

/** Which native engine serves generation. Only `sd-cpp` exists in this build. */
export type DiffusionEngineId = 'sd-cpp' | 'diffusers'

/** The compute backend the engine build was made for. */
export type DiffusionBackend = 'cpu' | 'metal' | 'cuda' | 'vulkan' | 'rocm'

/** Where the weights live while generating; `args.ts` turns it into sd.cpp offload flags. */
export type DiffusionOffloadPolicy = 'none' | 'group' | 'model'

export type DiffusionModality = 'image' | 'video'

export type DiffusionModelState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'failed'

/** What a request does with its images; every one of them is served by sd.cpp's single `img_gen`. */
export type ImageWorkflowId = 'create' | 'transform' | 'inpaint' | 'extend' | 'upscale' | 'reference' | 'edit'

export type ImageJobState = 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled'

/** `postprocessing` is in the app's union; nothing emits it yet. */
export type ImageJobPhase = 'queued' | 'encoding' | 'sampling' | 'decoding' | 'postprocessing' | 'saving'

/** Absolute paths of one checkpoint's files. Only `diffusionModel` is required. */
export interface DiffusionModelFiles {
  diffusionModel: string
  vae?: string
  /** `flux2` for the FLUX.2 VAE; absent otherwise. */
  vaeFormat?: string
  clipL?: string
  t5xxl?: string
  llm?: string
  /** A VLM vision projector (Qwen Image 2.1's Qwen3-VL), passed to sd.cpp as `--llm_vision`. */
  llmVision?: string
  qwen2vl?: string
}

/** Per-family defaults, handed over at load time so validation and the OpenAI facade need no catalog. */
export interface DiffusionFamilyDefaults {
  steps: number
  cfgScale: number
  guidance?: number
  samplingMethod?: string
  flowShift?: number
  width: number
  height: number
}

export interface DiffusionFamilyRanges {
  steps: [number, number]
  /** Inclusive min/max for both width and height. */
  dims: [number, number]
  dimMultiple: number
}

export interface LoadDiffusionModelRequest {
  /** `<family>:<quantId>`, e.g. `z-image:q4_k_m`. */
  modelId: string
  family: string
  modality: DiffusionModality
  displayName: string
  files: DiffusionModelFiles
  defaults: DiffusionFamilyDefaults
  ranges: DiffusionFamilyRanges
  offload: DiffusionOffloadPolicy
  engine?: DiffusionEngineId
  /** `--threads`, for CPU backends. */
  threads?: number
  /** Seconds to wait for the model to load. Default 600. */
  startupTimeoutSecs?: number
}

export type DiffusionEngineInstall =
  | { state: 'not-installed' }
  | {
      state: 'installed'
      engine: DiffusionEngineId
      backend: DiffusionBackend
      /** Upstream release tag, e.g. `master-849-d04e895`. */
      tag: string
      /** Manifest backend id, e.g. `macos-arm64`. */
      backendId: string
      /** Absolute directory holding `sd-server`. */
      dir: string
    }

export interface LoadedDiffusionModel {
  modelId: string
  family: string
  modality: DiffusionModality
  displayName: string
  engine: DiffusionEngineId
  backend: DiffusionBackend
  offload: DiffusionOffloadPolicy
  /** True once the ggml-abort recovery restarted the server on the CPU backend. */
  cpuFallback: boolean
  port: number
  pid: number
  loadedAtMs: number
}

/** A diffusion failure as job records and events carry it. `details` is always a string. */
export interface DiffusionErrorBody {
  code: DiffusionErrorCode
  message: string
  details?: string
}

export interface DiffusionStatus {
  /** False until `PUT /diffusion/config` has been accepted by this core generation. */
  configured: boolean
  install: DiffusionEngineInstall
  model: {
    state: DiffusionModelState
    loaded: LoadedDiffusionModel | null
    error?: DiffusionErrorBody
  }
  /** A queued or generating job, so a reload can adopt it. */
  activeJob: ImageJob | null
  outputDir: string
  /** Idle-unload timer in seconds; 0 = never. */
  idleUnloadSecs: number
}

/** What the loaded model can do; the app gates its form on this. */
export interface ImageCapabilities {
  workflows: ImageWorkflowId[]
  minDim: number
  maxDim: number
  dimMultiple: number
  supportsNegativePrompt: boolean
  supportsGuidance: boolean
  /** Whether a running generation can be cancelled without stopping the server. */
  cancelGenerating: boolean
  maxBatch: number
  defaults: DiffusionFamilyDefaults
  ranges: DiffusionFamilyRanges
}

/** One image input: a file to read, or PNG bytes the app produced itself (a data-URL prefix is accepted). */
export type ImageSource = { path: string } | { base64: string }

export interface ImageGenerateRequest {
  prompt: string
  negativePrompt?: string
  width: number
  height: number
  steps: number
  cfgScale: number
  guidance?: number
  /** Absent or negative: the core draws one; the recipe records the seed used. */
  seed?: number
  /** Images per job (`batch_count`), 1..maxBatch. */
  batchSize: number
  samplingMethod?: string
  flowShift?: number
  workflow?: ImageWorkflowId
  /** The source image of every workflow but `create`. */
  initImage?: ImageSource
  /** `inpaint` / `extend`: white where the model repaints. */
  maskImage?: ImageSource
  /** `reference`: extra references after the source. */
  referenceImages?: ImageSource[]
  /** Denoise strength 0..1 for the init-image workflows. */
  strength?: number
}

export interface ImageJobProgress {
  phase: ImageJobPhase
  step: number
  totalSteps: number
  /** 0..1 estimate for the whole job. */
  fraction: number
  etaSeconds: number | null
  /** Which image of the batch is being sampled, 0-based. */
  batchIndex: number
  batchSize: number
  elapsedMs: number
}

export interface ImageJob {
  id: string
  state: ImageJobState
  modelId: string
  /** The request with inline image bytes blanked; file paths stay. */
  request: ImageGenerateRequest
  createdAtMs: number
  startedAtMs?: number
  finishedAtMs?: number
  progress: ImageJobProgress | null
  outputs: GalleryImageItem[]
  error?: DiffusionErrorBody
}

/** Embedded verbatim in the PNG (`tEXt` keyword `atomic`). Enough to reproduce the image. */
export interface ImageRecipe {
  jobId: string
  /** 0-based index inside the batch. */
  index: number
  prompt: string
  negativePrompt: string | null
  width: number
  height: number
  steps: number
  cfgScale: number
  guidance: number | null
  /** The seed this image was sampled with (`batchSeed + index`). */
  seed: number
  /** The seed the batch was requested with. */
  batchSeed: number
  batchSize: number
  samplingMethod: string | null
  flowShift: number | null
  workflow: ImageWorkflowId
  strength: number | null
  model: {
    modelId: string
    family: string
    displayName: string
    /** Basename of the transformer file. */
    filename: string
  }
  engine: {
    kind: DiffusionEngineId
    backend: DiffusionBackend
    tag: string
    offload: DiffusionOffloadPolicy
    cpuFallback: boolean
  }
  createdAtMs: number
  durationMs: number
}

export interface GalleryImageItem {
  /** `<jobId>-<index:02>`; also the file stem. */
  id: string
  path: string
  /** The 256 px thumbnail, or null when it could not be written. */
  thumbnailPath: string | null
  width: number
  height: number
  sizeBytes: number
  createdAtMs: number
  pinned: boolean
  archived: boolean
  recipe: ImageRecipe
}

export interface GalleryPage {
  items: GalleryImageItem[]
  hasMore: boolean
  total: number
}

export interface GalleryListOptions {
  offset: number
  limit: number
  /** Default false: archived items are hidden. */
  includeArchived?: boolean
}

export interface GalleryFlags {
  pinned?: boolean
  archived?: boolean
}

/** A file found under `<data>/diffusion/models`. */
export interface DiffusionModelFile {
  path: string
  /** Relative to the models root, `/`-separated. */
  relativePath: string
  bytes: number
}

export interface DiffusionBackendInstallRecord {
  tag: string
  backendId: string
  backend: DiffusionBackend
  engine: DiffusionEngineId
  sha256: string | null
  installedAtMs: number
  dir: string
}

export interface FinalizeBackendInstallArgs {
  dir: string
  tag: string
  backendId: string
  backend: DiffusionBackend
  engine: DiffusionEngineId
  sha256?: string
}

/** Sent by the app once per core generation, before anything else. */
export interface DiffusionConfig {
  /** Must be the core's own data folder. */
  dataFolder: string
  /** Override for the gallery folder; absent for `<data>/images`. */
  outputDir?: string
  /** 0 = never unload on idle. */
  idleUnloadSecs?: number
}

export interface DiffusionCancelResult {
  cancelled: boolean
  /** True when the server had to be stopped to interrupt the generation. */
  serverStopped: boolean
}

/** Payloads of the four `diffusion:*` events (`events.rs` in the plugin). */
export interface DiffusionStateEvent {
  status: DiffusionStatus
  reason?: string
}

export interface DiffusionProgressEvent {
  jobId: string
  progress: ImageJobProgress
}

export interface DiffusionJobEvent {
  job: ImageJob
}

export interface DiffusionErrorEvent {
  jobId?: string
  code: DiffusionErrorCode
  message: string
  details?: string
}
