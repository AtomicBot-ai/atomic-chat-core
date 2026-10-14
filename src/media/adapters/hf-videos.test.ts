import { describe, expect, it } from 'vitest'
import type { VideoModelDescriptor } from '../../contracts/index.js'
import {
  bytesResponse,
  fakeMediaFetch,
  jsonResponse,
  mediaContext,
  MP4_STUB,
  PNG_1X1,
} from '../../../test/helpers/media-fetch.js'
import {
  falEndpoint,
  falError,
  falRequestPath,
  falVideoInput,
  falVideoModels,
  HF_VIDEO_LISTING_URL,
  HF_VIDEOS,
  hfRouterBase,
} from './hf-videos.js'
import type { VideoGenerationJob } from './types.js'

const BASE = 'https://router.huggingface.co/v1'
const ROUTER = 'https://router.huggingface.co'
const ENDPOINT = 'fal-ai/wan/v2.2-5b/text-to-video'
const REQUEST = '764cabcf-b745-4b3e-ae38-1200304cf45b'
const PATH = `/fal-ai/wan/requests/${REQUEST}`
const STATUS = `${ROUTER}/fal-ai${PATH}/status?_subdomain=queue`
const RESULT = `${ROUTER}/fal-ai${PATH}?_subdomain=queue`
const CDN = 'https://v3.fal.media/files/penguin/out.mp4'

function model(overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor {
  return {
    id: 'Wan-AI/Wan2.2-TI2V-5B',
    name: 'Wan 2.2 TI2V 5B',
    api: 'hf-videos',
    kind: 'video',
    source: 'catalog',
    workflows: ['create'],
    params: { aspect_ratios: { values: ['16:9', '9:16', '1:1'], default: '16:9' } },
    options: { hf_provider: 'fal-ai', provider_model: ENDPOINT },
    ...overrides,
  }
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: model(), prompt: 'a penguin dancing', workflow: 'create', ...overrides }
}

const frame = { bytes: PNG_1X1, mime: 'image/png' }

function ctx(fetchImpl: typeof fetch, baseUrl = BASE) {
  return mediaContext({ fetch: fetchImpl, baseUrl })
}

describe('hfRouterBase', () => {
  it.each([
    ['https://router.huggingface.co/v1', 'https://router.huggingface.co'],
    ['https://router.huggingface.co/v1/', 'https://router.huggingface.co'],
    ['https://hf-proxy.example.com/hf', 'https://hf-proxy.example.com/hf'],
  ])('%s → %s', (base, expected) => {
    expect(hfRouterBase(base)).toBe(expected)
  })
})

describe('falRequestPath', () => {
  it("takes the path of fal's response_url or status_url", () => {
    expect(falRequestPath({ response_url: `https://queue.fal.run${PATH}` }, ENDPOINT, REQUEST)).toBe(PATH)
    expect(falRequestPath({ status_url: `https://queue.fal.run${PATH}/status` }, ENDPOINT, REQUEST)).toBe(
      PATH
    )
  })

  it('drops the prefix of a URL the router already rewrote', () => {
    expect(
      falRequestPath({ response_url: `${ROUTER}/fal-ai${PATH}?_subdomain=queue` }, ENDPOINT, REQUEST)
    ).toBe(PATH)
  })

  it("builds the path from the endpoint's app when the URLs are missing or point elsewhere", () => {
    expect(falRequestPath({}, ENDPOINT, REQUEST)).toBe(PATH)
    expect(
      falRequestPath({ response_url: 'https://queue.fal.run/fal-ai/wan/requests/other' }, ENDPOINT, REQUEST)
    ).toBe(PATH)
    expect(falRequestPath({ response_url: 'not a url' }, ENDPOINT, REQUEST)).toBe(PATH)
  })
})

describe('falError', () => {
  it('reads a content policy type as a content refusal', () => {
    expect(
      falError('huggingface', { error: 'NSFW content detected', error_type: 'content_policy_violation' })
    ).toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
      message: 'huggingface refused the content: NSFW content detected',
    })
    expect(
      falError(
        'huggingface',
        { detail: [{ loc: ['body', 'prompt'], msg: 'flagged', type: 'content_policy_violation' }] },
        422
      )
    ).toMatchObject({ code: 'REMOTE_CONTENT_BLOCKED' })
  })

  it('reads the rest by status, a timeout type, or as unavailable', () => {
    expect(
      falError('huggingface', { detail: [{ msg: 'bad value', type: 'value_error' }] }, 422)
    ).toMatchObject({
      code: 'REMOTE_REJECTED',
    })
    expect(
      falError('huggingface', { error: 'took too long', error_type: 'generation_timeout' })
    ).toMatchObject({
      code: 'REMOTE_TIMEOUT',
    })
    expect(falError('huggingface', { error: 'boom', error_type: 'internal_server_error' })).toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
      details: 'internal_server_error: boom',
    })
  })
})

describe('falEndpoint', () => {
  it("answers the model's fal endpoint", () => {
    expect(falEndpoint(job())).toBe(ENDPOINT)
    expect(falEndpoint(job({ model: model({ options: { provider_model: ENDPOINT } }) }))).toBe(ENDPOINT)
  })

  it.each([
    ['another provider', { hf_provider: 'replicate', provider_model: 'wan-video/wan-2.2-5b-fast' }],
    ['no endpoint', { hf_provider: 'fal-ai' }],
    ['a malformed endpoint', { hf_provider: 'fal-ai', provider_model: '../admin' }],
  ])('refuses %s', (_name, options) => {
    expect(() => falEndpoint(job({ model: model({ options }) }))).toThrow(
      expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' })
    )
  })
})

describe('falVideoInput', () => {
  it('sends what the job set and the model offers', () => {
    expect(
      falVideoInput(
        job({ aspectRatio: '9:16', resolution: '720p', durationSecs: 5, seed: 9, negativePrompt: 'blur' })
      )
    ).toEqual({ prompt: 'a penguin dancing', aspect_ratio: '9:16' })
    expect(
      falVideoInput(
        job({
          model: model({
            params: {
              resolutions: { values: ['580p', '720p'] },
              durations: { values: [5, 8] },
              seed: true,
              negative_prompt: true,
              audio: true,
            },
          }),
          resolution: '720p',
          durationSecs: 5,
          seed: 9,
          negativePrompt: 'blur',
          generateAudio: false,
        })
      )
    ).toEqual({
      prompt: 'a penguin dancing',
      negative_prompt: 'blur',
      resolution: '720p',
      duration: 5,
      generate_audio: false,
      seed: 9,
    })
  })

  it('sends image to video frames as data URLs', () => {
    const input = falVideoInput(
      job({
        model: model({ workflows: ['image-to-video'], params: { last_frame: true } }),
        workflow: 'image-to-video',
        firstFrame: frame,
        lastFrame: frame,
      })
    )
    expect(input['image_url']).toBe(`data:image/png;base64,${PNG_1X1.toString('base64')}`)
    expect(input['end_image_url']).toBe(input['image_url'])
  })

  it.each([
    ['a workflow the model lacks', job({ workflow: 'image-to-video', firstFrame: frame })],
    [
      'image to video without a frame',
      job({ model: model({ workflows: ['image-to-video'] }), workflow: 'image-to-video' }),
    ],
    [
      'a last frame on a model without one',
      job({
        model: model({ workflows: ['image-to-video'] }),
        workflow: 'image-to-video',
        firstFrame: frame,
        lastFrame: frame,
      }),
    ],
  ])('refuses %s', (_name, input) => {
    expect(() => falVideoInput(input)).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('falVideoModels', () => {
  it('keeps live single-model fal-ai mappings', () => {
    expect(
      falVideoModels([
        {
          id: 'tencent/HunyuanVideo',
          inferenceProviderMapping: [
            {
              provider: 'fal-ai',
              providerId: 'fal-ai/hunyuan-video',
              status: 'live',
              task: 'text-to-video',
              type: 'single-model',
            },
            {
              provider: 'wavespeed',
              providerId: 'wavespeed-ai/hunyuan-video/t2v',
              status: 'live',
              task: 'text-to-video',
            },
          ],
        },
        {
          id: 'Wan-AI/Wan2.1-T2V-14B',
          inferenceProviderMapping: [
            { provider: 'fal-ai', providerId: 'fal-ai/wan-t2v', status: 'staging', task: 'text-to-video' },
          ],
        },
        {
          id: 'someone/Lora',
          inferenceProviderMapping: [
            {
              provider: 'fal-ai',
              providerId: 'fal-ai/x/lora',
              status: 'live',
              task: 'text-to-video',
              type: 'tag-filter',
            },
          ],
        },
        {
          id: 'only/wavespeed',
          inferenceProviderMapping: [{ provider: 'wavespeed', providerId: 'w/x', status: 'live' }],
        },
        {
          id: 'old/shape',
          inferenceProviderMapping: {
            'fal-ai': { providerId: 'fal-ai/old', status: 'live', task: 'text-to-video' },
          },
        },
        { id: 'tencent/HunyuanVideo', inferenceProviderMapping: [] },
      ])
    ).toEqual([
      {
        id: 'tencent/HunyuanVideo',
        workflows: ['create'],
        options: { hf_provider: 'fal-ai', provider_model: 'fal-ai/hunyuan-video' },
      },
      {
        id: 'old/shape',
        workflows: ['create'],
        options: { hf_provider: 'fal-ai', provider_model: 'fal-ai/old' },
      },
    ])
    expect(falVideoModels({ error: 'x' })).toEqual([])
  })
})

describe('HF_VIDEOS', () => {
  it("submits to fal's queue through the router with the key, keeping the queue path", async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${ROUTER}/fal-ai/${ENDPOINT}?_subdomain=queue`,
        answer: jsonResponse({
          request_id: REQUEST,
          status: 'IN_QUEUE',
          response_url: `https://queue.fal.run${PATH}`,
          status_url: `https://queue.fal.run${PATH}/status`,
          cancel_url: `https://queue.fal.run${PATH}/cancel`,
        }),
      },
    ])
    const submission = await HF_VIDEOS.submit(ctx(fetch), job({ aspectRatio: '16:9' }))
    expect(submission).toEqual({ id: REQUEST, data: { path: PATH } })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toEqual({ prompt: 'a penguin dancing', aspect_ratio: '16:9' })
  })

  it('throws a refused submit once, and an answer without a request id', async () => {
    const refused = fakeMediaFetch([
      {
        method: 'POST',
        url: /\/fal-ai\//,
        answer: jsonResponse({ error: 'You have exceeded your monthly included credits' }, 402),
      },
    ])
    await expect(HF_VIDEOS.submit(ctx(refused.fetch), job())).rejects.toMatchObject({ code: 'REMOTE_QUOTA' })
    expect(refused.requests).toHaveLength(1)
    const bare = fakeMediaFetch([
      { method: 'POST', url: /\/fal-ai\//, answer: jsonResponse({ status: 'IN_QUEUE' }) },
    ])
    await expect(HF_VIDEOS.submit(ctx(bare.fetch), job())).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  const submission = { id: REQUEST, data: { path: PATH } }

  it.each([
    [{ status: 'IN_QUEUE', queue_position: 2 }, { state: 'queued' }],
    [{ status: 'IN_PROGRESS', logs: [] }, { state: 'running' }],
  ])('polls %j as %j', async (answer, expected) => {
    const { fetch, requests } = fakeMediaFetch([{ method: 'GET', url: STATUS, answer: jsonResponse(answer) }])
    expect(await HF_VIDEOS.poll(ctx(fetch), submission)).toEqual(expected)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('fetches the result through the router once completed', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: STATUS,
        answer: jsonResponse({ status: 'COMPLETED', response_url: `https://queue.fal.run${PATH}` }),
      },
      {
        method: 'GET',
        url: RESULT,
        answer: jsonResponse({ video: { url: CDN, content_type: 'video/mp4' }, seed: 1 }),
      },
    ])
    expect(await HF_VIDEOS.poll(ctx(fetch), submission)).toEqual({ state: 'completed', result: { url: CDN } })
    expect(requests.map((r) => r.url)).toEqual([STATUS, RESULT])
    expect(requests.every((r) => r.url.startsWith(ROUTER))).toBe(true)
  })

  it('fails a completed request that carries an error, without fetching its result', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: STATUS,
        answer: jsonResponse({
          status: 'COMPLETED',
          error: 'NSFW content detected',
          error_type: 'content_policy_violation',
        }),
      },
    ])
    expect(await HF_VIDEOS.poll(ctx(fetch), submission)).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_CONTENT_BLOCKED' },
    })
    expect(requests).toHaveLength(1)
  })

  it('fails a result that is refused or has no video, and throws one that is unavailable', async () => {
    const refused = fakeMediaFetch([
      { method: 'GET', url: STATUS, answer: jsonResponse({ status: 'COMPLETED' }) },
      {
        method: 'GET',
        url: RESULT,
        answer: jsonResponse({ detail: [{ msg: 'flagged', type: 'content_policy_violation' }] }, 422),
      },
    ])
    expect(await HF_VIDEOS.poll(ctx(refused.fetch), submission)).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_CONTENT_BLOCKED' },
    })
    const empty = fakeMediaFetch([
      { method: 'GET', url: STATUS, answer: jsonResponse({ status: 'COMPLETED' }) },
      { method: 'GET', url: RESULT, answer: jsonResponse({ images: [] }) },
    ])
    expect(await HF_VIDEOS.poll(ctx(empty.fetch), submission)).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_UNAVAILABLE' },
    })
    const down = fakeMediaFetch([
      { method: 'GET', url: STATUS, answer: jsonResponse({ status: 'COMPLETED' }) },
      { method: 'GET', url: RESULT, answer: jsonResponse({ error: 'bad gateway' }, 502) },
    ])
    await expect(HF_VIDEOS.poll(ctx(down.fetch), submission)).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it.each([
    ['no path', { id: REQUEST }],
    ['a path off the queue', { id: REQUEST, data: { path: '/api/whoami' } }],
    ['a dot segment', { id: REQUEST, data: { path: `/fal-ai/../requests/${REQUEST}` } }],
  ])('refuses to poll a submission with %s', async (_name, broken) => {
    const { fetch, requests } = fakeMediaFetch([])
    await expect(HF_VIDEOS.poll(ctx(fetch), broken)).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
    expect(requests).toHaveLength(0)
  })

  it("downloads the clip from fal's CDN without the key", async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'GET', url: CDN, answer: bytesResponse(MP4_STUB, 'video/mp4') },
    ])
    expect(await HF_VIDEOS.download(ctx(fetch), submission, { url: CDN })).toEqual({
      bytes: MP4_STUB,
      mime: 'video/mp4',
    })
    expect(requests[0]?.headers.get('authorization')).toBeNull()
    const bad = fakeMediaFetch([{ method: 'GET', url: CDN, answer: bytesResponse(PNG_1X1, 'video/mp4') }])
    await expect(HF_VIDEOS.download(ctx(bad.fetch), submission, { url: CDN })).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
    await expect(HF_VIDEOS.download(ctx(bad.fetch), submission, {})).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('lists the public Hub without the key or custom headers', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: HF_VIDEO_LISTING_URL,
        answer: jsonResponse([
          {
            id: 'genmo/mochi-1-preview',
            inferenceProviderMapping: [
              { provider: 'fal-ai', providerId: 'fal-ai/mochi-v1', status: 'live', task: 'text-to-video' },
            ],
          },
        ]),
      },
    ])
    const models = await HF_VIDEOS.listModels?.(
      mediaContext({ fetch, baseUrl: BASE, customHeaders: [{ header: 'X-Secret', value: 's' }] })
    )
    expect(models).toEqual([
      {
        id: 'genmo/mochi-1-preview',
        workflows: ['create'],
        options: { hf_provider: 'fal-ai', provider_model: 'fal-ai/mochi-v1' },
      },
    ])
    expect(requests[0]?.headers.get('authorization')).toBeNull()
    expect(requests[0]?.headers.get('x-secret')).toBeNull()
  })

  it('lists nothing for a base off the router, and throws a failed listing', async () => {
    const off = fakeMediaFetch([])
    expect(await HF_VIDEOS.listModels?.(ctx(off.fetch, 'https://hf-proxy.example.com/v1'))).toEqual([])
    expect(off.requests).toHaveLength(0)
    const failed = fakeMediaFetch([
      { method: 'GET', url: HF_VIDEO_LISTING_URL, answer: jsonResponse({ error: 'down' }, 503) },
    ])
    await expect(HF_VIDEOS.listModels?.(ctx(failed.fetch))).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('has no cancel', () => {
    expect(HF_VIDEOS.cancel).toBeUndefined()
    expect(HF_VIDEOS.pollIntervalMs).toEqual({ first: 5000, max: 15000 })
  })
})
