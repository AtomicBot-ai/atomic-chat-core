import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreEvents, ImageGenerateRequest, ImageJob } from '../../contracts/index.js'
import { closeAll, postJson, startPublic } from '../../../test/helpers/public-server.js'
import { AtomicCoreError } from '../../contracts/index.js'
import { IMAGES_TIMEOUT_MS, NO_MODEL_MESSAGE, serveImagesGenerations } from './images.js'
import type { ImagesBackend } from './types.js'

afterEach(closeAll)

type Done = Awaited<ReturnType<ImagesBackend['start']>>['done']

interface FakeImages extends ImagesBackend {
  requests: ImageGenerateRequest[]
  cancelled: string[]
  /** What the next job settles with; a function can hold the job open. */
  next: () => Done
  present: boolean
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function job(over: Partial<ImageJob> = {}): ImageJob {
  return {
    id: 'job-7',
    state: 'completed',
    modelId: 'z-image:q4_k_m',
    request: { prompt: 'a cat', width: 1024, height: 768, steps: 8, cfgScale: 1, batchSize: 1 },
    createdAtMs: 1,
    progress: null,
    outputs: [
      {
        id: 'job-7-00',
        path: '/images/job-7-00.png',
        thumbnailPath: null,
        width: 1024,
        height: 768,
        sizeBytes: 7,
        createdAtMs: 1,
        pinned: false,
        archived: false,
        recipe: {
          jobId: 'job-7',
          index: 0,
          prompt: 'a cat',
          negativePrompt: null,
          width: 1024,
          height: 768,
          steps: 8,
          cfgScale: 1,
          guidance: 3.5,
          seed: 42,
          batchSeed: 42,
          batchSize: 1,
          samplingMethod: 'euler',
          flowShift: null,
          workflow: 'create',
          strength: null,
          model: {
            modelId: 'z-image:q4_k_m',
            family: 'z-image',
            displayName: 'Z-Image Turbo',
            filename: 'z.gguf',
          },
          engine: { kind: 'sd-cpp', backend: 'metal', tag: 't', offload: 'none', cpuFallback: false },
          createdAtMs: 1,
          durationMs: 2,
        },
      },
    ],
    ...over,
  }
}

function fakeImages(): FakeImages {
  const fake: FakeImages = {
    requests: [],
    cancelled: [],
    present: true,
    next: () => Promise.resolve({ ok: true, outcome: { job: job(), images: [PNG] } }),
    loaded: () =>
      fake.present
        ? {
            modelId: 'z-image:q4_k_m',
            displayName: 'Z-Image Turbo',
            defaults: {
              steps: 8,
              cfgScale: 1,
              guidance: 3.5,
              samplingMethod: 'euler',
              width: 1024,
              height: 768,
            },
          }
        : undefined,
    start: async (request) => {
      fake.requests.push(request)
      return { id: 'job-7', done: fake.next() }
    },
    cancel: async (id) => {
      fake.cancelled.push(id)
    },
  }
  return fake
}

async function server(images?: ImagesBackend, inspecting = false) {
  const events: CoreEvents['api:request'][] = []
  const started = await startPublic({
    ...(images ? { images } : {}),
    emit: (name, payload) => {
      if (name === 'api:request') events.push(payload as CoreEvents['api:request'])
    },
    inspecting: () => inspecting,
  })
  return { started, events }
}

const errorOf = async (res: Response) => ((await res.json()) as { error: Record<string, unknown> }).error

describe('POST /v1/images/generations', () => {
  it('answers 503 without an image model, and 400 for a bad body before that', async () => {
    const { started, events } = await server()
    const none = await postJson(started, '/images/generations', { prompt: 'a cat', size: '512x512' })
    expect(none.status).toBe(503)
    expect(none.headers.get('content-type')).toBe('application/json')
    expect(await errorOf(none)).toEqual({
      message: NO_MODEL_MESSAGE,
      type: 'server_error',
      param: null,
      code: 'model_not_loaded',
    })

    // The format check runs before the model check: a `url` request is a 400 even with nothing loaded.
    const url = await postJson(started, '/images/generations', { prompt: 'a cat', response_format: 'url' })
    expect(url.status).toBe(400)
    expect(await errorOf(url)).toMatchObject({ type: 'invalid_request_error', param: 'response_format' })

    const garbage = await fetch(`http://127.0.0.1:${started.port}/v1/images/generations`, {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    })
    expect(garbage.status).toBe(400)
    expect((await errorOf(garbage))['message']).toMatch(/^Invalid JSON body: /)

    // Only POST: the method table knows the route.
    const get = await fetch(`http://127.0.0.1:${started.port}/v1/images/generations`)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')

    await new Promise((resolve) => setTimeout(resolve, 20))
    const finished = events
      .filter((e) => e.phase === 'finished')
      .map((e) => (e.phase === 'finished' ? e.observation : null))
    expect(finished.map((o) => [o?.endpoint, o?.status, o?.error_kind, o?.backend])).toEqual([
      ['images/generations', 503, 'not_found', 'unknown'],
      ['images/generations', 400, 'bad_request', 'unknown'],
      ['images/generations', 400, 'bad_request', 'unknown'],
      ['images/generations', 405, 'method_not_allowed', 'unknown'],
    ])
  })

  it('generates: the family defaults, the OpenAI body with the atomic extras, and the analytics label', async () => {
    const images = fakeImages()
    const { started, events } = await server(images)
    const res = await postJson(started, '/images/generations', {
      prompt: ' a cat ',
      n: 1,
      seed: 42,
      model: 'Z-Image Turbo',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      created: expect.any(Number),
      data: [{ b64_json: PNG.toString('base64') }],
      atomic: { job_id: 'job-7', seed: 42, paths: ['/images/job-7-00.png'] },
    })
    expect(images.requests).toEqual([
      {
        prompt: 'a cat',
        width: 1024,
        height: 768,
        steps: 8,
        cfgScale: 1,
        guidance: 3.5,
        seed: 42,
        samplingMethod: 'euler',
        batchSize: 1,
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    const finished = events.find((e) => e.phase === 'finished')
    expect(finished?.phase === 'finished' ? finished.observation : null).toMatchObject({
      endpoint: 'images/generations',
      status: 200,
      backend: 'atomic-diffusion',
      model_id: 'z-image:q4_k_m',
      error_kind: null,
    })
  })

  it('refuses a model that is not the resident one', async () => {
    const images = fakeImages()
    const { started, events } = await server(images)
    const res = await postJson(started, '/images/generations', { prompt: 'a cat', model: 'gpt-image-1' })
    expect(res.status).toBe(503)
    expect(images.requests).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    const finished = events.find((e) => e.phase === 'finished')
    expect(finished?.phase === 'finished' ? finished.observation?.model_id : null).toBe('gpt-image-1')
  })

  it('maps a refusal to start, with the details of a 400 in brackets', async () => {
    const images = fakeImages()
    images.start = async () => {
      throw new AtomicCoreError('INVALID_DIMENSIONS', 'width must be a multiple of 16.', 'width=520')
    }
    const { started } = await server(images)
    const res = await postJson(started, '/images/generations', { prompt: 'a cat' })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toEqual({
      message: 'width must be a multiple of 16. (width=520)',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_request',
    })
    images.start = async () => {
      throw new AtomicCoreError('JOB_BUSY', 'An image is already being generated.', 'job-1')
    }
    const busy = await postJson(started, '/images/generations', { prompt: 'a cat' })
    expect(busy.status).toBe(429)
    expect(await errorOf(busy)).toMatchObject({
      message: 'An image is already being generated.',
      code: 'busy',
    })
    images.start = async () => {
      throw new Error('no code at all')
    }
    const odd = await postJson(started, '/images/generations', { prompt: 'a cat' })
    expect(odd.status).toBe(500)
    expect(await errorOf(odd)).toMatchObject({ message: 'no code at all', code: 'server_error' })
  })

  it('maps a job that failed, with the details on their own line', async () => {
    const images = fakeImages()
    images.next = () =>
      Promise.resolve({
        ok: false,
        error: {
          code: 'OUT_OF_MEMORY',
          message: 'sd-server ran out of memory while generating.',
          details: 'cudaMalloc failed',
        },
      })
    const { started } = await server(images)
    const res = await postJson(started, '/images/generations', { prompt: 'a cat' })
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toEqual({
      message: 'sd-server ran out of memory while generating.\ncudaMalloc failed',
      type: 'server_error',
      param: null,
      code: 'insufficient_memory',
    })
    images.next = () =>
      Promise.resolve({ ok: false, error: { code: 'CANCELLED', message: 'Generation was cancelled.' } })
    const cancelled = await postJson(started, '/images/generations', { prompt: 'a cat' })
    expect(await errorOf(cancelled)).toMatchObject({
      message: 'Generation was cancelled.',
      code: 'cancelled',
    })
  })

  it('cancels the job when the client goes away, and when the ceiling passes', async () => {
    const images = fakeImages()
    let release: (() => void) | undefined
    images.next = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ ok: false, error: { code: 'CANCELLED', message: 'Generation was cancelled.' } })
      })
    const { started } = await server(images)
    const controller = new AbortController()
    const pending = postJson(
      started,
      '/images/generations',
      { prompt: 'a cat' },
      { signal: controller.signal }
    )
    const deadline = Date.now() + 5_000
    while (images.requests.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    await expect(pending).rejects.toThrow()
    const cancelDeadline = Date.now() + 5_000
    while (images.cancelled.length === 0 && Date.now() < cancelDeadline)
      await new Promise((r) => setTimeout(r, 10))
    expect(images.cancelled).toEqual(['job-7'])
    release?.()
    expect(IMAGES_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it('answers 504 and cancels once the ceiling passes', async () => {
    const images = fakeImages()
    images.next = () => new Promise(() => {})
    // The route with a short ceiling, over a bare exchange.
    const ex = await fakeExchange(images)
    await serveImagesGenerations(ex.exchange, 50)
    expect(ex.status).toBe(504)
    expect(JSON.parse(ex.body).error).toEqual({
      message: 'Generation did not finish within 0 minutes and was cancelled.',
      type: 'server_error',
      param: null,
      code: 'timeout',
    })
    expect(images.cancelled).toEqual(['job-7'])
    expect(ex.exchange.trace.errorKind).toBe('timeout')
  })
})

/** An `Exchange` over a bare response object, for the one path that needs a shorter ceiling. */
async function fakeExchange(images: ImagesBackend) {
  const { EventEmitter } = await import('node:events')
  const { RequestTrace } = await import('./trace.js')
  const { newExchange } = await import('./exchange.js')
  const { Readable } = await import('node:stream')
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ prompt: 'a cat' }))]), {
    method: 'POST',
    url: '/v1/images/generations',
    headers: {},
    socket: { localAddress: '127.0.0.1' },
  })
  const captured = { status: 0, body: '', writableFinished: false }
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
    writeHead: (status: number) => {
      captured.status = status
      return res
    },
    end: (body: Buffer) => {
      captured.body = body.toString()
      captured.writableFinished = true
      return res
    },
    once: EventEmitter.prototype.once,
  }) as unknown as ServerResponse & { writableFinished: boolean }
  const deps = {
    findLocal: () => undefined,
    listLocal: () => [],
    providers: () => new Map(),
    increaseCtx: async () => ({ ok: false }),
    images,
  }
  const trace = new RequestTrace('POST', deps)
  const exchange = newExchange(
    req as unknown as IncomingMessage,
    res,
    '/images/generations',
    { host: '127.0.0.1', port: 1337, prefix: '/v1', apiKey: '', trustedHosts: [], proxyTimeoutSecs: 1 },
    deps,
    trace
  )
  return {
    exchange,
    get status() {
      return captured.status
    },
    get body() {
      return captured.body
    },
  }
}
