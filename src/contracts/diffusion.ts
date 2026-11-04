/**
 * Image generation on the wire. A field-for-field mirror of the app's
 * `web-app/src/services/diffusion/types.ts`, camelCase, including which optionals are absent and
 * which are `null` (ADR 2026-09-17-diffusion-speaks-the-apps-camelcase-and-error-codes-verbatim).
 * The same shapes are on disk: the recipe inside every PNG, `install.json`, `.flags.json`.
 *
 * Source of truth in the app: `src-tauri/plugins/tauri-plugin-atomic-diffusion/src/state.rs`.
 */

import type { DiffusionErrorCode } from './errors.js'
import type { MediaDialect, MediaTarget, RemoteImageOptions, RemoteVideoOptions } from './media.js'

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
  /** LTX-2: the audio VAE, passed to sd.cpp as `--audio-vae`. */
  audioVae?: string
  /** LTX-2.3: the text-embedding connectors, passed to sd.cpp as `--embeddings-connectors`. */
  embeddingsConnectors?: string
}

/** What a video family generates by default; present on every video load, absent on image loads. */
export interface DiffusionVideoDefaults {
  /** Frames per second the model was trained at; a request naming another rate is refused. */
  fps: number
  /** Default frame count; must itself satisfy `k * frameStep + frameOffset`. */
  frames: number
  /** Valid frame counts are `k * frameStep + frameOffset` (LTX-2: 8k+1, Wan: 4k+1). */
  frameStep: number
  frameOffset: number
  /** The sizes the family was trained for; the app's Resolution picker, never a hard limit. */
  resolutionPresets: [number, number][]
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
  /** A distilled model's fixed sigma schedule, sent as `custom_sigmas` when `steps` equals its length. */
  sigmas?: number[]
  video?: DiffusionVideoDefaults
}

export interface DiffusionFamilyRanges {
  steps: [number, number]
  /** Inclusive min/max for both width and height. */
  dims: [number, number]
  dimMultiple: number
  /** Video only: inclusive min/max frame count. */
  frames?: [number, number]
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
  /**
   * The policy to move to when the model runs out of memory under `offload`: the load, or the job,
   * that ran out is retried once with it, and the session keeps it until the next load. Ignored when
   * it equals `offload`.
   */
  offloadFallback?: DiffusionOffloadPolicy
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
  /** A queued or generating image job, so a reload can adopt it. */
  activeJob: ImageJob | null
  /** The video counterpart; at most one of the two is set. */
  activeVideoJob: VideoJob | null
  outputDir: string
  videoOutputDir: string
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
  /**
   * A cloud or self-hosted provider's model instead of the resident one. `width`, `height`, `steps`
   * and `cfgScale` are still sent; a model whose descriptor has no such control ignores them.
   */
  target?: MediaTarget
  /** What only a remote model takes; ignored without `target`. */
  remote?: RemoteImageOptions
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
  /**
   * `steps`, `cfgScale`, `seed` and `batchSeed`: a local recipe always has them. A provider's model
   * is sent only the knobs it takes, and its recipe leaves out the ones it was not sent (one written
   * before 0.18.9 holds 0, 0, -1 and -1 for them instead).
   */
  steps?: number
  cfgScale?: number
  guidance: number | null
  /** The seed this image was sampled with (`batchSeed + index`). */
  seed?: number
  /** The seed the batch was requested with. */
  batchSeed?: number
  batchSize: number
  samplingMethod: string | null
  flowShift: number | null
  workflow: ImageWorkflowId
  strength: number | null
  model: {
    modelId: string
    /** The provider id for a remote model. */
    family: string
    displayName: string
    /** Basename of the transformer file; empty for a remote model. */
    filename: string
  }
  engine: DiffusionRecipeEngine
  /** What a remote model was asked besides the fields above; absent for a local one. */
  remote?: RemoteImageOptions
  createdAtMs: number
  durationMs: number
}

/** The engine the core ran, as a recipe records it. */
export interface LocalRecipeEngine {
  kind: DiffusionEngineId
  backend: DiffusionBackend
  tag: string
  offload: DiffusionOffloadPolicy
  cpuFallback: boolean
}

/** A provider's model made it: who, through which adapter. */
export interface RemoteRecipeEngine {
  kind: 'remote'
  provider: string
  api: MediaDialect
}

export type DiffusionRecipeEngine = LocalRecipeEngine | RemoteRecipeEngine

export const isRemoteRecipeEngine = (engine: DiffusionRecipeEngine): engine is RemoteRecipeEngine =>
  engine.kind === 'remote'

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

/** Sent by the app once per core generation, before anything else. */
export interface DiffusionConfig {
  /** Must be the core's own data folder. */
  dataFolder: string
  /** Override for the gallery folder; absent for `<data>/images`. */
  outputDir?: string
  /** Override for the video folder; absent for `<data>/videos`. */
  videoOutputDir?: string
  /** 0 = never unload on idle. */
  idleUnloadSecs?: number
}

export interface DiffusionCancelResult {
  cancelled: boolean
  /** True when the server had to be stopped to interrupt the generation. */
  serverStopped: boolean
}

// ---------------------------------------------------------------------------------------------------
// Video generation. The same engine and session; its own request, job, recipe and gallery item, so the
// image types above keep the plugin's shape byte for byte. The app mirrors these in the same file.
// ---------------------------------------------------------------------------------------------------

/** `image-to-video` is reserved: parsed, recorded, and refused until the workflow lands. */
export type VideoWorkflowId = 'create' | 'image-to-video'

export type VideoJobState = ImageJobState
export type VideoJobPhase = ImageJobPhase

/** VP8 in WebM is what sd.cpp writes; providers answer with MP4. */
export type VideoOutputFormat = 'webm' | 'mp4'

/** What the loaded video model can do; the app gates its form on this. */
export interface VideoCapabilities {
  workflows: VideoWorkflowId[]
  minDim: number
  maxDim: number
  dimMultiple: number
  supportsNegativePrompt: boolean
  supportsGuidance: boolean
  /** Whether a running generation can be cancelled without stopping the server. */
  cancelGenerating: boolean
  fps: number
  frames: { min: number; max: number; step: number; offset: number; default: number }
  resolutionPresets: [number, number][]
  outputFormat: VideoOutputFormat
  /** From the engine's `output_formats_by_mode.vid_gen`; null when the build did not report formats. */
  webmSupported: boolean | null
  defaults: DiffusionFamilyDefaults
  ranges: DiffusionFamilyRanges
}

export interface VideoGenerateRequest {
  prompt: string
  negativePrompt?: string
  width: number
  height: number
  /** Absent: the family default. Must be `k * frameStep + frameOffset` within `ranges.frames`. */
  frames?: number
  /** Absent: the family rate. Any other value is refused. */
  fps?: number
  steps: number
  cfgScale: number
  guidance?: number
  /** Absent or negative: the core draws one; the recipe records the seed used. */
  seed?: number
  samplingMethod?: string
  flowShift?: number
  workflow?: VideoWorkflowId
  /** Reserved for `image-to-video`: the first frame. */
  initImage?: ImageSource
  /** Reserved for `image-to-video`: the last frame. */
  endImage?: ImageSource
  /** A cloud or self-hosted provider's model instead of the resident one. */
  target?: MediaTarget
  /** What only a remote model takes; ignored without `target`. */
  remote?: RemoteVideoOptions
}

/** Which memory a video generation competes for: Apple's unified memory, a discrete GPU's, or system RAM. */
export type VideoMemoryPool = 'unified' | 'vram' | 'system'

/** `fits`: at most 80 % of the budget; `tight`: at most 100 %; `exceeds`: past it, into swap. */
export type VideoMemoryVerdict = 'fits' | 'tight' | 'exceeds'

/** `heuristic`: the core's model of the family and the machine; `history`: calibrated by this machine's clips. */
export type VideoEstimateBasis = 'heuristic' | 'history'

/**
 * What a video request will cost on this machine with the loaded model, before it runs. Answered by
 * `POST /atomic/v1/diffusion/video/estimate` and carried by `VideoJob.estimate`.
 */
export interface VideoEstimate {
  memory: {
    requiredBytes: number
    budgetBytes: number
    /** The pool that decided the verdict. */
    pool: VideoMemoryPool
    verdict: VideoMemoryVerdict
  }
  /** Whole seconds, `0 < low <= high`; `null` when the verdict is `exceeds`: time in swap is unpredictable. */
  seconds: { low: number; high: number } | null
  basis: VideoEstimateBasis
}

/** How far a tiled VAE decode got: tiles finished out of the pass the engine announced. */
export interface VideoDecodeTiles {
  done: number
  total: number
}

/** One clip per job, so no batch fields. */
export interface VideoJobProgress {
  phase: VideoJobPhase
  step: number
  totalSteps: number
  /** 0..1 estimate for the whole job; never decreases and stays below 1 until the job is over. */
  fraction: number
  /**
   * Seconds left for the whole job: encoding, the remaining steps and the VAE decode. Before the
   * first measured step it comes from `VideoJob.estimate`; once a tiled decode finished a tile, from
   * the measured time per tile. A forecast that is spent is doubled rather than dropped. `null` when
   * unknown, once every tile of a tiled decode is done, and while saving.
   */
  etaSeconds: number | null
  /**
   * The decode's tiles while a tiled decode runs; absent in every other phase, for a decode in one
   * graph, and from older cores. A retried decode starts a new pass from `done: 0`.
   */
  decodeTiles?: VideoDecodeTiles
  /** Since the runner started the job. */
  elapsedMs: number
  /**
   * The steps, or the tiles of a tiled decode, slowed down sharply (a sign of swapping or a stalled
   * engine); once set it stays set for the job. Always sent by this core; absent from older cores,
   * which a client reads as `false`.
   */
  slowdown?: boolean
}

export interface VideoJob {
  id: string
  state: VideoJobState
  modelId: string
  /** The request with inline image bytes blanked; file paths stay. */
  request: VideoGenerateRequest
  createdAtMs: number
  startedAtMs?: number
  finishedAtMs?: number
  progress: VideoJobProgress | null
  /** Zero or one item. */
  outputs: GalleryVideoItem[]
  error?: DiffusionErrorBody
  /** The estimate for this request, taken when the job started; absent when it could not be made. */
  estimate?: VideoEstimate
}

/** Written as `<jobId>.json` beside the video (WebM has no text chunk). Enough to reproduce the clip. */
export interface VideoRecipe {
  jobId: string
  prompt: string
  negativePrompt: string | null
  width: number
  height: number
  /** The frame count that was requested and validated. */
  frames: number
  /** The frame count the engine reported for the file it wrote, after its own normalisation. */
  frameCount: number
  fps: number
  /**
   * `steps`, `cfgScale` and `seed`: a local clip always has them. A provider's clip is never sent
   * steps or CFG and leaves them out, and leaves out the seed when its model takes none (one written
   * before 0.18.9 holds the form's steps and CFG and seed -1 instead).
   */
  steps?: number
  cfgScale?: number
  guidance: number | null
  seed?: number
  samplingMethod: string | null
  flowShift: number | null
  workflow: VideoWorkflowId
  outputFormat: VideoOutputFormat
  model: {
    modelId: string
    /** The provider id for a remote model. */
    family: string
    displayName: string
    /** Basename of the transformer file; empty for a remote model. */
    filename: string
  }
  engine: DiffusionRecipeEngine
  createdAtMs: number
  durationMs: number
  /**
   * From the last sampling step to the saved clip: the VAE decode and the file's encoding. Absent
   * for a clip made before it was recorded, or when no sampling step was seen.
   */
  decodeMs?: number
  /**
   * The clip's length in seconds as the file says; a remote clip has it instead of `fps` and
   * `frameCount` (both 0 when the file did not say).
   */
  durationSecs?: number
  /** What a remote model was asked; absent for a local one. */
  remote?: RemoteVideoOptions
}

export interface GalleryVideoItem {
  /** The job id (32 hex characters); also the file stem. */
  id: string
  path: string
  /** `<id>.thumb.png`, once the app uploaded a poster; null until then. */
  posterPath: string | null
  width: number
  height: number
  fps: number
  frameCount: number
  /** `frameCount / fps`. */
  durationSecs: number
  sizeBytes: number
  createdAtMs: number
  pinned: boolean
  archived: boolean
  recipe: VideoRecipe
}

export interface VideoGalleryPage {
  items: GalleryVideoItem[]
  hasMore: boolean
  total: number
}

export interface DiffusionVideoProgressEvent {
  jobId: string
  progress: VideoJobProgress
}

export interface DiffusionVideoJobEvent {
  job: VideoJob
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
