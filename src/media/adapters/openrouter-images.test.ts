import { describe, expect, it } from 'vitest'
import type { ImageModelDescriptor } from '../../contracts/index.js'
import { fakeMediaFetch, jsonResponse, mediaContext, PNG_1X1 } from '../../../test/helpers/media-fetch.js'
import {
  OPENROUTER_IMAGES,
  openRouterBodyError,
  openRouterImageBody,
  openRouterImageModel,
  openRouterImageModels,
} from './openrouter-images.js'
import type { ImageGenerationJob } from './types.js'

const BASE = 'https://openrouter.ai/api/v1'
const b64 = PNG_1X1.toString('base64')
const png = { bytes: PNG_1X1, mime: 'image/png' }

function model(overrides: Partial<ImageModelDescriptor> = {}): ImageModelDescriptor {
  return {
    id: 'google/gemini-nano-banana-2.1',
    name: 'Nano Banana 2.1',
    api: 'openrouter-images',
    kind: 'image',
    source: 'catalog',
    workflows: ['create', 'edit', 'reference'],
    params: { max_input_images: 14 },
    ...overrides,
  }
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return { model: model(), prompt: 'a cat', workflow: 'create', n: 1, images: [], ...overrides }
}

// Entries of OpenRouter's `GET /api/v1/images/models` as it answered on 2026-10-12, trimmed.
const NANO_BANANA = {
  id: 'google/gemini-nano-banana-2.1',
  name: 'Google: Nano Banana 2.1',
  description: "Nano Banana 2.1 (Gemini Nano Banana 2.1) is Google's image generation and editing model...",
  created: 1791300825,
  architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] },
  supported_parameters: {
    resolution: { type: 'enum', values: ['1K', '2K', '4K'] },
    aspect_ratio: {
      type: 'enum',
      values: [
        '1:1',
        '1:4',
        '1:8',
        '2:3',
        '3:2',
        '3:4',
        '4:1',
        '4:3',
        '4:5',
        '5:4',
        '8:1',
        '9:16',
        '16:9',
        '21:9',
      ],
    },
    n: { type: 'range', min: 1, max: 1 },
    input_references: { type: 'range', min: 0, max: 14 },
  },
  supports_streaming: false,
  endpoints: '/api/v1/images/models/google/gemini-nano-banana-2.1/endpoints',
}

const GPT_IMAGE = {
  id: 'openai/gpt-image-2.5-flare',
  name: 'OpenAI: GPT Image 2.5 Flare',
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
  supported_parameters: {
    aspect_ratio: {
      type: 'enum',
      values: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto'],
    },
    quality: { type: 'enum', values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
    background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] },
    n: { type: 'range', min: 1, max: 10 },
    input_references: { type: 'range', min: 0, max: 16 },
    output_compression: { type: 'range', min: 0, max: 100 },
  },
}

const MING_DESIGN = {
  id: 'inclusionai/ming-image-0.1-design',
  name: 'inclusionAI: Ming Image 0.1 Design',
  architecture: { input_modalities: ['text'], output_modalities: ['image'] },
  supported_parameters: {
    output_format: { type: 'enum', values: ['png', 'jpeg', 'webp'] },
    n: { type: 'range', min: 1, max: 1 },
    input_references: { type: 'range', min: 0, max: 0 },
    size: { type: 'boolean' },
  },
}

// Made up: no preferred start value among its lists.
const SYNTHETIC = {
  id: 'example/no-defaults',
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
  supported_parameters: {
    resolution: { type: 'enum', values: ['2K', '4K'] },
    aspect_ratio: { type: 'enum', values: ['16:9', '9:16'] },
    output_format: { type: 'enum', values: ['webp', 'jpeg'] },
    input_references: { type: 'range', min: 0, max: 14 },
    seed: { type: 'boolean' },
  },
}

describe('openRouterImageBody', () => {
  it('sends what the job set, and the inputs of an edit as input_references', () => {
    expect(
      openRouterImageBody(
        job({
          model: model({ params: { seed: true } }),
          workflow: 'edit',
          n: 2,
          aspectRatio: '16:9',
          resolution: '2K',
          quality: 'high',
          background: 'transparent',
          outputFormat: 'webp',
          seed: 9,
          images: [png, png],
        })
      )
    ).toEqual({
      model: 'google/gemini-nano-banana-2.1',
      prompt: 'a cat',
      n: 2,
      aspect_ratio: '16:9',
      resolution: '2K',
      quality: 'high',
      background: 'transparent',
      output_format: 'webp',
      seed: 9,
      input_references: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    })
  })

  it('asks for png when the model offers formats, and leaves out what the model does not take', () => {
    const body = openRouterImageBody(
      job({
        model: model({ params: { output_format: { values: ['jpeg', 'png'] } } }),
        seed: 3,
        width: 1024,
        height: 768,
      })
    )
    expect(body).toEqual({
      model: 'google/gemini-nano-banana-2.1',
      prompt: 'a cat',
      size: '1024x768',
      output_format: 'png',
    })
  })
})

describe('openRouterImageModel', () => {
  it('turns supported_parameters into controls', () => {
    expect(openRouterImageModel(NANO_BANANA)).toEqual({
      id: 'google/gemini-nano-banana-2.1',
      name: 'Google: Nano Banana 2.1',
      description: NANO_BANANA.description,
      workflows: ['create', 'edit', 'reference'],
      params: {
        aspect_ratios: { values: NANO_BANANA.supported_parameters.aspect_ratio.values, default: '1:1' },
        resolutions: { values: ['1K', '2K', '4K'], default: '1K' },
        max_input_images: 14,
      },
    })
    expect(openRouterImageModel(GPT_IMAGE)?.params).toEqual({
      aspect_ratios: { values: GPT_IMAGE.supported_parameters.aspect_ratio.values, default: '1:1' },
      quality: { values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'auto' },
      background: { values: ['auto', 'transparent', 'opaque'], default: 'auto' },
      n: { max: 4 },
      max_input_images: 16,
    })
  })

  it('keeps a text-only model to create, and starts on the first value without a preferred one', () => {
    expect(openRouterImageModel(MING_DESIGN)).toEqual({
      id: 'inclusionai/ming-image-0.1-design',
      name: 'inclusionAI: Ming Image 0.1 Design',
      workflows: ['create'],
      params: { output_format: { values: ['png', 'jpeg', 'webp'], default: 'png' } },
    })
    expect(openRouterImageModel(SYNTHETIC)?.params).toEqual({
      aspect_ratios: { values: ['16:9', '9:16'], default: '16:9' },
      resolutions: { values: ['2K', '4K'], default: '2K' },
      output_format: { values: ['webp', 'jpeg'], default: 'webp' },
      seed: true,
      max_input_images: 14,
    })
  })

  it('drops an entry without an id or one that makes no image', () => {
    expect(openRouterImageModel({ name: 'x' })).toBeUndefined()
    expect(
      openRouterImageModel({ id: 'a/video', architecture: { output_modalities: ['video'] } })
    ).toBeUndefined()
    expect(openRouterImageModel({ id: 'meta/muse-image', supported_parameters: {} })).toEqual({
      id: 'meta/muse-image',
      workflows: ['create'],
      params: {},
    })
  })
})

describe('openRouterImageModels', () => {
  it('reads data[] once per id', () => {
    expect(
      openRouterImageModels({ data: [NANO_BANANA, NANO_BANANA, MING_DESIGN, 'junk'] }).map((m) => m.id)
    ).toEqual(['google/gemini-nano-banana-2.1', 'inclusionai/ming-image-0.1-design'])
    expect(openRouterImageModels(null)).toEqual([])
  })
})

describe('openRouterBodyError', () => {
  it('maps an error in a 200 body by its code, and ignores a body with images', () => {
    expect(openRouterBodyError('OpenRouter', { error: { code: 429, message: 'Slow down' } })).toMatchObject({
      code: 'REMOTE_RATE_LIMITED',
    })
    expect(openRouterBodyError('OpenRouter', { error: { message: 'Upstream failed' } })).toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
    expect(openRouterBodyError('OpenRouter', { data: [{ b64_json: b64 }] })).toBeUndefined()
  })
})

describe('OPENROUTER_IMAGES', () => {
  it('generates through POST /images with the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images`,
        answer: jsonResponse({ created: 1, data: [{ b64_json: b64, media_type: 'image/jpeg' }] }),
      },
    ])
    const phases: unknown[] = []
    const images = await OPENROUTER_IMAGES.generate(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ workflow: 'reference', images: [png] }),
      (p) => phases.push(p)
    )
    expect(images).toEqual([{ bytes: PNG_1X1, mime: 'image/png' }])
    expect(phases).toEqual([{ phase: 'generating' }])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect((requests[0]?.json as Record<string, unknown>)['input_references']).toHaveLength(1)
  })

  it('refuses inpaint before calling', async () => {
    const { fetch, requests } = fakeMediaFetch([])
    await expect(
      OPENROUTER_IMAGES.generate(
        mediaContext({ fetch, baseUrl: BASE }),
        job({ workflow: 'inpaint', images: [png] }),
        () => {}
      )
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
    expect(requests).toHaveLength(0)
  })

  it('maps a refused key and a 200 body error', async () => {
    const denied = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images`,
        answer: jsonResponse({ error: { code: 401, message: 'No auth' } }, 401),
      },
    ])
    await expect(
      OPENROUTER_IMAGES.generate(mediaContext({ fetch: denied.fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' })
    const inBody = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images`,
        answer: jsonResponse({ error: { code: 402, message: 'Insufficient credits' } }),
      },
    ])
    await expect(
      OPENROUTER_IMAGES.generate(mediaContext({ fetch: inBody.fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_QUOTA' })
  })

  it('lists /images/models with their controls', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: `${BASE}/images/models`, answer: jsonResponse({ data: [MING_DESIGN] }) },
    ])
    const models = await OPENROUTER_IMAGES.listModels?.(mediaContext({ fetch, baseUrl: BASE }))
    expect(models?.map((m) => [m.id, m.workflows])).toEqual([
      ['inclusionai/ming-image-0.1-design', ['create']],
    ])
  })
})
