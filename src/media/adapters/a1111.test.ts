import { describe, expect, it } from 'vitest'
import type { ImageModelDescriptor } from '../../contracts/index.js'
import {
  fakeMediaFetch,
  JPEG_STUB,
  jsonResponse,
  mediaContext,
  PNG_1X1,
} from '../../../test/helpers/media-fetch.js'
import { A1111, a1111Auth, a1111Body, a1111Images, a1111Root, liveModelsFromA1111 } from './a1111.js'
import type { ImageGenerationJob, RemoteProgress } from './types.js'

const ROOT = 'http://127.0.0.1:7860'
const png = PNG_1X1.toString('base64')
const jpeg = JPEG_STUB.toString('base64')

const model: ImageModelDescriptor = {
  id: 'sd_xl_base_1.0.safetensors [31e35c80fc]',
  name: 'sd_xl_base_1.0',
  api: 'a1111',
  kind: 'image',
  source: 'live',
  workflows: ['create', 'transform', 'inpaint'],
  params: {
    size: { kind: 'range', min: 256, max: 2048, multiple: 8, default_width: 1024, default_height: 1024 },
    n: { max: 4 },
    seed: true,
    negative_prompt: true,
    steps: { min: 1, max: 150, default: 25 },
    cfg: { min: 1, max: 30, default: 7, step: 0.5 },
    strength: { min: 0, max: 1, default: 0.75, step: 0.05 },
    sampler: true,
  },
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return { model, prompt: 'a lighthouse', workflow: 'create', n: 1, images: [], ...overrides }
}

const common = {
  override_settings: { sd_model_checkpoint: 'sd_xl_base_1.0.safetensors [31e35c80fc]' },
  override_settings_restore_afterwards: true,
  send_images: true,
  save_images: false,
}

/** A fetch whose request to `url` never answers and fails once its signal fires, like a real one. */
function hangingOn(url: string, inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (String(input) !== url) return inner(input, init)
    void inner(input, init).catch(() => undefined)
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      })
    })
  }) as typeof fetch
}

describe('a1111Root', () => {
  it.each([
    ['http://127.0.0.1:7860', ROOT],
    ['http://127.0.0.1:7860/', ROOT],
    ['http://127.0.0.1:7860/sdapi/v1', ROOT],
    ['http://127.0.0.1:7860/sdapi/v1/', ROOT],
    ['http://127.0.0.1:7860/v1', ROOT],
    ['https://box.example.com/forge/v1', 'https://box.example.com/forge'],
  ])('%s → %s', (base, root) => {
    expect(a1111Root(base)).toBe(root)
  })
})

describe('a1111Auth', () => {
  it('sends the key as basic auth unless a custom Authorization is set', () => {
    expect(a1111Auth({ apiKey: 'user:pass', customHeaders: [] })).toEqual({
      Authorization: 'Basic dXNlcjpwYXNz',
    })
    expect(
      a1111Auth({ apiKey: 'user:pass', customHeaders: [{ header: 'authorization', value: 'Basic x' }] })
    ).toEqual({})
    expect(a1111Auth({ apiKey: null, customHeaders: [] })).toEqual({})
    expect(a1111Auth({ apiKey: '  ', customHeaders: [] })).toEqual({})
  })
})

describe('a1111Body', () => {
  it('builds txt2img with the model defaults and a random seed', () => {
    expect(a1111Body(job())).toEqual({
      prompt: 'a lighthouse',
      negative_prompt: '',
      width: 1024,
      height: 1024,
      steps: 25,
      cfg_scale: 7,
      seed: -1,
      batch_size: 1,
      n_iter: 1,
      ...common,
    })
  })

  it('takes what the job set, Forge distilled CFG included', () => {
    expect(
      a1111Body(
        job({
          n: 3,
          width: 832,
          height: 1216,
          steps: 30,
          cfgScale: 1,
          guidance: 3.5,
          sampler: 'Euler a',
          seed: 12,
          negativePrompt: 'fog',
        })
      )
    ).toEqual({
      prompt: 'a lighthouse',
      negative_prompt: 'fog',
      width: 832,
      height: 1216,
      steps: 30,
      cfg_scale: 1,
      distilled_cfg_scale: 3.5,
      sampler_name: 'Euler a',
      seed: 12,
      batch_size: 3,
      n_iter: 1,
      ...common,
    })
  })

  it('adds the source for transform and the mask for inpaint', () => {
    const transform = a1111Body(
      job({ workflow: 'transform', images: [{ bytes: PNG_1X1, mime: 'image/png' }], strength: 0.4 })
    )
    expect(transform).toMatchObject({ init_images: [png], denoising_strength: 0.4 })
    expect(transform['mask']).toBeUndefined()
    const inpaint = a1111Body(
      job({
        workflow: 'inpaint',
        images: [{ bytes: PNG_1X1, mime: 'image/png' }],
        mask: { bytes: JPEG_STUB, mime: 'image/png' },
      })
    )
    expect(inpaint).toMatchObject({
      init_images: [png],
      denoising_strength: 0.75,
      mask: jpeg,
      inpainting_fill: 1,
      inpaint_full_res: false,
      mask_blur: 4,
    })
  })

  it('refuses transform without a source and inpaint without a mask', () => {
    expect(() => a1111Body(job({ workflow: 'transform' }))).toThrow(
      expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' })
    )
    expect(() =>
      a1111Body(job({ workflow: 'inpaint', images: [{ bytes: PNG_1X1, mime: 'image/png' }] }))
    ).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('a1111Images', () => {
  it('drops a leading grid and keeps n images', () => {
    expect(a1111Images({ provider: 'a1111' }, { images: [jpeg, png, png] }, 2).map((i) => i.mime)).toEqual([
      'image/png',
      'image/png',
    ])
    expect(a1111Images({ provider: 'a1111' }, { images: [png, jpeg, png] }, 1).map((i) => i.mime)).toEqual([
      'image/png',
    ])
  })

  it('refuses an answer without images', () => {
    expect(() => a1111Images({ provider: 'a1111' }, { images: [] }, 1)).toThrow(
      expect.objectContaining({ code: 'REMOTE_UNAVAILABLE' })
    )
  })
})

describe('liveModelsFromA1111', () => {
  it('lists checkpoints by title with every sampler', () => {
    expect(
      liveModelsFromA1111(
        [
          { title: 'a.safetensors [1]', model_name: 'a', hash: '1' },
          { title: 'a.safetensors [1]', model_name: 'a' },
          { model_name: 'b' },
          {},
        ],
        [{ name: 'Euler a' }, { name: 'DPM++ 2M' }, { aliases: [] }]
      )
    ).toEqual([
      { id: 'a.safetensors [1]', name: 'a', samplers: ['Euler a', 'DPM++ 2M'] },
      { id: 'b', name: 'b', samplers: ['Euler a', 'DPM++ 2M'] },
    ])
    expect(liveModelsFromA1111([{ title: 'x' }], undefined)).toEqual([{ id: 'x', name: 'x' }])
  })
})

describe('A1111', () => {
  it('creates through txt2img at the root, keyless', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${ROOT}/sdapi/v1/txt2img`,
        answer: jsonResponse({ images: [png], parameters: {}, info: '{}' }),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: `${ROOT}/sdapi/v1`, apiKey: null })
    const images = await A1111.generate(ctx, job({ seed: 4 }), () => {})
    expect(images).toEqual([{ bytes: PNG_1X1, mime: 'image/png' }])
    const call = requests.find((r) => r.url.endsWith('/txt2img'))
    expect(call?.headers.get('authorization')).toBeNull()
    expect(call?.json).toMatchObject({ seed: 4, override_settings: { sd_model_checkpoint: model.id } })
  })

  it('inpaints through img2img with basic auth from the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: `${ROOT}/sdapi/v1/img2img`, answer: jsonResponse({ images: [png] }) },
    ])
    const ctx = mediaContext({ fetch, baseUrl: ROOT, apiKey: 'user:pass' })
    await A1111.generate(
      ctx,
      job({
        workflow: 'inpaint',
        images: [{ bytes: PNG_1X1, mime: 'image/png' }],
        mask: { bytes: PNG_1X1, mime: 'image/png' },
      }),
      () => {}
    )
    const call = requests.find((r) => r.url.endsWith('/img2img'))
    expect(call?.headers.get('authorization')).toBe('Basic dXNlcjpwYXNz')
    expect(call?.json).toMatchObject({ init_images: [png], mask: png, inpainting_fill: 1 })
  })

  it('reports the progress route while the generation runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${ROOT}/sdapi/v1/txt2img`,
        answer: async () => {
          await gate
          return jsonResponse({ images: [png] })
        },
      },
      {
        method: 'GET',
        url: `${ROOT}/sdapi/v1/progress?skip_current_image=true`,
        answer: [
          jsonResponse({ progress: 0.25, eta_relative: 3, state: {} }),
          jsonResponse({ progress: 0.5, eta_relative: 2, state: {} }),
          () => {
            release()
            return jsonResponse({ progress: 0.9, eta_relative: 1, state: {} })
          },
        ],
      },
    ])
    const seen: RemoteProgress[] = []
    await A1111.generate(mediaContext({ fetch, baseUrl: ROOT, apiKey: null }), job(), (p) => seen.push(p))
    expect(seen.slice(0, 3)).toEqual([
      { phase: 'generating' },
      { phase: 'generating', fraction: 0.25 },
      { phase: 'generating', fraction: 0.5 },
    ])
    expect(requests.filter((r) => r.url.includes('/progress')).length).toBeGreaterThanOrEqual(3)
  })

  it('interrupts the server when the job is cancelled', async () => {
    const controller = new AbortController()
    const fake = fakeMediaFetch([
      {
        method: 'GET',
        url: `${ROOT}/sdapi/v1/progress?skip_current_image=true`,
        answer: () => {
          controller.abort()
          return jsonResponse({ progress: 0.1 })
        },
      },
      { method: 'POST', url: `${ROOT}/sdapi/v1/interrupt`, answer: jsonResponse(null) },
    ])
    const fetch = hangingOn(`${ROOT}/sdapi/v1/txt2img`, fake.fetch)
    const ctx = mediaContext({ fetch, baseUrl: ROOT, apiKey: null, signal: controller.signal })
    await expect(A1111.generate(ctx, job(), () => {})).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fake.requests.some((r) => r.method === 'POST' && r.url === `${ROOT}/sdapi/v1/interrupt`)).toBe(
      true
    )
  })

  it('maps a server exception and a missing API', async () => {
    const failing = fakeMediaFetch([
      {
        method: 'POST',
        url: `${ROOT}/sdapi/v1/txt2img`,
        answer: jsonResponse(
          { error: 'OutOfMemoryError', detail: '', body: '', errors: 'CUDA out of memory.' },
          500
        ),
      },
    ])
    await expect(
      A1111.generate(mediaContext({ fetch: failing.fetch, baseUrl: ROOT, apiKey: null }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
      details: 'HTTP 500: OutOfMemoryError: CUDA out of memory.',
    })
    const missing = fakeMediaFetch([
      { method: 'POST', url: `${ROOT}/sdapi/v1/txt2img`, answer: jsonResponse({ detail: 'Not Found' }, 404) },
    ])
    await expect(
      A1111.generate(mediaContext({ fetch: missing.fetch, baseUrl: ROOT, apiKey: null }), job(), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_NOT_CONFIGURED' })
    await expect(
      A1111.generate(
        mediaContext({ fetch: missing.fetch, baseUrl: ROOT }),
        job({ workflow: 'edit' }),
        () => {}
      )
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
  })

  it('lists checkpoints with samplers, and without them where the route is missing', async () => {
    const full = fakeMediaFetch([
      {
        method: 'GET',
        url: `${ROOT}/sdapi/v1/sd-models`,
        answer: jsonResponse([{ title: 'a [1]', model_name: 'a' }]),
      },
      { method: 'GET', url: `${ROOT}/sdapi/v1/samplers`, answer: jsonResponse([{ name: 'Euler' }]) },
    ])
    expect(
      await A1111.listModels?.(mediaContext({ fetch: full.fetch, baseUrl: `${ROOT}/v1`, apiKey: null }))
    ).toEqual([{ id: 'a [1]', name: 'a', samplers: ['Euler'] }])
    const neo = fakeMediaFetch([
      {
        method: 'GET',
        url: `${ROOT}/sdapi/v1/sd-models`,
        answer: jsonResponse([{ title: 'a [1]', model_name: 'a' }]),
      },
      { method: 'GET', url: `${ROOT}/sdapi/v1/samplers`, answer: jsonResponse({ detail: 'Not Found' }, 404) },
    ])
    expect(await A1111.listModels?.(mediaContext({ fetch: neo.fetch, baseUrl: ROOT, apiKey: null }))).toEqual(
      [{ id: 'a [1]', name: 'a' }]
    )
    const none = fakeMediaFetch([
      {
        method: 'GET',
        url: `${ROOT}/sdapi/v1/sd-models`,
        answer: jsonResponse({ detail: 'Not Found' }, 404),
      },
    ])
    await expect(
      A1111.listModels?.(mediaContext({ fetch: none.fetch, baseUrl: ROOT, apiKey: null }))
    ).rejects.toMatchObject({
      code: 'REMOTE_NOT_CONFIGURED',
    })
  })
})
