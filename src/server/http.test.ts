import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { ErrorCode } from '../contracts/index.js'
import {
  hostHeaderIsLoopback,
  isLoopbackAddress,
  MAX_JSON_BODY_BYTES,
  OVERSIZE_DRAIN_FACTOR,
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

  // Change close-cli-core-gaps, design D4: every segment of a rest parameter is decoded on its own, so
  // `%2F` inside one never moves the boundary with the fixed tail; a broken sequence is the caller's 400.
  describe('percent-decoding path parameters', () => {
    const models = new Router()
      .get('/atomic/v1/models/:provider/*modelId/capabilities', () => {})
      .post('/atomic/v1/clients/:id/heartbeat', () => {})
    const refusal = (method: string, path: string) => {
      try {
        models.find(method, path)
      } catch (error) {
        return error
      }
      return undefined
    }

    it('decodes each rest segment before joining them', () => {
      expect(
        models.find('GET', '/atomic/v1/models/llamacpp-upstream/imported/My%20Model-1/capabilities')
      ).toMatchObject({
        match: { params: { provider: 'llamacpp-upstream', modelId: 'imported/My Model-1' } },
      })
      expect(models.find('GET', '/atomic/v1/models/p/a%2Fb/c%25d/capabilities')).toMatchObject({
        match: { params: { modelId: 'a/b/c%d' } },
      })
    })

    it('leaves values without % as they are', () => {
      expect(models.find('GET', '/atomic/v1/models/p/Owner/Repo-GGUF:Q4_K_M/capabilities')).toMatchObject({
        match: { params: { provider: 'p', modelId: 'Owner/Repo-GGUF:Q4_K_M' } },
      })
    })

    it('refuses a broken sequence in a rest or a named parameter as INVALID_ARGUMENT (400)', () => {
      for (const [method, path] of [
        ['GET', '/atomic/v1/models/llamacpp-upstream/imported/bad%E0%A4/capabilities'],
        ['GET', '/atomic/v1/models/bad%ZZ/x/capabilities'],
        ['POST', '/atomic/v1/clients/%E0%A4/heartbeat'],
      ] as const) {
        const error = refusal(method, path)
        expect(error, path).toBeInstanceOf(AtomicCoreError)
        expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
        expect(statusForCode((error as AtomicCoreError).code)).toBe(400)
      }
    })

    it('refuses an encoding that decodes into a path step, and leaves a raw segment as it came', () => {
      for (const path of [
        '/atomic/v1/models/p/a%2F..%2F..%2Fx/capabilities',
        '/atomic/v1/models/p/%2E%2E/x/capabilities',
        '/atomic/v1/models/p/a%5C..%5Cx/capabilities',
        '/atomic/v1/models/p/%2Fetc/capabilities',
        '/atomic/v1/models/p/a%2F%2Fb/capabilities',
        '/atomic/v1/clients/%2E/heartbeat',
      ]) {
        const method = path.includes('/clients/') ? 'POST' : 'GET'
        const error = refusal(method, path)
        expect(error, path).toBeInstanceOf(AtomicCoreError)
        expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
      }
      expect(models.find('GET', '/atomic/v1/models/p/v1.2/model.Q4/capabilities')).toMatchObject({
        match: { params: { modelId: 'v1.2/model.Q4' } },
      })
    })

    it('decodes only the route that matched: a broken value on a wrong method is still a 405', () => {
      expect(models.find('POST', '/atomic/v1/models/p/bad%E0%A4/capabilities')).toEqual({
        methodMismatch: true,
      })
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
    expect(statusForCode('SERVER_START_TIMED_OUT')).toBe(504)
    expect(statusForCode('FOUNDATION_MODELS_UNAVAILABLE')).toBe(503)
    // Foundry Local (change add-foundry-local): prepare the accelerator first; the variant is not for this
    // host; the host process failed.
    expect(statusForCode('FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED')).toBe(409)
    expect(statusForCode('FOUNDRY_LOCAL_VARIANT_UNSUPPORTED')).toBe(422)
    expect(statusForCode('FOUNDRY_LOCAL_HOST_ERROR')).toBe(500)
    // LiteRT-LM (change add-litert-lm-runtime, task 6.1): the same three, and a file for a newer engine
    // (update the engine first, like ENGINE_UPDATE_REQUIRED).
    expect(statusForCode('LITERT_LM_ACCELERATOR_NOT_PREPARED')).toBe(409)
    expect(statusForCode('LITERT_LM_VARIANT_UNSUPPORTED')).toBe(422)
    expect(statusForCode('LITERT_LM_HOST_ERROR')).toBe(500)
    expect(statusForCode('LITERT_LM_MODEL_REQUIRES_NEWER_ENGINE')).toBe(409)
    // GenieX (change add-geniex-runtime, task 6.1): the host failed; the variant is not for this host or
    // device; a bundle for a newer GenieX (update the engine first).
    expect(statusForCode('GENIEX_HOST_ERROR')).toBe(500)
    expect(statusForCode('GENIEX_VARIANT_UNSUPPORTED')).toBe(422)
    expect(statusForCode('GENIEX_MODEL_REQUIRES_NEWER_ENGINE')).toBe(409)
    expect(statusForCode('OUT_OF_MEMORY')).toBe(500)
  })

  it.each([
    ['MODEL_ENGINE_INCOMPATIBLE', 422],
    ['MODEL_FORMAT_LEGACY', 422],
  ] satisfies Array<[ErrorCode, number]>)('maps the model compatibility code %s to %i', (code, status) => {
    expect(statusForCode(code)).toBe(status)
  })

  // Change close-cli-core-gaps, design D2: the catalog understood the file's requirements, and no
  // build on offer meets them.
  it('maps BACKEND_BUILD_UNAVAILABLE to 422', () => {
    expect(statusForCode('BACKEND_BUILD_UNAVAILABLE')).toBe(422)
  })

  it('maps the image-generation codes: the caller can fix 4xx, and nothing acts on the status', () => {
    const table: Array<[ErrorCode, number]> = [
      ['INVALID_REQUEST', 400],
      ['INVALID_DIMENSIONS', 400],
      ['UNSUPPORTED_WORKFLOW', 400],
      ['UNSUPPORTED_BACKEND', 400],
      ['JOB_NOT_FOUND', 404],
      ['ENGINE_MISSING', 404],
      ['MODEL_MISSING', 404],
      ['SIDE_FILE_MISSING', 404],
      ['MODEL_NOT_LOADED', 404],
      ['JOB_BUSY', 409],
      ['BACKEND_IN_USE', 409],
      ['NOT_CONFIGURED', 409],
      ['CANCELLED', 409],
      ['ENGINE_UPDATE_REQUIRED', 409],
      ['QUEUE_FULL', 429],
      ['DISK_FULL', 507],
      ['ENGINE_INSTALL_FAILED', 500],
      ['ENGINE_CRASHED', 500],
      ['MODEL_LOAD_FAILED', 500],
      ['MODEL_INCOMPATIBLE', 400],
      ['INVALID_OUTPUT', 500],
      ['INTERNAL', 500],
    ]
    for (const [code, status] of table) expect(statusForCode(code), code).toBe(status)
  })

  it("maps the remote media codes: a provider's refusal is never the caller's 401", () => {
    const table: Array<[ErrorCode, number]> = [
      ['REMOTE_NOT_CONFIGURED', 409],
      ['REMOTE_AUTH_FAILED', 502],
      ['REMOTE_UNAVAILABLE', 502],
      ['REMOTE_TIMEOUT', 504],
      ['REMOTE_QUOTA', 402],
      ['REMOTE_RATE_LIMITED', 429],
      ['REMOTE_REJECTED', 422],
      ['REMOTE_CONTENT_BLOCKED', 422],
      ['REMOTE_UNSUPPORTED', 422],
    ]
    for (const [code, status] of table) expect(statusForCode(code), code).toBe(status)
  })

  it('maps the managed-runtime codes: every conflict is 409, an unsupported engine is 422', () => {
    const table: Array<[ErrorCode, number]> = [
      ['MANAGED_OPERATION_NOT_FOUND', 404],
      ['MANAGED_OPERATION_CONFLICT', 409],
      ['MANAGED_REVISION_CONFLICT', 409],
      ['MANAGED_CONSENT_REQUIRED', 409],
      ['MANAGED_PLAN_CHANGED', 409],
      ['MANAGED_RECEIPT_CONFLICT', 409],
      ['MANAGED_RESOURCE_IN_USE', 409],
      ['MANAGED_IDENTITY_MISMATCH', 409],
      ['MANAGED_STOP_UNCONFIRMED', 409],
      ['MANAGED_ELEVATION_DECLINED', 409],
      ['MANAGED_PREREQUISITE_BLOCKED', 409],
      ['MANAGED_RELOGIN_REQUIRED', 409],
      ['MANAGED_REBOOT_REQUIRED', 409],
      ['GPU_BUSY', 409],
      ['SESSION_GENERATION_STALE', 409],
      ['MANAGED_HOST_STEP_INVALID', 400],
      // A caller sent a descriptor or plan this core refused.
      ['MANAGED_METADATA_INVALID', 400],
      ['MANAGED_ADAPTER_UNAVAILABLE', 422],
      // An on-disk operation record this core itself cannot read is never the caller's fault, so
      // `OperationStore`'s own corruption (`store.ts`'s `corrupt()`) is `IO_ERROR`, not
      // `MANAGED_METADATA_INVALID` — unmapped here, it falls through to the same 500 as any other
      // unexpected failure.
      ['IO_ERROR', 500],
    ]
    for (const [code, status] of table) expect(statusForCode(code), code).toBe(status)
  })

  it("maps the decision codes: configuration and engine are the caller's to fix, a stopped model is 503", () => {
    expect(statusForCode('DECISION_NOT_CONFIGURED')).toBe(409)
    expect(statusForCode('DECISION_ENGINE_UNSUPPORTED')).toBe(409)
    expect(statusForCode('DECISION_CHECKPOINT_INCOMPLETE')).toBe(409)
    expect(statusForCode('DECISION_MODEL_NOT_CHAT')).toBe(409)
    expect(statusForCode('DECISION_UNAVAILABLE')).toBe(503)
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

  it('reads an oversized body to its end before refusing it, and drops one past the drain ceiling', async () => {
    expect(OVERSIZE_DRAIN_FACTOR).toBe(8)
    // Within eight times the cap: read, discarded, refused with the envelope.
    const drained = await fetch(`${base}/echo`, { method: 'POST', body: 'x'.repeat(32 * 8) })
    expect(drained.status).toBe(400)
    expect((await drained.json()) as object).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', message: 'Request body is too large.', details: '> 32 bytes' },
    })
    // Past it: the connection goes instead of the rest of the body.
    await expect(fetch(`${base}/echo`, { method: 'POST', body: 'x'.repeat(32 * 8 + 1) })).rejects.toThrow()
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
