import { describe, expect, it } from 'vitest'
import {
  bytesResponse,
  fakeMediaFetch,
  JPEG_STUB,
  jsonResponse,
  mediaContext,
  MP4_STUB,
  PNG_1X1,
} from '../../test/helpers/media-fetch.js'
import {
  callProvider,
  decodeBase64Image,
  downloadResult,
  joinUrl,
  networkError,
  originOf,
  parseWxH,
  pollUntil,
  providerHeaders,
  providerMessage,
  remoteError,
  remoteHttpError,
  sniffImageMime,
  sniffVideoMime,
  toDataUrl,
} from './http.js'

describe('urls', () => {
  it('join without doubling slashes, and read an origin', () => {
    expect(joinUrl('https://a.example/v1/', '/images')).toBe('https://a.example/v1/images')
    expect(joinUrl('https://a.example/v1', 'images')).toBe('https://a.example/v1/images')
    expect(originOf('https://a.example:8443/v1/x')).toBe('https://a.example:8443')
    expect(originOf('not a url')).toBeUndefined()
  })
})

describe('providerHeaders', () => {
  it('sends custom headers, then the key in the asked style', () => {
    const ctx = { apiKey: 'k', customHeaders: [{ header: 'X-Org', value: 'o' }] }
    expect(Object.fromEntries(providerHeaders(ctx))).toEqual({ 'x-org': 'o', 'authorization': 'Bearer k' })
    expect(Object.fromEntries(providerHeaders(ctx, 'goog'))).toEqual({ 'x-org': 'o', 'x-goog-api-key': 'k' })
    expect(Object.fromEntries(providerHeaders(ctx, 'none', { Accept: 'x' }))).toEqual({
      'x-org': 'o',
      'accept': 'x',
    })
  })

  it('keeps a custom Authorization (basic auth in front of a self-hosted server)', () => {
    const headers = providerHeaders({
      apiKey: 'k',
      customHeaders: [{ header: 'Authorization', value: 'Basic eA==' }],
    })
    expect(headers.get('authorization')).toBe('Basic eA==')
  })
})

describe('errors', () => {
  it('read the provider words out of the usual shapes', () => {
    expect(providerMessage({ error: { message: 'bad size' } })).toBe('bad size')
    expect(providerMessage({ error: 'nope' })).toBe('nope')
    expect(providerMessage({ detail: [{ msg: 'field required' }] })).toBe('field required')
    expect(providerMessage({ base_resp: { status_msg: 'invalid key' } })).toBe('invalid key')
    expect(providerMessage(undefined, 'plain text')).toBe('plain text')
    expect(providerMessage(undefined, '')).toBeUndefined()
  })

  it.each([
    [401, {}, 'REMOTE_AUTH_FAILED'],
    [403, {}, 'REMOTE_AUTH_FAILED'],
    [402, {}, 'REMOTE_QUOTA'],
    [429, {}, 'REMOTE_RATE_LIMITED'],
    [504, {}, 'REMOTE_TIMEOUT'],
    [503, {}, 'REMOTE_UNAVAILABLE'],
    [400, { error: { message: 'rejected by our safety system' } }, 'REMOTE_CONTENT_BLOCKED'],
    [400, { error: { message: 'size must be one of ...' } }, 'REMOTE_REJECTED'],
  ])('map HTTP %i to the closest code', (status, body, code) => {
    expect(remoteHttpError('acme', status, body).code).toBe(code)
  })

  it('tell a cancel, a timeout and an unreachable provider apart', () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(networkError({ provider: 'acme', signal: aborted.signal }, new Error('x')).code).toBe('CANCELLED')
    const live = new AbortController().signal
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
    expect(networkError({ provider: 'acme', signal: live }, timeout).code).toBe('REMOTE_TIMEOUT')
    expect(networkError({ provider: 'acme', signal: live }, new TypeError('fetch failed')).code).toBe(
      'REMOTE_UNAVAILABLE'
    )
    expect(remoteError('REMOTE_REJECTED', 'no', 'why')).toMatchObject({
      code: 'REMOTE_REJECTED',
      details: 'why',
    })
  })
})

describe('callProvider', () => {
  it('sends JSON with the key and answers a 2xx parsed', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: 'https://api.example.com/v1/x', answer: jsonResponse({ ok: 1 }) },
    ])
    const answer = await callProvider(mediaContext({ fetch }), 'https://api.example.com/v1/x', {
      json: { a: 1 },
    })
    expect(answer.json).toEqual({ ok: 1 })
    expect(requests[0]?.headers.get('content-type')).toBe('application/json')
    expect(requests[0]?.json).toEqual({ a: 1 })
  })

  it('throws a non-2xx as a REMOTE code unless the status is accepted', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: 'https://api.example.com/v1/y', answer: jsonResponse({ error: 'gone' }, 404) },
    ])
    const ctx = mediaContext({ fetch })
    await expect(callProvider(ctx, 'https://api.example.com/v1/y')).rejects.toMatchObject({
      code: 'REMOTE_REJECTED',
    })
    expect((await callProvider(ctx, 'https://api.example.com/v1/y', { accept: [404] })).status).toBe(404)
  })
})

describe('downloadResult', () => {
  it('sends the key on the provider origin, follows a redirect off it bare', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: 'https://api.example.com/v1/files/1',
        answer: new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/1.mp4' } }),
      },
      { method: 'GET', url: 'https://cdn.example.net/1.mp4', answer: bytesResponse(MP4_STUB, 'video/mp4') },
    ])
    const file = await downloadResult(mediaContext({ fetch }), 'https://api.example.com/v1/files/1', {
      maxBytes: 1000,
    })
    expect(file.bytes).toEqual(MP4_STUB)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[1]?.headers.get('authorization')).toBeNull()
  })

  it('refuses plain http off the provider origin, and a file over the cap', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'GET',
        url: 'https://cdn.example.net/big',
        answer: bytesResponse(Buffer.alloc(64), 'image/png'),
      },
    ])
    const ctx = mediaContext({ fetch })
    await expect(downloadResult(ctx, 'http://cdn.example.net/x', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'REMOTE_REJECTED',
    })
    await expect(downloadResult(ctx, 'https://cdn.example.net/big', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    })
  })
})

describe('bytes', () => {
  it('sniff images and clips by their first bytes', () => {
    expect(sniffImageMime(PNG_1X1)).toBe('image/png')
    expect(sniffImageMime(JPEG_STUB)).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.from('GIF89a......'))).toBe('image/gif')
    expect(sniffImageMime(Buffer.from('nope'))).toBeUndefined()
    expect(sniffVideoMime(MP4_STUB)).toBe('video/mp4')
    expect(sniffVideoMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video/webm')
  })

  it('decode base64 and data URLs, refusing what is not an image', () => {
    const url = toDataUrl(PNG_1X1, 'image/png')
    expect(decodeBase64Image(url)).toEqual({ bytes: PNG_1X1, mime: 'image/png' })
    expect(decodeBase64Image(PNG_1X1.toString('base64')).mime).toBe('image/png')
    expect(() => decodeBase64Image(Buffer.from('text').toString('base64'))).toThrow(
      expect.objectContaining({ code: 'INVALID_OUTPUT' })
    )
  })

  it('read WxH sizes in either separator', () => {
    expect(parseWxH('1024x768')).toEqual({ width: 1024, height: 768 })
    expect(parseWxH('1328*1328')).toEqual({ width: 1328, height: 1328 })
    expect(parseWxH('auto')).toBeUndefined()
    expect(parseWxH(undefined)).toBeUndefined()
  })
})

describe('pollUntil', () => {
  it('waits with backoff until the step answers', async () => {
    const waits: number[] = []
    const { fetch } = fakeMediaFetch([])
    const base = mediaContext({ fetch })
    const ctx = { ...base, sleep: async (ms: number) => void waits.push(ms) }
    let n = 0
    const answer = await pollUntil(ctx, async () => (++n === 4 ? 'done' : undefined), {
      intervalMs: 100,
      maxIntervalMs: 200,
      timeoutMs: 10_000,
    })
    expect(answer).toBe('done')
    expect(waits).toEqual([100, 150, 200])
  })

  it('gives up with REMOTE_TIMEOUT past the deadline', async () => {
    const { fetch } = fakeMediaFetch([])
    await expect(
      pollUntil(mediaContext({ fetch }), async () => undefined, { intervalMs: 1000, timeoutMs: 2500 })
    ).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' })
  })
})
