/**
 * Post-download verification (size, then sha256). Port of `validate_downloaded_file` in
 * `src-tauri/src/core/downloads/helpers.rs`. Messages are the app's user-facing strings.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

export const HASH_MISMATCH_MESSAGE =
  'Hash verification failed. The downloaded file is corrupted or has been tampered with.'
export const VALIDATION_CANCELLED_MESSAGE = 'Validation cancelled'

export interface VerifyItem {
  sha256?: string | null
  size?: number | null
}

export interface VerifyDeps {
  fileSize: (path: string) => Promise<number>
  sha256: (path: string, signal?: AbortSignal) => Promise<string>
}

/** Streaming SHA-256 (lowercase hex), abortable between chunks. */
export function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    const onAbort = () => {
      stream.destroy()
      reject(new Error(VALIDATION_CANCELLED_MESSAGE))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(hash.digest('hex'))
    })
  })
}

export const defaultVerifyDeps: VerifyDeps = {
  fileSize: async (p) => (await stat(p)).size,
  sha256: sha256File,
}

/**
 * Throws with the app's message on mismatch. Skips entirely when neither sha256 nor size is
 * given; checks the size first (cheap), then the hash.
 */
export async function verifyDownloadedFile(
  item: VerifyItem,
  savePath: string,
  deps: VerifyDeps = defaultVerifyDeps,
  signal?: AbortSignal
): Promise<void> {
  const hasSha = item.sha256 !== undefined && item.sha256 !== null
  const hasSize = item.size !== undefined && item.size !== null
  if (!hasSha && !hasSize) return
  if (hasSize) {
    let actual: number
    try {
      actual = await deps.fileSize(savePath)
    } catch (e) {
      throw new Error(`Failed to verify file size: ${(e as Error).message}`)
    }
    if (actual !== item.size) {
      throw new Error(`Size verification failed. Expected ${item.size} bytes but got ${actual} bytes.`)
    }
  }
  if (signal?.aborted) throw new Error(VALIDATION_CANCELLED_MESSAGE)
  if (hasSha) {
    let computed: string
    try {
      computed = await deps.sha256(savePath, signal)
    } catch (e) {
      if ((e as Error).message === VALIDATION_CANCELLED_MESSAGE) throw e
      throw new Error(`Failed to verify file integrity: ${(e as Error).message}`)
    }
    if (computed !== item.sha256) throw new Error(HASH_MISMATCH_MESSAGE)
  }
}
