import { describe, expect, it } from 'vitest'
import type { ImageModelDescriptor } from '../../contracts/index.js'
import {
  bytesResponse,
  fakeMediaFetch,
  JPEG_STUB,
  jsonResponse,
  mediaContext,
  PNG_1X1,
} from '../../../test/helpers/media-fetch.js'
import type { ImageGenerationJob } from './types.js'
import { XAI_IMAGES, xaiImageBody, xaiImageModels } from './xai-images.js'

const BASE = 'https://api.x.ai/v1'
const b64 = PNG_1X1.toString('base64')
const png = { bytes: PNG_1X1, mime: 'image/png' }

function model(overrides: Partial<ImageModelDescriptor> = {}): ImageModelDescriptor {
  return {
    id: 'grok-imagine-image-2.0',
    name: 'Grok Imagine Image 2.0',
    api: 'xai-images',
    kind: 'image',
    source: 'catalog',
    workflows: ['create', 'edit', 'reference'],
    params: { n: { max: 4 }, max_input_images: 5 },
    ...overrides,
  }
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return { model: model(), prompt: 'a cat', workflow: 'create', n: 1, images: [], ...overrides }
}

describe('xaiImageBody', () => {
  it('sends what the job set and asks for b64_json', () => {
    expect(xaiImageBody(job({ n: 3, aspectRatio: '16:9', resolution: '2k', quality: 'medium' }))).toEqual({
      model: 'grok-imagine-image-2.0',
      prompt: 'a cat',
      n: 3,
      aspect_ratio: '16:9',
      resolution: '2k',
      quality: 'medium',
      response_format: 'b64_json',
    })
  })

  it('sends one input as image and several as images, never both', () => {
    const one = xaiImageBody(job({ workflow: 'edit', images: [png] }))
    expect(one['image']).toEqual({ url: `data:image/png;base64,${b64}`, type: 'image_url' })
    expect(one['images']).toBeUndefined()
    const many = xaiImageBody(job({ workflow: 'reference', images: [png, png, png] }))
    expect(many['images']).toHaveLength(3)
    expect(many['image']).toBeUndefined()
  })
})

describe('xaiImageModels', () => {
  it('keeps image models and gives editing to those that take images', () => {
    expect(
      xaiImageModels({
        models: [
          {
            id: 'grok-imagine-image-2.0',
            aliases: ['grok-imagine-image'],
            input_modalities: ['text', 'image'],
            output_modalities: ['image'],
          },
          { id: 'grok-imagine-image-lite', input_modalities: ['text'], output_modalities: ['image'] },
          { id: 'grok-imagine-video', input_modalities: ['text', 'image'], output_modalities: ['video'] },
          { id: 'grok-imagine-image-lite' },
        ],
      })
    ).toEqual([
      { id: 'grok-imagine-image-2.0', workflows: ['create', 'edit', 'reference'] },
      { id: 'grok-imagine-image-lite', workflows: ['create'] },
    ])
  })

  it('answers nothing for a body it cannot read', () => {
    expect(xaiImageModels(undefined)).toEqual([])
    expect(xaiImageModels({ models: 'none' })).toEqual([])
  })
})

describe('XAI_IMAGES', () => {
  it('creates through /images/generations with the key and decodes b64_json', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images/generations`,
        answer: jsonResponse({ data: [{ b64_json: b64, mime_type: 'image/jpeg' }] }),
      },
    ])
    const phases: unknown[] = []
    const images = await XAI_IMAGES.generate(mediaContext({ fetch, baseUrl: BASE }), job(), (p) =>
      phases.push(p)
    )
    expect(images).toEqual([{ bytes: PNG_1X1, mime: 'image/png' }])
    expect(phases).toEqual([{ phase: 'generating' }])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toEqual({
      model: 'grok-imagine-image-2.0',
      prompt: 'a cat',
      response_format: 'b64_json',
    })
  })

  it('edits through /images/edits and downloads a URL answer', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images/edits`,
        answer: jsonResponse({ data: [{ url: 'https://imgen.x.ai/a.jpg' }] }),
      },
      {
        method: 'GET',
        url: 'https://imgen.x.ai/a.jpg',
        answer: bytesResponse(JPEG_STUB, 'application/octet-stream'),
      },
    ])
    const images = await XAI_IMAGES.generate(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ workflow: 'edit', images: [png] }),
      () => {}
    )
    expect(images[0]?.mime).toBe('image/jpeg')
    expect((requests[0]?.json as Record<string, unknown>)['image']).toBeDefined()
    // The download is off the provider's origin: no key goes along.
    expect(requests[1]?.headers.get('authorization')).toBeNull()
  })

  it('refuses inpaint and an edit without a source before calling', async () => {
    const { fetch, requests } = fakeMediaFetch([])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(
      XAI_IMAGES.generate(ctx, job({ workflow: 'inpaint', images: [png], mask: png }), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
    await expect(XAI_IMAGES.generate(ctx, job({ workflow: 'edit' }), () => {})).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    })
    expect(requests).toHaveLength(0)
  })

  it('maps a moderation refusal to REMOTE_CONTENT_BLOCKED', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/images/generations`,
        answer: jsonResponse(
          { code: 'invalid', error: 'Generated image rejected by content moderation.' },
          400
        ),
      },
    ])
    await expect(
      XAI_IMAGES.generate(mediaContext({ fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
  })

  it('lists /image-generation-models', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/image-generation-models`,
        answer: jsonResponse({
          models: [
            { id: 'grok-imagine-image-2.0', input_modalities: ['text'], output_modalities: ['image'] },
          ],
        }),
      },
    ])
    expect(await XAI_IMAGES.listModels?.(mediaContext({ fetch, baseUrl: BASE }))).toEqual([
      { id: 'grok-imagine-image-2.0', workflows: ['create'] },
    ])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })
})
