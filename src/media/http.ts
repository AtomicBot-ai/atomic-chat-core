/**
 * How every media adapter talks to a provider: the request context, the provider's own headers, one
 * call shape that turns a non-2xx answer into a `REMOTE_*` error, and the download of a file a
 * provider pointed at. Two rules hold for every adapter:
 *
 * - every request to the provider goes to a URL derived from the registered `base_url` in code; the
 *   catalog never names a host, so it can never send a key anywhere new;
 * - a file the provider points at is fetched with the provider's key and custom headers only on the
 *   provider's own origin; anywhere else it goes bare, and only over https.
 */

import type { AtomicCoreError } from '../contracts/index.js'
import type { DiffusionErrorCode } from '../contracts/index.js'
import { diffusionError } from '../diffusion/index.js'

/** A generated image larger than this is not one. */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024
/** A clip larger than this is refused rather than held in memory. */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024
/** A generation call that answers with the result (images): the slowest providers take minutes. */
export const GENERATE_TIMEOUT_MS = 10 * 60_000
/** Listing, submitting and polling. */
export const SHORT_TIMEOUT_MS = 60_000
/** Redirects a download may follow. */
export const MAX_REDIRECTS = 5

export type MediaLog = (level: 'info' | 'warn' | 'debug', message: string) => void

/** What every adapter call gets: who the provider is, how to reach it, and when to stop. */
export interface MediaContext {
  provider: string
  /** The registered base URL without a trailing slash, e.g. `https://api.openai.com/v1`. */
  baseUrl: string
  apiKey: string | null
  customHeaders: ReadonlyArray<{ header: string; value: string }>
  /** Fires when the job is cancelled; every request and wait of the call stops with it. */
  signal: AbortSignal
  fetch: typeof fetch
  now: () => number
  /** Waits `ms`, or rejects with `CANCELLED` when `signal` fires first. */
  sleep: (ms: number) => Promise<void>
  log: MediaLog
}

/** How a provider takes its key: `Authorization: Bearer`, Google's `x-goog-api-key`, or not at all. */
export type AuthStyle = 'bearer' | 'goog' | 'none'

export function remoteError(code: DiffusionErrorCode, message: string, details?: string): AtomicCoreError {
  return diffusionError(code, message, details)
}

/** The base URL without a trailing slash, joined to `path` (which starts with `/`). */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

/** `scheme://host[:port]` of an absolute URL, or `undefined` when it is not one. */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** The headers of a request to the provider itself: its custom headers, then its key. */
export function providerHeaders(
  ctx: Pick<MediaContext, 'apiKey' | 'customHeaders'>,
  auth: AuthStyle = 'bearer',
  extra: Record<string, string> = {}
): Headers {
  const headers = new Headers()
  for (const { header, value } of ctx.customHeaders) headers.set(header, value)
  const key = ctx.apiKey?.trim()
  // A custom `Authorization` (basic auth in front of a self-hosted server) is the provider's own.
  if (key && auth === 'bearer' && !headers.has('authorization')) headers.set('Authorization', `Bearer ${key}`)
  if (key && auth === 'goog') headers.set('x-goog-api-key', key)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return headers
}

/** The provider's own words out of an error body, whatever shape it uses. */
export function providerMessage(body: unknown, text = ''): string | undefined {
  const pick = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const fields = body as Record<string, unknown>
    const error = fields['error']
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const inner = error as Record<string, unknown>
      const said = pick(inner['message']) ?? pick(inner['msg'])
      if (said) return said
    }
    const said =
      pick(error) ??
      pick(fields['message']) ??
      pick(fields['detail']) ??
      pick(fields['msg']) ??
      pick(fields['status_msg'])
    if (said) return said
    const detail = fields['detail']
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as Record<string, unknown> | undefined
      const message = pick(first?.['msg'])
      if (message) return message
    }
    const base = fields['base_resp']
    if (base && typeof base === 'object') {
      const message = pick((base as Record<string, unknown>)['status_msg'])
      if (message) return message
    }
  }
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, 500)
}

const BLOCKED = /moderation|content[ _-]?polic|safety|nsfw|sensitive|prohibited|blocked by|flagged/i

/** A provider's non-2xx answer as the closest `REMOTE_*` code, with its words in the message. */
export function remoteHttpError(provider: string, status: number, body: unknown, text = ''): AtomicCoreError {
  const said = providerMessage(body, text)
  const details = `HTTP ${status}${said ? `: ${said}` : ''}`
  if (status === 401 || status === 403)
    return remoteError('REMOTE_AUTH_FAILED', `${provider} refused the API key or the model.`, details)
  if (status === 402)
    return remoteError('REMOTE_QUOTA', `${provider} says the account is out of credit.`, details)
  if (status === 429)
    return remoteError('REMOTE_RATE_LIMITED', `${provider} is rate-limiting requests.`, details)
  if (status === 408 || status === 504)
    return remoteError('REMOTE_TIMEOUT', `${provider} took too long to answer.`, details)
  if (status >= 500) return remoteError('REMOTE_UNAVAILABLE', `${provider} failed to answer.`, details)
  if (said && BLOCKED.test(said))
    return remoteError('REMOTE_CONTENT_BLOCKED', `${provider} refused the request: ${said}`, details)
  return remoteError(
    'REMOTE_REJECTED',
    said ? `${provider}: ${said}` : `${provider} refused the request.`,
    details
  )
}

/** A request that never got an answer: cancelled, timed out, or the provider unreachable. */
export function networkError(
  ctx: Pick<MediaContext, 'provider' | 'signal'>,
  error: unknown
): AtomicCoreError {
  if (ctx.signal.aborted) return diffusionError('CANCELLED', 'Generation was cancelled.')
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return remoteError('REMOTE_TIMEOUT', `${ctx.provider} took too long to answer.`, message)
  return remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} could not be reached.`, message)
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** A JSON body. */
  json?: unknown
  /** A multipart body; the boundary is set by `fetch`. */
  form?: FormData
  auth?: AuthStyle
  headers?: Record<string, string>
  timeoutMs?: number
  /** Statuses outside 2xx answered as they are instead of thrown (a 202 poll, a 404 that means "gone"). */
  accept?: readonly number[]
}

export interface CallAnswer {
  status: number
  headers: Headers
  text: string
  /** The body as JSON, or `undefined` when it is not JSON. */
  json: unknown
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** The job's signal and a timeout as one. */
function deadline(ctx: Pick<MediaContext, 'signal'>, timeoutMs: number): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])
}

/**
 * One request to the provider. A 2xx (or a status in `accept`) is answered; anything else is thrown
 * as a `REMOTE_*` error carrying the provider's words.
 */
export async function callProvider(
  ctx: MediaContext,
  url: string,
  options: CallOptions = {}
): Promise<CallAnswer> {
  const extra: Record<string, string> = { Accept: 'application/json', ...options.headers }
  let body: string | FormData | undefined
  if (options.json !== undefined) {
    extra['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  } else if (options.form !== undefined) body = options.form
  const headers = providerHeaders(ctx, options.auth ?? 'bearer', extra)
  let response: Response
  try {
    response = await ctx.fetch(url, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body }),
      signal: deadline(ctx, options.timeoutMs ?? SHORT_TIMEOUT_MS),
    })
  } catch (error) {
    throw networkError(ctx, error)
  }
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw networkError(ctx, error)
  }
  const json = parseJson(text)
  const ok = response.status >= 200 && response.status < 300
  if (!ok && !(options.accept ?? []).includes(response.status))
    throw remoteHttpError(ctx.provider, response.status, json, text)
  return { status: response.status, headers: response.headers, text, json }
}

/** Read a body into memory, refusing it once it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number, what: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes)
    throw diffusionError(
      'INVALID_OUTPUT',
      `The provider's ${what} is larger than the core accepts.`,
      `${declared} bytes`
    )
  if (!response.body) return Buffer.from(await response.arrayBuffer())
  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      // Not awaited: a body teed elsewhere only settles its cancel once every branch is cancelled.
      void reader.cancel().catch(() => undefined)
      throw diffusionError(
        'INVALID_OUTPUT',
        `The provider's ${what} is larger than the core accepts.`,
        `over ${maxBytes} bytes`
      )
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export interface DownloadOptions {
  maxBytes: number
  /** How the key goes along when the file is on the provider's own origin. */
  auth?: AuthStyle
  timeoutMs?: number
  /** What the file is, for messages: `image`, `video`. */
  what?: string
}

/**
 * Fetch a file the provider pointed at. Redirects are followed by hand so the key never follows one
 * off the provider's origin; a URL off that origin must be https.
 */
export async function downloadResult(
  ctx: MediaContext,
  url: string,
  options: DownloadOptions
): Promise<{ bytes: Buffer; mime: string }> {
  const home = originOf(ctx.baseUrl)
  const what = options.what ?? 'file'
  let target = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const origin = originOf(target)
    if (!origin)
      throw remoteError('REMOTE_REJECTED', `${ctx.provider} pointed at an invalid ${what} URL.`, target)
    const own = origin === home
    if (!own && !target.startsWith('https://'))
      throw remoteError('REMOTE_REJECTED', `${ctx.provider} pointed at a ${what} over plain http.`, origin)
    const headers = own ? providerHeaders(ctx, options.auth ?? 'bearer') : new Headers()
    let response: Response
    try {
      response = await ctx.fetch(target, {
        headers,
        redirect: 'manual',
        signal: deadline(ctx, options.timeoutMs ?? GENERATE_TIMEOUT_MS),
      })
    } catch (error) {
      throw networkError(ctx, error)
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!next) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} redirected without a location.`)
      target = new URL(next, target).toString()
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      const text = await response.text().catch(() => '')
      throw remoteHttpError(ctx.provider, response.status, parseJson(text), text)
    }
    try {
      const bytes = await readCapped(response, options.maxBytes, what)
      return { bytes, mime: (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '' }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) throw error
      throw networkError(ctx, error)
    }
  }
  throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} redirected the ${what} too many times.`)
}

/** What the first bytes of an image say it is. */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif'
  return undefined
}

/** What the first bytes of a clip say it is. */
export function sniffVideoMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4'
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return 'video/webm'
  return undefined
}

/** Base64 or a data URL as bytes and the type the bytes themselves say. */
export function decodeBase64Image(payload: string, what = 'image'): { bytes: Buffer; mime: string } {
  const comma = payload.startsWith('data:') ? payload.indexOf(',') : -1
  const raw = (comma >= 0 ? payload.slice(comma + 1) : payload).trim()
  const bytes = Buffer.from(raw, 'base64')
  const mime = sniffImageMime(bytes)
  if (bytes.length === 0 || !mime)
    throw diffusionError('INVALID_OUTPUT', `The provider returned a ${what} that is not an image.`)
  return { bytes, mime }
}

export function toDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** `'1024x768'` → its dimensions; anything else (`auto`, a tier) → `undefined`. */
export function parseWxH(size: string | undefined): { width: number; height: number } | undefined {
  const match = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(size?.trim() ?? '')
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : undefined
}

export interface PollOptions {
  /** The first wait, and the wait between attempts until backoff grows it. */
  intervalMs: number
  /** The wait never grows past this. */
  maxIntervalMs?: number
  /** Give up with `REMOTE_TIMEOUT` after this long. */
  timeoutMs: number
}

/**
 * Ask `step` until it answers something, waiting in between (growing by half each time up to
 * `maxIntervalMs`). Stops with `CANCELLED` when the job is cancelled, `REMOTE_TIMEOUT` past
 * `timeoutMs`. For adapters whose image API is a job to poll.
 */
export async function pollUntil<T>(
  ctx: MediaContext,
  step: () => Promise<T | undefined>,
  options: PollOptions
): Promise<T> {
  const started = ctx.now()
  let wait = options.intervalMs
  for (;;) {
    const answer = await step()
    if (answer !== undefined) return answer
    if (ctx.now() - started > options.timeoutMs)
      throw remoteError(
        'REMOTE_TIMEOUT',
        `${ctx.provider} did not finish in time.`,
        `${options.timeoutMs} ms`
      )
    await ctx.sleep(wait)
    wait = Math.min(Math.round(wait * 1.5), options.maxIntervalMs ?? wait)
  }
}
