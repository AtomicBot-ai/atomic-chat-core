/**
 * Classification of a failed `llama-server` process into the app's error contract. Port of
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs` (`LlamacppError::from_stderr`,
 * `from_exit_status`, `from_process_output`). Pinned by `test/contract/errors.test.ts`. The
 * recorded desktop fixture predates the tensor-layout correction: a tensor-count mismatch alone
 * is backend incompatibility on every provider (2026-11-02-tensor-layout-error).
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

/**
 * NTSTATUS codes a Windows process ends with when the loader gives up before `main`, so it prints
 * nothing of its own — the same set `src/diffusion/install.ts` and `src/audio/install.ts` read for
 * their engines: a missing DLL, a missing ordinal or entry point, a bad image, a DLL whose init failed.
 */
export const WINDOWS_LOADER_FAILURES: ReadonlyMap<number, string> = new Map([
  [0xc000_0135, 'STATUS_DLL_NOT_FOUND'],
  [0xc000_0138, 'STATUS_ORDINAL_NOT_FOUND'],
  [0xc000_0139, 'STATUS_ENTRYPOINT_NOT_FOUND'],
  [0xc000_007b, 'STATUS_INVALID_IMAGE_FORMAT'],
  [0xc000_0142, 'STATUS_DLL_INIT_FAILED'],
])
/** STATUS_ILLEGAL_INSTRUCTION: the build uses an instruction this CPU does not have. */
export const WINDOWS_ILLEGAL_INSTRUCTION = 0xc000_001d

/**
 * An exit status as the load diagnostics spell it: `0x`-prefixed upper-case hex on Windows (NTSTATUS
 * codes arrive signed or unsigned), decimal elsewhere; `undefined` when the process was killed by a
 * signal or never started.
 */
export function formatExitCode(code: number | null, platform: NodeJS.Platform): string | undefined {
  if (code === null) return undefined
  if (platform !== 'win32') return String(code)
  return `0x${(code >>> 0).toString(16).toUpperCase()}`
}

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
 * llama.cpp, so there the mismatch is an unsupported architecture. Ollama conversions can differ
 * from upstream too, so on any build a tensor count alone does not prove a damaged file.
 */
const TENSOR_COUNT_MISMATCH = 'wrong number of tensors'

/**
 * What CUDA prints when a build cannot run on this card or driver: a driver too old for the toolchain
 * the build's PTX came from (CUDA 13.x on Turing before R616), or no kernels for this architecture at
 * all. The bare `ggml_cuda_kernel_can_use_pdl` + `cudaFuncGetAttributes` pair is the same failure when
 * the CUDA error line itself was cut off. Lowercase, like the stream the cascade reads.
 */
const GPU_BUILD_INCOMPATIBLE_MARKERS = [
  'provided ptx was compiled with an unsupported toolchain',
  'no kernel image is available for execution on the device',
]
const isGpuBuildIncompatible = (l: string) =>
  includesAny(l, GPU_BUILD_INCOMPATIBLE_MARKERS) ||
  (l.includes('ggml_cuda_kernel_can_use_pdl') && l.includes('cudafuncgetattributes'))

export const GPU_BACKEND_INCOMPATIBLE_MESSAGE =
  'This GPU build of the model engine does not run on this graphics card with its current driver. Update the NVIDIA graphics driver, or switch to another backend (CUDA 12, Vulkan or CPU).'
export const ENGINE_BINARY_BROKEN_MESSAGE =
  'The model engine could not load a library it needs, so it did not start. Its files may be incomplete or blocked by antivirus software: reinstall this backend or switch to another one.'
export const CPU_INSTRUCTION_UNSUPPORTED_MESSAGE =
  'The model engine stopped on a processor instruction this computer does not have. Switch to another backend, such as the CPU build, which picks the instructions this processor supports.'

export const ARGUMENT_REJECTED_MESSAGE =
  'This llama.cpp backend does not accept one of the arguments it was started with. If you added custom arguments to this model, remove them; otherwise switch to another backend version or update Atomic Chat.'

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
    // After out-of-memory (a card that ran out of VRAM is not an incompatible one), before every
    // model rule: the build never got far enough for the model to be the reason.
    code: 'GPU_BACKEND_INCOMPATIBLE',
    message: GPU_BACKEND_INCOMPATIBLE_MESSAGE,
    match: isGpuBuildIncompatible,
  },
  {
    code: 'MODEL_ARCH_NOT_SUPPORTED',
    message: "The model's architecture or format is not supported by this version of the backend.",
    match: (l) =>
      includesAny(l, [
        'error loading model architecture',
        'unknown model architecture',
        'error loading model hyperparameters',
        'key not found in model',
        TENSOR_COUNT_MISMATCH,
      ]),
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
    match: (l) =>
      includesAny(l, [
        'corrupted or incomplete',
        'invalid magic',
        'unexpectedly reached end of file',
        'failed to read tensor',
      ]),
  },
  {
    // `common_params_parse` (upstream, TurboQuant and Prism alike): a flag the build does not know,
    // or a value it refuses. Core's own flags are gated per build (engine-contract.json), so this is
    // a build that drifted from what core expects, or a custom argument in the model's settings. The
    // code stays the process error: it is worth a report, not the user's mistake alone.
    code: 'LLAMA_CPP_PROCESS_ERROR',
    message: ARGUMENT_REJECTED_MESSAGE,
    match: (l) => includesAny(l, ['error: invalid argument: ', 'error while handling argument']),
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

/**
 * A Windows exit status that names its own cause when stderr named none: the loader gave up before
 * `main` (`ENGINE_BINARY_BROKEN`), or the build hit an instruction this CPU lacks
 * (`CPU_INSTRUCTION_UNSUPPORTED`). `undefined` for anything else, and off Windows.
 */
export function windowsExitCause(
  exit: ExitInfo,
  platform: NodeJS.Platform
): { code: 'ENGINE_BINARY_BROKEN' | 'CPU_INSTRUCTION_UNSUPPORTED'; message: string } | undefined {
  if (platform !== 'win32' || exit.code === null) return undefined
  const status = exit.code >>> 0
  if (WINDOWS_LOADER_FAILURES.has(status))
    return { code: 'ENGINE_BINARY_BROKEN', message: ENGINE_BINARY_BROKEN_MESSAGE }
  if (status === WINDOWS_ILLEGAL_INSTRUCTION)
    return { code: 'CPU_INSTRUCTION_UNSUPPORTED', message: CPU_INSTRUCTION_UNSUPPORTED_MESSAGE }
  return undefined
}

/**
 * `LlamacppError::from_exit_status`: a recognised crash upgrades the generic error's message; beyond
 * the app, a Windows loader or illegal-instruction status that stderr did not explain gets its own code.
 */
export function classifyExit(
  exit: ExitInfo,
  stderr: string,
  platform: NodeJS.Platform,
  provider: LocalProviderId = 'llamacpp-upstream'
): AtomicCoreError {
  const base = classifyStderr(stderr, provider)
  if (base.code !== 'LLAMA_CPP_PROCESS_ERROR') return base
  const cause = windowsExitCause(exit, platform)
  if (cause) return new AtomicCoreError(cause.code, cause.message, stderr)
  if (!isCrashExit(exit, platform)) return base
  return new AtomicCoreError('LLAMA_CPP_PROCESS_ERROR', CRASH_MESSAGE, stderr)
}

/**
 * `LlamacppError::from_process_output`: stderr classification wins; otherwise try stdout (several
 * llama.cpp builds report loader failures there); otherwise keep the exit-status error but hand the
 * caller stdout as details when stderr is blank. A code read from the Windows exit status alone ranks
 * with the exit status, below stdout.
 */
export function classifyProcessOutput(
  exit: ExitInfo,
  stderr: string,
  stdout: string,
  platform: NodeJS.Platform,
  provider: LocalProviderId = 'llamacpp-upstream'
): AtomicCoreError {
  const base = classifyExit(exit, stderr, platform, provider)
  const fromStdout = classifyStderr(stdout, provider)
  const fromStderr =
    base.code !== 'LLAMA_CPP_PROCESS_ERROR' && base.code !== windowsExitCause(exit, platform)?.code
  const selected = fromStderr
    ? base
    : fromStdout.code !== 'LLAMA_CPP_PROCESS_ERROR'
      ? fromStdout
      : stderr.trim() === '' && stdout.trim() !== ''
        ? new AtomicCoreError(base.code, base.message, stdout)
        : base
  // Preserve the Rust-compatible body while retaining facts that disappear when details are scrubbed.
  return new AtomicCoreError(selected.code, selected.message, selected.details, {
    diagnostic: {
      component: 'runtime',
      operation: 'load',
      stage: 'ready',
      exitCode: exit.code,
      signal: exit.signal,
      ...(selected.code === 'LLAMA_CPP_PROCESS_ERROR' && /GGML_ASSERT/.test(stderr + stdout)
        ? ({ nativeFailure: 'assertion', reason: 'native_crash' } as const)
        : {}),
    },
  })
}
