/**
 * Resumable multi-file downloader. Port of `_download_files_internal` / `download_single_file` in
 * `src-tauri/src/core/downloads/helpers.rs` and the task registry in `commands.rs`.
 *
 * Behaviour that is a contract with the app (PLAN.md §8.2 "Downloads"):
 * - `save_path` is relative to `<data>` and must stay inside it (symlinked prefixes compared resolved)
 * - `.tmp` + `.url` sidecars; resume only when `resume` is set, the `.tmp` exists and `.url` matches
 * - `Range: bytes=N-` → 206 + validated `Content-Range`; 200/416 → restart from 0; 408/429/5xx retry
 * - 5 retries per stall, counter reset after every 1 MiB of fresh progress
 * - combined progress `{transferred,total}` after resume, every 10 MiB per file, per file end, task end
 * - verification (size, sha256) after all files; on failure the file and its directory (non-recursive)
 *   are removed and the task fails; cancel keeps every partial and finished file
 * - preflight: Windows path limit, free space with 512 MiB headroom (skipped when unknown)
 * - every fs error is rendered `Error: [disk_*] …`
 *
 * I/O is injected (`fetch`, fs, free-space probe, sleep) so the whole flow is testable against a
 * scripted HTTP server without touching the network or the real data folder.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CoreEvents } from '../contracts/index.js'
import { checkFreeSpace, checkPathWithinLimit, diskErrToString, remainingBytes } from './disk.js'
import type { ProxyConfig } from './protocol.js'
import {
  classifyDownloadStatus,
  classifyResumeStatus,
  DownloadRequestError,
  expectedDownloadSize,
  HEAD_TIMEOUT_MS,
  MAX_STREAM_RETRIES,
  PROGRESS_EMIT_INTERVAL_BYTES,
  RETRY_RESET_PROGRESS_BYTES,
  retryDelayMs,
  shouldBypassProxy,
  sidecarPath,
  validateContentRange,
  validateProxyConfig,
} from './protocol.js'
import { policyFetchFor } from './proxy-fetch.js'
import { verifyDownloadedFile } from './verify.js'
import type { VerifyDeps } from './verify.js'

export interface DownloadItem {
  url: string
  /** Relative to `<data>`. */
  save_path: string
  sha256?: string | null
  size?: number | null
  model_id?: string | null
  proxy?: ProxyConfig | null
}

export interface DownloadOptions {
  headers?: Record<string, string>
  resume?: boolean
}

export const DOWNLOAD_CANCELLED = 'Download cancelled'

export interface DownloaderDeps {
  dataFolder: string
  platform: NodeJS.Platform
  fetch: typeof fetch
  /** Build the fetch used for one item; the seam for a per-item proxy (PLAN.md risk 13). */
  fetchFor?: (item: DownloadItem, base: typeof fetch) => typeof fetch
  /** Free bytes on the volume holding `path`, or `undefined` when unknown. */
  availableSpace?: (path: string) => Promise<number | undefined>
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  retryBaseMs?: number
  verify?: VerifyDeps
  emit: <K extends 'download:progress' | 'model:validation-started'>(name: K, payload: CoreEvents[K]) => void
  log?: (level: 'info' | 'warn', msg: string) => void
}

interface Task {
  controller: AbortController
  superseded: boolean
}

export async function defaultAvailableSpace(path: string): Promise<number | undefined> {
  let probe = path
  for (;;) {
    try {
      const s = await statfs(probe)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return undefined
      probe = parent
    }
  }
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(new Error(DOWNLOAD_CANCELLED))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      res()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      rej(new Error(DOWNLOAD_CANCELLED))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolve the longest existing prefix through symlinks, then re-append the rest (Rust `canonicalize_existing_prefix`). */
export async function canonicalizeExistingPrefix(path: string): Promise<string> {
  const abs = resolve(path)
  let head = abs
  const tail: string[] = []
  for (;;) {
    try {
      const real = await realpath(head)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(head)
      if (parent === head) return abs
      tail.push(head.slice(parent.length).replace(/^[\\/]/, ''))
      head = parent
    }
  }
}

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class Downloader {
  private readonly tasks = new Map<string, Task>()
  private readonly deps: Required<
    Pick<DownloaderDeps, 'fetchFor' | 'availableSpace' | 'sleep' | 'retryBaseMs' | 'log'>
  > &
    DownloaderDeps

  constructor(deps: DownloaderDeps) {
    this.deps = {
      fetchFor: policyFetchFor,
      availableSpace: defaultAvailableSpace,
      sleep: defaultSleep,
      retryBaseMs: 1000,
      log: () => {},
      ...deps,
    }
  }

  /** Task ids currently running. */
  active(): string[] {
    return [...this.tasks.keys()]
  }

  /** Cancel a running task. Keeps partials and finished files. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    this.tasks.delete(taskId)
    task.controller.abort()
    return true
  }

  /**
   * Download every item of `taskId`. A second call with the same id supersedes the first (which
   * observes a cancellation but leaves the files to the newcomer).
   */
  async download(taskId: string, items: DownloadItem[], options: DownloadOptions = {}): Promise<void> {
    const existing = this.tasks.get(taskId)
    if (existing) {
      existing.superseded = true
      existing.controller.abort()
    }
    const task: Task = { controller: new AbortController(), superseded: false }
    this.tasks.set(taskId, task)
    try {
      await this.run(taskId, items, options, task.controller.signal)
    } finally {
      if (this.tasks.get(taskId) === task) this.tasks.delete(taskId)
    }
  }

  private async run(taskId: string, items: DownloadItem[], options: DownloadOptions, signal: AbortSignal) {
    const { dataFolder, platform, log } = this.deps
    const resume = options.resume ?? false
    const headers = options.headers ?? {}
    for (const item of items) {
      if (item.proxy) {
        const problem = validateProxyConfig(item.proxy)
        if (problem) throw new Error(`Error: ${problem}`)
      }
    }

    // Preflight sizes (catalog size or HEAD; HEAD failures degrade to unknown).
    const sizes = new Map<string, number>()
    for (const item of items) sizes.set(item.url, await this.preflightSize(item, headers, signal))
    const totalSize = [...sizes.values()].reduce((a, b) => a + b, 0)

    // Preflight paths: containment, Windows limit, free space.
    const resolvedRoot = await canonicalizeExistingPrefix(dataFolder)
    const partialSizes: number[] = []
    const savePaths: string[] = []
    for (const item of items) {
      const savePath = resolve(dataFolder, item.save_path)
      const limit = checkPathWithinLimit(savePath, platform)
      if (limit) throw new Error(limit)
      if (!isInside(await canonicalizeExistingPrefix(savePath), resolvedRoot)) {
        throw new Error(`Path ${savePath} is outside of Jan data folder ${dataFolder}`)
      }
      savePaths.push(savePath)
      if (resume) {
        try {
          partialSizes.push((await stat(sidecarPath(savePath, 'tmp'))).size)
        } catch {
          // no partial yet
        }
      }
    }
    const space = checkFreeSpace(
      await this.deps.availableSpace(dataFolder),
      remainingBytes(totalSize, partialSizes)
    )
    if (space) throw new Error(space)

    const progress = new Map<string, number>()
    const emitProgress = () => {
      const transferred = [...progress.values()].reduce((a, b) => a + b, 0)
      const percent = totalSize > 0 ? Math.min(100, (transferred / totalSize) * 100) : 0
      this.deps.emit('download:progress', { taskId, transferred, total: totalSize, percent })
    }

    const results = await Promise.all(
      items.map((item, i) =>
        this.downloadOne(item, savePaths[i] as string, `${taskId}-${i}`, sizes.get(item.url) ?? 0, {
          headers,
          resume,
          signal,
          progress,
          emitProgress,
        })
      )
    )

    if (items.some((it) => it.sha256 != null || it.size != null)) {
      const modelId =
        items.find((it) => it.model_id != null)?.model_id ??
        (items[0] ? (dirname(items[0].save_path).split(/[\\/]/).pop() ?? 'unknown') : 'unknown')
      this.deps.emit('model:validation-started', { modelId })
      log('info', `Starting validation for model: ${modelId}`)
    }

    const verifications = await Promise.allSettled(
      items.map((item, i) => verifyDownloadedFile(item, results[i] as string, this.deps.verify, signal))
    )
    for (let i = 0; i < verifications.length; i++) {
      const v = verifications[i]
      if (v && v.status === 'rejected') {
        const savePath = results[i] as string
        log('warn', `Validation failed (${(v.reason as Error).message}); removing ${savePath}`)
        await rm(savePath, { force: true }).catch(() => {})
        await rmdir(dirname(savePath)).catch(() => {})
        throw v.reason
      }
    }
    emitProgress()
  }

  private async preflightSize(item: DownloadItem, headers: Record<string, string>, signal: AbortSignal) {
    if (signal.aborted) throw new Error(DOWNLOAD_CANCELLED)
    if (item.size != null && item.size > 0) return item.size
    const fetchImpl = this.deps.fetchFor(item, this.deps.fetch)
    let retry = 0
    for (;;) {
      try {
        const res = await fetchImpl(item.url, {
          method: 'HEAD',
          headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(HEAD_TIMEOUT_MS)]),
        })
        if (!res.ok) {
          const err = classifyDownloadStatus(res.status, '')
          err.message = `Failed to get file size: HTTP status ${res.status}`
          throw err
        }
        return Number(res.headers.get('content-length') ?? '0') || 0
      } catch (e) {
        if (signal.aborted) throw new Error(DOWNLOAD_CANCELLED)
        const retryable = !(e instanceof DownloadRequestError) || e.kind === 'retryable'
        if (retryable && retry < MAX_STREAM_RETRIES) {
          await this.deps.sleep(retryDelayMs(retry, this.deps.retryBaseMs), signal)
          retry++
          continue
        }
        this.deps.log(
          'warn',
          `Preflight HEAD for '${item.url}' failed: ${(e as Error).message}. Continuing with unknown size`
        )
        return 0
      }
    }
  }

  private async request(
    fetchImpl: typeof fetch,
    item: DownloadItem,
    headers: Record<string, string>,
    startBytes: number,
    expectedSize: number,
    signal: AbortSignal
  ): Promise<Response> {
    let res: Response
    try {
      res = await fetchImpl(item.url, {
        headers: startBytes > 0 ? { ...headers, Range: `bytes=${startBytes}-` } : headers,
        signal,
      })
    } catch (e) {
      if (signal.aborted) throw new Error(DOWNLOAD_CANCELLED)
      throw new DownloadRequestError('retryable', (e as Error).message)
    }
    if (startBytes > 0) {
      if (res.status === 206) {
        validateContentRange(res.headers.get('content-range'), startBytes, expectedSize)
        return res
      }
      const body =
        res.status === 200 || res.status === 416 || (res.status >= 500 && res.status < 600)
          ? ''
          : await res.text().catch(() => '')
      throw classifyResumeStatus(res.status, body)
    }
    if (!res.ok) throw classifyDownloadStatus(res.status, await res.text().catch(() => ''))
    return res
  }

  private async requestWithRetry(
    fetchImpl: typeof fetch,
    item: DownloadItem,
    headers: Record<string, string>,
    startBytes: number,
    expectedSize: number,
    signal: AbortSignal
  ): Promise<Response> {
    let retry = 0
    for (;;) {
      try {
        return await this.request(fetchImpl, item, headers, startBytes, expectedSize, signal)
      } catch (e) {
        if (e instanceof DownloadRequestError && e.kind === 'retryable' && retry < MAX_STREAM_RETRIES) {
          if (signal.aborted) throw new Error(DOWNLOAD_CANCELLED)
          this.deps.log(
            'warn',
            `Download request for '${item.url}' failed: ${e.message}. Retry ${retry + 1}/${MAX_STREAM_RETRIES}`
          )
          await this.deps.sleep(retryDelayMs(retry, this.deps.retryBaseMs), signal)
          retry++
          continue
        }
        throw e
      }
    }
  }

  private async downloadOne(
    item: DownloadItem,
    savePath: string,
    fileId: string,
    fileSize: number,
    ctx: {
      headers: Record<string, string>
      resume: boolean
      signal: AbortSignal
      progress: Map<string, number>
      emitProgress: () => void
    }
  ): Promise<string> {
    const { signal, headers, progress, emitProgress } = ctx
    const disk = (e: unknown) => new Error(diskErrToString(e))
    const fetchImpl = this.deps.fetchFor(item, this.deps.fetch)
    if (item.proxy && shouldBypassProxy(item.url, item.proxy.no_proxy ?? []))
      this.deps.log('info', `Bypassing proxy for URL ${item.url}`)

    await mkdir(dirname(savePath), { recursive: true }).catch((e) => {
      throw disk(e)
    })
    const tmpPath = sidecarPath(savePath, 'tmp')
    const urlPath = sidecarPath(savePath, 'url')

    let shouldResume =
      ctx.resume &&
      (await stat(tmpPath).then(
        () => true,
        () => false
      )) &&
      (await readFile(urlPath, 'utf8').then(
        (u) => u === item.url,
        () => false
      ))
    await writeFile(urlPath, item.url).catch((e) => {
      throw disk(e)
    })

    const expectedSize = expectedDownloadSize(item.size, fileSize)
    let res: Response
    let totalTransferred = 0

    if (shouldResume) {
      const downloaded = (
        await stat(tmpPath).catch((e) => {
          throw disk(e)
        })
      ).size
      if (expectedSize > 0 && downloaded === expectedSize) {
        progress.set(fileId, downloaded)
        await rename(tmpPath, savePath).catch((e) => {
          throw disk(e)
        })
        await rm(urlPath, { force: true }).catch(() => {})
        this.deps.log('info', `Completed download was already present for '${item.url}'`)
        return savePath
      }
      if (expectedSize > 0 && downloaded > expectedSize) {
        this.deps.log(
          'warn',
          `Partial file for '${item.url}' is larger than expected (${downloaded} > ${expectedSize}); restarting`
        )
        shouldResume = false
        res = await this.requestWithRetry(fetchImpl, item, headers, 0, expectedSize, signal).catch(
          rethrowAsString
        )
      } else {
        try {
          res = await this.requestWithRetry(fetchImpl, item, headers, downloaded, expectedSize, signal)
          totalTransferred = downloaded
          progress.set(fileId, downloaded)
          emitProgress()
        } catch (e) {
          if (e instanceof DownloadRequestError && e.kind === 'restart') {
            this.deps.log('warn', `Resume is unavailable for '${item.url}': ${e.message}`)
            shouldResume = false
            res = await this.requestWithRetry(fetchImpl, item, headers, 0, expectedSize, signal).catch(
              rethrowAsString
            )
          } else throw rethrowAsString(e)
        }
      }
    } else {
      res = await this.requestWithRetry(fetchImpl, item, headers, 0, expectedSize, signal).catch(
        rethrowAsString
      )
    }

    let writer = createWriteStream(tmpPath, { flags: shouldResume ? 'a' : 'w' })
    const write = (chunk: Uint8Array) =>
      new Promise<void>((ok, fail) => {
        writer.write(chunk, (e) => (e ? fail(disk(e)) : ok()))
      })
    const close = () =>
      new Promise<void>((ok, fail) => writer.end((e?: Error | null) => (e ? fail(disk(e)) : ok())))

    let body = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    let reader = body.getReader()
    let delta = 0
    let retryCount = 0
    let sinceReset = 0

    for (;;) {
      let streamError: string | undefined
      try {
        const { done, value } = await reader.read()
        if (done) {
          if (expectedSize > 0 && totalTransferred < expectedSize) {
            streamError = `stream ended after ${totalTransferred} of ${expectedSize} bytes`
          } else break
        } else if (value) {
          if (signal.aborted) {
            await close().catch(() => {})
            this.deps.log('info', `Download cancelled: ${item.url}`)
            throw new Error(DOWNLOAD_CANCELLED)
          }
          await write(value)
          delta += value.byteLength
          totalTransferred += value.byteLength
          sinceReset += value.byteLength
          if (sinceReset >= RETRY_RESET_PROGRESS_BYTES) {
            retryCount = 0
            sinceReset = 0
          }
          if (delta >= PROGRESS_EMIT_INTERVAL_BYTES) {
            progress.set(fileId, totalTransferred)
            emitProgress()
            delta = 0
          }
        }
      } catch (e) {
        if ((e as Error).message === DOWNLOAD_CANCELLED || (e as Error).message.startsWith('Error: ['))
          throw e
        if (signal.aborted) throw new Error(DOWNLOAD_CANCELLED)
        streamError = (e as Error).message
      }
      if (streamError === undefined) continue

      await close().catch((e) => {
        throw new Error(
          `${(e as Error).message} (failed to flush partial download before retrying '${item.url}')`
        )
      })
      const durable = (
        await stat(tmpPath).catch((e) => {
          throw disk(e)
        })
      ).size
      if (durable !== totalTransferred) {
        throw new Error(
          `Partial download size mismatch for '${item.url}': tracked ${totalTransferred} bytes but persisted ${durable} bytes`
        )
      }
      for (;;) {
        if (retryCount >= MAX_STREAM_RETRIES) {
          throw new Error(
            `Download failed after ${MAX_STREAM_RETRIES} retries at byte ${durable}: ${streamError}`
          )
        }
        if (signal.aborted) throw new Error(DOWNLOAD_CANCELLED)
        this.deps.log(
          'warn',
          `Stream error at byte ${durable} for '${item.url}': ${streamError}. Retry ${retryCount + 1}/${MAX_STREAM_RETRIES}`
        )
        await this.deps.sleep(retryDelayMs(retryCount, this.deps.retryBaseMs), signal)
        retryCount++
        try {
          res = await this.request(fetchImpl, item, headers, durable, expectedSize, signal)
          writer = createWriteStream(tmpPath, { flags: 'a' })
          break
        } catch (e) {
          if (e instanceof DownloadRequestError && e.kind === 'restart') {
            try {
              res = await this.request(fetchImpl, item, headers, 0, expectedSize, signal)
              writer = createWriteStream(tmpPath, { flags: 'w' })
              progress.set(fileId, 0)
              totalTransferred = 0
              delta = 0
              sinceReset = 0
              this.deps.log(
                'warn',
                `Server cannot resume '${item.url}' (${e.message}); restarted from byte 0`
              )
              break
            } catch (e2) {
              if (e2 instanceof DownloadRequestError && e2.kind === 'retryable') {
                this.deps.log('warn', `Full-download reconnect for '${item.url}' failed: ${e2.message}`)
                continue
              }
              throw rethrowAsString(e2)
            }
          }
          if (e instanceof DownloadRequestError && e.kind === 'retryable') {
            this.deps.log('warn', `Range reconnect at byte ${durable} for '${item.url}' failed: ${e.message}`)
            continue
          }
          throw rethrowAsString(e)
        }
      }
      body = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
      reader = body.getReader()
    }

    await close()
    const persisted = (
      await stat(tmpPath).catch((e) => {
        throw disk(e)
      })
    ).size
    if (persisted !== totalTransferred) {
      throw new Error(
        `Downloaded file size mismatch for '${item.url}': tracked ${totalTransferred} bytes but persisted ${persisted} bytes`
      )
    }
    if (expectedSize > 0 && persisted !== expectedSize) {
      throw new Error(
        `Incomplete download for '${item.url}': expected ${expectedSize} bytes but received ${persisted} bytes; partial file was kept for resume`
      )
    }
    progress.set(fileId, totalTransferred)
    emitProgress()
    await rename(tmpPath, savePath).catch((e) => {
      throw disk(e)
    })
    await rm(urlPath, { force: true }).catch((e) => {
      throw disk(e)
    })
    this.deps.log('info', `Finished downloading: ${item.url}`)
    return savePath
  }
}

/** Request errors reach the caller as plain `Error`s with the Rust message text. */
function rethrowAsString(e: unknown): never {
  if (e instanceof DownloadRequestError) throw new Error(e.message)
  throw e
}
