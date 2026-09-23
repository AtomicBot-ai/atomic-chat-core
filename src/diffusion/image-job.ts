/**
 * The image side of the job runner: what an image job validates, sends, decodes and saves. Moved
 * out of `jobs.ts` when video arrived; the functions are the plugin's (`jobs.rs` at app commit
 * `ec1fd3ea7`), the `JobKind` wrapper is what the shared runner sees.
 */

import { basename } from 'node:path'
import type {
  GalleryImageItem,
  ImageGenerateRequest,
  ImageJob,
  ImageJobProgress,
  ImageRecipe,
  ImageSource,
} from '../contracts/index.js'
import { buildImgGenRequest } from './args.js'
import { diffusionError, internalError } from './errors.js'
import { isBlankOutput } from './gallery.js'
import type { JobKind, SaveContext } from './job-kind.js'
import type { JobDeps } from './jobs.js'
import { sampledSteps } from './tracker.js'
import type { ResolvedInputs, ServerSpec } from './types.js'
import { stripDataUrl, validateRequest } from './validate.js'
import { defaultStrength, usesInitImage, usesMask, usesReferences, workflowOf } from './workflow.js'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One source as the base64 `sd-server` takes: inline bytes as they are, a file read from disk. */
export async function resolveSource(source: ImageSource, deps: Pick<JobDeps, 'readSource'>): Promise<string> {
  if ('base64' in source) return stripDataUrl(source.base64)
  try {
    return (await deps.readSource(source.path)).toString('base64')
  } catch (error) {
    throw diffusionError(
      'INVALID_REQUEST',
      'The source image could not be read.',
      error instanceof Error ? error.message : String(error)
    )
  }
}

/** The request's images as the base64 `sd-server` takes, once per job (not per retry). Only what the workflow uses is read. */
export async function resolveInputs(
  request: ImageGenerateRequest,
  deps: Pick<JobDeps, 'readSource'>
): Promise<ResolvedInputs> {
  const workflow = workflowOf(request)
  const inputs: ResolvedInputs = { refs: [] }
  if (workflow === 'create' || request.initImage === undefined) return inputs
  const source = await resolveSource(request.initImage, deps)
  if (usesReferences(workflow)) {
    inputs.refs.push(source)
    for (const extra of request.referenceImages ?? []) inputs.refs.push(await resolveSource(extra, deps))
  } else {
    inputs.init = source
    if (usesMask(workflow) && request.maskImage !== undefined)
      inputs.mask = await resolveSource(request.maskImage, deps)
  }
  return inputs
}

/** A source as a job record carries it: the path stays, inline bytes are blanked. */
export const redactSource = (source: ImageSource): ImageSource =>
  'path' in source ? { path: source.path } : { base64: '' }

/** The request as the job record and every job event carry it: file paths stay, inline bytes are blanked. */
export function withoutSources(request: ImageGenerateRequest): ImageGenerateRequest {
  const copy: ImageGenerateRequest = { ...request }
  if (request.initImage) copy.initImage = redactSource(request.initImage)
  if (request.maskImage) copy.maskImage = redactSource(request.maskImage)
  if (request.referenceImages) copy.referenceImages = request.referenceImages.map(redactSource)
  return copy
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The images of a completed job, in index order. */
export function decodeImages(job: Record<string, unknown>): Buffer[] {
  const result = job['result']
  const list =
    result !== null && typeof result === 'object' ? (result as Record<string, unknown>)['images'] : undefined
  const items: Array<{ index: number; b64: string }> = []
  if (Array.isArray(list))
    for (const image of list) {
      if (image === null || typeof image !== 'object') continue
      const { b64_json: b64, index } = image as Record<string, unknown>
      if (typeof b64 !== 'string') continue
      items.push({ index: typeof index === 'number' ? index : 0, b64 })
    }
  items.sort((a, b) => a.index - b.index)
  const out = items.map(({ b64 }) => {
    const trimmed = b64.trim()
    const bytes = Buffer.from(trimmed, 'base64')
    if (bytes.length === 0 && trimmed !== '') throw internalError('sd-server returned an undecodable image.')
    return bytes
  })
  if (out.length === 0) throw internalError('The image server completed the job but returned no images.')
  return out
}

/** Refuse a blank batch, then write every PNG with its recipe and thumbnail into the gallery. */
export async function saveImageOutputs(
  deps: JobDeps,
  ctx: SaveContext<ImageGenerateRequest>,
  pngs: Buffer[]
): Promise<{ items: GalleryImageItem[]; bytes: Buffer[] }> {
  const { id, request, spec, seed: batchSeed, startedAt } = ctx
  // A frame sd.cpp returned after a numerical overflow is not an image; nothing of the batch is kept.
  for (const png of pngs)
    if (await isBlankOutput(png))
      throw diffusionError('INVALID_OUTPUT', 'The image engine produced a blank frame. Nothing was saved.')
  const outputDir = deps.state.outputDir()
  const workflow = workflowOf(request)
  const createdAtMs = deps.now()
  const durationMs = Math.max(createdAtMs - startedAt, 0)
  const items: GalleryImageItem[] = []
  const bytes: Buffer[] = []
  for (const [index, png] of pngs.entries()) {
    const recipe: ImageRecipe = {
      jobId: id,
      index,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt ? request.negativePrompt : null,
      width: request.width,
      height: request.height,
      steps: request.steps,
      cfgScale: request.cfgScale,
      guidance: request.guidance ?? spec.defaults.guidance ?? null,
      seed: batchSeed + index,
      batchSeed,
      batchSize: request.batchSize,
      samplingMethod: request.samplingMethod ?? spec.defaults.samplingMethod ?? null,
      flowShift: request.flowShift ?? spec.defaults.flowShift ?? null,
      workflow,
      // The effective value, so a recipe can be replayed as sent.
      strength: usesInitImage(workflow) ? (request.strength ?? defaultStrength(workflow)) : null,
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
      durationMs,
    }
    const saved = await deps.gallery.save(outputDir, recipe, png)
    deps.state.updateJob(id, (record) => (record.job as ImageJob).outputs.push(saved.item))
    items.push(saved.item)
    bytes.push(saved.bytes)
  }
  return { items, bytes }
}

// ---------------------------------------------------------------------------
// The kind
// ---------------------------------------------------------------------------

export const IMAGE_JOB_KIND: JobKind<
  ImageGenerateRequest,
  ImageJob,
  GalleryImageItem,
  ImageJobProgress,
  Buffer[]
> = {
  id: 'image',
  modality: 'image',
  submitPath: '/sdcpp/v1/img_gen',
  messages: {
    busy: 'An image is already being generated.',
    wrongModel: 'The loaded model generates video, not images. Load an image model first.',
    outOfMemory: 'sd-server ran out of memory while generating.',
    failed: 'The image server failed to generate.',
  },
  validate: (request, spec, deps) => validateRequest(request, spec, deps),
  newJob: (id, spec: ServerSpec, request, now) => ({
    id,
    state: 'queued',
    modelId: spec.modelId,
    request: withoutSources(request),
    createdAtMs: now,
    progress: null,
    outputs: [],
  }),
  resolveInputs,
  buildBody: (request, spec, seed, inputs) => buildImgGenRequest(request, spec.defaults, seed, inputs),
  trackerShape: (request) => ({ steps: sampledSteps(request), batch: request.batchSize }),
  progress: (snapshot) => snapshot,
  emitJob: (emit, job) => emit('diffusion:job', { job }),
  emitProgress: (emit, jobId, progress) => emit('diffusion:progress', { jobId, progress }),
  cancelGenerating: (capabilities) => capabilities.cancelGenerating,
  decode: decodeImages,
  save: saveImageOutputs,
}
