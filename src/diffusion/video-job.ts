/**
 * The video side of the job runner: what a video job validates, sends to `vid_gen`, decodes and
 * saves. One clip per job, VP8 in WebM, the recipe beside it as a sidecar; the shared runner in
 * `jobs.ts` drives it through `VIDEO_JOB_KIND`.
 */

import { basename } from 'node:path'
import type {
  GalleryVideoItem,
  ImageJobProgress,
  VideoGenerateRequest,
  VideoJob,
  VideoJobProgress,
  VideoRecipe,
} from '../contracts/index.js'
import { buildVidGenRequest } from './args.js'
import { diffusionError, internalError } from './errors.js'
import { redactSource, resolveSource } from './image-job.js'
import type { JobKind, SaveContext } from './job-kind.js'
import type { JobDeps } from './jobs.js'
import type { ResolvedInputs, ServerCapabilities, ServerSpec } from './types.js'
import { validateVideoRequest } from './validate.js'
import { isWebm } from './video-gallery.js'

/** What a completed `vid_gen` job carries once decoded. */
export interface DecodedVideo {
  bytes: Buffer
  fps: number
  frameCount: number
  outputFormat: string
  mimeType: string
}

/** The first and last frames as the base64 `sd-server` takes; nothing is read for text-to-video. */
export async function resolveVideoInputs(
  request: VideoGenerateRequest,
  deps: Pick<JobDeps, 'readSource'>
): Promise<ResolvedInputs> {
  const inputs: ResolvedInputs = { refs: [] }
  if ((request.workflow ?? 'create') !== 'image-to-video') return inputs
  if (request.initImage !== undefined) inputs.init = await resolveSource(request.initImage, deps)
  if (request.endImage !== undefined) inputs.end = await resolveSource(request.endImage, deps)
  return inputs
}

/** The request as the job record carries it: file paths stay, inline bytes are blanked. */
export function withoutVideoSources(request: VideoGenerateRequest): VideoGenerateRequest {
  const copy: VideoGenerateRequest = { ...request }
  if (request.initImage) copy.initImage = redactSource(request.initImage)
  if (request.endImage) copy.endImage = redactSource(request.endImage)
  return copy
}

/** The clip of a completed job: `result.b64_json` in the container the request asked for. */
export function decodeVideo(job: Record<string, unknown>): DecodedVideo {
  const result = job['result']
  const fields = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  const b64 = fields['b64_json']
  if (typeof b64 !== 'string' || b64.trim() === '')
    throw internalError('The video server completed the job but returned no video.')
  const outputFormat = typeof fields['output_format'] === 'string' ? fields['output_format'] : 'webm'
  if (outputFormat !== 'webm')
    throw internalError('The video server returned a video in an unexpected format.', outputFormat)
  const bytes = Buffer.from(b64.trim(), 'base64')
  if (bytes.length === 0) throw internalError('sd-server returned an undecodable video.')
  const fps = fields['fps']
  const frameCount = fields['frame_count']
  return {
    bytes,
    fps: typeof fps === 'number' && Number.isInteger(fps) && fps > 0 ? fps : 0,
    frameCount:
      typeof frameCount === 'number' && Number.isInteger(frameCount) && frameCount > 0 ? frameCount : 0,
    outputFormat,
    mimeType: typeof fields['mime_type'] === 'string' ? fields['mime_type'] : 'video/webm',
  }
}

/** Refuse anything that is not a WebM, then write the clip and its sidecar into the video gallery. */
export async function saveVideoOutput(
  deps: JobDeps,
  ctx: SaveContext<VideoGenerateRequest>,
  decoded: DecodedVideo
): Promise<{ items: GalleryVideoItem[]; bytes: Buffer[] }> {
  const { id, request, spec, seed, startedAt } = ctx
  if (!isWebm(decoded.bytes))
    throw diffusionError('INVALID_OUTPUT', 'The video engine returned something that is not a WebM.')
  const video = spec.defaults.video
  const frames = request.frames ?? video?.frames ?? decoded.frameCount
  const fps = request.fps ?? video?.fps ?? decoded.fps
  const createdAtMs = deps.now()
  const recipe: VideoRecipe = {
    jobId: id,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ? request.negativePrompt : null,
    width: request.width,
    height: request.height,
    frames,
    // What the engine wrote, after its own normalisation; the requested count is `frames`.
    frameCount: decoded.frameCount > 0 ? decoded.frameCount : frames,
    fps: decoded.fps > 0 ? decoded.fps : fps,
    steps: request.steps,
    cfgScale: request.cfgScale,
    guidance: request.guidance ?? spec.defaults.guidance ?? null,
    seed,
    samplingMethod: request.samplingMethod ?? spec.defaults.samplingMethod ?? null,
    flowShift: request.flowShift ?? spec.defaults.flowShift ?? null,
    workflow: request.workflow ?? 'create',
    outputFormat: 'webm',
    model: {
      modelId: spec.modelId,
      family: spec.family,
      displayName: spec.displayName,
      filename: basename(spec.files.diffusionModel),
    },
    engine: {
      kind: spec.engine,
      backend: spec.backend,
      tag: spec.tag,
      offload: spec.offload,
      cpuFallback: spec.cpuFallback,
    },
    createdAtMs,
    durationMs: Math.max(createdAtMs - startedAt, 0),
  }
  const saved = await deps.videoGallery.save(deps.state.videoOutputDir(), recipe, decoded.bytes)
  deps.state.updateJob(id, (record) => (record.job as VideoJob).outputs.push(saved.item))
  return { items: [saved.item], bytes: [saved.bytes] }
}

/** The wire progress of a clip: the tracker's snapshot without the batch fields. */
export function videoProgress(snapshot: ImageJobProgress): VideoJobProgress {
  return {
    phase: snapshot.phase,
    step: snapshot.step,
    totalSteps: snapshot.totalSteps,
    fraction: snapshot.fraction,
    etaSeconds: snapshot.etaSeconds,
    elapsedMs: snapshot.elapsedMs,
  }
}

/** A build without libwebm cannot write the one container the app plays; say so before submitting. */
export function checkWebmSupport(capabilities: ServerCapabilities | undefined): void {
  const formats = capabilities?.vidGen?.outputFormats
  if (formats !== undefined && !formats.includes('webm'))
    throw diffusionError(
      'UNSUPPORTED_BACKEND',
      'This engine build was made without WebM support.',
      `output formats: ${formats.join(', ') || 'none'}`
    )
}

export const VIDEO_JOB_KIND: JobKind<
  VideoGenerateRequest,
  VideoJob,
  GalleryVideoItem,
  VideoJobProgress,
  DecodedVideo
> = {
  id: 'video',
  modality: 'video',
  submitPath: '/sdcpp/v1/vid_gen',
  messages: {
    busy: 'A video is already being generated.',
    wrongModel: 'The loaded model generates images, not video. Load a video model first.',
    outOfMemory:
      'sd-server ran out of memory while generating the clip: a clip this long at this size does not fit. Fewer frames or a smaller size will.',
    failed: 'The video server failed to generate.',
  },
  validate: (request, spec, deps) => validateVideoRequest(request, spec, deps),
  newJob: (id, spec: ServerSpec, request, now) => ({
    id,
    state: 'queued',
    modelId: spec.modelId,
    request: withoutVideoSources(request),
    createdAtMs: now,
    progress: null,
    outputs: [],
  }),
  resolveInputs: resolveVideoInputs,
  buildBody: (request, spec, seed, inputs) => buildVidGenRequest(request, spec.defaults, seed, inputs),
  trackerShape: (request) => ({ steps: Math.max(request.steps, 1), batch: 1 }),
  progress: videoProgress,
  emitJob: (emit, job) => emit('diffusion:video-job', { job }),
  emitProgress: (emit, jobId, progress) => emit('diffusion:video-progress', { jobId, progress }),
  cancelGenerating: (capabilities) => capabilities.vidGen?.cancelGenerating ?? false,
  preflight: checkWebmSupport,
  decode: decodeVideo,
  save: saveVideoOutput,
}
