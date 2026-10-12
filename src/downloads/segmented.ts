/**
 * One large, hash-pinned file over several bounded byte ranges at once (`DownloaderDeps.streams`).
 * Each range is appended to its own file under `<save path>.segments/`, so an interrupted download
 * keeps what every range already has; the directory is reused only for the same URL, size, hash and
 * stream count. When every range is complete they are joined into `<save path>.tmp` and renamed into
 * place; the downloader verifies size and hash afterwards, as for any file.
 *
 * A server that does not answer a range with a matching 206 (a 200, a 416, a different
 * `Content-Range`, more bytes than asked for) makes the whole file fall back to one stream: the
 * function returns `false` and leaves nothing behind. Any other failure is retried per range with the
 * downloader's own backoff, the counter reset by fresh progress; a range that receives nothing for
 * `inactivityTimeoutMs` is retried as a stall.
 */

import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_STREAM_RETRIES, RETRY_RESET_PROGRESS_BYTES, retryDelayMs } from './protocol.js'

/** The most ranges one file is fetched over, whatever is asked for. */
export const MAX_DOWNLOAD_STREAMS = 4
/** Smallest file worth splitting: below this one stream is as fast and simpler. */
export const SEGMENTED_MIN_BYTES = 32 * 1024 * 1024
/** How long a range may receive nothing before it counts as stalled and is retried. */
export const SEGMENT_INACTIVITY_TIMEOUT_MS = 120_000
/** At most one progress report per this many milliseconds while ranges are flowing. */
export const SEGMENT_PROGRESS_INTERVAL_MS = 200

export interface SegmentedDownload {
  url: string
  /** Final path; `.segments/` and `.tmp` live beside it. */
  destination: string
  size: number
  sha256: string
  streams: number
  fetch: typeof fetch
  headers: Record<string, string>
  signal: AbortSignal
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  retryBaseMs: number
  now: () => number
  /** Bytes held across every range so far. */
  progress: (transferred: number) => void
  inactivityTimeoutMs?: number
}

/** The server cannot serve this file in ranges; the caller downloads it in one stream instead. */
class RangeUnavailable extends Error {}

/** Stalled: the range received nothing for the inactivity timeout. Retried like any stream error. */
class RangeStalled extends Error {}

/** `true` when the file is in place; `false` when the server cannot serve ranges. Throws the rest. */
export async function downloadSegments(o: SegmentedDownload): Promise<boolean> {
  const count = Math.max(1, Math.min(MAX_DOWNLOAD_STREAMS, Math.floor(o.streams)))
  const chunk = Math.ceil(o.size / count)
  const directory = `${o.destination}.segments`
  const identity = JSON.stringify([o.url, o.size, o.sha256, count])
  if ((await readFile(join(directory, 'identity'), 'utf8').catch(() => '')) !== identity) {
    await rm(directory, { recursive: true, force: true })
  }
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'identity'), identity)

  // One range failing for good stops the others: the file cannot complete anyway.
  const stopAll = new AbortController()
  const signal = AbortSignal.any([o.signal, stopAll.signal])
  const held: number[] = Array<number>(count).fill(0)
  let reportedAt = Number.NEGATIVE_INFINITY
  const report = (force = false) => {
    const now = o.now()
    if (!force && now - reportedAt < SEGMENT_PROGRESS_INTERVAL_MS) return
    reportedAt = now
    o.progress(held.reduce((a, b) => a + b, 0))
  }
  const inactivity = o.inactivityTimeoutMs ?? SEGMENT_INACTIVITY_TIMEOUT_MS

  const transfer = async (i: number) => {
    const start = i * chunk
    const end = Math.min(o.size, start + chunk) - 1
    const length = end - start + 1
    const path = join(directory, String(i))
    held[i] = Math.min(
      length,
      await stat(path).then(
        (s) => s.size,
        () => 0
      )
    )
    if (held[i] === length) return report(true)

    let retries = 0
    let sinceReset = 0
    for (;;) {
      signal.throwIfAborted()
      const attempt = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(
          () => attempt.abort(new RangeStalled(`no data received for ${inactivity / 1000} seconds`)),
          inactivity
        )
      }
      let response: Response | undefined
      try {
        const from = start + (held[i] as number)
        arm()
        response = await o.fetch(o.url, {
          headers: { ...o.headers, Range: `bytes=${from}-${end}` },
          signal: AbortSignal.any([signal, attempt.signal]),
        })
        if (response.status === 200 || response.status === 416) {
          throw new RangeUnavailable(`HTTP ${response.status} to a range request`)
        }
        if (response.status !== 206) throw new Error(`HTTP ${response.status}`)
        if (response.headers.get('content-range') !== `bytes ${from}-${end}/${o.size}`) {
          throw new RangeUnavailable('a Content-Range that does not match the request')
        }
        if (!response.body) throw new Error('no body')
        const file = await open(path, 'a', 0o600)
        const reader = response.body.getReader()
        try {
          for (;;) {
            arm()
            const { done, value } = await reader.read()
            if (done) break
            if ((held[i] as number) + value.byteLength > length) {
              throw new RangeUnavailable('more bytes than the range asked for')
            }
            await file.writeFile(value)
            held[i] = (held[i] as number) + value.byteLength
            sinceReset += value.byteLength
            if (sinceReset >= RETRY_RESET_PROGRESS_BYTES) {
              retries = 0
              sinceReset = 0
            }
            report()
          }
        } finally {
          await reader.cancel().catch(() => {})
          await file.close()
        }
        if (held[i] !== length) throw new Error(`the range ended after ${held[i]} of ${length} bytes`)
        return report(true)
      } catch (error) {
        await response?.body?.cancel().catch(() => {})
        if (signal.aborted) throw signal.reason
        const cause = attempt.signal.aborted ? attempt.signal.reason : error
        if (cause instanceof RangeUnavailable || retries >= MAX_STREAM_RETRIES) throw cause
        await o.sleep(retryDelayMs(retries++, o.retryBaseMs), signal)
      } finally {
        clearTimeout(timer)
      }
    }
  }

  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) =>
      transfer(i).catch((error: unknown) => {
        stopAll.abort(error)
        throw error
      })
    )
  )
  if (o.signal.aborted) throw o.signal.reason
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed !== undefined) {
    // The first range to fail stopped the rest; its reason is the one that matters.
    const reason: unknown = stopAll.signal.reason ?? failed.reason
    if (reason instanceof RangeUnavailable) {
      await rm(directory, { recursive: true, force: true })
      return false
    }
    throw reason
  }

  const temporary = `${o.destination}.tmp`
  const output = await open(temporary, 'w', 0o600)
  try {
    for (let i = 0; i < count; i++) {
      for await (const buffer of createReadStream(join(directory, String(i)))) {
        o.signal.throwIfAborted()
        await output.writeFile(buffer as Buffer)
      }
    }
  } finally {
    await output.close()
  }
  o.signal.throwIfAborted()
  await rename(temporary, o.destination)
  await rm(directory, { recursive: true, force: true })
  report(true)
  return true
}
