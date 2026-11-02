/**
 * Jobs: validate, send to `audiocpp_server`, save, and the cancel path. One job at a time; the
 * request is synchronous (audio.cpp has no job API), so a job moves through phases only —
 * `queued`, `loading` while a server stopped by a cancel or a crash comes back, `generating` while
 * the engine runs, `saving` while the clip is written — each one an `audio:job` event.
 *
 * Cancel: audio.cpp cannot interrupt a running request and goes on generating after a JSON client
 * hangs up, so a cancel aborts the request and stops the process, keeping the spec; the next job
 * respawns the server from it. A job not generating yet just ends.
 */

import { randomInt, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type {
  AudioCancelResult,
  AudioErrorBody,
  AudioGalleryItem,
  AudioGenerateRequest,
  AudioJob,
  AudioJobPhase,
  AudioMode,
  AudioSource,
} from '../contracts/index.js'
import type { AsyncMutex } from '../diffusion/index.js'
import { audioError, audioErrorBody, audioInternalError } from './errors.js'
import type { AudioGallery } from './gallery.js'
import { AudioTimeoutError } from './http.js'
import type { AudioHttpClient } from './http.js'
import { audioCrashError, engineErrorMessage, engineRejection } from './output.js'
import { buildAudioRecipe } from './recipe.js'
import {
  buildSpeechBody,
  buildTaskBody,
  decodeTaskAudio,
  extraOptions,
  SPEECH_PATH,
  TASK_PATH,
} from './request.js'
import {
  emitAudioError,
  loadFromSpec,
  modelNotLoadedError,
  stopKeepingSpec,
  takeDownSession,
} from './session.js'
import type { AudioSessionDeps } from './session.js'
import { isTerminalAudioJobState } from './state.js'
import type { AudioJobRecord } from './state.js'
import { MAX_VOICE_REF_BYTES } from './types.js'
import type { AudioServerHandle, AudioServerSpec } from './types.js'
import { parseWav, stripAudioDataUrl } from './wav.js'

export interface AudioJobTimings {
  /** Only stops a wedged engine from holding the slot forever; a long song on a CPU takes many minutes. */
  generationCeilingMs: number
  /** How long a dropped connection waits for the server's exit to show before it is called a crash. */
  exitWaitMs: number
}

export const DEFAULT_AUDIO_JOB_TIMINGS: AudioJobTimings = {
  generationCeilingMs: 6 * 60 * 60 * 1000,
  exitWaitMs: 1_000,
}

export interface AudioJobDeps extends AudioSessionDeps {
  http: AudioHttpClient
  gallery: AudioGallery
  loadLock: AsyncMutex
  timings: AudioJobTimings
  drawSeed: () => number
  /** A reference voice from disk, refused when it is larger than `maxBytes`. */
  readSource: (path: string, maxBytes: number) => Promise<Buffer>
}

export interface AudioJobOutcome {
  job: AudioJob
  item: AudioGalleryItem
  /** The clip's bytes, as saved. */
  wav: Buffer
}

export type AudioJobResult = { ok: true; outcome: AudioJobOutcome } | { ok: false; error: AudioErrorBody }

export interface StartedAudioJob {
  job: AudioJob
  /** Settles when the job is over; never rejects. */
  done: Promise<AudioJobResult>
}

export function drawAudioSeed(): number {
  return randomInt(0, 0x8000_0000)
}

const cancelledError = () => audioError('CANCELLED', 'The job was cancelled.')

/** A reference voice file, read whole once it is known to be small enough. */
export async function readVoiceRefFile(path: string, maxBytes: number): Promise<Buffer> {
  const meta = await stat(path).catch(() => undefined)
  if (!meta || !meta.isFile())
    throw audioError('INVALID_REQUEST', 'The reference voice file was not found.', path)
  if (meta.size > maxBytes)
    throw audioError('INVALID_REQUEST', 'The reference voice is larger than 5 MiB.', `${meta.size} bytes`)
  return readFile(path).catch((error: unknown) => {
    throw audioError(
      'INVALID_REQUEST',
      'The reference voice file could not be read.',
      error instanceof Error ? error.message : String(error)
    )
  })
}

/** The reference voice as the engine takes it: a WAV of at most 5 MiB, base64. */
export async function resolveVoiceRef(
  source: AudioSource,
  readSource: AudioJobDeps['readSource']
): Promise<string> {
  let bytes: Buffer
  if ('path' in source) bytes = await readSource(source.path, MAX_VOICE_REF_BYTES)
  else {
    const payload = stripAudioDataUrl(source.base64)
    // Refused before it is decoded: four characters carry three bytes.
    if (Math.floor((payload.length * 3) / 4) > MAX_VOICE_REF_BYTES + 2)
      throw audioError(
        'INVALID_REQUEST',
        'The reference voice is larger than 5 MiB.',
        `${payload.length} base64 characters`
      )
    bytes = Buffer.from(payload, 'base64')
    if (bytes.length > MAX_VOICE_REF_BYTES)
      throw audioError(
        'INVALID_REQUEST',
        'The reference voice is larger than 5 MiB.',
        `${bytes.length} bytes`
      )
  }
  if (!parseWav(bytes)) throw audioError('INVALID_REQUEST', 'The reference voice is not a WAV file.')
  return bytes.toString('base64')
}

/** The request as the job record keeps it: inline audio bytes blanked, file paths kept. */
export function withoutInlineAudio(request: AudioGenerateRequest): AudioGenerateRequest {
  const copy = structuredClone(request)
  if (copy.voiceRef && 'base64' in copy.voiceRef) copy.voiceRef = { base64: '' }
  return copy
}

const MODE_WORDS: Readonly<Record<AudioMode, string>> = {
  speech: 'speech',
  music: 'music',
  effects: 'sound effects',
}

// ---------------------------------------------------------------------------
// Job bookkeeping
// ---------------------------------------------------------------------------

function emitJob(deps: AudioJobDeps, id: string): void {
  const job = deps.state.job(id)
  if (job) deps.emit('audio:job', { job })
}

/** Move a job to `phase` (and to `generating` with it), never out of a terminal state. */
export function setJobPhase(deps: AudioJobDeps, id: string, phase: AudioJobPhase): void {
  let changed = false
  deps.state.updateJob(id, (job) => {
    if (isTerminalAudioJobState(job.state)) return
    const now = deps.now()
    job.progress = { phase, elapsedMs: now - job.createdAtMs }
    if ((phase === 'generating' || phase === 'saving') && job.state === 'queued') {
      job.state = 'generating'
      job.startedAtMs = now
    }
    changed = true
  })
  if (changed) emitJob(deps, id)
}

/** Move a job to a terminal state exactly once. Whether this call made the transition. */
export function finishAudioJob(
  deps: AudioJobDeps,
  id: string,
  result: { ok: true; item: AudioGalleryItem } | { ok: false; error: AudioErrorBody }
): boolean {
  let transitioned = false
  deps.state.updateJob(id, (job) => {
    if (isTerminalAudioJobState(job.state)) return
    transitioned = true
    const now = deps.now()
    job.finishedAtMs = now
    if (job.progress) job.progress = { ...job.progress, elapsedMs: now - job.createdAtMs }
    if (result.ok) {
      job.state = 'completed'
      job.output = result.item
      delete job.error
    } else {
      job.state = result.error.code === 'CANCELLED' ? 'cancelled' : 'failed'
      job.error = result.error
    }
  })
  if (transitioned) {
    if (deps.state.activeJobId === id) deps.state.activeJobId = undefined
    emitJob(deps, id)
  }
  return transitioned
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Validate, register and start a job in `mode` on the loaded model. */
export async function startAudioJob(
  deps: AudioJobDeps,
  mode: AudioMode,
  request: AudioGenerateRequest
): Promise<StartedAudioJob> {
  const { state } = deps
  if (state.closing) throw audioError('ENGINE_CRASHED', 'The audio engine is shutting down.')
  const spec = state.spec
  if (!spec) throw modelNotLoadedError()
  if (spec.mode !== mode)
    throw audioError(
      'UNSUPPORTED_MODE',
      `The loaded model makes ${MODE_WORDS[spec.mode]}, not ${MODE_WORDS[mode]}.`,
      `${spec.modelId}: ${spec.mode}`
    )
  if (request.text.trim() === '') throw audioError('INVALID_REQUEST', 'Say what to make.')
  const busy = () => {
    if (state.activeJobId !== undefined)
      throw audioError('JOB_BUSY', 'Another clip is being made. Wait for it, or stop it.', state.activeJobId)
  }
  busy()
  const speech = mode === 'speech'
  if (speech && request.voiceRef === undefined && state.capabilities?.requiresVoiceRef === true)
    throw audioError(
      'INVALID_REQUEST',
      'This voice model speaks only in a cloned voice: add a reference voice.'
    )
  const voiceRef =
    speech && request.voiceRef !== undefined
      ? await resolveVoiceRef(request.voiceRef, deps.readSource)
      : undefined
  // Reading the reference took a moment: another job may have started meanwhile.
  if (state.closing) throw audioError('ENGINE_CRASHED', 'The audio engine is shutting down.')
  if (state.spec !== spec)
    throw audioError(
      'CANCELLED',
      'The audio model changed while the reference voice was being read. Try again.'
    )
  busy()

  const id = randomUUID().replaceAll('-', '')
  state.activeJobId = id
  state.clearIdle()
  const createdAtMs = deps.now()
  const record: AudioJobRecord = {
    job: {
      id,
      state: 'queued',
      mode,
      modelId: spec.modelId,
      request: withoutInlineAudio(request),
      createdAtMs,
      progress: { phase: 'queued', elapsedMs: 0 },
      output: null,
    },
    cancel: { requested: false, abort: new AbortController() },
  }
  state.insertJob(record)
  emitJob(deps, id)

  const done = execute(deps, id, mode, request, voiceRef, record).then(
    (outcome): AudioJobResult => {
      finishAudioJob(deps, id, { ok: true, item: outcome.item })
      state.touchIdle()
      const job = state.job(id) as AudioJob
      return { ok: true, outcome: { job, item: outcome.item, wav: outcome.wav } }
    },
    (raw: unknown): AudioJobResult => {
      const error = audioErrorBody(raw)
      finishAudioJob(deps, id, { ok: false, error })
      state.touchIdle()
      if (error.code !== 'CANCELLED') emitAudioError(deps, id, error)
      // The record is authoritative: a cancel that raced the runner may already have marked it.
      return { ok: false, error: state.job(id)?.error ?? error }
    }
  )
  record.done = done
  return { job: state.job(id) as AudioJob, done }
}

/** Run one job to completion; the path a caller that awaits the clip takes. */
export async function runAudioJob(
  deps: AudioJobDeps,
  mode: AudioMode,
  request: AudioGenerateRequest
): Promise<AudioJobOutcome> {
  const { done } = await startAudioJob(deps, mode, request)
  const result = await done
  if (result.ok) return result.outcome
  throw audioError(result.error.code, result.error.message, result.error.details)
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

interface SessionView {
  baseUrl: string
  spec: AudioServerSpec
  server: AudioServerHandle
}

/** The resident session, respawned from the kept spec when a cancel or a crash took the server down. */
async function ensureSession(deps: AudioJobDeps, id: string, record: AudioJobRecord): Promise<SessionView> {
  const { state } = deps
  const view = (): SessionView | undefined => {
    const session = state.session
    return session && session.server.exitStatus() === undefined
      ? { baseUrl: session.baseUrl, spec: session.spec, server: session.server }
      : undefined
  }
  const alive = view()
  if (alive) return alive
  if (record.cancel.requested) throw cancelledError()
  setJobPhase(deps, id, 'loading')
  await deps.loadLock.run(async () => {
    // Once the lock is held the job may be cancelled, the model unloaded or replaced, or the server
    // already back: the spec is read only now.
    if (record.cancel.requested) throw cancelledError()
    if (state.closing) throw audioError('ENGINE_CRASHED', 'The audio engine is shutting down.')
    if (view()) return
    const current = state.spec
    if (!current) throw modelNotLoadedError()
    await takeDownSession(deps)
    await loadFromSpec(deps, current, 'respawn', record.cancel.abort.signal)
  })
  const back = view()
  if (!back) throw audioError('ENGINE_CRASHED', 'The audio engine went away right after starting.')
  return back
}

async function execute(
  deps: AudioJobDeps,
  id: string,
  mode: AudioMode,
  request: AudioGenerateRequest,
  voiceRef: string | undefined,
  record: AudioJobRecord
): Promise<{ item: AudioGalleryItem; wav: Buffer }> {
  const { state, timings } = deps
  const seed = request.seed !== undefined && request.seed >= 0 ? request.seed : deps.drawSeed()
  const view = await ensureSession(deps, id, record)
  if (record.cancel.requested) throw cancelledError()
  const speech = mode === 'speech'
  const body = speech
    ? buildSpeechBody(view.spec.modelId, request, seed, voiceRef)
    : buildTaskBody(view.spec.modelId, request, seed)
  setJobPhase(deps, id, 'generating')
  const started = deps.now()
  let response
  try {
    response = await deps.http.post(`${view.baseUrl}${speech ? SPEECH_PATH : TASK_PATH}`, body, {
      timeoutMs: timings.generationCeilingMs,
      signal: record.cancel.abort.signal,
    })
  } catch (error) {
    return afterTransportError(deps, record, view, error)
  }
  const durationMs = deps.now() - started
  if (record.cancel.requested) throw cancelledError()
  if (response.status === 503)
    throw audioError(
      'JOB_BUSY',
      'The audio engine is busy with another request.',
      engineErrorMessage(response.body.toString('utf8'))
    )
  if (response.status !== 200) throw engineRejection(response.status, response.body.toString('utf8'))
  const wav = speech ? response.body : decodeTaskAudio(response.body)
  if (!parseWav(wav))
    throw audioError(
      'INVALID_OUTPUT',
      'The audio engine returned something that is not a WAV.',
      response.contentType
    )

  setJobPhase(deps, id, 'saving')
  if (record.cancel.requested) throw cancelledError()
  const options = extraOptions(mode, request)
  if (speech && request.instruct !== undefined) options['instruct'] = request.instruct
  const recipe = buildAudioRecipe({
    jobId: id,
    request,
    spec: view.spec,
    seed,
    options,
    createdAtMs: record.job.createdAtMs,
    durationMs,
  })
  const item = await deps.gallery.save(state.outputDir(), recipe, wav)
  return { item, wav }
}

/**
 * The request to the engine failed without an answer. A cancel is a cancel; past the ceiling the
 * server is stopped; otherwise the server crashed or dropped the connection, and is stopped too —
 * keeping the spec, so the next job brings it back.
 */
async function afterTransportError(
  deps: AudioJobDeps,
  record: AudioJobRecord,
  view: SessionView,
  raw: unknown
): Promise<never> {
  if (record.cancel.requested) throw cancelledError()
  const reason = raw instanceof Error ? raw.message : String(raw)
  const ours = () => deps.state.session?.server === view.server
  if (raw instanceof AudioTimeoutError) {
    const error = audioInternalError(
      `Generation exceeded ${Math.round(deps.timings.generationCeilingMs / 3_600_000)} hours and was stopped.`,
      reason
    )
    if (ours()) await stopKeepingSpec(deps, 'timeout', audioErrorBody(error))
    throw error
  }
  const exit =
    view.server.exitStatus() ??
    (await Promise.race([view.server.exited, deps.sleep(deps.timings.exitWaitMs).then(() => undefined)]))
  const error = exit
    ? audioCrashError(exit, view.server.tail())
    : audioError('ENGINE_CRASHED', 'The audio engine dropped the connection while generating.', reason)
  deps.log('warn', `audio job failed: ${error.message} (${error.details ?? reason})`)
  if (ours()) await stopKeepingSpec(deps, 'crashed', audioErrorBody(error))
  throw error
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Cancel a job. While the engine generates, the request is aborted and the server stopped (the spec
 * stays, so the next job respawns it); a clip already being saved is kept. Before that the job ends
 * here and now: its runner may be waiting for the load lock to respawn the server, and the caller may
 * hold that lock (a load, an unload, an engine update), so nothing here waits for the runner then.
 */
export async function cancelAudioJob(deps: AudioJobDeps, id: string): Promise<AudioCancelResult> {
  const { state } = deps
  const record = state.record(id)
  if (!record) throw audioError('JOB_NOT_FOUND', 'That job no longer exists.')
  if (isTerminalAudioJobState(record.job.state))
    return { cancelled: record.job.state === 'cancelled', serverStopped: false }
  record.cancel.requested = true
  const generating = record.job.progress?.phase === 'generating'
  record.cancel.abort.abort()
  if (generating) {
    deps.log('info', 'cancelling an audio job: stopping audiocpp_server, which cannot interrupt a request')
    await stopKeepingSpec(deps, 'cancelled')
    finishAudioJob(deps, id, { ok: false, error: audioErrorBody(cancelledError()) })
    return { cancelled: true, serverStopped: true }
  }
  if (record.job.progress?.phase === 'saving') {
    // The engine has answered and the clip is being written, which needs no lock.
    await record.done
    return { cancelled: state.job(id)?.state === 'cancelled', serverStopped: false }
  }
  finishAudioJob(deps, id, { ok: false, error: audioErrorBody(cancelledError()) })
  return { cancelled: true, serverStopped: false }
}
