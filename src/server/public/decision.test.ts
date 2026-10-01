import { afterEach, describe, expect, it } from 'vitest'
import type { CoreEvents } from '../../contracts/index.js'
import { closeAll, closedPort, startPublic, startUpstream } from '../../../test/helpers/public-server.js'
import {
  DECISION_BACKEND_LABEL,
  DECISION_ROUTES,
  decisionErrorBody,
  MAX_DECISION_BODY_BYTES,
} from './decision.js'
import type { DecisionBackend, DecisionTarget } from './types.js'

afterEach(closeAll)

/** Bytes JavaScript would change on a parse and re-serialize: `1.0`, a big integer, number-like keys. */
const RAW =
  '{"state":{"amount":1.0,"id":12345678901234567890},"questions":{"2":{"type":"noul","instructions":"b?"},"1":{"type":"noul","instructions":"a?"}}}'

function backend(target: () => DecisionTarget | Promise<DecisionTarget>, modelId: string | null = null) {
  const log: string[] = []
  const fake: DecisionBackend = {
    acquire: async (waitMs) => {
      log.push(`acquire ${waitMs}`)
      const t = await target()
      return t.ok ? { ...t, release: () => void log.push('release') } : t
    },
    modelId: () => modelId,
  }
  return { fake, log }
}

async function publicWith(decision: DecisionBackend | undefined, apiKey = '', inspecting = false) {
  const events: CoreEvents['api:request'][] = []
  const server = await startPublic(
    {
      ...(decision ? { decision } : {}),
      emit: (name, payload) => {
        if (name === 'api:request') events.push(payload as CoreEvents['api:request'])
      },
      inspecting: () => inspecting,
    },
    { apiKey }
  )
  return { server, events }
}

const post = (port: number, path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

describe('POST /v1/systemone and /v1/router/score', () => {
  it('forwards the body byte for byte with the process key, and relays the answer unchanged', async () => {
    const seen: Array<{ url: string; auth: string | undefined; body: string }> = []
    const upstream = await startUpstream((req, body, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body })
      res.writeHead(200, { 'content-type': 'application/json', 'x-engine': 'fork' })
      res.end('{"model":"laya","answers":{"2":{"type":"noul","noul":0.9,"confidence":0.9}},"latency_ms":1.0}')
    })
    const { fake, log } = backend(
      () => ({
        ok: true,
        port: upstream.port,
        apiKey: 'process-key',
        release: () => {},
      }),
      'laya-multilingual'
    )
    const { server, events } = await publicWith(fake, 'server-key')

    const res = await post(server.port, '/systemone', RAW, { authorization: 'Bearer server-key' })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-engine')).toBe('fork')
    expect(await res.text()).toBe(
      '{"model":"laya","answers":{"2":{"type":"noul","noul":0.9,"confidence":0.9}},"latency_ms":1.0}'
    )
    expect(seen).toEqual([{ url: '/v1/systemone', auth: 'Bearer process-key', body: RAW }])
    expect(log).toEqual(['acquire 30000', 'release'])
    expect(events.at(-1)).toMatchObject({
      phase: 'finished',
      observation: {
        endpoint: 'systemone',
        model_id: 'laya-multilingual',
        backend: DECISION_BACKEND_LABEL,
        status: 200,
      },
    })

    await post(server.port, '/router/score', '{"task":"t","criterion":"c","candidates":[]}', {
      authorization: 'Bearer server-key',
    })
    expect(seen.at(-1)?.url).toBe('/v1/router/score')
    expect(Object.keys(DECISION_ROUTES)).toEqual(['/systemone', '/router/score'])
  })

  it('gives the open inspector a preview of the state and of the answers, the bytes untouched', async () => {
    const reply =
      '{"model":"laya","answers":{"2":{"type":"noul","noul":0.9,"confidence":0.9}},"usage":{"input_tokens":12}}'
    const upstream = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(reply)
    })
    const { fake } = backend(
      () => ({ ok: true, port: upstream.port, apiKey: 'k', release: () => {} }),
      'laya'
    )
    const { server, events } = await publicWith(fake, '', true)

    const res = await post(server.port, '/systemone', RAW)
    expect(await res.text()).toBe(reply)
    await new Promise((r) => setTimeout(r, 20))
    expect(events.find((e) => e.phase === 'started')).toMatchObject({
      endpoint: 'systemone',
      model_id: 'laya',
      prompt_preview: '{"amount":1,"id":12345678901234567000}\n\nQuestions: 1, 2',
    })
    expect(events.find((e) => e.phase === 'finished')).toMatchObject({
      finish: { status: 200, reply_preview: '2: 0.90', prompt_tokens: 12 },
    })
  })

  it("relays the engine's error envelope and status as they are", async () => {
    const envelope =
      '{"error":{"code":400,"type":"invalid_request_error","reason":"INVALID_CARD","message":"card needs name","param":"candidates[0].card"}}'
    const upstream = await startUpstream((_req, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json', 'connection': 'close' })
      res.end(envelope)
    })
    const { fake } = backend(() => ({ ok: true, port: upstream.port, apiKey: 'k', release: () => {} }))
    const { server } = await publicWith(fake)
    const res = await post(
      server.port,
      '/router/score',
      '{"task":"t","criterion":"c","candidates":[{"id":"a"}]}'
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(envelope)
  })

  it('answers 503 in the engine envelope when the module cannot take the request', async () => {
    const none = await publicWith(undefined)
    const res = await post(none.server.port, '/systemone', RAW)
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({
      error: {
        code: 503,
        type: 'unavailable_error',
        reason: 'UNAVAILABLE',
        message: 'The decision model is not available in this core.',
      },
    })

    const { fake, log } = backend(() => ({
      ok: false,
      reason: 'disabled',
      message: 'The decision model is turned off.',
    }))
    const off = await publicWith(fake)
    const refused = await post(off.server.port, '/router/score', '{}')
    expect(refused.status).toBe(503)
    expect(off.events.at(-1)).toMatchObject({
      phase: 'finished',
      observation: { endpoint: 'router/score', model_id: null, status: 503 },
    })
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
      'The decision model is not available (disabled). The decision model is turned off.'
    )
    expect(log).toEqual(['acquire 30000'])
  })

  it('answers 503 when the process does not answer, and still releases it', async () => {
    const port = await closedPort()
    const { fake, log } = backend(() => ({ ok: true, port, apiKey: 'k', release: () => {} }))
    const { server } = await publicWith(fake)
    const res = await post(server.port, '/systemone', RAW)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe('UNAVAILABLE')
    expect(log).toEqual(['acquire 30000', 'release'])
  })

  it('hands acquire a signal that fires when the client leaves during the wait', async () => {
    let signal: AbortSignal | undefined
    let aborted: () => void = () => {}
    const wasAborted = new Promise<void>((resolve) => (aborted = resolve))
    const fake: DecisionBackend = {
      acquire: (_waitMs, s) => {
        signal = s
        return new Promise((resolve) => {
          s?.addEventListener('abort', () => {
            aborted()
            resolve({ ok: false, reason: 'starting', message: 'The decision model is starting.' })
          })
        })
      },
    }
    const { server } = await publicWith(fake)
    const client = new AbortController()
    const leaving = fetch(`http://127.0.0.1:${server.port}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: RAW,
      signal: client.signal,
    }).catch(() => undefined)
    for (let i = 0; i < 500 && signal === undefined; i++) await new Promise((r) => setTimeout(r, 10))
    expect(signal).toBeInstanceOf(AbortSignal)
    client.abort()
    await leaving
    await wasAborted
    expect(signal?.aborted).toBe(true)
  })

  it('keeps the public key gate, and only POST is served', async () => {
    const { fake, log } = backend(() => ({ ok: false, reason: 'x', message: 'y' }))
    const { server } = await publicWith(fake, 'server-key')
    expect((await post(server.port, '/systemone', RAW)).status).toBe(401)
    const get = await fetch(`http://127.0.0.1:${server.port}/v1/systemone`, {
      headers: { authorization: 'Bearer server-key' },
    })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect(log).toEqual([])
  })

  it('refuses a body over the public cap without asking the module', async () => {
    const { fake, log } = backend(() => ({ ok: false, reason: 'x', message: 'y' }))
    const { server } = await publicWith(fake)
    const res = await post(server.port, '/systemone', 'x'.repeat(MAX_DECISION_BODY_BYTES + 1))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe('BODY_TOO_LARGE')
    expect(log).toEqual([])
  })

  it('labels its traffic as the decision backend', () => {
    expect(DECISION_BACKEND_LABEL).toBe('atomic-decision')
    expect(JSON.parse(decisionErrorBody(503, 'UNAVAILABLE', 'm', 'unavailable_error'))).toEqual({
      error: { code: 503, type: 'unavailable_error', reason: 'UNAVAILABLE', message: 'm' },
    })
  })
})
