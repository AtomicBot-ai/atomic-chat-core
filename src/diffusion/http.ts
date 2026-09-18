/**
 * The little HTTP the job runner needs against `sd-server`: a GET or a JSON POST with a deadline,
 * status and body text back. Over the raw-socket client rather than the global `fetch`, which in the
 * Bun-compiled binary honours `HTTP_PROXY` even for loopback (measured while planning stage 7;
 * ADR 2026-09-15-proxied-downloads-use-a-raw-socket-client).
 */

import { createPolicyFetch } from '../downloads/index.js'

export interface SdResponse {
  status: number
  text: string
}

export interface SdHttpClient {
  get(url: string, timeoutMs: number): Promise<SdResponse>
  /** `json` undefined sends an empty body (sd.cpp's cancel takes none). */
  post(url: string, json: unknown, timeoutMs: number): Promise<SdResponse>
}

/** One request with a deadline that covers the whole exchange, body included. */
async function exchange(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<SdResponse> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    return { status: response.status, text: await response.text() }
  } catch (error) {
    if (timedOut) throw new Error(`sd-server did not answer within ${timeoutMs} ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function createSdHttpClient(fetchImpl: typeof fetch = createPolicyFetch({})): SdHttpClient {
  return {
    get: (url, timeoutMs) => exchange(fetchImpl, url, { method: 'GET' }, timeoutMs),
    post: (url, json, timeoutMs) => {
      const body = json === undefined ? '' : JSON.stringify(json)
      const headers: Record<string, string> = { 'content-length': String(Buffer.byteLength(body)) }
      if (json !== undefined) headers['content-type'] = 'application/json'
      return exchange(fetchImpl, url, { method: 'POST', headers, body }, timeoutMs)
    },
  }
}
