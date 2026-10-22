/**
 * Remote jobs: an image or a clip a cloud or self-hosted provider makes for a request whose
 * `target` names it (ADR 2026-10-13-remote-media-shares-the-diffusion-job-table). The records live in
 * the same job table as the local runner's, go out as the same `diffusion:*` events and land in the
 * same galleries, so the Images and Video pages, `/v1/images/generations` and `/v1/videos` see them
 * the way they see a local job. What differs:
 *
 * - no `sd-server`, no `activeJobId`, no GPU claim, no idle timer: a remote job never blocks a local
 *   one, and up to `MAX_REMOTE_JOBS` run at once;
 * - the request that starts a generation is never retried (the provider would bill twice);
 * - cancel aborts every request and wait, then asks the provider to stop, best effort;
 * - a video job is written to `remote-jobs.json` once submitted and polled again after a restart.
 *
 * The adapters that speak each provider live in `src/media/`; this file sees them through
 * `RemoteMediaGateway`, injected by the owner.
 */

import { randomUUID } from 'node:crypto'
import type {
  DiffusionCancelResult,
  DiffusionErrorBody,
  GalleryImageItem,
  GalleryVideoItem,
  ImageGenerateRequest,
  ImageJob,
  ImageJobProgress,
  ImageModelDescriptor,
  ImageRecipe,
  ImageSource,
  MediaKind,
  MediaTarget,
  RemoteImageOptions,
  RemoteImageWorkflow,
  RemoteVideoOptions,
  RemoteVideoWorkflow,
  VideoGenerateRequest,
  VideoJob,
  VideoJobProgress,
  VideoModelDescriptor,
  VideoRecipe,
} from '../contracts/index.js'
import type {
  ImageAdapter,
  ImageGenerationJob,
  MediaContext,
  MediaInput,
  VideoAdapter,
  VideoGenerationJob,
  VideoResultRef,
} from '../media/index.js'
import { cancelledError, diffusionError, errorBody } from './errors.js'
import { IMAGE_JOB_KIND, resolveSource, withoutSources } from './image-job.js'
import type { JobDeps, JobResult, StartedJob } from './jobs.js'
import { finishJob, setJobState } from './jobs.js'
import { imageMime, imageSize, mp4Facts } from './media-header.js'
import type { RemoteJobStore, StoredRemoteVideoJob, StoredSubmission } from './remote-store.js'
import type { JobRecord } from './state.js'
import { isTerminalJobState } from './state.js'
import { VIDEO_JOB_KIND, withoutVideoSources } from './video-job.js'

/** Remote jobs running at once, images and clips together. */
export const MAX_REMOTE_JOBS = 4
/** A clip still not done after this long is given up on. */
export const REMOTE_VIDEO_CEILING_MS = 3 * 60 * 60 * 1000
/** Polls that may fail in a row (network, 5xx, rate limit) before the job fails. */
export const MAX_POLL_FAILURES = 10
/** Progress goes out at least this often while a remote job runs. */
export const REMOTE_HEARTBEAT_MS = 1_000
/** How long a resumed job waits for the app to configure the galleries before saving to the defaults. */
export const RESUME_CONFIG_WAIT_MS = 60_000

/** A provider's model, ready to run: what it is, the code that speaks to it, and a context per job. */
export interface ResolvedRemote<Descriptor, Adapter> {
  target: MediaTarget
  descriptor: Descriptor
  adapter: Adapter
  context(signal: AbortSignal): MediaContext
}

/** What the runner needs of `src/media/`: resolve a target, find a public model. */
export interface RemoteMediaGateway {
  image(target: MediaTarget): Promise<ResolvedRemote<ImageModelDescriptor, ImageAdapter>>
  video(target: MediaTarget): Promise<ResolvedRemote<VideoModelDescriptor, VideoAdapter>>
  /** The provider and model a client's `model` names among the enabled media models. */
  find(model: string, kind: MediaKind): MediaTarget | undefined
}

export interface RemoteDeps {
  gateway: RemoteMediaGateway
  store: RemoteJobStore
  maxJobs?: number
}

function remoteDeps(deps: JobDeps): RemoteDeps {
  if (!deps.remote)
    throw diffusionError(
      'REMOTE_NOT_CONFIGURED',
      'This core does not generate with cloud or self-hosted models.'
    )
  return deps.remote
}

/** A fraction that creeps toward `cap` over time, for providers that say nothing about progress. */
export function timeFraction(elapsedMs: number, scaleMs: number, cap = 0.95): number {
  if (elapsedMs <= 0) return 0
  return Math.min(cap, cap * (1 - Math.exp(-elapsedMs / scaleMs)))
}

// ---------------------------------------------------------------------------
// Validation and the adapter's job, pure
// ---------------------------------------------------------------------------

const IMAGE_INPUT_WORKFLOWS: readonly RemoteImageWorkflow[] = ['edit', 'reference', 'transform', 'inpaint']

/** Refuse what the model cannot do before anything is sent; the workflow it runs. */
export function checkRemoteImageRequest(
  request: ImageGenerateRequest,
  model: ImageModelDescriptor
): RemoteImageWorkflow {
  if (request.prompt.trim() === '') throw diffusionError('INVALID_REQUEST', 'Write a prompt first.')
  const workflow = (request.workflow ?? 'create') as RemoteImageWorkflow
  if (!(model.workflows as readonly string[]).includes(workflow))
    throw diffusionError('UNSUPPORTED_WORKFLOW', `${model.name} cannot do that.`, workflow)
  if (IMAGE_INPUT_WORKFLOWS.includes(workflow) && request.initImage === undefined)
    throw diffusionError('INVALID_REQUEST', 'This workflow needs a source image.', workflow)
  if (workflow === 'inpaint' && request.maskImage === undefined)
    throw diffusionError('INVALID_REQUEST', 'Inpainting needs a mask.')
  const inputs = (request.initImage ? 1 : 0) + (request.referenceImages?.length ?? 0)
  const most = model.params.max_input_images
  if (inputs > 1 && most !== undefined && inputs > most)
    throw diffusionError('INVALID_REQUEST', `${model.name} takes at most ${most} images.`, `${inputs} given`)
  const most_n = model.params.n?.max ?? 1
  if (request.batchSize > most_n)
    throw diffusionError('INVALID_REQUEST', `${model.name} makes at most ${most_n} image(s) at a time.`)
  return workflow
}

/** The adapter's job out of the request, the model's defaults filling what the request left out. */
export function imageGenerationJob(
  request: ImageGenerateRequest,
  model: ImageModelDescriptor,
  workflow: RemoteImageWorkflow,
  inputs: { images: MediaInput[]; mask?: MediaInput },
  seed: number | undefined
): ImageGenerationJob {
  const { params } = model
  const remote = request.remote ?? {}
  const job: ImageGenerationJob = {
    model,
    prompt: request.prompt,
    workflow,
    n: Math.max(1, request.batchSize),
    images: inputs.images,
  }
  if (inputs.mask) job.mask = inputs.mask
  if (request.negativePrompt && params.negative_prompt) job.negativePrompt = request.negativePrompt
  if (seed !== undefined) job.seed = seed
  if (params.size?.kind === 'range' && request.width > 0 && request.height > 0) {
    job.width = request.width
    job.height = request.height
  }
  const size = remote.size ?? (params.size?.kind === 'enum' ? params.size.default : undefined)
  if (size !== undefined && params.size?.kind === 'enum') job.size = size
  const pick = (value: string | undefined, choice: { default?: string } | undefined) =>
    value ?? choice?.default
  const aspect = pick(remote.aspectRatio, params.aspect_ratios)
  if (aspect && params.aspect_ratios) job.aspectRatio = aspect
  const resolution = pick(remote.resolution, params.resolutions)
  if (resolution && params.resolutions) job.resolution = resolution
  if (remote.quality && params.quality) job.quality = remote.quality
  if (remote.background && params.background) job.background = remote.background
  // PNG keeps the recipe inside the image and gets a thumbnail; ask for it when the model offers it.
  const format = remote.outputFormat ?? (params.output_format?.values.includes('png') ? 'png' : undefined)
  if (format && params.output_format) job.outputFormat = format
  if (params.steps && request.steps > 0) job.steps = request.steps
  if (params.cfg && request.cfgScale > 0) job.cfgScale = request.cfgScale
  if (params.guidance && request.guidance !== undefined) job.guidance = request.guidance
  if (params.sampler && request.samplingMethod) job.sampler = request.samplingMethod
  if (params.strength && (workflow === 'transform' || workflow === 'inpaint'))
    job.strength = request.strength ?? params.strength.default ?? 0.75
  return job
}

/** Refuse what the model cannot do before anything is sent; the workflow it runs. */
export function checkRemoteVideoRequest(
  request: VideoGenerateRequest,
  model: VideoModelDescriptor
): RemoteVideoWorkflow {
  if (request.prompt.trim() === '' && request.initImage === undefined)
    throw diffusionError('INVALID_REQUEST', 'Write a prompt first.')
  const workflow = (request.workflow ?? 'create') as RemoteVideoWorkflow
  if (!(model.workflows as readonly string[]).includes(workflow))
    throw diffusionError('UNSUPPORTED_WORKFLOW', `${model.name} cannot do that.`, workflow)
  if (workflow === 'image-to-video' && request.initImage === undefined)
    throw diffusionError('INVALID_REQUEST', 'Image to video needs a first frame.')
  const seconds = request.remote?.durationSecs
  const durations = model.params.durations
  if (seconds !== undefined && durations) {
    const listed = durations.values
    const ok = listed
      ? listed.includes(seconds)
      : seconds >= (durations.min ?? 0) && seconds <= (durations.max ?? Number.POSITIVE_INFINITY)
    if (!ok) throw diffusionError('INVALID_REQUEST', `${model.name} cannot make a clip of ${seconds} s.`)
  }
  return workflow
}

/** The adapter's job out of the request, the model's defaults filling what the request left out. */
export function videoGenerationJob(
  request: VideoGenerateRequest,
  model: VideoModelDescriptor,
  workflow: RemoteVideoWorkflow,
  frames: { first?: MediaInput; last?: MediaInput },
  seed: number | undefined
): VideoGenerationJob {
  const { params } = model
  const remote = request.remote ?? {}
  const job: VideoGenerationJob = { model, prompt: request.prompt, workflow }
  if (request.negativePrompt && params.negative_prompt) job.negativePrompt = request.negativePrompt
  if (seed !== undefined) job.seed = seed
  const seconds = remote.durationSecs ?? params.durations?.default
  if (seconds !== undefined && params.durations) job.durationSecs = seconds
  const resolution = remote.resolution ?? params.resolutions?.default
  if (resolution && params.resolutions) job.resolution = resolution
  const aspect = remote.aspectRatio ?? params.aspect_ratios?.default
  if (aspect && params.aspect_ratios) job.aspectRatio = aspect
  const size = remote.size ?? params.sizes?.default
  if (size && params.sizes) job.size = size
  if (params.audio && remote.generateAudio !== undefined) job.generateAudio = remote.generateAudio
  if (workflow === 'image-to-video') {
    if (frames.first) job.firstFrame = frames.first
    if (frames.last && params.last_frame) job.lastFrame = frames.last
  }
  return job
}

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

function checkCapacity(deps: JobDeps, remote: RemoteDeps): void {
  const most = remote.maxJobs ?? MAX_REMOTE_JOBS
  if (deps.state.liveRemoteJobs() >= most)
    throw diffusionError('JOB_BUSY', `${most} cloud generations are already running. Wait for one to finish.`)
}

async function readInput(source: ImageSource, deps: JobDeps): Promise<MediaInput> {
  const bytes = Buffer.from(await resolveSource(source, deps), 'base64')
  return { bytes, mime: imageMime(bytes) ?? 'image/png' }
}

/** A seed for the job when the model takes one: the request's, else a drawn one, so the recipe has it. */
function seedFor(
  deps: JobDeps,
  requested: number | undefined,
  takesSeed: boolean | undefined
): number | undefined {
  if (!takesSeed) return undefined
  return requested !== undefined && requested >= 0 ? requested : deps.drawSeed()
}

/** The job's outcome on its record and in the events; the runner's `done` value. */
function settle<J extends ImageJob | VideoJob>(
  deps: JobDeps,
  id: string,
  outcome: { ok: true; outputs: unknown[]; bytes: Buffer[] } | { ok: false; raw: unknown }
): JobResult<J> {
  if (outcome.ok) {
    finishJob(deps, id, { ok: true, outputs: outcome.outputs })
    const job = deps.state.anyJob(id) as J
    return { ok: true, outcome: { job, images: outcome.bytes } }
  }
  const error: DiffusionErrorBody = errorBody(outcome.raw)
  finishJob(deps, id, { ok: false, error })
  if (error.code !== 'CANCELLED') deps.emit('diffusion:error', { ...error, jobId: id })
  return { ok: false, error: deps.state.anyJob(id)?.error ?? error }
}

/**
 * Progress for a remote job: what the provider says when it says it, else a fraction that creeps
 * forward with time; never backwards, and out at least every `REMOTE_HEARTBEAT_MS`.
 */
class RemoteProgressFeed {
  private reported = 0
  private provider: number | undefined
  private phase: 'queued' | 'sampling' = 'queued'
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly deps: JobDeps,
    private readonly id: string,
    private readonly kind: 'image' | 'video',
    private readonly startedAt: number,
    private readonly scaleMs: number,
    private readonly batchSize = 1
  ) {}

  start(): void {
    this.emit()
    this.timer = setInterval(() => this.emit(), REMOTE_HEARTBEAT_MS)
    this.timer.unref?.()
  }

  update(fraction: number | undefined, phase?: 'queued' | 'generating'): void {
    if (fraction !== undefined && Number.isFinite(fraction))
      this.provider = Math.min(Math.max(fraction, 0), 0.99)
    if (phase) this.phase = phase === 'queued' ? 'queued' : 'sampling'
    this.emit()
  }

  saving(): void {
    this.phase = 'sampling'
    this.reported = Math.max(this.reported, 0.99)
    this.emit('saving')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private emit(phase?: 'saving'): void {
    const record = this.deps.state.record(this.id)
    if (!record || isTerminalJobState(record.job.state)) return this.stop()
    const elapsedMs = Math.max(this.deps.now() - this.startedAt, 0)
    const guess = timeFraction(elapsedMs, this.scaleMs)
    this.reported = Math.max(this.reported, this.provider ?? guess)
    const common = {
      phase: phase ?? this.phase,
      step: 0,
      totalSteps: 0,
      fraction: this.reported,
      etaSeconds: null,
      elapsedMs,
    }
    if (this.kind === 'image') {
      const progress: ImageJobProgress = { ...common, batchIndex: 0, batchSize: this.batchSize }
      this.deps.state.updateJob(this.id, (r) => ((r.job as ImageJob).progress = progress))
      IMAGE_JOB_KIND.emitProgress(this.deps.emit, this.id, progress)
    } else {
      const progress: VideoJobProgress = common
      this.deps.state.updateJob(this.id, (r) => ((r.job as VideoJob).progress = progress))
      VIDEO_JOB_KIND.emitProgress(this.deps.emit, this.id, progress)
    }
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** How long a provider usually takes for an image; the time-based fraction is drawn over it. */
const IMAGE_SCALE_MS = 20_000

/** Validate, register and start an image job on a provider's model. */
export async function startRemoteImageJob(
  deps: JobDeps,
  request: ImageGenerateRequest
): Promise<StartedJob<ImageJob>> {
  const remote = remoteDeps(deps)
  const target = request.target
  if (!target) throw diffusionError('INVALID_REQUEST', 'A remote job needs a target.')
  const resolved = await remote.gateway.image(target)
  const workflow = checkRemoteImageRequest(request, resolved.descriptor)
  checkCapacity(deps, remote)

  const id = randomUUID().replaceAll('-', '')
  const abort = new AbortController()
  const job: ImageJob = {
    id,
    state: 'queued',
    modelId: target.model,
    request: withoutSources(request),
    createdAtMs: deps.now(),
    progress: null,
    outputs: [],
  }
  const record: JobRecord = { kind: 'image', job, cancel: { requested: false }, remote: { target, abort } }
  deps.state.insertJob(record)
  IMAGE_JOB_KIND.emitJob(deps.emit, structuredClone(job))

  const done = runRemoteImage(deps, id, request, resolved, workflow, abort.signal).then(
    (saved) => settle<ImageJob>(deps, id, { ok: true, outputs: saved.items, bytes: saved.bytes }),
    (raw: unknown) => settle<ImageJob>(deps, id, { ok: false, raw })
  )
  return { id, done }
}

async function runRemoteImage(
  deps: JobDeps,
  id: string,
  request: ImageGenerateRequest,
  resolved: ResolvedRemote<ImageModelDescriptor, ImageAdapter>,
  workflow: RemoteImageWorkflow,
  signal: AbortSignal
): Promise<{ items: GalleryImageItem[]; bytes: Buffer[] }> {
  const { descriptor, adapter, target } = resolved
  const images: MediaInput[] = []
  let mask: MediaInput | undefined
  if (workflow !== 'create' && request.initImage) {
    images.push(await readInput(request.initImage, deps))
    for (const extra of request.referenceImages ?? []) images.push(await readInput(extra, deps))
    if (workflow === 'inpaint' && request.maskImage) mask = await readInput(request.maskImage, deps)
  }
  const seed = seedFor(deps, request.seed, descriptor.params.seed)
  const job = imageGenerationJob(request, descriptor, workflow, mask ? { images, mask } : { images }, seed)
  if (signal.aborted) throw cancelledError()
  setJobState(deps, id, 'generating')
  const startedAt = deps.now()
  const feed = new RemoteProgressFeed(deps, id, 'image', startedAt, IMAGE_SCALE_MS, job.n)
  feed.start()
  try {
    const outputs = await adapter.generate(resolved.context(signal), job, (progress) =>
      feed.update(progress.fraction, progress.phase)
    )
    if (signal.aborted) throw cancelledError()
    feed.saving()
    const dir = deps.state.outputDir()
    const createdAtMs = deps.now()
    const items: GalleryImageItem[] = []
    const bytes: Buffer[] = []
    for (const [index, output] of outputs.entries()) {
      const size = imageSize(output.bytes)
      const recipe: ImageRecipe = {
        jobId: id,
        index,
        prompt: request.prompt,
        negativePrompt: job.negativePrompt ?? null,
        width: size?.width ?? request.width,
        height: size?.height ?? request.height,
        // Only the knobs the model was sent: a placeholder would read as a setting.
        ...(job.steps === undefined ? {} : { steps: job.steps }),
        ...(job.cfgScale === undefined ? {} : { cfgScale: job.cfgScale }),
        guidance: job.guidance ?? null,
        ...(seed === undefined ? {} : { seed: seed + index, batchSeed: seed }),
        batchSize: job.n,
        samplingMethod: job.sampler ?? null,
        flowShift: null,
        workflow,
        strength: job.strength ?? null,
        model: { modelId: target.model, family: target.provider, displayName: descriptor.name, filename: '' },
        engine: { kind: 'remote', provider: target.provider, api: descriptor.api },
        createdAtMs,
        durationMs: Math.max(createdAtMs - startedAt, 0),
      }
      const options = recipeImageOptions(job)
      if (options) recipe.remote = options
      const saved = await deps.gallery.saveRemote(
        dir,
        recipe,
        output.bytes,
        imageMime(output.bytes) ?? output.mime
      )
      deps.state.updateJob(id, (r) => (r.job as ImageJob).outputs.push(saved.item))
      items.push(saved.item)
      bytes.push(saved.bytes)
    }
    return { items, bytes }
  } finally {
    feed.stop()
  }
}

/** What a remote image was asked besides the common recipe fields; `undefined` when nothing. */
function recipeImageOptions(job: ImageGenerationJob): RemoteImageOptions | undefined {
  const out: RemoteImageOptions = {}
  if (job.size) out.size = job.size
  if (job.aspectRatio) out.aspectRatio = job.aspectRatio
  if (job.resolution) out.resolution = job.resolution
  if (job.quality) out.quality = job.quality
  if (job.background) out.background = job.background
  if (job.outputFormat) out.outputFormat = job.outputFormat
  return Object.keys(out).length > 0 ? out : undefined
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/** How long a provider usually takes for a clip; the time-based fraction is drawn over it. */
const VIDEO_SCALE_MS = 120_000
const DEFAULT_POLL = { first: 5_000, max: 20_000 }

/** Validate, register, submit and follow a clip on a provider's model. */
export async function startRemoteVideoJob(
  deps: JobDeps,
  request: VideoGenerateRequest
): Promise<StartedJob<VideoJob>> {
  const remote = remoteDeps(deps)
  const target = request.target
  if (!target) throw diffusionError('INVALID_REQUEST', 'A remote job needs a target.')
  const resolved = await remote.gateway.video(target)
  const workflow = checkRemoteVideoRequest(request, resolved.descriptor)
  checkCapacity(deps, remote)

  const id = randomUUID().replaceAll('-', '')
  const abort = new AbortController()
  const job: VideoJob = {
    id,
    state: 'queued',
    modelId: target.model,
    request: withoutVideoSources(request),
    createdAtMs: deps.now(),
    progress: null,
    outputs: [],
  }
  const record: JobRecord = { kind: 'video', job, cancel: { requested: false }, remote: { target, abort } }
  deps.state.insertJob(record)
  VIDEO_JOB_KIND.emitJob(deps.emit, structuredClone(job))

  const done = submitAndFollow(deps, id, request, resolved, workflow, abort.signal).then(
    (saved) => settle<VideoJob>(deps, id, { ok: true, outputs: saved.items, bytes: saved.bytes }),
    (raw: unknown) => settle<VideoJob>(deps, id, { ok: false, raw })
  )
  return { id, done }
}

async function submitAndFollow(
  deps: JobDeps,
  id: string,
  request: VideoGenerateRequest,
  resolved: ResolvedRemote<VideoModelDescriptor, VideoAdapter>,
  workflow: RemoteVideoWorkflow,
  signal: AbortSignal
): Promise<{ items: GalleryVideoItem[]; bytes: Buffer[] }> {
  const remote = remoteDeps(deps)
  const frames: { first?: MediaInput; last?: MediaInput } = {}
  if (workflow === 'image-to-video') {
    if (request.initImage) frames.first = await readInput(request.initImage, deps)
    if (request.endImage) frames.last = await readInput(request.endImage, deps)
  }
  const seed = seedFor(deps, request.seed, resolved.descriptor.params.seed)
  const job = videoGenerationJob(request, resolved.descriptor, workflow, frames, seed)
  if (signal.aborted) throw cancelledError()
  const ctx = resolved.context(signal)
  const submission = await resolved.adapter.submit(ctx, job)
  const startedAtMs = deps.now()
  const stored: StoredRemoteVideoJob = {
    jobId: id,
    target: resolved.target,
    submission: submission as StoredSubmission,
    request: withoutVideoSources(withOptions(request, job)),
    ...(seed === undefined ? {} : { seed }),
    createdAtMs: deps.state.record(id)?.job.createdAtMs ?? startedAtMs,
    startedAtMs,
  }
  await remote.store
    .put(stored)
    .catch((error: unknown) =>
      deps.log('warn', `remote video ${id}: could not record the job: ${String(error)}`)
    )
  return follow(deps, stored, resolved, signal)
}

/** The request with what the adapter was actually asked, so the recipe records it. */
function withOptions(request: VideoGenerateRequest, job: VideoGenerationJob): VideoGenerateRequest {
  const remote: RemoteVideoOptions = {}
  if (job.durationSecs !== undefined) remote.durationSecs = job.durationSecs
  if (job.resolution) remote.resolution = job.resolution
  if (job.aspectRatio) remote.aspectRatio = job.aspectRatio
  if (job.size) remote.size = job.size
  if (job.generateAudio !== undefined) remote.generateAudio = job.generateAudio
  return { ...request, remote }
}

/** Poll a submitted clip to its end, download it, save it; the job's store entry goes either way. */
async function follow(
  deps: JobDeps,
  stored: StoredRemoteVideoJob,
  resolved: ResolvedRemote<VideoModelDescriptor, VideoAdapter>,
  signal: AbortSignal
): Promise<{ items: GalleryVideoItem[]; bytes: Buffer[] }> {
  const remote = remoteDeps(deps)
  const { adapter } = resolved
  const id = stored.jobId
  const ctx = resolved.context(signal)
  const cancel = adapter.cancel?.bind(adapter)
  if (cancel)
    deps.state.updateJob(id, (record) => {
      if (record.remote)
        record.remote.cancelUpstream = () =>
          cancel(resolved.context(AbortSignal.timeout(15_000)), stored.submission)
    })
  setJobState(deps, id, 'generating')
  const feed = new RemoteProgressFeed(deps, id, 'video', stored.startedAtMs, VIDEO_SCALE_MS)
  feed.start()
  try {
    const interval = adapter.pollIntervalMs ?? DEFAULT_POLL
    let wait = interval.first
    let failures = 0
    let result: VideoResultRef | undefined
    while (!result) {
      if (signal.aborted) throw cancelledError()
      if (deps.now() - stored.startedAtMs > REMOTE_VIDEO_CEILING_MS)
        throw diffusionError('REMOTE_TIMEOUT', `${resolved.target.provider} did not finish the clip in time.`)
      let poll
      try {
        poll = await adapter.poll(ctx, stored.submission)
        failures = 0
      } catch (error) {
        if (signal.aborted) throw cancelledError()
        const code = (error as { code?: string }).code
        const transient =
          code === 'REMOTE_UNAVAILABLE' || code === 'REMOTE_TIMEOUT' || code === 'REMOTE_RATE_LIMITED'
        if (!transient || ++failures > MAX_POLL_FAILURES) throw error
        deps.log(
          'debug',
          `remote video ${id}: poll failed (${failures}): ${String((error as Error).message)}`
        )
      }
      if (poll?.state === 'completed') {
        result = poll.result
        break
      }
      if (poll?.state === 'failed') throw poll.error
      if (poll) feed.update(poll.progress, poll.state === 'queued' ? 'queued' : 'generating')
      await ctx.sleep(wait)
      wait = Math.min(Math.round(wait * 1.5), interval.max)
    }
    const file = await adapter.download(ctx, stored.submission, result)
    if (signal.aborted) throw cancelledError()
    feed.saving()
    return await saveClip(deps, stored, resolved.descriptor, file.bytes)
  } finally {
    feed.stop()
    // A core shutting down keeps the entry: the next one polls the clip again.
    if (!deps.state.closing) await remote.store.remove(id).catch(() => {})
  }
}

async function saveClip(
  deps: JobDeps,
  stored: StoredRemoteVideoJob,
  model: VideoModelDescriptor,
  bytes: Buffer
): Promise<{ items: GalleryVideoItem[]; bytes: Buffer[] }> {
  const facts = mp4Facts(bytes)
  const isMp4 = bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp'
  const request = stored.request
  const options = request.remote ?? {}
  const createdAtMs = deps.now()
  const recipe: VideoRecipe = {
    jobId: stored.jobId,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ? request.negativePrompt : null,
    width: facts?.width || request.width,
    height: facts?.height || request.height,
    frames: 0,
    frameCount: 0,
    fps: 0,
    // A provider's clip is never sent steps or CFG, and a seed only when its model takes one.
    guidance: null,
    ...(stored.seed === undefined ? {} : { seed: stored.seed }),
    samplingMethod: null,
    flowShift: null,
    workflow: request.workflow ?? 'create',
    outputFormat: isMp4 ? 'mp4' : 'webm',
    model: {
      modelId: stored.target.model,
      family: stored.target.provider,
      displayName: model.name,
      filename: '',
    },
    engine: { kind: 'remote', provider: stored.target.provider, api: model.api },
    createdAtMs,
    durationMs: Math.max(createdAtMs - stored.startedAtMs, 0),
  }
  const seconds = facts?.durationSecs || options.durationSecs
  if (seconds) recipe.durationSecs = seconds
  if (Object.keys(options).length > 0) recipe.remote = options
  const saved = await deps.videoGallery.save(deps.state.videoOutputDir(), recipe, bytes)
  deps.videoSaved?.()
  deps.state.updateJob(stored.jobId, (record) => (record.job as VideoJob).outputs.push(saved.item))
  return { items: [saved.item], bytes: [saved.bytes] }
}

/**
 * Follow again every clip the last core submitted and did not finish. A job whose provider is gone
 * fails at once; none is ever submitted twice.
 */
export async function resumeRemoteVideoJobs(deps: JobDeps): Promise<void> {
  const remote = deps.remote
  if (!remote) return
  const stored = await remote.store.list().catch(() => [])
  for (const entry of stored) {
    if (deps.state.record(entry.jobId)) continue
    const abort = new AbortController()
    const job: VideoJob = {
      id: entry.jobId,
      state: 'generating',
      modelId: entry.target.model,
      request: entry.request,
      createdAtMs: entry.createdAtMs,
      startedAtMs: entry.startedAtMs,
      progress: null,
      outputs: [],
    }
    deps.state.insertJob({
      kind: 'video',
      job,
      cancel: { requested: false },
      remote: { target: entry.target, abort },
    })
    VIDEO_JOB_KIND.emitJob(deps.emit, structuredClone(job))
    void (async () => {
      try {
        const resolved = await remote.gateway.video(entry.target)
        await waitConfigured(deps, abort.signal)
        const saved = await follow(deps, entry, resolved, abort.signal)
        settle<VideoJob>(deps, entry.jobId, { ok: true, outputs: saved.items, bytes: saved.bytes })
      } catch (raw) {
        if (deps.state.closing) return
        await remote.store.remove(entry.jobId).catch(() => {})
        settle<VideoJob>(deps, entry.jobId, { ok: false, raw })
      }
    })()
    deps.log('info', `remote video ${entry.jobId}: following it again at ${entry.target.provider}`)
  }
}

/** A resumed clip saves into the folder the app configures; without an app, the default one. */
async function waitConfigured(deps: JobDeps, signal: AbortSignal): Promise<void> {
  const deadline = deps.now() + RESUME_CONFIG_WAIT_MS
  while (!deps.state.configured && deps.now() < deadline && !signal.aborted) await deps.sleep(500)
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/** Stop a remote job: every request and wait aborts, and the provider is asked to stop it too. */
export async function cancelRemoteJob(deps: JobDeps, id: string): Promise<DiffusionCancelResult> {
  const record = deps.state.record(id)
  if (!record?.remote) throw diffusionError('JOB_NOT_FOUND', 'That job no longer exists.')
  if (isTerminalJobState(record.job.state))
    return { cancelled: record.job.state === 'cancelled', serverStopped: false }
  record.cancel.requested = true
  record.remote.abort.abort()
  finishJob(deps, id, { ok: false, error: errorBody(cancelledError()) })
  const upstream = record.remote.cancelUpstream
  if (upstream)
    await upstream().catch((error: unknown) => deps.log('debug', `remote cancel of ${id}: ${String(error)}`))
  return { cancelled: true, serverStopped: false }
}
