/**
 * Image jobs: validate, submit to `sd-server`, poll, save, and the cancel path. Shared by the
 * control route and the OpenAI facade, so both get the same validation, events, gallery and idle
 * timer. Port of `jobs.rs` in `tauri-plugin-atomic-diffusion` (app commit `ec1fd3ea7`).
 *
 * One deliberate change: a respawn re-checks, once it holds the load lock, that nobody cancelled
 * the job or unloaded the model while it waited. The plugin took the lock and spawned regardless.
 */

import { randomInt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  DiffusionCancelResult,
  DiffusionErrorBody,
  GalleryImageItem,
  ImageGenerateRequest,
  ImageJob,
  ImageJobState,
  ImageRecipe,
  ImageSource,
} from '../contracts/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import { buildImgGenRequest, cpuBackendExtraArgs, isGgmlUnsupportedOpAbort } from './args.js'
import { cancelledError, diffusionError, errorBody, internalError, modelNotLoadedError } from './errors.js'
import { isBlankOutput } from './gallery.js'
import type { Gallery } from './gallery.js'
import type { SdHttpClient } from './http.js'
import type { AsyncMutex } from './mutex.js'
import { classifyExit, diagnosticTail, GpuFaultWatch } from './progress.js'
import { describeExit, exitCodeOf } from './server-process.js'
import { loadFromSpec, stopKeepingSpec, takeDownSession } from './session.js'
import type { SessionDeps } from './session.js'
import type { CancelFlag, DiffusionState, JobRecord } from './state.js'
import { isTerminalJobState } from './state.js'
import { ProgressTracker, sampledSteps } from './tracker.js'
import type { ResolvedInputs, ServerSpec } from './types.js'
import { validateRequest } from './validate.js'
import { stripDataUrl } from './validate.js'
import { defaultStrength, usesInitImage, usesMask, usesReferences, workflowOf } from './workflow.js'

export const IMG_GEN_PATH = '/sdcpp/v1/img_gen'
export const JOBS_PATH = '/sdcpp/v1/jobs'

export interface JobTimings {
  pollIntervalMs: number
  submitTimeoutMs: number
  statusTimeoutMs: number
  /** The native engine exists for slow CPU hosts; this only stops a wedged process from holding the slot forever. */
  generationCeilingMs: number
  /** How long a native cancel gets to show in the job status before the server is stopped instead. */
  cancelGraceMs: number
  /** How often a cancel looks at the job while it waits out the grace. */
  cancelPollMs: number
}

export const DEFAULT_JOB_TIMINGS: JobTimings = {
  pollIntervalMs: 400,
  submitTimeoutMs: 60_000,
  statusTimeoutMs: 10_000,
  generationCeilingMs: 6 * 60 * 60 * 1000,
  cancelGraceMs: 5_000,
  cancelPollMs: 100,
}

export interface JobDeps extends SessionDeps {
  http: SdHttpClient
  gallery: Gallery
  loadLock: AsyncMutex
  timings: JobTimings
  drawSeed: () => number
  readSource: (path: string) => Promise<Buffer>
  isFile: (path: string) => Promise<boolean>
}

export interface JobOutcome {
  job: ImageJob
  /** The final PNG bytes (recipe included), in batch order. */
  images: Buffer[]
}

export type JobResult = { ok: true; outcome: JobOutcome } | { ok: false; error: DiffusionErrorBody }

export function drawSeed(): number {
  return randomInt(0, 0x1_0000_0000)
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

async function resolveSource(source: ImageSource, deps: Pick<JobDeps, 'readSource'>): Promise<string> {
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

/** The request as the job record and every job event carry it: file paths stay, inline bytes are blanked. */
export function withoutSources(request: ImageGenerateRequest): ImageGenerateRequest {
  const redact = (source: ImageSource): ImageSource =>
    'path' in source ? { path: source.path } : { base64: '' }
  const copy: ImageGenerateRequest = { ...request }
  if (request.initImage) copy.initImage = redact(request.initImage)
  if (request.maskImage) copy.maskImage = redact(request.maskImage)
  if (request.referenceImages) copy.referenceImages = request.referenceImages.map(redact)
  return copy
}

// ---------------------------------------------------------------------------
// Job bookkeeping
// ---------------------------------------------------------------------------

function emitJob(deps: JobDeps, id: string): void {
  const job = deps.state.job(id)
  if (job) deps.emit('diffusion:job', { job })
}

function setJobState(deps: JobDeps, id: string, next: ImageJobState): void {
  let changed = false
  deps.state.updateJob(id, (record) => {
    if (record.job.state === next || isTerminalJobState(record.job.state)) return
    record.job.state = next
    if (next === 'generating' && record.job.startedAtMs === undefined) record.job.startedAtMs = deps.now()
    changed = true
  })
  if (changed) emitJob(deps, id)
}

function setProgress(deps: JobDeps, id: string, tracker: ProgressTracker): void {
  const progress = tracker.snapshot()
  deps.state.updateJob(id, (record) => (record.job.progress = progress))
  deps.emit('diffusion:progress', { jobId: id, progress })
}

/** Move a job to a terminal state exactly once. Whether this call made the transition. */
export function finishJob(
  deps: JobDeps,
  id: string,
  result: { ok: true; outputs: GalleryImageItem[] } | { ok: false; error: DiffusionErrorBody }
): boolean {
  let transitioned = false
  deps.state.updateJob(id, (record) => {
    if (isTerminalJobState(record.job.state)) return
    transitioned = true
    record.job.finishedAtMs = deps.now()
    if (result.ok) {
      record.job.state = 'completed'
      record.job.outputs = result.outputs
      delete record.job.error
    } else {
      record.job.state = result.error.code === 'CANCELLED' ? 'cancelled' : 'failed'
      record.job.error = result.error
    }
  })
  if (transitioned) {
    if (deps.state.activeJobId === id) deps.state.activeJobId = undefined
    emitJob(deps, id)
  }
  return transitioned
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface StartedJob {
  id: string
  /** Settles when the job is over; never rejects, so a caller that only wanted the id owes nothing. */
  done: Promise<JobResult>
}

/** Validate, register and start a job. */
export async function startImageJob(deps: JobDeps, request: ImageGenerateRequest): Promise<StartedJob> {
  const { state } = deps
  const spec = state.spec
  if (!spec) throw modelNotLoadedError()
  await validateRequest(request, spec, { isFile: deps.isFile })

  const id = randomUUID().replaceAll('-', '')
  if (state.activeJobId !== undefined)
    throw diffusionError('JOB_BUSY', 'An image is already being generated.', state.activeJobId)
  state.activeJobId = id
  state.clearIdle()

  const record: JobRecord = {
    job: {
      id,
      state: 'queued',
      modelId: spec.modelId,
      request: withoutSources(request),
      createdAtMs: deps.now(),
      progress: null,
      outputs: [],
    },
    cancel: { requested: false },
  }
  state.insertJob(record)
  emitJob(deps, id)

  const done = execute(deps, id, request, record.cancel).then(
    (outcome): JobResult => {
      finishJob(deps, id, { ok: true, outputs: outcome.job.outputs })
      if (state.activeJobId === id) state.activeJobId = undefined
      state.touchIdle()
      const job = state.job(id) ?? outcome.job
      return { ok: true, outcome: { job, images: outcome.images } }
    },
    (raw: unknown): JobResult => {
      const error = errorBody(raw)
      finishJob(deps, id, { ok: false, error })
      if (state.activeJobId === id) state.activeJobId = undefined
      state.touchIdle()
      if (error.code !== 'CANCELLED') {
        const payload = { ...error, jobId: id }
        deps.emit('diffusion:error', payload)
      }
      // The record is authoritative: a cancel that raced the runner may already have marked it.
      return { ok: false, error: state.job(id)?.error ?? error }
    }
  )
  return { id, done }
}

/** Run one job to completion; the OpenAI facade's path. */
export async function runImageJob(deps: JobDeps, request: ImageGenerateRequest): Promise<JobOutcome> {
  const { done } = await startImageJob(deps, request)
  const result = await done
  if (result.ok) return result.outcome
  throw diffusionError(result.error.code, result.error.message, result.error.details)
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

interface SessionView {
  baseUrl: string
  spec: ServerSpec
}

/**
 * Replace the resident server with one for `next(spec)`, under the load lock. Once the lock is held
 * the job may already be cancelled, the model unloaded, or the spec replaced by a load or an engine
 * update: the spec is read only then, and without one nothing is spawned.
 */
async function replaceSession(
  deps: JobDeps,
  next: (current: ServerSpec) => ServerSpec,
  reason: string,
  cancel: CancelFlag
): Promise<void> {
  await deps.loadLock.run(async () => {
    if (cancel.requested) throw cancelledError()
    if (deps.state.closing) throw diffusionError('ENGINE_CRASHED', 'sd-server was stopped.')
    const current = deps.state.spec
    if (!current) throw modelNotLoadedError()
    await takeDownSession(deps)
    await loadFromSpec(deps, next(current), reason)
  })
}

/** The resident session, respawned from the spec when a cancel or a crash took the server down. */
async function ensureSession(deps: JobDeps, cancel: CancelFlag): Promise<SessionView> {
  const { state } = deps
  const alive = state.session
  if (alive && alive.server.exitStatus() === undefined) return { baseUrl: alive.baseUrl, spec: alive.spec }
  if (cancel.requested) throw cancelledError()
  await replaceSession(deps, (current) => current, 'respawn', cancel)
  const session = state.session
  if (!session) throw diffusionError('ENGINE_CRASHED', 'sd-server went away right after starting.')
  return { baseUrl: session.baseUrl, spec: session.spec }
}

type Liveness = { kind: 'alive' } | { kind: 'gone' } | { kind: 'exited'; exit: ExitInfo; tail: string[] }

function liveness(state: DiffusionState): Liveness {
  const session = state.session
  if (!session) return { kind: 'gone' }
  const exit = session.server.exitStatus()
  if (!exit) return { kind: 'alive' }
  return { kind: 'exited', exit, tail: session.server.tail() }
}

type Attempt = { kind: 'done'; outcome: JobOutcome } | { kind: 'retry-on-cpu' }

async function execute(
  deps: JobDeps,
  id: string,
  request: ImageGenerateRequest,
  cancel: CancelFlag
): Promise<JobOutcome> {
  const batchSeed = request.seed !== undefined && request.seed >= 0 ? request.seed : deps.drawSeed()
  const inputs = await resolveInputs(request, deps)
  const started = deps.now()
  for (let attempts = 1; ; attempts++) {
    const view = await ensureSession(deps, cancel)
    const body = buildImgGenRequest(request, view.spec.defaults, batchSeed, inputs)
    const attempt = await runAttempt(deps, id, request, view, body, batchSeed, cancel, started)
    if (attempt.kind === 'done') return attempt.outcome
    if (attempts > 1) throw diffusionError('ENGINE_CRASHED', 'sd-server crashed again on the CPU backend.')
    deps.log('warn', 'ggml abort on the device backend; restarting sd-server on the CPU backend')
    const spec: ServerSpec = {
      ...view.spec,
      extraArgs: cpuBackendExtraArgs(view.spec.extraArgs),
      cpuFallback: true,
    }
    await replaceSession(deps, () => spec, 'cpu-fallback', cancel)
  }
}

async function runAttempt(
  deps: JobDeps,
  id: string,
  request: ImageGenerateRequest,
  view: SessionView,
  body: Record<string, unknown>,
  batchSeed: number,
  cancel: CancelFlag,
  started: number
): Promise<Attempt> {
  if (cancel.requested) throw cancelledError()
  const lines: string[] = []
  deps.state.session?.server.setLineListener((line) => lines.push(line))
  try {
    return await pollJob(deps, id, request, view, body, batchSeed, cancel, started, lines)
  } finally {
    deps.state.session?.server.setLineListener(undefined)
  }
}

function serverFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function afterTransportError(
  deps: JobDeps,
  cancel: CancelFlag,
  what: string,
  error: unknown
): Promise<never> {
  if (cancel.requested) throw cancelledError()
  const live = liveness(deps.state)
  if (live.kind === 'exited') {
    const text = diagnosticTail(live.tail)
    throw diffusionError(classifyExit(text, exitCodeOf(live.exit)), `sd-server died during ${what}.`, text)
  }
  if (live.kind === 'gone') throw diffusionError('ENGINE_CRASHED', 'sd-server was stopped.')
  throw internalError(`The image server did not accept the ${what}.`, serverFailure(error))
}

const clip = (text: string, limit: number): string => [...text].slice(0, limit).join('')

async function pollJob(
  deps: JobDeps,
  id: string,
  request: ImageGenerateRequest,
  view: SessionView,
  body: Record<string, unknown>,
  batchSeed: number,
  cancel: CancelFlag,
  started: number,
  lines: string[]
): Promise<Attempt> {
  const { http, state, timings } = deps
  const submitted = await http
    .post(`${view.baseUrl}${IMG_GEN_PATH}`, body, timings.submitTimeoutMs)
    .catch((error: unknown) => afterTransportError(deps, cancel, 'submit', error))
  if (submitted.status === 429)
    throw diffusionError('QUEUE_FULL', "The image server's queue is full. Try again in a moment.")
  if (submitted.status === 400)
    throw diffusionError(
      'INVALID_REQUEST',
      'The image server rejected the request.',
      clip(submitted.text, 500)
    )
  if (submitted.status !== 200 && submitted.status !== 202)
    throw internalError(`The image server answered ${submitted.status} on submit.`, clip(submitted.text, 500))
  let accepted: unknown
  try {
    accepted = JSON.parse(submitted.text)
  } catch (error) {
    throw internalError('sd-server returned a non-JSON submit response.', serverFailure(error))
  }
  const serverJobId = (accepted as { id?: unknown } | null)?.id
  if (typeof serverJobId !== 'string') throw internalError('sd-server returned no job id.')
  state.updateJob(id, (record) => (record.serverJobId = serverJobId))

  const tracker = new ProgressTracker(sampledSteps(request), request.batchSize, deps.now)
  const jobUrl = `${view.baseUrl}${JOBS_PATH}/${serverJobId}`
  const deadline = started + timings.generationCeilingMs
  const gpu = new GpuFaultWatch()
  const drain = () => {
    for (const line of lines.splice(0)) {
      tracker.onLine(line)
      gpu.onLine(line)
    }
  }
  // Metal stays in its error state after an address fault, so every retry on this process would
  // fail at once: retire it, keep the spec, and the next job respawns a clean server.
  const retireAfterGpuFault = async (): Promise<void> => {
    drain()
    if (!gpu.tripped) return
    const error = diffusionError(
      'ENGINE_CRASHED',
      'The GPU stopped this render. The image engine was restarted; try again at a smaller resolution.',
      diagnosticTail(tracker.logLines(), 20, 1500)
    )
    await stopKeepingSpec(deps, 'gpu-fault', errorBody(error))
    throw error
  }

  for (;;) {
    drain()
    if (tracker.takeDirty()) setProgress(deps, id, tracker)

    const live = liveness(state)
    if (live.kind === 'gone') {
      if (cancel.requested) throw cancelledError()
      throw diffusionError('ENGINE_CRASHED', 'sd-server was stopped during generation.')
    }
    if (live.kind === 'exited') {
      if (cancel.requested) throw cancelledError()
      const text = diagnosticTail(live.tail)
      if (isGgmlUnsupportedOpAbort(text) && !view.spec.cpuFallback) return { kind: 'retry-on-cpu' }
      const code = classifyExit(text, exitCodeOf(live.exit))
      const error = diffusionError(
        code,
        code === 'OUT_OF_MEMORY'
          ? 'sd-server ran out of memory while generating.'
          : `sd-server exited during generation (${describeExit(live.exit)}).`,
        text
      )
      await stopKeepingSpec(deps, 'crashed', errorBody(error))
      throw error
    }

    if (deps.now() > deadline) {
      await http.post(`${jobUrl}/cancel`, undefined, 5_000).catch(() => undefined)
      const error = internalError(
        `Generation exceeded ${Math.round(timings.generationCeilingMs / 3_600_000)} hours and was stopped.`
      )
      await stopKeepingSpec(deps, 'timeout', errorBody(error))
      throw error
    }

    const polled = await http.get(jobUrl, timings.statusTimeoutMs).catch((error: unknown) => {
      if (cancel.requested) throw cancelledError()
      deps.log('debug', `job poll failed: ${serverFailure(error)}`)
      return undefined
    })
    if (!polled) {
      await deps.sleep(timings.pollIntervalMs)
      continue
    }
    if (polled.status === 404 || polled.status === 410)
      throw diffusionError('JOB_NOT_FOUND', 'The image server forgot the job.')
    let job: Record<string, unknown> | undefined
    if (polled.status === 200) {
      try {
        const parsed: unknown = JSON.parse(polled.text)
        job = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
      } catch {
        job = undefined
      }
    }
    if (!job) {
      await deps.sleep(timings.pollIntervalMs)
      continue
    }
    switch (job['status']) {
      case 'queued':
        tracker.setPhase('queued')
        break
      case 'generating':
        setJobState(deps, id, 'generating')
        if (tracker.phase === 'queued') tracker.setPhase('encoding')
        break
      case 'completed': {
        setJobState(deps, id, 'generating')
        tracker.setPhase('saving')
        setProgress(deps, id, tracker)
        await retireAfterGpuFault()
        const pngs = decodeImages(job)
        const { items, images } = await saveOutputs(deps, id, request, view, batchSeed, started, pngs)
        const record = state.job(id)
        if (!record) throw internalError('job record vanished')
        return { kind: 'done', outcome: { job: { ...record, outputs: items }, images } }
      }
      case 'failed': {
        await retireAfterGpuFault()
        const failure = (job['error'] ?? {}) as Record<string, unknown>
        const code = typeof failure['code'] === 'string' ? failure['code'] : 'error'
        const message = typeof failure['message'] === 'string' ? failure['message'] : ''
        // The job only ever says `generate_image returned no results`; why is in what the server printed.
        drain()
        const said = diagnosticTail(tracker.logLines(), 12, 1200)
        const outOfMemory = classifyExit(`${message}\n${said}`, undefined) === 'OUT_OF_MEMORY'
        deps.log('warn', `sd-server failed the job (${code}: ${message}):\n${said}`)
        throw diffusionError(
          outOfMemory ? 'OUT_OF_MEMORY' : 'INTERNAL',
          outOfMemory
            ? 'sd-server ran out of memory while generating.'
            : 'The image server failed to generate.',
          `${code}: ${message}\n${said}`
        )
      }
      case 'cancelled':
        throw cancelledError()
      default:
        break
    }
    if (tracker.takeDirty()) setProgress(deps, id, tracker)
    await deps.sleep(timings.pollIntervalMs)
  }
}

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

async function saveOutputs(
  deps: JobDeps,
  id: string,
  request: ImageGenerateRequest,
  view: SessionView,
  batchSeed: number,
  started: number,
  pngs: Buffer[]
): Promise<{ items: GalleryImageItem[]; images: Buffer[] }> {
  // A frame sd.cpp returned after a numerical overflow is not an image; nothing of the batch is kept.
  for (const png of pngs)
    if (await isBlankOutput(png))
      throw diffusionError('INVALID_OUTPUT', 'The image engine produced a blank frame. Nothing was saved.')
  const outputDir = deps.state.outputDir()
  const { spec } = view
  const workflow = workflowOf(request)
  const createdAtMs = deps.now()
  const durationMs = Math.max(createdAtMs - started, 0)
  const items: GalleryImageItem[] = []
  const images: Buffer[] = []
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
    const { item, bytes } = await deps.gallery.save(outputDir, recipe, png)
    deps.state.updateJob(id, (record) => record.job.outputs.push(item))
    items.push(item)
    images.push(bytes)
  }
  return { items, images }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

async function waitTerminal(deps: JobDeps, id: string, graceMs: number): Promise<ImageJobState | undefined> {
  const deadline = deps.now() + graceMs
  for (;;) {
    const state = deps.state.job(id)?.state
    if (state === undefined) return undefined
    if (isTerminalJobState(state) || deps.now() >= deadline) return state
    await deps.sleep(deps.timings.cancelPollMs)
  }
}

/**
 * Cancel a job. A queued job cancels natively; a generating one gets the engine's cancel and a grace
 * period, twice when the engine promised `cancelGenerating`; after that the server is stopped. The
 * spec stays, so the next job respawns it.
 */
export async function cancelJob(
  deps: JobDeps,
  id: string,
  graceMs = deps.timings.cancelGraceMs
): Promise<DiffusionCancelResult> {
  const { state } = deps
  const record = state.record(id)
  if (!record) throw diffusionError('JOB_NOT_FOUND', 'That job no longer exists.')
  if (isTerminalJobState(record.job.state))
    return { cancelled: record.job.state === 'cancelled', serverStopped: false }
  record.cancel.requested = true

  const session = state.session
  if (session && record.serverJobId !== undefined)
    await deps.http
      .post(`${session.baseUrl}${JOBS_PATH}/${record.serverJobId}/cancel`, undefined, 5_000)
      .catch(() => undefined)

  const rounds = session?.server.capabilities.cancelGenerating ? 2 : 1
  for (let round = 0; round < rounds; round++) {
    const final = await waitTerminal(deps, id, graceMs)
    if (final !== undefined && isTerminalJobState(final))
      return { cancelled: final === 'cancelled', serverStopped: false }
  }

  // sd-server will not interrupt a running generation: stop the process.
  deps.log('warn', `cancel not honoured within ${graceMs} ms; stopping sd-server`)
  await stopKeepingSpec(deps, 'cancelled')
  finishJob(deps, id, { ok: false, error: errorBody(cancelledError()) })
  return { cancelled: true, serverStopped: true }
}

/** Read a source image from disk; the default `readSource`. */
export const readSourceFile = (path: string): Promise<Buffer> => readFile(path)
