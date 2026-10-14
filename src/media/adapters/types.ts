/**
 * What an adapter is: the code that speaks one provider media API (a "dialect"). An image adapter
 * answers a generation with the images; a video adapter submits a job, polls it and downloads the
 * clip, because every video API is asynchronous and a clip takes minutes. The job runner
 * (`src/diffusion/remote-job.ts`) drives both; adapters never touch the gallery, the job table or
 * events.
 *
 * Rules every adapter keeps (see `http.ts`):
 * - derive every URL from `ctx.baseUrl` in code; never take a host from the catalog;
 * - never retry a request that starts a generation (the provider may bill twice);
 * - throw `REMOTE_*` errors (`remoteError`, `remoteHttpError`), `CANCELLED` when `ctx.signal` fired;
 * - read model-specific settings from `job.model.options` and parameters from `job.model.params`.
 */

import type {
  ImageModelDescriptor,
  MediaDialect,
  RemoteImageWorkflow,
  RemoteVideoWorkflow,
  VideoModelDescriptor,
} from '../../contracts/index.js'
import type { AtomicCoreError } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import type { MediaContext } from '../http.js'

/** An image handed to the provider: a source, a reference, a frame or a mask. */
export interface MediaInput {
  bytes: Buffer
  mime: string
}

export interface ImageGenerationJob {
  model: ImageModelDescriptor
  prompt: string
  negativePrompt?: string
  workflow: RemoteImageWorkflow
  /** Images to make, within `model.params.n.max` (1 when the model has no `n`). */
  n: number
  seed?: number
  /** The form's pixel size, for a model whose `size` is a range. */
  width?: number
  height?: number
  /** `auto` or `WxH`, for a model whose `size` is a list. */
  size?: string
  aspectRatio?: string
  resolution?: string
  quality?: string
  background?: string
  outputFormat?: string
  steps?: number
  cfgScale?: number
  guidance?: number
  sampler?: string
  /** Denoise strength 0..1 (`transform`, `inpaint`). */
  strength?: number
  /** The source image first (every workflow but `create`), then the references. */
  images: MediaInput[]
  /** `inpaint`: a PNG the size of the source, white where the model repaints. */
  mask?: MediaInput
}

export interface GeneratedImage {
  bytes: Buffer
  /** What the bytes are (`image/png`, `image/jpeg`, `image/webp`); sniffed, not the header's word. */
  mime: string
}

/** How far a generation got, when the provider says; both fields optional. */
export interface RemoteProgress {
  /** 0..1 */
  fraction?: number
  phase?: 'queued' | 'generating'
}

export interface ImageAdapter {
  readonly dialect: MediaDialect
  readonly kind: 'image'
  /** The provider's live model listing; absent when it has none (the catalog alone applies). */
  listModels?(ctx: MediaContext): Promise<LiveMediaModel[]>
  generate(
    ctx: MediaContext,
    job: ImageGenerationJob,
    report: (progress: RemoteProgress) => void
  ): Promise<GeneratedImage[]>
}

export interface VideoGenerationJob {
  model: VideoModelDescriptor
  prompt: string
  negativePrompt?: string
  workflow: RemoteVideoWorkflow
  durationSecs?: number
  resolution?: string
  aspectRatio?: string
  /** `WxH`, for a model whose `sizes` is a list. */
  size?: string
  generateAudio?: boolean
  seed?: number
  /** `image-to-video`: the first frame. */
  firstFrame?: MediaInput
  /** `image-to-video`: the last frame, when the model takes one. */
  lastFrame?: MediaInput
}

type Plain = string | number | boolean | null

/**
 * What a submit answered: enough to poll, download and cancel later, also after a restart of the
 * core. Written to disk as JSON, so plain data only.
 */
export interface VideoSubmission {
  /** The provider's job id. */
  id: string
  data?: Record<string, Plain>
}

/** Where the finished clip is: a URL the provider gave, and/or what the adapter needs to fetch it. */
export interface VideoResultRef {
  url?: string
  data?: Record<string, Plain>
}

export type VideoPoll =
  | { state: 'queued' | 'running'; /** 0..1 */ progress?: number }
  | { state: 'completed'; result: VideoResultRef }
  | { state: 'failed'; error: AtomicCoreError }

export interface VideoAdapter {
  readonly dialect: MediaDialect
  readonly kind: 'video'
  listModels?(ctx: MediaContext): Promise<LiveMediaModel[]>
  /** Starts the generation; never retried. */
  submit(ctx: MediaContext, job: VideoGenerationJob): Promise<VideoSubmission>
  /** One look at the job; a transport failure here is retried by the runner. */
  poll(ctx: MediaContext, submission: VideoSubmission): Promise<VideoPoll>
  download(
    ctx: MediaContext,
    submission: VideoSubmission,
    result: VideoResultRef
  ): Promise<{ bytes: Buffer; mime: string }>
  /** Best effort; most providers cannot cancel a running clip. */
  cancel?(ctx: MediaContext, submission: VideoSubmission): Promise<void>
  /** How often to poll: the first wait, and the cap backoff grows it to. Default 5 s and 20 s. */
  readonly pollIntervalMs?: { first: number; max: number }
}

export type MediaAdapter = ImageAdapter | VideoAdapter
