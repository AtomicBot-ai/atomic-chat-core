import { describe, expect, it } from 'vitest'
import type { ImageModelDescriptor } from '../../contracts/index.js'
import {
  fakeMediaFetch,
  JPEG_STUB,
  jsonResponse,
  mediaContext,
  PNG_1X1,
} from '../../../test/helpers/media-fetch.js'
import {
  GEMINI_IMAGE,
  geminiHttpError,
  geminiImageBody,
  geminiImageModels,
  geminiImages,
  geminiNativeBase,
} from './gemini-image.js'
import type { ImageGenerationJob } from './types.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
const NATIVE = 'https://generativelanguage.googleapis.com/v1beta'
const b64 = PNG_1X1.toString('base64')
const png = { bytes: PNG_1X1, mime: 'image/png' }

function model(overrides: Partial<ImageModelDescriptor> = {}): ImageModelDescriptor {
  return {
    id: 'gemini-nano-banana-2.1',
    name: 'Nano Banana 2.1',
    api: 'gemini-image',
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

function answerWith(parts: unknown[], finishReason = 'STOP'): unknown {
  return { candidates: [{ content: { role: 'model', parts }, finishReason }] }
}

describe('geminiNativeBase', () => {
  it.each([
    [BASE, NATIVE],
    [`${BASE}/`, NATIVE],
    [NATIVE, NATIVE],
    ['https://proxy.example.com/google/v1beta/openai', 'https://proxy.example.com/google/v1beta'],
  ])('%s → %s', (base, native) => {
    expect(geminiNativeBase(base)).toBe(native)
  })
})

describe('geminiImageBody', () => {
  it('sends the prompt, then every input inline, and the size in imageConfig', () => {
    expect(
      geminiImageBody(
        job({
          workflow: 'edit',
          images: [png, { bytes: JPEG_STUB, mime: 'image/jpeg' }],
          aspectRatio: '16:9',
          resolution: '2k',
        })
      )
    ).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'a cat' },
            { inline_data: { mime_type: 'image/png', data: b64 } },
            { inline_data: { mime_type: 'image/jpeg', data: JPEG_STUB.toString('base64') } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      },
    })
  })

  it('moves the size to responseFormat.image when the model says so, and leaves it out when unset', () => {
    const flipped = geminiImageBody(
      job({ model: model({ options: { image_config_field: 'responseFormat' } }), resolution: '4K' })
    )
    expect(flipped['generationConfig']).toEqual({
      responseModalities: ['TEXT', 'IMAGE'],
      responseFormat: { image: { imageSize: '4K' } },
    })
    expect(geminiImageBody(job())['generationConfig']).toEqual({ responseModalities: ['TEXT', 'IMAGE'] })
  })
})

describe('geminiImages', () => {
  it('takes the final images in either casing and skips thoughts and text', () => {
    const images = geminiImages(
      'Gemini',
      answerWith([
        { text: 'Here you go' },
        { inlineData: { mimeType: 'image/png', data: JPEG_STUB.toString('base64') }, thought: true },
        { inlineData: { mimeType: 'image/png', data: b64 } },
        { inline_data: { mime_type: 'image/jpeg', data: JPEG_STUB.toString('base64') } },
      ])
    )
    // The mime is what the bytes say, not the answer's word.
    expect(images.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg'])
  })

  it.each([
    [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'REMOTE_CONTENT_BLOCKED'],
    [answerWith([], 'IMAGE_SAFETY'), 'REMOTE_CONTENT_BLOCKED'],
    [answerWith([{ text: 'I cannot draw that.' }], 'IMAGE_PROHIBITED_CONTENT'), 'REMOTE_CONTENT_BLOCKED'],
    [answerWith([], 'NO_IMAGE'), 'REMOTE_REJECTED'],
    [answerWith([{ text: 'Which cat do you mean?' }]), 'REMOTE_REJECTED'],
    [{}, 'REMOTE_REJECTED'],
  ])('maps %j to %s', (json, code) => {
    expect(() => geminiImages('Gemini', json)).toThrow(expect.objectContaining({ code }))
  })

  it('carries the model text as details of a refusal', () => {
    try {
      geminiImages('Gemini', answerWith([{ text: 'Which cat do you mean?' }]))
      expect.unreachable()
    } catch (error) {
      expect((error as { details?: string }).details).toBe('STOP: Which cat do you mean?')
    }
  })
})

describe('geminiHttpError', () => {
  it('turns a 400 for a bad key into REMOTE_AUTH_FAILED and leaves other answers to remoteHttpError', () => {
    const badKey = {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', 'reason': 'API_KEY_INVALID' }],
      },
    }
    expect(geminiHttpError('Gemini', 400, badKey)).toMatchObject({ code: 'REMOTE_AUTH_FAILED' })
    expect(
      geminiHttpError('Gemini', 400, {
        error: { code: 400, message: 'Unsupported aspect ratio', status: 'INVALID_ARGUMENT' },
      })
    ).toMatchObject({ code: 'REMOTE_REJECTED', message: 'Gemini: Unsupported aspect ratio' })
    expect(geminiHttpError('Gemini', 429, { error: { message: 'Quota exceeded' } })).toMatchObject({
      code: 'REMOTE_RATE_LIMITED',
    })
  })
})

describe('geminiImageModels', () => {
  it('keeps image models that answer generateContent, without the models/ prefix', () => {
    expect(
      geminiImageModels({
        models: [
          {
            name: 'models/gemini-3-pro-image',
            displayName: 'Gemini 3 Pro Image',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/gemini-nano-banana-2.1',
            description: 'Fast',
            supportedGenerationMethods: ['generateContent'],
          },
          { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
          { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['countTokens'] },
        ],
      })
    ).toEqual([
      { id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image' },
      { id: 'gemini-nano-banana-2.1', description: 'Fast' },
    ])
    expect(geminiImageModels(undefined)).toEqual([])
  })
})

describe('GEMINI_IMAGE', () => {
  it('generates on the native API with x-goog-api-key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${NATIVE}/models/gemini-nano-banana-2.1:generateContent`,
        answer: jsonResponse(answerWith([{ inlineData: { mimeType: 'image/png', data: b64 } }])),
      },
    ])
    const phases: unknown[] = []
    const images = await GEMINI_IMAGE.generate(mediaContext({ fetch, baseUrl: BASE }), job(), (p) =>
      phases.push(p)
    )
    expect(images).toEqual([{ bytes: PNG_1X1, mime: 'image/png' }])
    expect(phases).toEqual([{ phase: 'generating' }])
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('sk-test')
    expect(requests[0]?.headers.get('authorization')).toBeNull()
  })

  it('makes n images with n calls in a row and reports each', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${NATIVE}/models/gemini-nano-banana-2.1:generateContent`,
        answer: jsonResponse(answerWith([{ inlineData: { mimeType: 'image/png', data: b64 } }])),
      },
    ])
    const phases: unknown[] = []
    const images = await GEMINI_IMAGE.generate(mediaContext({ fetch, baseUrl: BASE }), job({ n: 2 }), (p) =>
      phases.push(p)
    )
    expect(images).toHaveLength(2)
    expect(requests).toHaveLength(2)
    expect(phases).toEqual([
      { phase: 'generating' },
      { phase: 'generating', fraction: 0.5 },
      { phase: 'generating', fraction: 1 },
    ])
  })

  it('maps a bad key and a safety stop, and refuses inpaint before calling', async () => {
    const url = `${NATIVE}/models/gemini-nano-banana-2.1:generateContent`
    const badKey = fakeMediaFetch([
      {
        method: 'POST',
        url,
        answer: jsonResponse(
          { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } },
          400
        ),
      },
    ])
    await expect(
      GEMINI_IMAGE.generate(mediaContext({ fetch: badKey.fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_AUTH_FAILED',
    })
    const unsafe = fakeMediaFetch([
      { method: 'POST', url, answer: jsonResponse(answerWith([], 'IMAGE_SAFETY')) },
    ])
    await expect(
      GEMINI_IMAGE.generate(mediaContext({ fetch: unsafe.fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
    const none = fakeMediaFetch([])
    await expect(
      GEMINI_IMAGE.generate(
        mediaContext({ fetch: none.fetch, baseUrl: BASE }),
        job({ workflow: 'inpaint', images: [png] }),
        () => {}
      )
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
    expect(none.requests).toHaveLength(0)
  })

  it('lists every page of the native /models', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${NATIVE}/models?pageSize=1000`,
        answer: jsonResponse({
          models: [{ name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] }],
          nextPageToken: 'next',
        }),
      },
      {
        method: 'GET',
        url: `${NATIVE}/models?pageSize=1000&pageToken=next`,
        answer: jsonResponse({
          models: [
            { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
          ],
        }),
      },
    ])
    expect(await GEMINI_IMAGE.listModels?.(mediaContext({ fetch, baseUrl: BASE }))).toEqual([
      { id: 'gemini-3-pro-image' },
      { id: 'gemini-3.1-flash-image' },
    ])
    expect(requests.every((r) => r.headers.get('x-goog-api-key') === 'sk-test')).toBe(true)
  })
})
