import { describe, expect, it } from 'vitest'
import type { ImageModelDescriptor } from '../../contracts/index.js'
import {
  fakeMediaFetch,
  JPEG_STUB,
  jsonResponse,
  mediaContext,
  PNG_1X1,
} from '../../../test/helpers/media-fetch.js'
import { NVIDIA_GENAI, nvidiaBody, nvidiaImages, nvidiaInferUrl } from './nvidia-genai.js'
import type { ImageGenerationJob, RemoteProgress } from './types.js'

const BASE = 'https://integrate.api.nvidia.com/v1'
const SCHNELL = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell'
const jpeg = JPEG_STUB.toString('base64')

function model(
  schema: string | undefined,
  overrides: Partial<ImageModelDescriptor> = {}
): ImageModelDescriptor {
  return {
    id: 'black-forest-labs/flux.1-schnell',
    name: 'FLUX.1 schnell',
    api: 'nvidia-genai',
    kind: 'image',
    source: 'catalog',
    workflows: ['create'],
    params: {
      size: { kind: 'enum', values: ['1024x1024'] },
      seed: true,
      steps: { min: 1, max: 4, default: 4 },
    },
    ...(schema ? { options: { schema } } : {}),
    ...overrides,
  }
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return {
    model: model('flux-schnell'),
    prompt: 'a frog',
    workflow: 'create',
    n: 1,
    images: [],
    ...overrides,
  }
}

describe('nvidiaInferUrl', () => {
  it.each([
    [BASE, 'black-forest-labs/flux.1-dev', 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev'],
    [
      'https://integrate.api.nvidia.com/v1/',
      'stabilityai/stable-diffusion-3-medium',
      'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium',
    ],
    ['http://gpu-box:8000/v1', 'black-forest-labs/flux.1-dev', 'http://gpu-box:8000/v1/infer'],
    ['http://gpu-box:8000', 'x', 'http://gpu-box:8000/v1/infer'],
    ['https://proxy.example.com/nim/v1', 'x', 'https://proxy.example.com/nim/v1/infer'],
  ])('%s + %s → %s', (base, id, expected) => {
    expect(nvidiaInferUrl(base, id)).toBe(expected)
  })
})

describe('nvidiaBody', () => {
  it('builds each schema with its fixed fields and defaults', () => {
    expect(nvidiaBody(job({ seed: 7, steps: 2 }))).toEqual({
      prompt: 'a frog',
      width: 1024,
      height: 1024,
      steps: 2,
      seed: 7,
      cfg_scale: 0,
      mode: 'base',
      samples: 1,
    })
    expect(nvidiaBody(job({ model: model('flux-dev', { params: {} }), size: '1024x1024' }))).toEqual({
      prompt: 'a frog',
      mode: 'base',
      cfg_scale: 5,
      width: 1024,
      height: 1024,
      steps: 50,
      seed: 0,
      samples: 1,
    })
    expect(nvidiaBody(job({ model: model('flux2-klein'), seed: 3 }), 1)).toEqual({
      prompt: 'a frog',
      mode: 'Image Generation',
      steps: 4,
      cfg_scale: 0,
      seed: 4,
      width: 1024,
      height: 1024,
    })
    expect(
      nvidiaBody(
        job({
          model: model('sd3', { params: { aspect_ratios: { values: ['1:1', '16:9'], default: '1:1' } } }),
          negativePrompt: 'blur',
          aspectRatio: '16:9',
          cfgScale: 6,
          steps: 30,
          seed: -1,
        })
      )
    ).toEqual({
      prompt: 'a frog',
      negative_prompt: 'blur',
      aspect_ratio: '16:9',
      cfg_scale: 6,
      steps: 30,
      seed: 0,
    })
  })

  it('sends only what the job set for a model without a schema, and wraps the seed', () => {
    expect(nvidiaBody(job({ model: model(undefined, { params: {} }), seed: 2 ** 32 + 5 }))).toEqual({
      prompt: 'a frog',
      seed: 5,
    })
  })
})

describe('nvidiaImages', () => {
  it('reads artifacts and the SD3 shape', () => {
    expect(
      nvidiaImages(
        { provider: 'nvidia' },
        { artifacts: [{ base64: jpeg, finishReason: 'SUCCESS', seed: 1 }] }
      )
    ).toEqual([{ bytes: JPEG_STUB, mime: 'image/jpeg' }])
    expect(
      nvidiaImages(
        { provider: 'nvidia' },
        { image: PNG_1X1.toString('base64'), finish_reason: 'SUCCESS', seed: 1 }
      )[0]?.mime
    ).toBe('image/png')
  })

  it.each([
    [{ artifacts: [{ base64: jpeg, finishReason: 'CONTENT_FILTERED' }] }, 'REMOTE_CONTENT_BLOCKED'],
    [{ image: jpeg, finish_reason: 'CONTENT_FILTERED' }, 'REMOTE_CONTENT_BLOCKED'],
    [{ artifacts: [{ finishReason: 'ERROR' }] }, 'REMOTE_UNAVAILABLE'],
    [{ artifacts: [] }, 'REMOTE_UNAVAILABLE'],
  ])('refuses %j as %s', (json, code) => {
    expect(() => nvidiaImages({ provider: 'nvidia' }, json)).toThrow(expect.objectContaining({ code }))
  })
})

describe('NVIDIA_GENAI', () => {
  it('posts to the genai host with the key, one call per image', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: SCHNELL,
        answer: jsonResponse({ artifacts: [{ base64: jpeg, finishReason: 'SUCCESS', seed: 9 }] }),
      },
    ])
    const seen: RemoteProgress[] = []
    const images = await NVIDIA_GENAI.generate(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ n: 2, seed: 10 }),
      (p) => seen.push(p)
    )
    expect(images).toHaveLength(2)
    expect(requests.map((r) => (r.json as Record<string, unknown>)['seed'])).toEqual([10, 11])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.headers.get('accept')).toBe('application/json')
    expect(seen).toEqual([
      { phase: 'generating' },
      { phase: 'generating', fraction: 0.5 },
      { phase: 'generating', fraction: 1 },
    ])
  })

  it('posts to /v1/infer on a self-hosted NIM', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: 'http://gpu-box:8000/v1/infer',
        answer: jsonResponse({ artifacts: [{ base64: jpeg, finishReason: 'SUCCESS' }] }),
      },
    ])
    await NVIDIA_GENAI.generate(
      mediaContext({ fetch, baseUrl: 'http://gpu-box:8000/v1', apiKey: null }),
      job(),
      () => {}
    )
    expect(requests[0]?.headers.get('authorization')).toBeNull()
  })

  it('maps a 422 validation error and refuses other workflows', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: SCHNELL,
        answer: jsonResponse(
          { detail: [{ loc: ['body', 'steps'], msg: 'Input should be less than or equal to 4', type: 'x' }] },
          422
        ),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(NVIDIA_GENAI.generate(ctx, job({ steps: 9 }), () => {})).rejects.toMatchObject({
      code: 'REMOTE_REJECTED',
      details: expect.stringContaining('less than or equal to 4'),
    })
    await expect(
      NVIDIA_GENAI.generate(
        ctx,
        job({ workflow: 'edit', images: [{ bytes: PNG_1X1, mime: 'image/png' }] }),
        () => {}
      )
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
  })

  it('maps a filtered result to REMOTE_CONTENT_BLOCKED', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: SCHNELL,
        answer: jsonResponse({ artifacts: [{ base64: jpeg, finishReason: 'CONTENT_FILTERED' }] }),
      },
    ])
    await expect(
      NVIDIA_GENAI.generate(mediaContext({ fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
  })

  it('polls a hosted 202 by its request id until the answer', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: SCHNELL, answer: jsonResponse({}, 202, { 'NVCF-REQID': 'abc-1' }) },
      {
        method: 'GET',
        url: 'https://ai.api.nvidia.com/v1/status/abc-1',
        answer: [
          jsonResponse({}, 202),
          jsonResponse({ artifacts: [{ base64: jpeg, finishReason: 'SUCCESS' }] }),
        ],
      },
    ])
    const images = await NVIDIA_GENAI.generate(mediaContext({ fetch, baseUrl: BASE }), job(), () => {})
    expect(images).toHaveLength(1)
    expect(requests.map((r) => r.method)).toEqual(['POST', 'GET', 'GET'])
  })
})
