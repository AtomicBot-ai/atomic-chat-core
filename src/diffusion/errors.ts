/**
 * Image-generation failures. Port of `error.rs` in `tauri-plugin-atomic-diffusion` (app commit
 * `767ff6350`): the same codes and messages, carried by `AtomicCoreError` so the control server's
 * envelope and the job records show one shape.
 */

import { AtomicCoreError, DIFFUSION_ERROR_CODES } from '../contracts/index.js'
import type { DiffusionErrorBody, DiffusionErrorCode } from '../contracts/index.js'

export function diffusionError(code: DiffusionErrorCode, message: string, details?: string): AtomicCoreError {
  return new AtomicCoreError(code, message, details)
}

export function internalError(message: string, details?: string): AtomicCoreError {
  return diffusionError('INTERNAL', message, details)
}

export function notConfiguredError(): AtomicCoreError {
  return diffusionError('NOT_CONFIGURED', 'Image generation has not been configured yet.')
}

export function modelNotLoadedError(): AtomicCoreError {
  return diffusionError('MODEL_NOT_LOADED', 'Load an image model first.')
}

export function cancelledError(): AtomicCoreError {
  return diffusionError('CANCELLED', 'Generation was cancelled.')
}

/** libuv reports a full disk as `ENOSPC` everywhere, Windows' two "disk full" codes included. */
export function isDiskFull(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC'
}

/**
 * An I/O failure on the closest code: a full disk is something the user can act on, everything else
 * is internal, with `context` as the message.
 */
export function ioError(context: string, error: unknown): AtomicCoreError {
  const reason = error instanceof Error ? error.message : String(error)
  if (isDiskFull(error)) return diffusionError('DISK_FULL', 'The disk is full.', `${context}: ${reason}`)
  return internalError(context, reason)
}

export function isDiffusionErrorCode(code: unknown): code is DiffusionErrorCode {
  return typeof code === 'string' && (DIFFUSION_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * Any failure as a job record or an event carries it. A code from outside this surface (an
 * `IO_ERROR` from a shared helper, a plain `Error`) becomes `INTERNAL`, which is what the web app
 * knows how to show; its original code is kept in the details.
 */
export function errorBody(error: unknown): DiffusionErrorBody {
  if (error instanceof AtomicCoreError) {
    if (isDiffusionErrorCode(error.code)) {
      return error.details === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, details: error.details }
    }
    const details = error.details === undefined ? error.code : `${error.code}: ${error.details}`
    return { code: 'INTERNAL', message: error.message, details }
  }
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
}

/** The thrown form of `errorBody`: what a caller awaiting the operation receives. */
export function toDiffusionError(error: unknown): AtomicCoreError {
  if (error instanceof AtomicCoreError && isDiffusionErrorCode(error.code)) return error
  const body = errorBody(error)
  return diffusionError(body.code, body.message, body.details)
}
