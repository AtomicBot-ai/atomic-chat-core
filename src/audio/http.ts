/**
 * The HTTP the audio module needs against `audiocpp_server`: a GET or a JSON POST with a deadline and
 * an abort signal, status, content type and the body as bytes back (a speech answer is a WAV, a task
 * answer a JSON document that can run past 100 MB for a long song). Over the raw-socket client rather
 * than the global `fetch`, which in the Bun-compiled binary honours `HTTP_PROXY` even for loopback
 * (ADR 2026-09-15-proxied-downloads-use-a-raw-socket-client), as image generation does.
 */

import { createPolicyFetch } from '../downloads/index.js'

export interface AudioResponse {
  status: number
  contentType: string
  body: Buffer
}

export interface AudioRequestOptions {
  timeoutMs: number
  /** Stops the exchange (a cancel); the promise rejects with the abort. */
  signal?: AbortSignal
}

export interface AudioHttpClient {
  get(url: string, options: AudioRequestOptions): Promise<AudioResponse>
  post(url: string, json: unknown, options: AudioRequestOptions): Promise<AudioResponse>
}

/** Thrown when the deadline, not the caller, ended the exchange. */
export class AudioTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`audiocpp_server did not answer within ${timeoutMs} ms`)
    this.name = 'AudioTimeoutError'
  }
}

/** One request with a deadline that covers the whole exchange, body included. */
async function exchange(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: AudioRequestOptions
): Promise<AudioResponse> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const forward = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    const body = Buffer.from(await response.arrayBuffer())
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', body }
  } catch (error) {
    if (timedOut) throw new AudioTimeoutError(options.timeoutMs)
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forward)
  }
}

export function createAudioHttpClient(fetchImpl: typeof fetch = createPolicyFetch({})): AudioHttpClient {
  return {
    get: (url, options) => exchange(fetchImpl, url, { method: 'GET' }, options),
    post: (url, json, options) => {
      const body = JSON.stringify(json)
      const headers = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      }
      return exchange(fetchImpl, url, { method: 'POST', headers, body }, options)
    },
  }
}
