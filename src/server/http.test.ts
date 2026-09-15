import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  hostHeaderIsLoopback,
  isLoopbackAddress,
  MAX_JSON_BODY_BYTES,
  pathOf,
  queryOf,
  readJsonBody,
  Router,
  sendError,
  statusForCode,
} from './http.js'

describe('Router', () => {
  const router = new Router()
    .get('/atomic/v1/health', () => {})
    .post('/atomic/v1/clients/:id/heartbeat', () => {})
    .post('/atomic/v1/models/:provider/*modelId/load', () => {})

  it('matches literal, named and rest segments', () => {
    expect(router.find('GET', '/atomic/v1/health')).toMatchObject({ match: { params: {} } })
    expect(router.find('POST', '/atomic/v1/clients/abc-123/heartbeat')).toMatchObject({
      match: { params: { id: 'abc-123' } },
    })
    expect(router.find('POST', '/atomic/v1/models/llamacpp-upstream/Owner/Repo-GGUF/load')).toMatchObject({
      match: { params: { provider: 'llamacpp-upstream', modelId: 'Owner/Repo-GGUF' } },
    })
  })

  it('separates an unknown path from a wrong method', () => {
    expect(router.find('GET', '/atomic/v1/nope')).toBeUndefined()
    expect(router.find('POST', '/atomic/v1/health')).toEqual({ methodMismatch: true })
    expect(router.find('GET', '/atomic/v1/models/p/m/load')).toEqual({ methodMismatch: true })
  })

  it('refuses a rest segment with nothing in it and a path that is too short or too long', () => {
    expect(router.find('POST', '/atomic/v1/models/llamacpp/load')).toBeUndefined()
    expect(router.find('POST', '/atomic/v1/clients/abc')).toBeUndefined()
    expect(router.find('GET', '/atomic/v1/health/extra')).toBeUndefined()
  })

  it('decodes a percent-encoded named segment', () => {
    expect(router.find('POST', '/atomic/v1/clients/a%2Fb/heartbeat')).toMatchObject({
      match: { params: { id: 'a/b' } },
    })
  })
})

describe('loopback checks', () => {
  it('accepts loopback peers, including IPv4-mapped IPv6, and rejects the rest', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.3.2.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('accepts only loopback Host names, which is the DNS-rebinding guard', () => {
    expect(hostHeaderIsLoopback('127.0.0.1:41000')).toBe(true)
    expect(hostHeaderIsLoopback('localhost:41000')).toBe(true)
    expect(hostHeaderIsLoopback('LOCALHOST')).toBe(true)
    expect(hostHeaderIsLoopback('[::1]:41000')).toBe(true)
    expect(hostHeaderIsLoopback('evil.example.com:41000')).toBe(false)
    expect(hostHeaderIsLoopback('localhost.evil.com')).toBe(false)
    expect(hostHeaderIsLoopback(undefined)).toBe(false)
  })
})

describe('error envelope', () => {
  it('maps codes to statuses, with 500 for anything unmapped', () => {
    expect(statusForCode('UNAUTHORIZED')).toBe(401)
    expect(statusForCode('FORBIDDEN_HOST')).toBe(403)
    expect(statusForCode('MODEL_NOT_FOUND')).toBe(404)
    expect(statusForCode('CORE_ALREADY_RUNNING')).toBe(409)
    expect(statusForCode('INVALID_ARGUMENT')).toBe(400)
    expect(statusForCode('CORE_NOT_RUNNING')).toBe(503)
    expect(statusForCode('MODEL_LOAD_TIMED_OUT')).toBe(504)
    expect(statusForCode('OUT_OF_MEMORY')).toBe(500)
  })
})

describe('request helpers over a real socket', () => {
  let base = ''
  const server = createServer((req, res) => {
    void (async () => {
      const path = pathOf(req)
      if (path === '/query') {
        res.end(JSON.stringify({ path, cursor: queryOf(req).get('cursor') }))
        return
      }
      if (path === '/echo') {
        try {
          res.end(JSON.stringify(await readJsonBody<Record<string, unknown>>(req, 32)))
        } catch (e) {
          sendError(res, e)
        }
        return
      }
      sendError(res, new AtomicCoreError('MODEL_NOT_FOUND', 'nope', 'details here'))
    })()
  })
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('splits path from query and parses the query string', async () => {
    const res = await fetch(`${base}/query?cursor=abc:7&x=1`)
    expect(await res.json()).toEqual({ path: '/query', cursor: 'abc:7' })
  })

  it('reads a JSON body, treats an empty body as {} and rejects oversized or invalid JSON', async () => {
    const ok = await fetch(`${base}/echo`, { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(await ok.json()).toEqual({ a: 1 })
    const empty = await fetch(`${base}/echo`, { method: 'POST' })
    expect(await empty.json()).toEqual({})
    const tooBig = await fetch(`${base}/echo`, {
      method: 'POST',
      body: JSON.stringify({ a: 'x'.repeat(100) }),
    })
    expect(tooBig.status).toBe(400)
    expect((await tooBig.json()) as object).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
    const invalid = await fetch(`${base}/echo`, { method: 'POST', body: '{oops' })
    expect(invalid.status).toBe(400)
  })

  it('sends the shared error envelope with the code the app matches on', async () => {
    const res = await fetch(`${base}/anything`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      error: { code: 'MODEL_NOT_FOUND', message: 'nope', details: 'details here' },
    })
  })

  it('caps bodies at a sane default', () => {
    expect(MAX_JSON_BODY_BYTES).toBe(8 * 1024 * 1024)
  })
})
