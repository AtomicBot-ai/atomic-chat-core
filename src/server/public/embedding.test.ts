import { afterEach, describe, expect, it } from 'vitest'
import type { CoreEvents } from '../../contracts/index.js'
import {
  closeAll,
  closedPort,
  localSession,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'
import {
  EMBEDDING_BACKEND_LABEL,
  EMBEDDING_OWNED_BY,
  MAX_EMBEDDING_BODY_BYTES,
  serveEmbeddingIfOwned,
} from './embedding.js'
import type { EmbeddingBackend, EmbeddingTarget } from './types.js'

afterEach(closeAll)

/** Bytes a parse and re-serialize would change: the passthrough must not. */
const RAW =
  '{"model":"embeddinggemma-2","input":["task: search result | query: 1.0"],"encoding_format":"float","n":1.0}'

function backend(
  target: () => EmbeddingTarget | Promise<EmbeddingTarget>,
  modelId: string | null = 'embeddinggemma-2'
) {
  const log: string[] = []
  const fake: EmbeddingBackend = {
    acquire: async (waitMs) => {
      log.push(`acquire ${waitMs}`)
      const t = await target()
      return t.ok ? { ...t, release: () => void log.push('release') } : t
    },
    modelId: () => modelId,
  }
  return { fake, log }
}

const ready = (port: number, over: Partial<EmbeddingTarget & { ok: true }> = {}): EmbeddingTarget => ({
  ok: true,
  port,
  apiKey: 'process-key',
  modelId: 'embeddinggemma-2',
  dims: 768,
  modalities: ['text', 'image', 'audio'],
  release: () => {},
  ...over,
})

async function publicWith(deps: Parameters<typeof startPublic>[0], apiKey = '') {
  const events: CoreEvents['api:request'][] = []
  const server = await startPublic(
    {
      ...deps,
      emit: (name, payload) => {
        if (name === 'api:request') events.push(payload as CoreEvents['api:request'])
      },
    },
    { apiKey }
  )
  return { server, events }
}

const post = (port: number, body: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

describe('POST /v1/embeddings for the embedding module', () => {
  it('forwards the body byte for byte with the process key and relays the answer', async () => {
    const seen: Array<{ url: string; auth: string | undefined; body: string }> = []
    const upstream = await startUpstream((req, body, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body })
      res.writeHead(200, { 'content-type': 'application/json', 'x-engine': 'llama.cpp' })
      res.end('{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.5,0.25]}]}')
    })
    const { fake, log } = backend(() => ready(upstream.port))
    const { server, events } = await publicWith({ embedding: fake }, 'server-key')

    const res = await post(server.port, RAW, { authorization: 'Bearer server-key' })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-engine')).toBe('llama.cpp')
    expect(await res.json()).toMatchObject({ data: [{ embedding: [0.5, 0.25] }] })
    expect(seen).toEqual([{ url: '/v1/embeddings', auth: 'Bearer process-key', body: RAW }])
    expect(log).toEqual(['acquire 60000', 'release'])
    expect(events.at(-1)).toMatchObject({
      phase: 'finished',
      observation: {
        endpoint: 'embeddings',
        model_id: 'embeddinggemma-2',
        backend: EMBEDDING_BACKEND_LABEL,
        status: 200,
      },
    })
  })

  it('leaves every other model to the sessions, with the body it already read', async () => {
    const session = await startUpstream((req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ via: 'session', body: JSON.parse(body) }))
    })
    const { fake, log } = backend(() => ready(1))
    const { server } = await publicWith({
      embedding: fake,
      sessions: [localSession(session.port, { modelId: 'sentence-transformer-mini' })],
    })
    const res = await post(server.port, '{"model":"sentence-transformer-mini","input":"x"}')
    expect(await res.json()).toEqual({
      via: 'session',
      body: { model: 'sentence-transformer-mini', input: 'x' },
    })
    // Not JSON at all: the forwarder answers that, as it always did.
    expect((await post(server.port, 'not json')).status).toBe(400)
    expect(log).toEqual([])
  })

  it('stays out of the way when the module is off', async () => {
    const { fake, log } = backend(() => ready(1), null)
    const { server } = await publicWith({ embedding: fake })
    const res = await post(server.port, RAW)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('No models are available')
    expect(log).toEqual([])
  })

  it.each([
    [
      { input: [{ content: [{ type: 'image_url', image_url: { url: 'http://192.168.1.2/cat.png' } }] }] },
      'links are not fetched',
    ],
    [
      { input: [{ content: [{ type: 'input_audio', input_audio: { data: 'UklGRg==' } }] }] },
      'does not read audio',
    ],
    [{ input: 'x', dimensions: 256 }, '768-dimension'],
  ])('refuses %j before the engine sees it', async (body, says) => {
    let reached = false
    const upstream = await startUpstream((_req, _body, res) => {
      reached = true
      res.end('{}')
    })
    const { fake, log } = backend(() => ready(upstream.port, { modalities: ['text', 'image'] }))
    const { server } = await publicWith({ embedding: fake })
    const res = await post(server.port, JSON.stringify({ model: 'embeddinggemma-2', ...body }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { type: 'invalid_request_error', message: expect.stringContaining(says) },
    })
    expect(reached).toBe(false)
    expect(log).toEqual(['acquire 60000', 'release'])
  })

  it('names the field of inline media the engine would not read, in the OpenAI shape', async () => {
    let reached = false
    const upstream = await startUpstream((_req, _body, res) => {
      reached = true
      res.end('{}')
    })
    const { fake } = backend(() => ready(upstream.port))
    const { server } = await publicWith({ embedding: fake })
    const body = {
      model: 'embeddinggemma-2',
      input: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }] }],
    }
    const res = await post(server.port, JSON.stringify(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        message: expect.stringContaining('placeholder'),
        type: 'invalid_request_error',
        param: 'input[0].content[0].image_url.url',
        code: 'invalid_value',
      },
    })
    expect(reached).toBe(false)
  })

  it('answers 400 for the engine 500 about media it could not decode, and relays any other 500', async () => {
    let says = 'Failed to load image or audio file'
    const upstream = await startUpstream((_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'application/json', 'x-engine': 'llama.cpp' })
      res.end(JSON.stringify({ error: { code: 500, message: says, type: 'server_error' } }))
    })
    const { fake, log } = backend(() => ready(upstream.port))
    const { server, events } = await publicWith({ embedding: fake })
    const body = JSON.stringify({
      model: 'embeddinggemma-2',
      input: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAAAAAA' } }] }],
    })

    const res = await post(server.port, body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        message: expect.stringContaining('could not be decoded as an image, audio or video file'),
        type: 'invalid_request_error',
        param: 'input[0].content[0].image_url.url',
        code: 'invalid_value',
      },
    })
    expect(events.at(-1)).toMatchObject({ phase: 'finished', observation: { status: 400 } })

    says = 'Compute error'
    const other = await post(server.port, body)
    expect(other.status).toBe(500)
    expect(other.headers.get('x-engine')).toBe('llama.cpp')
    expect(await other.json()).toEqual({
      error: { code: 500, message: 'Compute error', type: 'server_error' },
    })
    expect(log).toEqual(['acquire 60000', 'release', 'acquire 60000', 'release'])
  })

  it('answers 503 in the OpenAI shape when the model cannot be reached', async () => {
    const off = backend(() => ({
      ok: false,
      reason: 'unsupported',
      message: 'Update llama.cpp to b11454 or newer.',
    }))
    const { server } = await publicWith({ embedding: off.fake })
    const res = await post(server.port, RAW)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: {
        message: 'Update llama.cpp to b11454 or newer.',
        type: 'server_error',
        code: 'model_not_available',
      },
    })

    const dead = backend(async () => ready(await closedPort()))
    const second = await publicWith({ embedding: dead.fake })
    const res2 = await post(second.server.port, RAW)
    expect(res2.status).toBe(503)
    expect(await res2.text()).toContain('did not answer')
    expect(dead.log).toEqual(['acquire 60000', 'release'])
  })

  it('refuses a body over the cap whoever it was for', async () => {
    const { fake } = backend(() => ready(1))
    const { server } = await publicWith({ embedding: fake })
    const res = await post(server.port, `{"model":"x","input":"${'a'.repeat(MAX_EMBEDDING_BODY_BYTES)}"}`)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: { code: 'request_too_large' } })
  }, 30_000)
})

describe('GET /v1/models with the embedding module', () => {
  it('lists the module model while it is on, once', async () => {
    const { fake } = backend(() => ready(1))
    const { server } = await publicWith({
      embedding: fake,
      sessions: [localSession(1, { modelId: 'qwen3-8b' })],
    })
    const models = (await (await fetch(`http://127.0.0.1:${server.port}/v1/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>
    }
    expect(models.data.map((m) => [m.id, m.owned_by])).toEqual([
      ['qwen3-8b', 'llama.cpp-upstream'],
      ['embeddinggemma-2', EMBEDDING_OWNED_BY],
    ])
    // Muse Code's catalogue is for chat models only.
    const muse = (await (await fetch(`http://127.0.0.1:${server.port}/v1/muse-code/models`)).json()) as {
      data: Array<{ id: string }>
    }
    expect(muse.data.map((m) => m.id)).toEqual(['qwen3-8b'])
  })
})

describe('serveEmbeddingIfOwned', () => {
  it('is exported for the dispatcher and declines without a model', async () => {
    const declined = await serveEmbeddingIfOwned({} as never, {
      acquire: async () => ({ ok: false, reason: '', message: '' }),
      modelId: () => null,
    })
    expect(declined).toBe(false)
  })
})
