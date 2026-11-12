/**
 * Audio-generation failures, carried by `AtomicCoreError` so the control server's envelope and the
 * job records show one shape, as image generation's do (`src/diffusion/errors.ts`).
 */

import { AtomicCoreError, AUDIO_ERROR_CODES } from '../contracts/index.js'
import type { AudioErrorBody, AudioErrorCode } from '../contracts/index.js'
import { classifyIoError } from '../downloads/index.js'

export function audioError(code: AudioErrorCode, message: string, details?: string): AtomicCoreError {
  return new AtomicCoreError(code, message, details)
}

export function audioInternalError(message: string, details?: string): AtomicCoreError {
  return audioError('INTERNAL', message, details)
}

/**
 * An I/O failure on the closest code: the shared download classifier names the disk cases (a full
 * disk or a file-size limit is something the user can act on), everything else is internal, with
 * `context` as the message and the original error as the `cause`, as image generation's does.
 */
export function audioIoError(context: string, error: unknown): AtomicCoreError {
  const reason = error instanceof Error ? error.message : String(error)
  const tag = classifyIoError(error)
  return tag === 'disk_full' || tag === 'disk_fs_limit'
    ? new AtomicCoreError('DISK_FULL', `[${tag}] The disk is full.`, `${context}: ${reason}`, { cause: error })
    : new AtomicCoreError('INTERNAL', context, reason, { cause: error })
}

export function isAudioErrorCode(code: unknown): code is AudioErrorCode {
  return typeof code === 'string' && (AUDIO_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * Any failure as a job record or an event carries it. A code from outside this surface becomes
 * `INTERNAL`, its original code kept in the details.
 */
export function audioErrorBody(error: unknown): AudioErrorBody {
  if (error instanceof AtomicCoreError) {
    if (isAudioErrorCode(error.code)) {
      return error.details === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, details: error.details }
    }
    const details = error.details === undefined ? error.code : `${error.code}: ${error.details}`
    return { code: 'INTERNAL', message: error.message, details }
  }
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
}

/** The thrown form of `audioErrorBody`: what a caller awaiting the operation receives. */
export function toAudioError(error: unknown): AtomicCoreError {
  if (error instanceof AtomicCoreError && isAudioErrorCode(error.code)) return error
  const body = audioErrorBody(error)
  return audioError(body.code, body.message, body.details)
}
