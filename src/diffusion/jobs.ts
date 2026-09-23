/**
 * Jobs: validate, submit to `sd-server`, poll, save, and the cancel path. Shared by the control
 * routes and the OpenAI facades, so every caller gets the same validation, events, gallery and idle
 * timer. Port of `jobs.rs` in `tauri-plugin-atomic-diffusion` (app commit `ec1fd3ea7`), made
 * generic over a `JobKind` when video arrived: the loop, the crash handling, the CPU fallback and
 * the cancel ladder are one code path; what a kind sends, decodes and saves lives with the kind
 * (`image-job.ts`, `video-job.ts`).
 *
 * One deliberate change: a respawn re-checks, once it holds the load lock, that nobody cancelled
 * the job or unloaded the model while it waited. The plugin took the lock and spawned regardless.
 */

import { randomInt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  DiffusionCancelResult,
  DiffusionErrorBody,
  ImageGenerateRequest,
  ImageJob,
  ImageJobState,
  VideoGenerateRequest,
  VideoJob,
} from '../contracts/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import { cpuBackendExtraArgs, isGgmlUnsupportedOpAbort } from './args.js'
import { cancelledError, diffusionError, errorBody, internalError, modelNotLoadedError } from './errors.js'
import type { Gallery } from './gallery.js'
import type { SdHttpClient } from './http.js'
import { IMAGE_JOB_KIND } from './image-job.js'
import { VIDEO_JOB_KIND } from './video-job.js'
import type { VideoGallery } from './video-gallery.js'
import type { AnyJobKind, JobCommon, JobKind } from './job-kind.js'
import type { AsyncMutex } from './mutex.js'
import { classifyExit, diagnosticTail, GpuFaultWatch } from './progress.js'
import { describeExit, exitCodeOf } from './server-process.js'
import { loadFromSpec, stopKeepingSpec, takeDownSession } from './session.js'
import type { SessionDeps } from './session.js'
import type { CancelFlag, DiffusionState, JobKindId, JobRecord } from './state.js'
import { isTerminalJobState } from './state.js'
import { ProgressTracker } from './tracker.js'
import type { ServerSpec } from './types.js'

export { decodeImages, resolveInputs, withoutSources } from './image-job.js'

export const IMG_GEN_PATH = '/sdcpp/v1/img_gen'
export const VID_GEN_PATH = '/sdcpp/v1/vid_gen'
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
  videoGallery: VideoGallery
  loadLock: AsyncMutex
  timings: JobTimings
  drawSeed: () => number
  readSource: (path: string) => Promise<Buffer>
  isFile: (path: string) => Promise<boolean>
}

export interface JobOutcome<J = ImageJob> {
  job: J
  /** The final bytes: every PNG (recipe included) in batch order, or the one video. */
  images: Buffer[]
}

export type JobResult<J = ImageJob> =
  { ok: true; outcome: JobOutcome<J> } | { ok: false; error: DiffusionErrorBody }

/** The runner path a record belongs to. */
const kindOf = (id: JobKindId): AnyJobKind => (id === 'video' ? VIDEO_JOB_KIND : IMAGE_JOB_KIND)

export function drawSeed(): number {
  return randomInt(0, 0x1_0000_0000)
}

// ---------------------------------------------------------------------------
// Job bookkeeping
// ---------------------------------------------------------------------------

function emitJob(deps: JobDeps, id: string): void {
  const record = deps.state.record(id)
  if (record) kindOf(record.kind).emitJob(deps.emit, structuredClone(record.job))
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

function setProgress(deps: JobDeps, id: string, kind: AnyJobKind, tracker: ProgressTracker): void {
  const progress: unknown = kind.progress(tracker.snapshot())
  deps.state.updateJob(id, (record) => ((record.job as JobCommon<unknown, unknown>).progress = progress))
  kind.emitProgress(deps.emit, id, progress)
}

/** Move a job to a terminal state exactly once. Whether this call made the transition. */
export function finishJob<Item>(
  deps: JobDeps,
  id: string,
  result: { ok: true; outputs: Item[] } | { ok: false; error: DiffusionErrorBody }
): boolean {
  let transitioned = false
  deps.state.updateJob(id, (record) => {
    if (isTerminalJobState(record.job.state)) return
    transitioned = true
    record.job.finishedAtMs = deps.now()
    if (result.ok) {
      record.job.state = 'completed'
      ;(record.job as unknown as JobCommon<Item, unknown>).outputs = result.outputs
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

export interface StartedJob<J = ImageJob> {
  id: string
  /** Settles when the job is over; never rejects, so a caller that only wanted the id owes nothing. */
  done: Promise<JobResult<J>>
}

/** Validate, register and start a job of `kind`. */
export async function startJob<Req, Job extends JobCommon<Item, Progress>, Item, Progress, Decoded>(
  deps: JobDeps,
  kind: JobKind<Req, Job, Item, Progress, Decoded>,
  request: Req
): Promise<StartedJob<Job>> {
  const { state } = deps
  const spec = state.spec
  if (!spec) throw modelNotLoadedError()
  if (spec.modality !== kind.modality)
    throw diffusionError('MODEL_INCOMPATIBLE', kind.messages.wrongModel, spec.modelId)
  await kind.validate(request, spec, { isFile: deps.isFile })

  const id = randomUUID().replaceAll('-', '')
  if (state.activeJobId !== undefined) throw diffusionError('JOB_BUSY', kind.messages.busy, state.activeJobId)
  state.activeJobId = id
  state.clearIdle()

  const record: JobRecord = {
    kind: kind.id,
    job: kind.newJob(id, spec, request, deps.now()) as unknown as ImageJob | VideoJob,
    cancel: { requested: false },
  }
  state.insertJob(record)
  emitJob(deps, id)

  const done = execute(deps, kind, id, request, record.cancel).then(
    (outcome): JobResult<Job> => {
      finishJob(deps, id, { ok: true, outputs: outcome.job.outputs })
      if (state.activeJobId === id) state.activeJobId = undefined
      state.touchIdle()
      const job = (state.anyJob(id) as Job | undefined) ?? outcome.job
      return { ok: true, outcome: { job, images: outcome.images } }
    },
    (raw: unknown): JobResult<Job> => {
      const error = errorBody(raw)
      finishJob(deps, id, { ok: false, error })
      if (state.activeJobId === id) state.activeJobId = undefined
      state.touchIdle()
      if (error.code !== 'CANCELLED') {
        const payload = { ...error, jobId: id }
        deps.emit('diffusion:error', payload)
      }
      // The record is authoritative: a cancel that raced the runner may already have marked it.
      return { ok: false, error: state.anyJob(id)?.error ?? error }
    }
  )
  return { id, done }
}

/** Validate, register and start an image job. */
export const startImageJob = (deps: JobDeps, request: ImageGenerateRequest): Promise<StartedJob> =>
  startJob(deps, IMAGE_JOB_KIND, request)

/** Run one job of `kind` to completion; the facades' path. */
export async function runJob<Req, Job extends JobCommon<Item, Progress>, Item, Progress, Decoded>(
  deps: JobDeps,
  kind: JobKind<Req, Job, Item, Progress, Decoded>,
  request: Req
): Promise<JobOutcome<Job>> {
  const { done } = await startJob(deps, kind, request)
  const result = await done
  if (result.ok) return result.outcome
  throw diffusionError(result.error.code, result.error.message, result.error.details)
}

/** Run one image job to completion; the OpenAI facade's path. */
export const runImageJob = (deps: JobDeps, request: ImageGenerateRequest): Promise<JobOutcome> =>
  runJob(deps, IMAGE_JOB_KIND, request)

/** Validate, register and start a video job. */
export const startVideoJob = (deps: JobDeps, request: VideoGenerateRequest): Promise<StartedJob<VideoJob>> =>
  startJob(deps, VIDEO_JOB_KIND, request)

/** Run one video job to completion; `images` holds the one clip. */
export const runVideoJob = (deps: JobDeps, request: VideoGenerateRequest): Promise<JobOutcome<VideoJob>> =>
  runJob(deps, VIDEO_JOB_KIND, request)

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

type Attempt<J> = { kind: 'done'; outcome: JobOutcome<J> } | { kind: 'retry-on-cpu' }

/** A request's own seed when it has one, else a drawn one; the record and the recipe carry it. */
function seedOf(request: unknown, deps: JobDeps): number {
  const seed = (request as { seed?: number }).seed
  return seed !== undefined && seed >= 0 ? seed : deps.drawSeed()
}

async function execute<Req, Job extends JobCommon<Item, Progress>, Item, Progress, Decoded>(
  deps: JobDeps,
  kind: JobKind<Req, Job, Item, Progress, Decoded>,
  id: string,
  request: Req,
  cancel: CancelFlag
): Promise<JobOutcome<Job>> {
  const seed = seedOf(request, deps)
  const inputs = await kind.resolveInputs(request, deps)
  const started = deps.now()
  for (let attempts = 1; ; attempts++) {
    const view = await ensureSession(deps, cancel)
    kind.preflight?.(deps.state.session?.server.capabilities)
    const body = kind.buildBody(request, view.spec, seed, inputs)
    const attempt = await runAttempt(deps, kind, id, request, view, body, seed, cancel, started)
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

async function runAttempt<Req, Job extends JobCommon<Item, Progress>, Item, Progress, Decoded>(
  deps: JobDeps,
  kind: JobKind<Req, Job, Item, Progress, Decoded>,
  id: string,
  request: Req,
  view: SessionView,
  body: Record<string, unknown>,
  seed: number,
  cancel: CancelFlag,
  started: number
): Promise<Attempt<Job>> {
  if (cancel.requested) throw cancelledError()
  const lines: string[] = []
  deps.state.session?.server.setLineListener((line) => lines.push(line))
  try {
    return await pollJob(deps, kind, id, request, view, body, seed, cancel, started, lines)
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

async function pollJob<Req, Job extends JobCommon<Item, Progress>, Item, Progress, Decoded>(
  deps: JobDeps,
  kind: JobKind<Req, Job, Item, Progress, Decoded>,
  id: string,
  request: Req,
  view: SessionView,
  body: Record<string, unknown>,
  seed: number,
  cancel: CancelFlag,
  started: number,
  lines: string[]
): Promise<Attempt<Job>> {
  const { http, state, timings } = deps
  const submitted = await http
    .post(`${view.baseUrl}${kind.submitPath}`, body, timings.submitTimeoutMs)
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

  const shape = kind.trackerShape(request)
  const tracker = new ProgressTracker(shape.steps, shape.batch, deps.now)
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
    if (tracker.takeDirty()) setProgress(deps, id, kind, tracker)

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
        setProgress(deps, id, kind, tracker)
        await retireAfterGpuFault()
        const decoded = kind.decode(job)
        const { items, bytes } = await kind.save(
          deps,
          { id, request, spec: view.spec, seed, startedAt: started },
          decoded
        )
        const record = state.anyJob(id) as Job | undefined
        if (!record) throw internalError('job record vanished')
        return { kind: 'done', outcome: { job: { ...record, outputs: items }, images: bytes } }
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
          outOfMemory ? kind.messages.outOfMemory : kind.messages.failed,
          `${code}: ${message}\n${said}`
        )
      }
      case 'cancelled':
        throw cancelledError()
      default:
        break
    }
    if (tracker.takeDirty()) setProgress(deps, id, kind, tracker)
    await deps.sleep(timings.pollIntervalMs)
  }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

async function waitTerminal(deps: JobDeps, id: string, graceMs: number): Promise<ImageJobState | undefined> {
  const deadline = deps.now() + graceMs
  for (;;) {
    const state = deps.state.anyJob(id)?.state
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

  const rounds = session && kindOf(record.kind).cancelGenerating(session.server.capabilities) ? 2 : 1
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
