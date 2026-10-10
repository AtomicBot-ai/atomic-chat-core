/**
 * Reading the evidence of one GGUF file: the local header (a bounded prefix read, memoised by path,
 * size and mtime so the load gate does not re-read a 12 MB header per load) and a remote header over
 * HTTP ranges before download.
 */

import { open, stat } from 'node:fs/promises'
import { readGgufTensorSummaryChunked } from '../gguf/index.js'
import { evidenceFromSummary } from './resolve.js'
import type { GgufEvidence } from './resolve.js'

const memo = new Map<string, GgufEvidence>()
const MEMO_LIMIT = 256

/** Header evidence of a file on disk. Throws for a missing file or a header that is not GGUF. */
export async function inspectLocalGguf(path: string): Promise<GgufEvidence> {
  const info = await stat(path)
  const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}`
  const hit = memo.get(key)
  if (hit) return hit
  const handle = await open(path, 'r')
  try {
    const summary = await readGgufTensorSummaryChunked(
      async (byteLength) => {
        const buffer = Buffer.allocUnsafe(byteLength)
        const { bytesRead } = await handle.read(buffer, 0, byteLength, 0)
        return buffer.subarray(0, bytesRead)
      },
      { fileSize: info.size }
    )
    const evidence = evidenceFromSummary(summary)
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string)
    memo.set(key, evidence)
    return evidence
  } finally {
    await handle.close().catch(() => {})
  }
}

/** `https://huggingface.co/<repo>/resolve/<revision>/<file>`. */
export function hfResolveUrl(
  repo: string,
  file: string,
  revision = 'main',
  endpoint = 'https://huggingface.co'
): string {
  const path = file.split('/').map(encodeURIComponent).join('/')
  return `${endpoint.replace(/\/+$/, '')}/${repo}/resolve/${encodeURIComponent(revision)}/${path}`
}

/** The first range a remote header read asks for; doubled until the tensor table is complete. */
export const REMOTE_GGUF_FIRST_BYTES = 64 * 1024
/** The most of a remote file a header read takes before giving up. */
export const REMOTE_GGUF_MAX_BYTES = 64 * 1024 * 1024
/** A server that ignores `Range` is still read when its whole answer is at most this long. */
const REMOTE_GGUF_WHOLE_FILE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Header evidence of a remote file, read in ranges from 64 KiB, doubling (Bonsai: 6–12 MB), within
 * `maxBytes`. With `timeoutMs` the whole read, every range included, gives up after that long, so a
 * slow or broken mirror fails it instead of hanging it; without one it waits as long as the mirror
 * takes (the app's model setup, which would rather wait than lose the evidence). The file size is
 * not asked for: only the last tensor goes unsized, which does not move a type's bits per weight. A
 * header beyond the byte budget throws `GgufParseError`.
 */
export async function inspectRemoteGguf(
  url: string,
  options: { fetch: typeof fetch; token?: string; maxBytes?: number; timeoutMs?: number }
): Promise<GgufEvidence> {
  const auth: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {}
  const maxBytes = options.maxBytes ?? REMOTE_GGUF_MAX_BYTES
  const timeoutMs = options.timeoutMs
  const deadline = new AbortController()
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => deadline.abort(), timeoutMs)
  try {
    const summary = await readGgufTensorSummaryChunked(
      async (byteLength) => {
        const response = await options.fetch(url, {
          headers: { ...auth, Range: `bytes=0-${byteLength - 1}` },
          signal: deadline.signal,
        })
        const length = Number(response.headers.get('content-length') ?? Number.NaN)
        // A server that ignores Range would stream the whole multi-gigabyte file; a small one is read.
        const whole =
          response.status === 200 &&
          Number.isFinite(length) &&
          length <= Math.min(maxBytes, Math.max(byteLength, REMOTE_GGUF_WHOLE_FILE_MAX_BYTES))
        if (response.status !== 206 && !whole) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`${url} answered HTTP ${response.status} to a range request`)
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        return response.status === 206 ? bytes.subarray(0, byteLength) : bytes
      },
      { chunkSize: Math.min(REMOTE_GGUF_FIRST_BYTES, maxBytes), maxBytes, growth: 'doubling' }
    )
    return evidenceFromSummary(summary)
  } catch (error) {
    if (deadline.signal.aborted && timeoutMs !== undefined) {
      throw new Error(`Reading the GGUF header of ${url} took longer than ${timeoutMs / 1000} seconds`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
