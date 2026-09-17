/**
 * How an mlx-server that failed is explained.
 *
 * Ported from: tauri-plugin-mlx/src/error.rs (`MlxError::from_stderr`) and the startup branches of
 * commands.rs (`load_mlx_model_impl`). Contract: test/fixtures/app/mlx-errors.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { ExitInfo } from '../llamacpp/errors.js'

const OOM_PATTERNS = [
  'out of memory',
  'failed to allocate',
  'insufficient memory',
  'metal::malloc',
  'maximum allowed buffer size',
  'recommended max working set size',
  'recommended working set size',
  'kiogpucommandbuffercallbackerroroutofmemory',
  'erroroutofdevicememory',
]

const ARCH_PATTERNS = [
  'unknown model type',
  "no module named 'mlx_vlm.models",
  "no module named 'mlx_vlm.speculative.drafters",
  "no module named 'mlx_lm.models",
  'switch_mlp',
]

export function classifyMlxStderr(stderr: string): AtomicCoreError {
  const lower = stderr.toLowerCase()
  if (OOM_PATTERNS.some((pattern) => lower.includes(pattern)))
    return new AtomicCoreError(
      'OUT_OF_MEMORY',
      'Out of memory. The model requires more memory than is available on this device.',
      stderr
    )
  if (
    (lower.includes('model type') && lower.includes('not supported')) ||
    ARCH_PATTERNS.some((pattern) => lower.includes(pattern))
  )
    return new AtomicCoreError(
      'MODEL_ARCH_NOT_SUPPORTED',
      "This model's architecture isn't supported by the current MLX backend yet.",
      stderr
    )
  return new AtomicCoreError(
    'MLX_PROCESS_ERROR',
    'The MLX model process encountered an unexpected error.',
    stderr
  )
}

/** stdout lines that mean the server is up (commands.rs, stdout reader). */
export const MLX_STDOUT_READY_MARKERS = [
  'uvicorn running on',
  'application startup complete',
  'http server listening',
  'server is listening',
  'server started',
  'ready to accept',
  'server started and listening on',
] as const

/** stderr lines that mean the server is up (commands.rs, stderr reader) — a different set. */
export const MLX_STDERR_READY_MARKERS = [
  'uvicorn running on',
  'application startup complete',
  'server is listening',
  'server listening on',
  'server started and listening on',
] as const

export function mlxTimeout(timeoutSecs: number, stderr: string): AtomicCoreError {
  return new AtomicCoreError(
    'MODEL_LOAD_TIMED_OUT',
    'The MLX model took too long to load and timed out.',
    `Timeout: ${timeoutSecs}s\n\nStderr:\n${stderr}`
  )
}

export function mlxBinaryMissing(path: string): AtomicCoreError {
  return new AtomicCoreError('BINARY_NOT_FOUND', `MLX server binary not found at: ${path}`)
}

export function mlxModelMissing(path: string): AtomicCoreError {
  return new AtomicCoreError('MODEL_FILE_NOT_FOUND', `Model file not found at: ${path}`)
}

/**
 * The wording of an exit, for `session:died` and the log: the plugin's diagnosis that an external
 * kill leaves no stderr behind, which is what users and support ask first.
 */
export function describeMlxExit(exit: ExitInfo, stderr: string): string {
  if (exit.signal) return `MLX server terminated by signal ${exit.signal} — an external process killed it.`
  if (stderr.trim() === '')
    return `MLX server exited with code ${exit.code ?? -1} and produced no stderr — the signature of an external kill.`
  return classifyMlxStderr(stderr).message
}
