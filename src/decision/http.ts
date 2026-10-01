/**
 * The HTTP the decision module needs against its own process: a GET or a POST of ready bytes, with a
 * deadline over the whole exchange, an optional caller signal and the process's bearer key. Over the
 * raw-socket client rather than the global `fetch`, which in the Bun-compiled binary honours
 * `HTTP_PROXY` even for loopback (ADR 2026-09-15-proxied-downloads-use-a-raw-socket-client).
 *
 * The body is sent as given: callers that pass bytes through (the public route) never have them
 * re-serialized, and callers that build a request serialize it once themselves.
 */

import { createPolicyFetch } from '../downloads/index.js'

export interface DecisionHttpResponse {
  status: number
  text: string
}

export interface DecisionRequest {
  method: 'GET' | 'POST'
  /** Bearer key of the process; omitted for the public routes before it is known. */
  apiKey?: string
  body?: string | Buffer
  contentType?: string
  timeoutMs: number
  /** The caller gave up (a client that left, a shutdown). */
  signal?: AbortSignal
}

export interface DecisionHttp {
  request(url: string, init: DecisionRequest): Promise<DecisionHttpResponse>
}

/** The deadline passed before the answer was complete. */
export class DecisionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the decision model did not answer within ${timeoutMs} ms`)
    this.name = 'DecisionTimeoutError'
  }
}

/** The caller's signal fired first. */
export class DecisionAbortedError extends Error {
  constructor() {
    super('the decision request was abandoned by its caller')
    this.name = 'DecisionAbortedError'
  }
}

export function createDecisionHttp(fetchImpl: typeof fetch = createPolicyFetch({})): DecisionHttp {
  return {
    async request(url, init) {
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, init.timeoutMs)
      const onAbort = () => controller.abort()
      if (init.signal?.aborted) controller.abort()
      else init.signal?.addEventListener('abort', onAbort, { once: true })
      const headers: Record<string, string> = { accept: 'application/json' }
      if (init.apiKey) headers['authorization'] = `Bearer ${init.apiKey}`
      let body: Buffer | undefined
      if (init.body !== undefined) {
        body = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body, 'utf8')
        headers['content-type'] = init.contentType ?? 'application/json'
        headers['content-length'] = String(body.length)
      }
      try {
        const response = await fetchImpl(url, {
          method: init.method,
          headers,
          ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
          signal: controller.signal,
        })
        return { status: response.status, text: await response.text() }
      } catch (error) {
        if (timedOut) throw new DecisionTimeoutError(init.timeoutMs)
        if (init.signal?.aborted) throw new DecisionAbortedError()
        throw error
      } finally {
        clearTimeout(timer)
        init.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
