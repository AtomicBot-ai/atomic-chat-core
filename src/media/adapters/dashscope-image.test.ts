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
import {
  DASHSCOPE_IMAGE,
  dashscopeError,
  dashscopeImageBody,
  dashscopeImageModels,
  dashscopeImageUrls,
  dashscopeOrigin,
} from './dashscope-image.js'
import type { ImageGenerationJob } from './types.js'

const BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
const ORIGIN = 'https://dashscope-intl.aliyuncs.com'
const GENERATE = `${ORIGIN}/api/v1/services/aigc/multimodal-generation/generation`
const OSS = 'https://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com'
const b64 = PNG_1X1.toString('base64')
const png = { bytes: PNG_1X1, mime: 'image/png' }

function model(overrides: Partial<ImageModelDescriptor> = {}): ImageModelDescriptor {
  return {
    id: 'qwen-image-3.0',
    name: 'Qwen-Image 3.0',
    api: 'dashscope-image',
    kind: 'image',
    source: 'catalog',
    workflows: ['create', 'edit', 'reference'],
    params: { n: { max: 4 }, seed: true, negative_prompt: true, max_input_images: 3 },
    ...overrides,
  }
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return { model: model(), prompt: 'a cat', workflow: 'create', n: 1, images: [], ...overrides }
}

function answerWith(...choices: string[][]): unknown {
  return {
    output: {
      choices: choices.map((urls) => ({
        finish_reason: 'stop',
        message: { role: 'assistant', content: urls.map((image) => ({ image })) },
      })),
    },
    usage: { image_count: choices.flat().length },
    request_id: 'r1',
  }
}

describe('dashscopeOrigin', () => {
  it('cuts the base after its host', () => {
    expect(dashscopeOrigin(BASE)).toBe(ORIGIN)
    expect(dashscopeOrigin('https://dashscope.aliyuncs.com/compatible-mode/v1/')).toBe(
      'https://dashscope.aliyuncs.com'
    )
  })

  it('refuses a base that is not a URL', () => {
    expect(() => dashscopeOrigin('dashscope')).toThrow(
      expect.objectContaining({ code: 'REMOTE_NOT_CONFIGURED' })
    )
  })
})

describe('dashscopeImageBody', () => {
  it('puts the inputs before the one text item and sends the size as W*H', () => {
    expect(
      dashscopeImageBody(
        job({
          workflow: 'edit',
          images: [png, png],
          size: '2688x1536',
          n: 2,
          seed: 4,
          negativePrompt: 'blurry',
        })
      )
    ).toEqual({
      model: 'qwen-image-3.0',
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { image: `data:image/png;base64,${b64}` },
              { image: `data:image/png;base64,${b64}` },
              { text: 'a cat' },
            ],
          },
        ],
      },
      parameters: {
        n: 2,
        size: '2688*1536',
        negative_prompt: 'blurry',
        prompt_extend: false,
        watermark: false,
        seed: 4,
      },
    })
  })

  it('sends a resolution tier as the size of a model that has one, and leaves out what the model does not take', () => {
    const body = dashscopeImageBody(
      job({
        model: model({ id: 'wan2.7-image', params: {} }),
        resolution: '2K',
        seed: 4,
        negativePrompt: 'blurry',
      })
    )
    expect(body['parameters']).toEqual({ n: 1, size: '2K', prompt_extend: false, watermark: false })
    expect(dashscopeImageBody(job({ width: 1024, height: 768 }))['parameters']).toMatchObject({
      size: '1024*768',
    })
  })
})

describe('dashscopeImageUrls', () => {
  it('collects images from every choice', () => {
    expect(dashscopeImageUrls(answerWith([`${OSS}/a.png`], [`${OSS}/b.png`, `${OSS}/c.png`]))).toEqual([
      `${OSS}/a.png`,
      `${OSS}/b.png`,
      `${OSS}/c.png`,
    ])
    expect(dashscopeImageUrls({ output: { choices: [{ message: { content: [{ text: 'no' }] } }] } })).toEqual(
      []
    )
    expect(dashscopeImageUrls(null)).toEqual([])
  })
})

describe('dashscopeError', () => {
  it.each([
    [
      400,
      { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [
      400,
      {
        code: 'IPInfringementSuspect',
        message: 'Input data is suspected of being involved in IP infringement.',
      },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [
      400,
      { code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' },
      'REMOTE_QUOTA',
    ],
    [400, { code: 'InvalidParameter', message: 'The size is not supported.' }, 'REMOTE_REJECTED'],
    [401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 'REMOTE_AUTH_FAILED'],
    [429, { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded.' }, 'REMOTE_RATE_LIMITED'],
  ])('HTTP %i %j → %s', (status, body, code) => {
    expect(dashscopeError('Qwen', status, body)).toMatchObject({ code })
  })

  it('keeps the code and the words in the details', () => {
    expect(dashscopeError('Qwen', 400, { code: 'InvalidParameter', message: 'Bad size' })).toMatchObject({
      details: 'HTTP 400 InvalidParameter: Bad size',
    })
  })
})

describe('dashscopeImageModels', () => {
  it('reads output.models[] by model, or data[] by id', () => {
    expect(
      dashscopeImageModels({
        request_id: 'r',
        output: {
          total: 2,
          page_no: 1,
          page_size: 100,
          models: [
            { model: 'qwen-image-3.0', name: 'Qwen-Image 3.0', description: 'Text to image' },
            { model: 'wan2.7-image', name: 'wan2.7-image' },
            { model: 'wan2.7-image' },
            { name: 'no id' },
          ],
        },
      })
    ).toEqual([
      { id: 'qwen-image-3.0', name: 'Qwen-Image 3.0', description: 'Text to image' },
      { id: 'wan2.7-image' },
    ])
    expect(dashscopeImageModels({ data: [{ id: 'qwen-image-3.0-pro' }] })).toEqual([
      { id: 'qwen-image-3.0-pro' },
    ])
    expect(dashscopeImageModels(undefined)).toEqual([])
  })
})

describe('DASHSCOPE_IMAGE', () => {
  it('generates on the native origin with the key and downloads every image without it', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: GENERATE,
        answer: jsonResponse(answerWith([`${OSS}/a.png?Expires=1`], [`${OSS}/b.png`])),
      },
      { method: 'GET', url: `${OSS}/a.png?Expires=1`, answer: bytesResponse(PNG_1X1, 'image/png') },
      { method: 'GET', url: `${OSS}/b.png`, answer: bytesResponse(JPEG_STUB, 'image/png') },
    ])
    const phases: unknown[] = []
    const images = await DASHSCOPE_IMAGE.generate(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ workflow: 'reference', images: [png], n: 2 }),
      (p) => phases.push(p)
    )
    expect(images.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg'])
    expect(phases).toEqual([{ phase: 'generating' }])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[1]?.headers.get('authorization')).toBeNull()
    expect(requests[2]?.headers.get('authorization')).toBeNull()
  })

  it('maps a content refusal, also one answered as HTTP 200', async () => {
    const refused = fakeMediaFetch([
      {
        method: 'POST',
        url: GENERATE,
        answer: jsonResponse(
          {
            code: 'DataInspectionFailed',
            message: 'Output data may contain inappropriate content.',
            request_id: 'r',
          },
          400
        ),
      },
    ])
    await expect(
      DASHSCOPE_IMAGE.generate(mediaContext({ fetch: refused.fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_CONTENT_BLOCKED' })
    const inBody = fakeMediaFetch([
      {
        method: 'POST',
        url: GENERATE,
        answer: jsonResponse({
          code: 'DataInspectionFailed',
          message: 'Input data may contain inappropriate content.',
        }),
      },
    ])
    await expect(
      DASHSCOPE_IMAGE.generate(mediaContext({ fetch: inBody.fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_CONTENT_BLOCKED' })
    const empty = fakeMediaFetch([{ method: 'POST', url: GENERATE, answer: jsonResponse(answerWith([])) }])
    await expect(
      DASHSCOPE_IMAGE.generate(mediaContext({ fetch: empty.fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
  })

  it('refuses inpaint and an edit without a source before calling', async () => {
    const { fetch, requests } = fakeMediaFetch([])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(
      DASHSCOPE_IMAGE.generate(ctx, job({ workflow: 'inpaint', images: [png] }), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    })
    await expect(DASHSCOPE_IMAGE.generate(ctx, job({ workflow: 'edit' }), () => {})).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    })
    expect(requests).toHaveLength(0)
  })

  it('lists image models on the native origin, and nothing when the listing is not there', async () => {
    const listing = `${ORIGIN}/api/v1/models?page_no=1&page_size=100&capabilities=IG`
    const found = fakeMediaFetch([
      {
        method: 'GET',
        url: listing,
        answer: jsonResponse({ output: { models: [{ model: 'qwen-image-3.0' }] } }),
      },
    ])
    expect(await DASHSCOPE_IMAGE.listModels?.(mediaContext({ fetch: found.fetch, baseUrl: BASE }))).toEqual([
      { id: 'qwen-image-3.0' },
    ])
    expect(found.requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    const missing = fakeMediaFetch([
      { method: 'GET', url: listing, answer: jsonResponse({ code: 'NotFound' }, 404) },
    ])
    expect(await DASHSCOPE_IMAGE.listModels?.(mediaContext({ fetch: missing.fetch, baseUrl: BASE }))).toEqual(
      []
    )
  })
})
