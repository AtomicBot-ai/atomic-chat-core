import { describe, expect, it } from 'vitest'
import type { ImageModelDescriptor } from '../../contracts/index.js'
import { decodePng } from '../../diffusion/index.js'
import {
  bytesResponse,
  fakeMediaFetch,
  JPEG_STUB,
  jsonResponse,
  mediaContext,
  PNG_1X1,
} from '../../../test/helpers/media-fetch.js'
import { commonFields, imageModelsFromListing, imagesFromAnswer, OPENAI_IMAGES } from './openai-images.js'
import type { ImageGenerationJob } from './types.js'

const BASE = 'https://api.openai.com/v1'

function model(overrides: Partial<ImageModelDescriptor> = {}): ImageModelDescriptor {
  return {
    id: 'gpt-image-2.5-flare',
    name: 'GPT Image 2.5 Flare',
    api: 'openai-images',
    kind: 'image',
    source: 'catalog',
    workflows: ['create', 'edit', 'reference', 'inpaint'],
    params: { size: { kind: 'enum', values: ['auto', '1024x1024'] }, n: { max: 4 }, seed: true },
    ...overrides,
  }
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return { model: model(), prompt: 'a cat', workflow: 'create', n: 1, images: [], ...overrides }
}

const b64 = PNG_1X1.toString('base64')

describe('commonFields', () => {
  it('sends what the job set and leaves response_format out for gpt-image', () => {
    expect(
      commonFields(
        job({
          n: 2,
          size: '1024x1024',
          quality: 'high',
          background: 'transparent',
          outputFormat: 'png',
          seed: 7,
        })
      )
    ).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: 'a cat',
      n: 2,
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      output_format: 'png',
      seed: 7,
    })
  })

  it('asks for b64_json from other models and builds the size from a range', () => {
    const body = commonFields(
      job({ model: model({ id: 'x/z-image-turbo', params: {} }), width: 768, height: 512, seed: 3 })
    )
    expect(body).toEqual({
      model: 'x/z-image-turbo',
      prompt: 'a cat',
      size: '768x512',
      response_format: 'b64_json',
    })
  })
})

describe('imagesFromAnswer', () => {
  it('decodes b64_json and data URLs, and downloads a URL on the provider', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: 'https://cdn.example.com/a.jpg', answer: bytesResponse(JPEG_STUB, 'image/jpeg') },
    ])
    const images = await imagesFromAnswer(mediaContext({ fetch }), {
      data: [
        { b64_json: b64 },
        { url: `data:image/png;base64,${b64}` },
        { url: 'https://cdn.example.com/a.jpg' },
      ],
    })
    expect(images.map((i) => i.mime)).toEqual(['image/png', 'image/png', 'image/jpeg'])
  })

  it('refuses an answer without an image', async () => {
    const { fetch } = fakeMediaFetch([])
    await expect(imagesFromAnswer(mediaContext({ fetch }), { data: [] })).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })
})

describe('imageModelsFromListing', () => {
  it('keeps image models of a full listing, by type when given, by id otherwise', () => {
    expect(
      imageModelsFromListing(
        {
          data: [
            { id: 'gpt-4o' },
            { id: 'gpt-image-2' },
            {
              id: 'google/gemini-nano-banana-2.1',
              type: 'openai/image-generations',
              info: { name: 'Nano Banana' },
            },
            { id: 'google/veo', type: 'internal/video-generations/submit' },
          ],
        },
        true
      )
    ).toEqual([{ id: 'gpt-image-2' }, { id: 'google/gemini-nano-banana-2.1', name: 'Nano Banana' }])
  })

  it('keeps everything of a listing that is image models only', () => {
    expect(imageModelsFromListing({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }, false)).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
  })
})

describe('OPENAI_IMAGES', () => {
  it('creates through /images/generations with the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images/generations`,
        answer: jsonResponse({ data: [{ b64_json: b64 }] }),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    const images = await OPENAI_IMAGES.generate(ctx, job({ size: 'auto' }), () => {})
    expect(images).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toEqual({ model: 'gpt-image-2.5-flare', prompt: 'a cat', size: 'auto' })
  })

  it('edits with the JSON form, the mask turned into alpha', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/images/edits`, answer: jsonResponse({ data: [{ b64_json: b64 }] }) },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await OPENAI_IMAGES.generate(
      ctx,
      job({
        workflow: 'inpaint',
        images: [{ bytes: PNG_1X1, mime: 'image/png' }],
        mask: { bytes: PNG_1X1, mime: 'image/png' },
      }),
      () => {}
    )
    const body = requests[0]?.json as Record<string, unknown>
    expect(
      (body['images'] as Array<{ image_url: string }>)[0]?.image_url.startsWith('data:image/png;base64,')
    ).toBe(true)
    const mask = (body['mask'] as { image_url: string }).image_url
    const decoded = await decodePng(Buffer.from(mask.split(',')[1] as string, 'base64'))
    expect(decoded.channels).toBe(4)
  })

  it('edits through generations with image_urls when the model says so', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images/generations`,
        answer: jsonResponse({ data: [{ b64_json: b64 }] }),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await OPENAI_IMAGES.generate(
      ctx,
      job({
        model: model({ id: 'google/gemini-nano-banana-2.1', options: { edit_via: 'image_urls' } }),
        workflow: 'edit',
        images: [{ bytes: PNG_1X1, mime: 'image/png' }],
      }),
      () => {}
    )
    expect((requests[0]?.json as Record<string, unknown>)['image_urls']).toHaveLength(1)
  })

  it('sends a multipart edit when the model asks for it', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/images/edits`, answer: jsonResponse({ data: [{ b64_json: b64 }] }) },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await OPENAI_IMAGES.generate(
      ctx,
      job({
        model: model({ options: { edit_transport: 'multipart' } }),
        workflow: 'edit',
        images: [{ bytes: PNG_1X1, mime: 'image/png' }],
      }),
      () => {}
    )
    expect(requests[0]?.form?.get('prompt')).toBe('a cat')
    expect(requests[0]?.form?.getAll('image[]')).toHaveLength(1)
  })

  it('maps a provider refusal to a REMOTE code with its words', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images/generations`,
        answer: jsonResponse({ error: { message: 'Your request was rejected by the safety system.' } }, 400),
      },
    ])
    await expect(
      OPENAI_IMAGES.generate(mediaContext({ fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
  })

  it('lists Eden AI style /images/models whole, else filters /models', async () => {
    const own = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/images/models`,
        answer: jsonResponse({ data: [{ id: 'openai/gpt-image-2' }] }),
      },
    ])
    expect(await OPENAI_IMAGES.listModels?.(mediaContext({ fetch: own.fetch, baseUrl: BASE }))).toEqual([
      { id: 'openai/gpt-image-2' },
    ])
    const plain = fakeMediaFetch([
      { method: 'GET', url: `${BASE}/images/models`, answer: jsonResponse({ error: 'not found' }, 404) },
      {
        method: 'GET',
        url: `${BASE}/models`,
        answer: jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'gpt-image-2' }] }),
      },
    ])
    expect(await OPENAI_IMAGES.listModels?.(mediaContext({ fetch: plain.fetch, baseUrl: BASE }))).toEqual([
      { id: 'gpt-image-2' },
    ])
  })
})
