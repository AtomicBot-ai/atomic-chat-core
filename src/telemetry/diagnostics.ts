import {
  DIAGNOSTIC_VERSION,
  FAILURE_CATEGORIES,
  FAILURE_COMPONENTS,
  FAILURE_OPERATIONS,
  FAILURE_STAGES,
  FAILURE_REASONS,
  NATIVE_FAILURES,
} from '../contracts/index.js'
import type { FailureDiagnostic, FailureObserver } from '../contracts/index.js'
import { errorCodeOf, isCancellation } from './policy.js'
import { parseStack } from './stack.js'
import type { ErrorReport, ErrorSink } from './types.js'

const SIGNALS = new Set([
  'SIGABRT',
  'SIGALRM',
  'SIGBUS',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINT',
  'SIGKILL',
  'SIGPIPE',
  'SIGQUIT',
  'SIGSEGV',
  'SIGSYS',
  'SIGTERM',
  'SIGTRAP',
  'SIGUSR1',
  'SIGUSR2',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGBREAK',
])

const EXPECTED: Readonly<Record<string, FailureDiagnostic['reason']>> = {
  INVALID_ARGUMENT: 'invalid_request',
  INVALID_REQUEST: 'invalid_request',
  INVALID_DIMENSIONS: 'invalid_request',
  UNAUTHORIZED: 'authentication',
  AUTH_REQUIRED: 'authentication',
  FORBIDDEN_HOST: 'authentication',
  MODEL_NOT_FOUND: 'not_found',
  MODEL_NOT_LOADED: 'not_found',
  NO_MODEL_LOADED: 'not_found',
  PROVIDER_NOT_FOUND: 'not_found',
  MODEL_MISSING: 'not_found',
  SIDE_FILE_MISSING: 'not_found',
  CORE_ALREADY_RUNNING: 'busy',
  CORE_NOT_RUNNING: 'not_configured',
  REMOTE_ACCESS_SERVER_STOPPED: 'not_configured',
  REMOTE_ACCESS_OPERATION_IN_PROGRESS: 'busy',
  GPU_BUSY: 'busy',
  JOB_BUSY: 'busy',
  QUEUE_FULL: 'busy',
  JOB_NOT_FOUND: 'not_found',
  BACKEND_IN_USE: 'busy',
  ENGINE_INSTALL_IN_PROGRESS: 'busy',
  ENGINE_MISSING: 'not_configured',
  ENGINE_UPDATE_REQUIRED: 'unsupported',
  NOT_CONFIGURED: 'not_configured',
  DECISION_NOT_CONFIGURED: 'not_configured',
  EMBEDDING_NOT_CONFIGURED: 'not_configured',
  DECISION_ENGINE_UNSUPPORTED: 'unsupported',
  EMBEDDING_ENGINE_UNSUPPORTED: 'unsupported',
  UNSUPPORTED_BACKEND: 'unsupported',
  UNSUPPORTED_WORKFLOW: 'unsupported',
  MODEL_INCOMPATIBLE: 'unsupported',
  MODEL_ENGINE_INCOMPATIBLE: 'unsupported',
  MODEL_FORMAT_LEGACY: 'unsupported',
}
const OPERATIONAL: Readonly<Record<string, FailureDiagnostic['reason']>> = {
  OUT_OF_MEMORY: 'out_of_memory',
  ENOMEM: 'out_of_memory',
  ENOSPC: 'disk_full',
  DISK_FULL: 'disk_full',
  EACCES: 'disk_permission',
  EPERM: 'disk_permission',
  EBUSY: 'disk_file_locked',
  ENAMETOOLONG: 'disk_path_too_long',
  EIO: 'disk_io',
  ENODEV: 'disk_device_lost',
  ECONNREFUSED: 'network',
  ECONNRESET: 'network',
  ENETUNREACH: 'network',
  ENOTFOUND: 'network',
  EAI_AGAIN: 'network',
  ETIMEDOUT: 'timeout',
  MODEL_LOAD_TIMED_OUT: 'timeout',
  SERVER_START_TIMED_OUT: 'timeout',
  UPSTREAM_ERROR: 'upstream',
  MODEL_FILE_NOT_FOUND: 'not_found',
  MODEL_FILE_CORRUPT: 'integrity',
  MODEL_SHARDS_INCOMPLETE: 'integrity',
  MODEL_ARCH_NOT_SUPPORTED: 'unsupported',
  MULTIMODAL_PROJECTOR_LOAD_FAILED: 'unsupported',
  BINARY_NOT_FOUND: 'not_found',
  OS_VERSION_UNSUPPORTED: 'unsupported',
  CPU_NO_AVX: 'unsupported',
  CPU_INSTRUCTION_UNSUPPORTED: 'unsupported',
  GPU_BACKEND_INCOMPATIBLE: 'unsupported',
  ENGINE_BINARY_BROKEN: 'integrity',
  EFBIG: 'disk_fs_limit',
  REMOTE_RATE_LIMITED: 'upstream',
  REMOTE_QUOTA: 'upstream',
  REMOTE_UNAVAILABLE: 'upstream',
  REMOTE_TIMEOUT: 'timeout',
}

/** Bounded, identity-aware traversal; never enumerates arbitrary thrown objects. */
export function errorChain(error: unknown): Error[] {
  const chain: Error[] = []
  const seen = new Set<Error>()
  while (error instanceof Error && !seen.has(error) && chain.length < 5) {
    seen.add(error)
    chain.push(error)
    error = error.cause
  }
  return chain
}

/** Runtime validation also protects library callers compiled without TypeScript. */
export function classifyFailure(error: unknown, context: FailureDiagnostic): FailureDiagnostic {
  const own = errorChain(error).find(
    (entry) => typeof (entry as Error & { diagnostic?: unknown }).diagnostic === 'object'
  ) as (Error & { diagnostic?: FailureDiagnostic }) | undefined
  const input = { ...context, ...own?.diagnostic }
  const diagnostic: FailureDiagnostic = {
    component: FAILURE_COMPONENTS.includes(input.component) ? input.component : 'core',
    operation: FAILURE_OPERATIONS.includes(input.operation) ? input.operation : 'request',
  }
  if (input.stage && FAILURE_STAGES.includes(input.stage)) diagnostic.stage = input.stage
  if (input.nativeFailure && NATIVE_FAILURES.includes(input.nativeFailure))
    diagnostic.nativeFailure = input.nativeFailure
  if (input.exitCode === null || (typeof input.exitCode === 'number' && Number.isSafeInteger(input.exitCode)))
    diagnostic.exitCode = input.exitCode
  if (typeof input.signal === 'number' && Number.isSafeInteger(input.signal)) diagnostic.signal = input.signal
  else if (typeof input.signal === 'string' && SIGNALS.has(input.signal)) diagnostic.signal = input.signal
  // version_backend may contain a local, user-named backend directory after the version.
  if (typeof input.engineVersion === 'string') {
    const version = /^(b\d{1,10}(?:-\d+(?:\.\d+){1,3})?|v?\d+(?:\.\d+){1,3})(?:\/|$)/.exec(
      input.engineVersion
    )?.[1]
    if (version && version.length <= 48) diagnostic.engineVersion = version
  }
  let category: FailureDiagnostic['category'] = 'unknown'
  let reason: FailureDiagnostic['reason'] = 'unknown'
  const code = errorCodeOf(error)
  if (isCancellation(error) || errorChain(error).some(isCancellation)) {
    category = 'expected'
    reason = 'cancelled'
  } else if (code && EXPECTED[code]) {
    category = 'expected'
    reason = EXPECTED[code]
  } else {
    const chain = errorChain(error)
    const cause = [...chain]
      .reverse()
      .map(errorCodeOf)
      .find((value) => value && OPERATIONAL[value])
    const operational = OPERATIONAL[code ?? ''] ?? (cause ? OPERATIONAL[cause] : undefined)
    if (operational) {
      category = 'operational'
      reason = operational
    } else if (
      code === 'INTERNAL_ERROR' ||
      code === 'INTERNAL' ||
      error instanceof TypeError ||
      error instanceof ReferenceError
    ) {
      category = 'defect'
      reason = 'internal'
    }
  }
  if (!diagnostic.nativeFailure) {
    const signal = diagnostic.signal
    const exit =
      diagnostic.exitCode === undefined || diagnostic.exitCode === null ? null : diagnostic.exitCode >>> 0
    if (signal === 'SIGSEGV' || signal === 11) diagnostic.nativeFailure = 'sigsegv'
    else if (signal === 'SIGABRT' || signal === 6) diagnostic.nativeFailure = 'sigabrt'
    else if (signal === 'SIGKILL' || signal === 9) {
      diagnostic.nativeFailure = 'sigkill'
      category = 'operational'
    } else if (exit === 0xc0000005) diagnostic.nativeFailure = 'access_violation'
    else if (exit === 0xc00000fd) diagnostic.nativeFailure = 'stack_overflow'
    else if (exit === 0xc0000409) diagnostic.nativeFailure = 'native_crash'
  }
  if (reason !== 'cancelled') {
    if (input.category && FAILURE_CATEGORIES.includes(input.category)) category = input.category
    if (input.reason && FAILURE_REASONS.includes(input.reason)) reason = input.reason
  }
  return { ...diagnostic, category, reason }
}

/** Finite facts are useful without sending raw messages, arguments, paths or engine output. */
export function diagnosticTags(
  error: unknown,
  diagnostic: FailureDiagnostic
): Record<string, string | number | null | undefined> {
  const causeCode = [...errorChain(error)].reverse().map(errorCodeOf).find(Boolean)
  return {
    diagnostic_version: DIAGNOSTIC_VERSION,
    component: diagnostic.component,
    operation: diagnostic.operation,
    failure_category: diagnostic.category,
    failure_reason: diagnostic.reason,
    failure_stage: diagnostic.stage,
    cause_code: causeCode,
    native_failure: diagnostic.nativeFailure,
    exit_code: diagnostic.exitCode,
    signal: diagnostic.signal,
    engine_version: diagnostic.engineVersion,
  }
}

/** Unknown causes keep their source location; messages and user-selected models never form a key. */
export function diagnosticFingerprint(
  error: unknown,
  diagnostic: FailureDiagnostic,
  provider?: string
): string[] {
  const chain = errorChain(error)
  const leaf = chain.at(-1)
  const frame = parseStack(leaf?.stack, leaf?.message)
    .filter((entry) => entry.in_app)
    .at(-1)
  const reason = diagnostic.reason ?? 'unknown'
  const location =
    reason === 'unknown' || reason === 'internal'
      ? frame
        ? `${frame.filename}:${frame.lineno ?? 0}:${frame.colno ?? 0}`
        : 'no-stack'
      : reason
  return [
    DIAGNOSTIC_VERSION,
    diagnostic.component,
    diagnostic.operation,
    provider ?? '',
    reason,
    diagnostic.nativeFailure ?? '',
    errorCodeOf(leaf) ?? errorCodeOf(error) ?? '',
    location,
  ]
}

/** One injected observer per owner. Repeated propagation of an Error is reported only once. */
export function failureObserver(sink: ErrorSink | undefined): FailureObserver {
  return (error, context) => {
    if (!sink) return
    try {
      const diagnostic = classifyFailure(error, context)
      if (diagnostic.category === 'expected') return
      sink.capture({
        source: 'operation',
        error,
        diagnostic,
        level: diagnostic.category === 'operational' ? 'warning' : 'error',
        // Preserve the engine-report cooldown when an internal observer replaces an SSE subscriber.
        throttle: { key: diagnosticFingerprint(error, diagnostic).join('\u0000'), windowMs: 5 * 60_000 },
      })
    } catch {
      /* Observability must never change the operation's result. */
    }
  }
}

/** Legacy report producers acquire the same diagnostic vocabulary at the serialization boundary. */
export function reportDiagnostic(report: ErrorReport): FailureDiagnostic {
  const contexts: Record<ErrorReport['source'], FailureDiagnostic> = {
    operation: { component: 'core', operation: 'request' },
    startup: { component: 'core', operation: 'startup' },
    uncaught_exception: { component: 'core', operation: 'event' },
    unhandled_rejection: { component: 'core', operation: 'event' },
    event_listener: { component: 'core', operation: 'event' },
    control_route: { component: 'http', operation: 'request' },
    public_server: { component: 'http', operation: 'request' },
    model_load: { component: 'runtime', operation: 'load' },
    backend_crash: { component: 'runtime', operation: 'exit', reason: 'process_exit' },
    inference: { component: 'runtime', operation: 'inference' },
    diffusion_load: { component: 'diffusion', operation: 'load' },
    diffusion_job: { component: 'diffusion', operation: 'job' },
    audio_load: { component: 'audio', operation: 'load' },
    audio_job: { component: 'audio', operation: 'job' },
  }
  const context = { ...(report.diagnostic ?? contexts[report.source]) }
  if (!report.diagnostic && report.level === 'warning') context.category = 'operational'
  const crash = report.tags?.['crash_kind']
  if (typeof crash === 'string' && (NATIVE_FAILURES as readonly string[]).includes(crash))
    context.nativeFailure = crash as FailureDiagnostic['nativeFailure'] & string
  if (report.source === 'inference')
    context.reason = report.tags?.['failure_kind'] === 'compute' ? 'compute' : 'upstream'
  if (report.tags?.['oom_subtype'] || report.tags?.['failure_kind'] === 'oom')
    context.reason = 'out_of_memory'
  const code = report.tags?.['exit_code']
  if (typeof code === 'number') context.exitCode = code
  const signal = report.tags?.['signal']
  if (typeof signal === 'number' || typeof signal === 'string') context.signal = signal
  return classifyFailure(report.error, context)
}
