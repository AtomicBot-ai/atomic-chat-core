import { classifyFailure } from './diagnostics.js'
/**
 * What each failure the core observes becomes as a report — or null when it is not a defect worth
 * an issue. Pure: callers hand in what they know, the reporter scrubs and sends.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents, LocalProviderId } from '../contracts/index.js'
import { isCrashExit, signalNumber } from '../runtime/llamacpp/index.js'
import { errorCodeOf, isCancellation, isClientAbort, markerLines, oomSubtype, quantOf } from './policy.js'
import { headline } from './scrub.js'
import type { ErrorReport, ErrorSink } from './types.js'

/** Hand a report to the sink when there is one and the failure is worth reporting. */
export function captureReport(sink: ErrorSink | undefined, report: ErrorReport | null): void {
  if (sink && report) sink.capture(report)
}

/** A crash-looping engine is one report per model, code and window (the web app's throttle). */
export const ENGINE_THROTTLE_MS = 5 * 60_000

function modelTag(modelId: string): string {
  return modelId.replace(/\\/g, '/')
}

function detailsOf(error: unknown): string | undefined {
  if (error instanceof AtomicCoreError) return error.details ?? error.message
  return error instanceof Error ? error.message : undefined
}

// ── the daemon process ────────────────────────────────────────────────────────

export type ProcessFailureSource = 'uncaught_exception' | 'unhandled_rejection' | 'startup' | 'event_listener'

/** A throw nothing caught: the daemon dies (fatal), or an event listener lost one event (error). */
export function processFailureReport(
  source: ProcessFailureSource,
  error: unknown,
  context: { event?: string } = {}
): ErrorReport | null {
  // Losing the race for the instance lock is how a second launch learns an owner already runs.
  if (source === 'startup' && errorCodeOf(error) === 'CORE_ALREADY_RUNNING') return null
  const diagnostic = classifyFailure(error, {
    component: 'core',
    operation: source === 'startup' ? 'startup' : 'event',
  })
  if (source === 'event_listener' && diagnostic.category === 'expected') return null
  return {
    source,
    level:
      source === 'event_listener' ? (diagnostic.category === 'operational' ? 'warning' : 'error') : 'fatal',
    error,
    tags: { error_code: errorCodeOf(error), event: context.event },
  }
}

// ── the HTTP servers ─────────────────────────────────────────────────────────

/**
 * A request that failed on our side. The category distinguishes coded defects from expected
 * answers; a disconnected client does not turn its abandoned request into a defect.
 */
export function internalErrorReport(input: {
  source: 'control_route' | 'public_server'
  error: unknown
  status: number
  route?: string
}): ErrorReport | null {
  if (isClientAbort(input.error)) return null
  const diagnostic = classifyFailure(input.error, { component: 'http', operation: 'request' })
  if (diagnostic.category === 'expected' || (input.status < 500 && diagnostic.category !== 'defect'))
    return null
  return {
    source: input.source,
    diagnostic,
    level: diagnostic.category === 'operational' ? 'warning' : 'error',
    error: input.error,
    tags: { route: input.route, http_status: input.status, error_code: errorCodeOf(input.error) },
  }
}

// ── local engines ────────────────────────────────────────────────────────────

/**
 * A loaded engine that exited. A native crash is an error, a kill from outside (the OOM killer,
 * Jetsam) or an out-of-memory exit a warning; a polite stop or a clean exit is nothing. Loads that
 * crash are reported by `loadFailureReport`: `session:died` fires only for a session that was up.
 */
export function sessionDeathReport(
  died: Pick<CoreEvents['session:died'], 'provider' | 'model_id' | 'exit_code' | 'signal' | 'message'>,
  platform: NodeJS.Platform
): ErrorReport | null {
  const signal = signalNumber(died.signal)
  const crashed = isCrashExit({ code: died.exit_code, signal: died.signal }, platform)
  const oom = /out of memory|\boom\b/i.test(died.message)
  let kind: string
  if (crashed) kind = signal === 11 ? 'sigsegv' : signal === 6 ? 'sigabrt' : 'native_crash'
  else if (signal === 9) kind = 'sigkill'
  else if (oom) kind = 'oom'
  else if (signal === null && died.exit_code !== null && died.exit_code !== 0) kind = 'exit'
  else return null
  return {
    source: 'backend_crash',
    level: kind === 'sigkill' || kind === 'oom' ? 'warning' : 'error',
    type: 'BackendCrash',
    message: headline(died.message),
    fingerprint: ['backend-crash', died.provider, kind],
    tags: {
      provider: died.provider,
      model_id: modelTag(died.model_id),
      quant: quantOf(died.model_id),
      crash_kind: kind,
      exit_code: died.exit_code,
      signal: died.signal,
    },
    throttle: { key: `died:${died.provider}:${died.model_id}:${kind}`, windowMs: ENGINE_THROTTLE_MS },
  }
}

/**
 * Refusals before any engine starts: an unknown provider or model, a model another owner holds, a
 * core that is stopping. They are answers to the caller, not load failures.
 */
const NOT_ENGINE_FAILURES: ReadonlySet<string> = new Set([
  'PROVIDER_NOT_FOUND',
  'MODEL_NOT_FOUND',
  'CORE_ALREADY_RUNNING',
  'CORE_NOT_RUNNING',
])

/**
 * A model that did not load, from any caller (the app, the public API, a remote client, the CLI).
 * The user stopping it and the conditions they can fix themselves (a missing file, an old OS) are
 * not reported; environment causes are counted at `warning`, like the web app did.
 */
export function loadFailureReport(input: {
  provider: LocalProviderId
  modelId: string
  error: unknown
  overrides?: Record<string, unknown> | undefined
  isEmbedding?: boolean | undefined
}): ErrorReport | null {
  if (isCancellation(input.error)) return null
  const code = errorCodeOf(input.error) ?? 'UNKNOWN'
  const diagnostic = classifyFailure(input.error, { component: 'runtime', operation: 'load' })
  if (diagnostic.category === 'expected' || NOT_ENGINE_FAILURES.has(code)) return null
  const details = detailsOf(input.error)
  const o = input.overrides ?? {}
  const engineErrors = markerLines(details)
  return {
    source: 'model_load',
    diagnostic,
    level: diagnostic.category === 'operational' ? 'warning' : 'error',
    error: input.error,
    fingerprint: ['model-load-failure', input.provider, code],
    tags: {
      provider: input.provider,
      error_code: code,
      model_id: modelTag(input.modelId),
      quant: quantOf(input.modelId),
      backend: o['version_backend'] as string | undefined,
      context_length: (o['ctx_size'] ?? o['ctx_len']) as number | undefined,
      gpu_layers: o['n_gpu_layers'] as number | undefined,
      cache_type_k: o['cache_type_k'] as string | undefined,
      is_embedding: input.isEmbedding || undefined,
      oom_subtype: code === 'OUT_OF_MEMORY' ? oomSubtype(details) : undefined,
    },
    ...(engineErrors ? { extra: { engine_errors: engineErrors } } : {}),
    throttle: { key: `load:${input.provider}:${input.modelId}:${code}`, windowMs: ENGINE_THROTTLE_MS },
  }
}

/**
 * Image-generation codes that name something the user or the app can fix — a missing engine or
 * file, an unsupported request, a busy queue, a full disk — rather than an engine or core defect.
 */
export const RECOVERABLE_DIFFUSION_CODES: ReadonlySet<string> = new Set([
  'ENGINE_MISSING',
  'ENGINE_UPDATE_REQUIRED',
  'MODEL_MISSING',
  'SIDE_FILE_MISSING',
  'MODEL_INCOMPATIBLE',
  'MODEL_NOT_LOADED',
  'UNSUPPORTED_BACKEND',
  'UNSUPPORTED_WORKFLOW',
  'INVALID_DIMENSIONS',
  'INVALID_REQUEST',
  'JOB_BUSY',
  'JOB_NOT_FOUND',
  'QUEUE_FULL',
  'CANCELLED',
  'DISK_FULL',
  'BACKEND_IN_USE',
  'NOT_CONFIGURED',
])

/** sd.cpp failing to load a model (`load`) or to finish an image (`job`). */
export function diffusionFailureReport(input: {
  phase: 'load' | 'job'
  error: unknown
  family?: string | undefined
  engine?: string | undefined
}): ErrorReport | null {
  if (isCancellation(input.error)) return null
  const code = errorCodeOf(input.error) ?? 'INTERNAL'
  const diagnostic = classifyFailure(input.error, {
    component: 'diffusion',
    operation: input.phase === 'load' ? 'load' : 'job',
  })
  if (diagnostic.category === 'expected') return null
  const engineErrors = markerLines(detailsOf(input.error))
  return {
    source: input.phase === 'load' ? 'diffusion_load' : 'diffusion_job',
    diagnostic,
    level: diagnostic.category === 'operational' || code === 'INVALID_OUTPUT' ? 'warning' : 'error',
    error: input.error,
    fingerprint: [input.phase === 'load' ? 'diffusion-load-failure' : 'diffusion-failure', code],
    tags: { provider: 'diffusion', error_code: code, diffusion_family: input.family, engine: input.engine },
    ...(engineErrors ? { extra: { engine_errors: engineErrors } } : {}),
    throttle: { key: `diffusion:${input.phase}:${input.family ?? ''}:${code}`, windowMs: ENGINE_THROTTLE_MS },
  }
}

/**
 * Audio-generation codes that name something the user or the client can fix — a missing engine or
 * file, the wrong mode, a request audio.cpp refused, a busy engine, a full disk — rather than an
 * engine or core defect.
 */
export const RECOVERABLE_AUDIO_CODES: ReadonlySet<string> = new Set([
  'ENGINE_MISSING',
  'MODEL_MISSING',
  'MODEL_INCOMPATIBLE',
  'MODEL_NOT_LOADED',
  'UNSUPPORTED_BACKEND',
  'UNSUPPORTED_MODE',
  'INVALID_REQUEST',
  'REQUEST_REJECTED',
  'JOB_BUSY',
  'JOB_NOT_FOUND',
  'CANCELLED',
  'DISK_FULL',
  'BACKEND_IN_USE',
])

/** audio.cpp failing to load a model (`load`) or to finish a clip (`job`). */
export function audioFailureReport(input: {
  phase: 'load' | 'job'
  error: unknown
  family?: string | undefined
}): ErrorReport | null {
  if (isCancellation(input.error)) return null
  const code = errorCodeOf(input.error) ?? 'INTERNAL'
  if (RECOVERABLE_AUDIO_CODES.has(code)) return null
  const engineErrors = markerLines(detailsOf(input.error))
  return {
    source: input.phase === 'load' ? 'audio_load' : 'audio_job',
    level: code === 'OUT_OF_MEMORY' || code === 'INVALID_OUTPUT' ? 'warning' : 'error',
    error: input.error,
    fingerprint: [input.phase === 'load' ? 'audio-load-failure' : 'audio-failure', code],
    tags: { provider: 'audio', error_code: code, audio_family: input.family },
    ...(engineErrors ? { extra: { engine_errors: engineErrors } } : {}),
    throttle: { key: `audio:${input.phase}:${input.family ?? ''}:${code}`, windowMs: ENGINE_THROTTLE_MS },
  }
}

/**
 * A running local engine that failed a request: a compute failure that leaves the backend unusable
 * (a Metal OOM during prompt processing, "failed to decode") at `warning`, any other 5xx at `error`.
 * A 4xx is about the request (context overflow included) and stays with the app.
 */
export function inferenceFailureReport(input: {
  provider: LocalProviderId
  modelId: string
  status: number
  compute: boolean
  oom: boolean
}): ErrorReport | null {
  if (input.status < 500) return null
  const kind = input.oom ? 'oom' : input.compute ? 'compute' : String(input.status)
  return {
    source: 'inference',
    level: input.compute || input.oom ? 'warning' : 'error',
    type: 'InferenceFailure',
    message: `HTTP ${input.status}`,
    fingerprint: ['inference-failure', input.provider, kind],
    tags: {
      provider: input.provider,
      quant: quantOf(input.modelId),
      http_status: input.status,
      failure_kind: kind,
    },
    throttle: { key: `inference:${input.provider}:${kind}`, windowMs: ENGINE_THROTTLE_MS },
  }
}
