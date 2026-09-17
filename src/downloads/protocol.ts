/**
 * HTTP-level rules of the resumable downloader: sidecar names, retry policy, status classification,
 * `Content-Range` validation and proxy rules. Port of the pure parts of
 * `src-tauri/src/core/downloads/helpers.rs`.
 */

import type { DownloadStage } from '../contracts/index.js'

export const MAX_STREAM_RETRIES = 5
export const RETRY_BASE_DELAY_MS = 1_000
/** Fresh progress that resets the retry counter — the limit is per stall, not per file. */
export const RETRY_RESET_PROGRESS_BYTES = 1024 * 1024
/** Combined progress is reported every 10 MiB per file. */
export const PROGRESS_EMIT_INTERVAL_BYTES = 10 * 1024 * 1024
export const HEAD_TIMEOUT_MS = 30_000
export const CONNECT_TIMEOUT_MS = 30_000

/** `model.gguf` → `model.gguf.tmp`: the extension is appended, so `a.bin` and `a.gguf` differ. */
export function sidecarPath(savePath: string, ext: string): string {
  return `${savePath}.${ext}`
}

/** Exponential backoff, capped at 2^6 × base. */
export function retryDelayMs(retryCount: number, baseMs = RETRY_BASE_DELAY_MS): number {
  return baseMs * 2 ** Math.min(retryCount, 6)
}

/**
 * The stage a retry ladder reports. `attempt` counts requests already made — 0 for the first,
 * then 1…`MAX_STREAM_RETRIES` before each backoff wait — as the app's `StageReporter` does.
 */
export function downloadStage(kind: DownloadStage['kind'], attempt: number): DownloadStage {
  return { kind, attempt, maxAttempts: MAX_STREAM_RETRIES }
}

export type DownloadRequestErrorKind = 'retryable' | 'restart' | 'fatal'

export class DownloadRequestError extends Error {
  constructor(
    readonly kind: DownloadRequestErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'DownloadRequestError'
  }
}

/** 408, 429 and 5xx are worth retrying; everything else that is not success is fatal. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * Validate the `Content-Range` of a 206 resume response against the offset we asked for and the
 * size we expect. Any mismatch means "restart from byte 0", never a silent append.
 */
export function validateContentRange(
  header: string | null | undefined,
  requestedStart: number,
  expectedSize: number
): void {
  const restart = (msg: string) => new DownloadRequestError('restart', msg)
  if (header === null || header === undefined)
    throw restart('Resume response is missing the Content-Range header')
  const value = header
  if (!value.startsWith('bytes '))
    throw restart(`Resume response has an unsupported Content-Range value: ${value}`)
  const range = value.slice('bytes '.length)
  const slash = range.indexOf('/')
  if (slash < 0) throw restart(`Resume response has an invalid Content-Range value: ${value}`)
  const bounds = range.slice(0, slash)
  const total = range.slice(slash + 1)
  const dash = bounds.indexOf('-')
  if (dash < 0) throw restart(`Resume response has an invalid Content-Range value: ${value}`)
  const startStr = bounds.slice(0, dash)
  const endStr = bounds.slice(dash + 1)
  if (!/^\d+$/.test(startStr))
    throw restart('Resume response has an invalid Content-Range start: invalid digit found in string')
  if (!/^\d+$/.test(endStr))
    throw restart('Resume response has an invalid Content-Range end: invalid digit found in string')
  const start = Number(startStr)
  const end = Number(endStr)
  if (start !== requestedStart || end < start) {
    throw restart(
      `Resume response range does not match the requested offset: requested ${requestedStart}, got ${value}`
    )
  }
  if (total !== '*') {
    if (!/^\d+$/.test(total))
      throw restart('Resume response has an invalid Content-Range total: invalid digit found in string')
    const totalNum = Number(total)
    if (end >= totalNum) throw restart(`Resume response range exceeds its declared total: ${value}`)
    if (expectedSize > 0 && totalNum !== expectedSize) {
      throw restart(
        `Remote file size changed while resuming: expected ${expectedSize} bytes, server reports ${totalNum} bytes`
      )
    }
  }
}

/** Classify a non-206 answer to a ranged request. */
export function classifyResumeStatus(status: number, body: string): DownloadRequestError {
  if (status === 200 || status === 416) {
    return new DownloadRequestError('restart', `Server did not accept resume offset: HTTP status ${status}`)
  }
  if (isRetryableStatus(status)) {
    return new DownloadRequestError('retryable', `Resume request failed with HTTP status ${status}`)
  }
  return new DownloadRequestError('fatal', `Failed to resume download: HTTP status ${status}, ${body}`)
}

/** Classify a non-2xx answer to a plain request. */
export function classifyDownloadStatus(status: number, body: string): DownloadRequestError {
  const message = `Failed to download: HTTP status ${status}, ${body}`
  return new DownloadRequestError(isRetryableStatus(status) ? 'retryable' : 'fatal', message)
}

export interface ProxyConfig {
  url: string
  username?: string | null
  password?: string | null
  no_proxy?: string[] | null
  ignore_ssl?: boolean | null
}

/** Same rules as `validate_proxy_config`; returns the error text or `undefined`. */
export function validateProxyConfig(config: ProxyConfig): string | undefined {
  let url: URL
  try {
    url = new URL(config.url)
  } catch (e) {
    return `Invalid proxy URL '${config.url}': ${(e as Error).message}`
  }
  const scheme = url.protocol.replace(/:$/, '')
  if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) return `Unsupported proxy scheme: ${scheme}`
  const hasUser = config.username !== undefined && config.username !== null
  const hasPass = config.password !== undefined && config.password !== null
  if (hasUser && !hasPass) return 'Username provided without password'
  if (hasPass && !hasUser) return 'Password provided without username'
  for (const entry of config.no_proxy ?? []) {
    if (entry === '') return 'Empty no_proxy entry'
    if (entry.startsWith('*.') && entry.length < 3) return `Invalid wildcard pattern: ${entry}`
  }
  return undefined
}

/** `*` matches everything, `*.domain` matches by suffix, otherwise exact host match. */
export function shouldBypassProxy(url: string, noProxy: string[]): boolean {
  if (noProxy.length === 0) return false
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  if (host === '') return false
  for (const entry of noProxy) {
    if (entry === '*') return true
    if (entry.startsWith('*.')) {
      if (host.endsWith(entry.slice(2))) return true
    } else if (host === entry) return true
  }
  return false
}

/** Size to expect: the catalog size when known, else what the HEAD reported (0 = unknown). */
export function expectedDownloadSize(catalogSize: number | undefined | null, responseSize: number): number {
  return catalogSize !== undefined && catalogSize !== null && catalogSize > 0 ? catalogSize : responseSize
}
