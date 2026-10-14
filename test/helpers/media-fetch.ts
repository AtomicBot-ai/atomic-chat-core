/**
 * A fake `fetch` for the remote media adapters: routes by method and URL, records every request with
 * its parsed body, and answers with canned responses. Plus a `MediaContext` whose `sleep` returns at
 * once, and tiny valid media files.
 */

import { diffusionError } from '../../src/diffusion/index.js'
import type { MediaContext } from '../../src/media/http.js'

export interface RecordedRequest {
  method: string
  url: string
  headers: Headers
  /** The JSON body, parsed; `undefined` for a body that is not JSON. */
  json: unknown
  /** The multipart body, when there was one. */
  form?: FormData
  text?: string
}

export type Answer = Response | ((request: RecordedRequest) => Response | Promise<Response>)

export interface FakeRoute {
  method: string
  /** A full URL, or a pattern the URL must match. */
  url: string | RegExp
  /** One answer for every call, or a list taken in order (the last one repeats). */
  answer: Answer | Answer[]
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function bytesResponse(bytes: Buffer, type: string, status = 200): Response {
  return new Response(new Uint8Array(bytes), { status, headers: { 'content-type': type } })
}

/** A route table as a `fetch`; an unrouted request is a 599 so a test sees it fail. */
export function fakeMediaFetch(routes: FakeRoute[]): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const calls = new Map<FakeRoute, number>()
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const recorded: RecordedRequest = { method, url, headers, json: undefined }
    if (typeof init.body === 'string') {
      recorded.text = init.body
      try {
        recorded.json = JSON.parse(init.body)
      } catch {
        recorded.json = undefined
      }
    } else if (init.body instanceof FormData) recorded.form = init.body
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    requests.push(recorded)
    const route = routes.find(
      (r) => r.method === method && (typeof r.url === 'string' ? r.url === url : r.url.test(url))
    )
    if (!route) return new Response(`no route for ${method} ${url}`, { status: 599 })
    const n = calls.get(route) ?? 0
    calls.set(route, n + 1)
    const answers = Array.isArray(route.answer) ? route.answer : [route.answer]
    const answer = answers[Math.min(n, answers.length - 1)] as Answer
    if (typeof answer === 'function') return answer(recorded)
    // A fresh Response per call rather than a clone: a cloned body is a tee, and cancelling one branch
    // of a tee waits for the other.
    return new Response(answer.body === null ? null : await answer.clone().arrayBuffer(), {
      status: answer.status,
      headers: answer.headers,
    })
  }
  return { fetch: fetchImpl as typeof fetch, requests }
}

/** A context for adapter tests: no real waits, a clock that moves with every sleep. */
export function mediaContext(overrides: Partial<MediaContext> & Pick<MediaContext, 'fetch'>): MediaContext {
  let clock = 1_000_000
  const signal = overrides.signal ?? new AbortController().signal
  return {
    provider: 'test',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    customHeaders: [],
    signal,
    now: () => clock,
    sleep: async (ms: number) => {
      if (signal.aborted) throw diffusionError('CANCELLED', 'Generation was cancelled.')
      clock += ms
    },
    log: () => {},
    ...overrides,
  }
}

/** A 1×1 PNG. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
)

/** The first bytes of a JPEG; enough for the sniffer. */
export const JPEG_STUB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

/** The first bytes of an MP4 (`ftyp isom`); enough for the sniffer. */
export const MP4_STUB = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(12),
])
