/**
 * Classification of a failed `llama-server` process into the app's error contract. Port of
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs` (`LlamacppError::from_stderr`,
 * `from_exit_status`, `from_process_output`). Pinned by `test/contract/errors.test.ts`. The
 * TurboQuant fork's `error.rs` differs in one rule, `wrong number of tensors` (app commit
 * `ec1fd3ea7`), so the provider is a parameter.
 *
 * The cascade is ordered: the first matching group wins. Messages are the app's user-facing strings
 * and are part of the contract. `details` is always set (the raw stream), even when empty.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { LocalProviderId, RuntimeErrorCode } from '../../contracts/index.js'

export interface ExitInfo {
  /** Exit code, or null when the process was killed by a signal. Windows codes may be unsigned. */
  code: number | null
  /** Unix signal as number (11) or Node name ('SIGSEGV'); null on a normal exit. */
  signal: number | string | null
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
}

/** Normalise a Node signal name to the Unix number Rust sees. */
export function signalNumber(signal: number | string | null): number | null {
  if (signal === null) return null
  if (typeof signal === 'number') return signal
  return SIGNAL_NUMBERS[signal] ?? null
}

/** Windows: STATUS_ACCESS_VIOLATION / STATUS_STACK_OVERFLOW / STATUS_STACK_BUFFER_OVERRUN. */
const WINDOWS_CRASH_CODES = new Set([0xc000_0005, 0xc000_00fd, 0xc000_0409])

/** A hard native crash (segfault / abort) rather than a normal non-zero exit. */
export function isCrashExit(exit: ExitInfo, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return exit.code !== null && WINDOWS_CRASH_CODES.has(exit.code >>> 0)
  }
  const sig = signalNumber(exit.signal)
  return sig === 11 || sig === 6
}

interface Rule {
  code: RuntimeErrorCode
  message: string
  match: (lower: string, provider: LocalProviderId) => boolean
}

const includesAny = (lower: string, needles: string[]) => needles.some((n) => lower.includes(n))

/**
 * TurboQuant (`llamacpp`) can know an architecture and still expect a tensor layout that differs
 * from a valid upstream GGUF: re-downloading cannot fix that, and the same file loads in stock
 * llama.cpp, so there the mismatch is an unsupported architecture. Upstream it still means a
 * damaged file.
 */
const TENSOR_COUNT_MISMATCH = 'wrong number of tensors'
const tensorLayoutIsArchitecture = (provider: LocalProviderId) => provider === 'llamacpp'

const CASCADE: Rule[] = [
  {
    code: 'OS_VERSION_UNSUPPORTED',
    message:
      "The model engine couldn't start because it requires a newer version of macOS than the one on this Mac.",
    match: (l) => l.includes('dyld') && l.includes('symbol not found'),
  },
  {
    code: 'OUT_OF_MEMORY',
    message: 'Out of memory. The model requires more RAM or VRAM than available.',
    match: (l) =>
      includesAny(l, [
        'out of memory',
        'failed to allocate',
        'insufficient memory',
        'erroroutofdevicememory',
        'kiogpucommandbuffercallbackerroroutofmemory',
        'cuda_error_out_of_memory',
      ]),
  },
  {
    code: 'MODEL_ARCH_NOT_SUPPORTED',
    message: "The model's architecture or format is not supported by this version of the backend.",
    match: (l, provider) =>
      includesAny(l, [
        'error loading model architecture',
        'unknown model architecture',
        'error loading model hyperparameters',
        'key not found in model',
      ]) ||
      (tensorLayoutIsArchitecture(provider) && l.includes(TENSOR_COUNT_MISMATCH)),
  },
  {
    code: 'MULTIMODAL_PROJECTOR_LOAD_FAILED',
    message:
      "This model's multimodal projector isn't supported by the current llama.cpp backend. Vision/audio is unavailable for this model on this backend.",
    match: (l) => l.includes('unknown projector type'),
  },
  {
    code: 'MODEL_FILE_CORRUPT',
    message:
      'The model file appears to be incomplete or corrupted. Try deleting and re-downloading the model.',
    match: (l, provider) =>
      includesAny(l, [
        'corrupted or incomplete',
        'invalid magic',
        'unexpectedly reached end of file',
        'failed to read tensor',
      ]) ||
      (!tensorLayoutIsArchitecture(provider) && l.includes(TENSOR_COUNT_MISMATCH)),
  },
]

export const GENERIC_PROCESS_ERROR_MESSAGE = 'The model process encountered an unexpected error.'
export const CRASH_MESSAGE =
  'The model process crashed unexpectedly (access violation / segfault). This usually means the model is incompatible with this backend, or its speculative-decoding (MTP) configuration is unsupported here.'

/** `LlamacppError::from_stderr`: ordered substring cascade over the lowercased stream. */
export function classifyStderr(
  stderr: string,
  provider: LocalProviderId = 'llamacpp-upstream'
): AtomicCoreError {
  const lower = stderr.toLowerCase()
  for (const rule of CASCADE) {
    if (rule.match(lower, provider)) return new AtomicCoreError(rule.code, rule.message, stderr)
  }
  return new AtomicCoreError('LLAMA_CPP_PROCESS_ERROR', GENERIC_PROCESS_ERROR_MESSAGE, stderr)
}

/** `LlamacppError::from_exit_status`: a recognised crash upgrades the generic error's message. */
export function classifyExit(
  exit: ExitInfo,
  stderr: string,
  platform: NodeJS.Platform,
  provider: LocalProviderId = 'llamacpp-upstream'
): AtomicCoreError {
  const base = classifyStderr(stderr, provider)
  if (base.code !== 'LLAMA_CPP_PROCESS_ERROR' || !isCrashExit(exit, platform)) return base
  return new AtomicCoreError('LLAMA_CPP_PROCESS_ERROR', CRASH_MESSAGE, stderr)
}

/**
 * `LlamacppError::from_process_output`: stderr classification wins; otherwise try stdout (several
 * llama.cpp builds report loader failures there); otherwise keep the exit-status error but hand the
 * caller stdout as details when stderr is blank.
 */
export function classifyProcessOutput(
  exit: ExitInfo,
  stderr: string,
  stdout: string,
  platform: NodeJS.Platform,
  provider: LocalProviderId = 'llamacpp-upstream'
): AtomicCoreError {
  const base = classifyExit(exit, stderr, platform, provider)
  if (base.code !== 'LLAMA_CPP_PROCESS_ERROR') return base
  const fromStdout = classifyStderr(stdout, provider)
  if (fromStdout.code !== 'LLAMA_CPP_PROCESS_ERROR') return fromStdout
  if (stderr.trim() === '' && stdout.trim() !== '') {
    return new AtomicCoreError(base.code, base.message, stdout)
  }
  return base
}
