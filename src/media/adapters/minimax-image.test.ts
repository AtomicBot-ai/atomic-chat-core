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
import { MINIMAX_IMAGE, minimaxImageBody, minimaxImages, minimaxImageStatusError } from './minimax-image.js'
import type { ImageGenerationJob } from './types.js'

const BASE = 'https://api.minimax.io/v1'
const b64 = PNG_1X1.toString('base64')
const png = { bytes: PNG_1X1, mime: 'image/png' }

function model(overrides: Partial<ImageModelDescriptor> = {}): ImageModelDescriptor {
  return {
    id: 'image-01',
    name: 'MiniMax Image-01',
    api: 'minimax-image',
    kind: 'image',
    source: 'catalog',
    workflows: ['create', 'reference'],
    params: { n: { max: 4 }, seed: true, max_input_images: 1 },
    ...overrides,
  }
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return { model: model(), prompt: 'a cat', workflow: 'create', n: 1, images: [], ...overrides }
}

const ok = { status_code: 0, status_msg: 'success' }

describe('minimaxImageBody', () => {
  it('sends the aspect ratio, base64, the seed, n and no prompt optimizer', () => {
    expect(minimaxImageBody(job({ aspectRatio: '16:9', width: 1024, height: 576, seed: 5, n: 3 }))).toEqual({
      model: 'image-01',
      prompt: 'a cat',
      aspect_ratio: '16:9',
      response_format: 'base64',
      seed: 5,
      n: 3,
      prompt_optimizer: false,
    })
  })

  it('sends a pixel size without an aspect ratio, and the first input as the subject of a reference', () => {
    const body = minimaxImageBody(
      job({
        model: model({ params: {} }),
        workflow: 'reference',
        size: '1024x768',
        seed: 5,
        images: [png, png],
      })
    )
    expect(body).toEqual({
      model: 'image-01',
      prompt: 'a cat',
      width: 1024,
      height: 768,
      response_format: 'base64',
      prompt_optimizer: false,
      subject_reference: [{ type: 'character', image_file: `data:image/png;base64,${b64}` }],
    })
  })
})

describe('minimaxImageStatusError', () => {
  it.each([
    [1002, 'REMOTE_RATE_LIMITED'],
    [1004, 'REMOTE_AUTH_FAILED'],
    [2049, 'REMOTE_AUTH_FAILED'],
    [1008, 'REMOTE_QUOTA'],
    [1026, 'REMOTE_CONTENT_BLOCKED'],
    [1027, 'REMOTE_CONTENT_BLOCKED'],
    [2013, 'REMOTE_REJECTED'],
    [1000, 'REMOTE_UNAVAILABLE'],
  ])('status_code %i → %s', (code, expected) => {
    expect(
      minimaxImageStatusError('MiniMax', { base_resp: { status_code: code, status_msg: 'words' } })
    ).toMatchObject({
      code: expected,
      details: `status_code ${code}: words`,
    })
  })

  it('says nothing for a success or a body without base_resp', () => {
    expect(minimaxImageStatusError('MiniMax', { base_resp: ok })).toBeUndefined()
    expect(minimaxImageStatusError('MiniMax', {})).toBeUndefined()
    expect(minimaxImageStatusError('MiniMax', 'text')).toBeUndefined()
  })
})

describe('minimaxImages', () => {
  it('decodes base64 and downloads URLs', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'GET',
        url: 'https://cdn.minimax.example/a.jpeg',
        answer: bytesResponse(JPEG_STUB, 'image/png'),
      },
    ])
    const images = await minimaxImages(mediaContext({ fetch }), {
      data: { image_base64: [b64], image_urls: ['https://cdn.minimax.example/a.jpeg'] },
      base_resp: ok,
    })
    expect(images.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg'])
  })

  it('maps images held back by the safety check, and an empty answer', async () => {
    const { fetch } = fakeMediaFetch([])
    await expect(
      minimaxImages(mediaContext({ fetch }), {
        data: { image_base64: [] },
        metadata: { failed_count: '1', success_count: '0' },
        base_resp: ok,
      })
    ).rejects.toMatchObject({ code: 'REMOTE_CONTENT_BLOCKED' })
    await expect(minimaxImages(mediaContext({ fetch }), { data: {}, base_resp: ok })).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })
})

describe('MINIMAX_IMAGE', () => {
  it('generates through /image_generation with the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/image_generation`,
        answer: jsonResponse({
          id: 't1',
          data: { image_base64: [b64] },
          metadata: { success_count: 1 },
          base_resp: ok,
        }),
      },
    ])
    const phases: unknown[] = []
    const images = await MINIMAX_IMAGE.generate(mediaContext({ fetch, baseUrl: BASE }), job(), (p) =>
      phases.push(p)
    )
    expect(images).toEqual([{ bytes: PNG_1X1, mime: 'image/png' }])
    expect(phases).toEqual([{ phase: 'generating' }])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect((requests[0]?.json as Record<string, unknown>)['response_format']).toBe('base64')
  })

  it('maps an error answered as HTTP 200', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/image_generation`,
        answer: jsonResponse({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
      },
    ])
    await expect(
      MINIMAX_IMAGE.generate(mediaContext({ fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_QUOTA',
    })
  })

  it('refuses edit and a reference without an image before calling', async () => {
    const { fetch, requests } = fakeMediaFetch([])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(
      MINIMAX_IMAGE.generate(ctx, job({ workflow: 'edit', images: [png] }), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    })
    await expect(MINIMAX_IMAGE.generate(ctx, job({ workflow: 'reference' }), () => {})).rejects.toMatchObject(
      {
        code: 'REMOTE_UNSUPPORTED',
      }
    )
    expect(requests).toHaveLength(0)
    expect(MINIMAX_IMAGE.listModels).toBeUndefined()
  })
})
