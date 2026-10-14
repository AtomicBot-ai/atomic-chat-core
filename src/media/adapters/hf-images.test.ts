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
import type { FalHandle } from './hf-images.js'
import {
  FAL_POLL,
  falCancel,
  falResult,
  falStatus,
  falSubmit,
  falWait,
  HF_IMAGES,
  liveModelsFromHub,
} from './hf-images.js'
import type { ImageGenerationJob, RemoteProgress } from './types.js'

const BASE = 'https://router.huggingface.co/v1'
const ROUTER = 'https://router.huggingface.co'
const QUEUE = `${ROUTER}/fal-ai/fal-ai/flux/requests/req-1`
const CDN = 'https://v3.fal.media/files/cat.jpg'

function model(overrides: Partial<ImageModelDescriptor> = {}): ImageModelDescriptor {
  return {
    id: 'black-forest-labs/FLUX.1-schnell',
    name: 'FLUX.1 schnell',
    api: 'hf-images',
    kind: 'image',
    source: 'catalog',
    workflows: ['create'],
    params: { size: { kind: 'enum', values: ['1024x1024', '1344x768'] }, seed: true },
    options: { hf_provider: 'fal-ai', provider_model: 'fal-ai/flux/schnell' },
    ...overrides,
  }
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return { model: model(), prompt: 'a cat', workflow: 'create', n: 1, images: [], ...overrides }
}

const submitted = {
  request_id: 'req-1',
  status: 'IN_QUEUE',
  status_url: 'https://queue.fal.run/fal-ai/flux/requests/req-1/status',
  response_url: 'https://queue.fal.run/fal-ai/flux/requests/req-1',
}

const handle: FalHandle = {
  requestId: 'req-1',
  providerModel: 'fal-ai/flux/schnell',
  statusUrl: submitted.status_url,
  responseUrl: submitted.response_url,
}

describe('falSubmit', () => {
  it('posts the input to the queue through the router with the HF key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${ROUTER}/fal-ai/fal-ai/flux/schnell?_subdomain=queue`,
        answer: jsonResponse(submitted),
      },
    ])
    const answer = await falSubmit(mediaContext({ fetch, baseUrl: BASE }), 'fal-ai/flux/schnell', {
      prompt: 'a cat',
    })
    expect(answer).toEqual(handle)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toEqual({ prompt: 'a cat' })
  })

  it('refuses a model id that is not one and an answer without a request id', async () => {
    const empty = fakeMediaFetch([{ method: 'POST', url: /\/fal-ai\//, answer: jsonResponse({}) }])
    const ctx = mediaContext({ fetch: empty.fetch, baseUrl: BASE })
    await expect(falSubmit(ctx, '../../evil', {})).rejects.toMatchObject({ code: 'REMOTE_NOT_CONFIGURED' })
    await expect(falSubmit(ctx, 'fal-ai/flux/schnell', {})).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('maps fal content_policy_violation to REMOTE_CONTENT_BLOCKED', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: /\/fal-ai\//,
        answer: jsonResponse({ detail: [{ msg: 'No.', type: 'content_policy_violation' }] }, 422),
      },
    ])
    await expect(
      falSubmit(mediaContext({ fetch, baseUrl: BASE }), 'fal-ai/flux/schnell', {})
    ).rejects.toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
  })
})

describe('falStatus', () => {
  it.each([
    [
      { status: 'IN_QUEUE', queue_position: 3 },
      { state: 'queued', position: 3 },
    ],
    [{ status: 'IN_PROGRESS', logs: [] }, { state: 'running' }],
    [{ status: 'COMPLETED' }, { state: 'completed' }],
    [{ status: 'SOMETHING_NEW' }, { state: 'running' }],
  ])('reads %j', async (body, expected) => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'GET', url: `${QUEUE}/status?_subdomain=queue`, answer: jsonResponse(body) },
    ])
    expect(await falStatus(mediaContext({ fetch, baseUrl: BASE }), handle)).toEqual(expected)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it.each([
    [
      { status: 'COMPLETED', error: 'flagged by a content checker', error_type: 'content_policy_violation' },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [{ status: 'COMPLETED', error: 'too slow', error_type: 'request_timeout' }, 'REMOTE_TIMEOUT'],
    [{ status: 'COMPLETED', error: 'boom', error_type: 'runner_server_error' }, 'REMOTE_UNAVAILABLE'],
    [{ status: 'COMPLETED', error: 'width too large', error_type: 'value_error' }, 'REMOTE_REJECTED'],
    [{}, 'REMOTE_UNAVAILABLE'],
  ])('reports a failure %j as %s', async (body, code) => {
    const { fetch } = fakeMediaFetch([{ method: 'GET', url: /\/status/, answer: jsonResponse(body) }])
    const status = await falStatus(mediaContext({ fetch, baseUrl: BASE }), handle)
    expect(status).toMatchObject({ state: 'failed', error: { code } })
  })

  it('builds the paths from the model id when fal gave no URL, and takes router URLs as they are', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'GET', url: /\/status/, answer: jsonResponse({ status: 'COMPLETED' }) },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await falStatus(ctx, { requestId: 'r 2', providerModel: 'fal-ai/flux/dev' })
    await falStatus(ctx, { requestId: 'r', providerModel: 'workflows/me/app/x' })
    await falStatus(ctx, { requestId: 'r', statusUrl: `${ROUTER}/fal-ai/fal-ai/qwen/requests/r/status` })
    // A URL on another host is not followed; the model id decides.
    await falStatus(ctx, {
      requestId: 'r',
      responseUrl: 'https://evil.example.com/x/requests/r',
      providerModel: 'a/b/c',
    })
    expect(requests.map((r) => r.url)).toEqual([
      `${ROUTER}/fal-ai/fal-ai/flux/requests/r%202/status?_subdomain=queue`,
      `${ROUTER}/fal-ai/workflows/me/app/requests/r/status?_subdomain=queue`,
      `${ROUTER}/fal-ai/fal-ai/qwen/requests/r/status?_subdomain=queue`,
      `${ROUTER}/fal-ai/a/b/requests/r/status?_subdomain=queue`,
    ])
    await expect(falStatus(ctx, { requestId: 'r' })).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
  })
})

describe('falResult', () => {
  it('answers the result JSON and maps a refusal', async () => {
    const ok = fakeMediaFetch([
      { method: 'GET', url: `${QUEUE}?_subdomain=queue`, answer: jsonResponse({ images: [{ url: CDN }] }) },
    ])
    expect(await falResult(mediaContext({ fetch: ok.fetch, baseUrl: BASE }), handle)).toEqual({
      images: [{ url: CDN }],
    })
    const refused = fakeMediaFetch([
      {
        method: 'GET',
        url: `${QUEUE}?_subdomain=queue`,
        answer: jsonResponse({ detail: [{ msg: 'flagged', type: 'content_policy_violation' }] }, 422),
      },
    ])
    await expect(
      falResult(mediaContext({ fetch: refused.fetch, baseUrl: BASE }), handle)
    ).rejects.toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
    const invalid = fakeMediaFetch([
      {
        method: 'GET',
        url: `${QUEUE}?_subdomain=queue`,
        answer: jsonResponse({ detail: [{ msg: 'bad width', type: 'value_error' }] }, 422),
      },
    ])
    await expect(
      falResult(mediaContext({ fetch: invalid.fetch, baseUrl: BASE }), handle)
    ).rejects.toMatchObject({
      code: 'REMOTE_REJECTED',
    })
  })
})

describe('falWait', () => {
  it('polls until completed, reporting queued then generating, then reads the result', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${QUEUE}/status?_subdomain=queue`,
        answer: [
          jsonResponse({ status: 'IN_QUEUE', queue_position: 1 }),
          jsonResponse({ status: 'IN_PROGRESS' }),
          jsonResponse({ status: 'COMPLETED' }),
        ],
      },
      {
        method: 'GET',
        url: `${QUEUE}?_subdomain=queue`,
        answer: jsonResponse({ video: { url: 'https://v3.fal.media/a.mp4' } }),
      },
    ])
    const seen: RemoteProgress[] = []
    const result = await falWait(mediaContext({ fetch, baseUrl: BASE }), handle, (p) => seen.push(p))
    expect(result).toEqual({ video: { url: 'https://v3.fal.media/a.mp4' } })
    expect(seen).toEqual([{ phase: 'queued' }, { phase: 'generating' }])
    expect(requests).toHaveLength(4)
  })

  it('throws the failure and times out past the limit', async () => {
    const failed = fakeMediaFetch([
      {
        method: 'GET',
        url: /\/status/,
        answer: jsonResponse({ status: 'COMPLETED', error: 'x', error_type: 'runner_disconnected' }),
      },
    ])
    await expect(falWait(mediaContext({ fetch: failed.fetch, baseUrl: BASE }), handle)).rejects.toMatchObject(
      {
        code: 'REMOTE_UNAVAILABLE',
      }
    )
    const stuck = fakeMediaFetch([
      { method: 'GET', url: /\/status/, answer: jsonResponse({ status: 'IN_QUEUE' }) },
    ])
    await expect(
      falWait(mediaContext({ fetch: stuck.fetch, baseUrl: BASE }), handle, () => {}, {
        ...FAL_POLL,
        timeoutMs: 10_000,
      })
    ).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' })
  })
})

describe('falCancel', () => {
  it('puts a cancel and takes an already finished request quietly', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'PUT',
        url: `${QUEUE}/cancel?_subdomain=queue`,
        answer: jsonResponse({ status: 'ALREADY_COMPLETED' }, 400),
      },
    ])
    await falCancel(mediaContext({ fetch, baseUrl: BASE }), handle)
    expect(requests[0]?.method).toBe('PUT')
  })
})

describe('liveModelsFromHub', () => {
  it('keeps models a supported provider serves live, preferring fal-ai', () => {
    expect(
      liveModelsFromHub([
        {
          id: 'black-forest-labs/FLUX.1-dev',
          inferenceProviderMapping: [
            { provider: 'replicate', providerId: 'bfl/flux-dev', status: 'live', task: 'text-to-image' },
            {
              provider: 'hf-inference',
              providerId: 'black-forest-labs/FLUX.1-dev',
              status: 'live',
              task: 'text-to-image',
            },
            { provider: 'fal-ai', providerId: 'fal-ai/flux/dev', status: 'live', task: 'text-to-image' },
          ],
        },
        {
          id: 'stabilityai/stable-diffusion-3.5-large',
          inferenceProviderMapping: [
            { provider: 'fal-ai', providerId: 'fal-ai/sd35', status: 'error', task: 'text-to-image' },
          ],
        },
        {
          id: 'old/keyed',
          inferenceProviderMapping: { 'hf-inference': { status: 'live', providerId: 'old/keyed' } },
        },
        { id: 'no/mapping' },
        'junk',
      ])
    ).toEqual([
      {
        id: 'black-forest-labs/FLUX.1-dev',
        options: { hf_provider: 'fal-ai', provider_model: 'fal-ai/flux/dev' },
      },
      { id: 'old/keyed', options: { hf_provider: 'hf-inference', provider_model: 'old/keyed' } },
    ])
  })

  it('answers nothing for something that is not a listing', () => {
    expect(liveModelsFromHub({ error: 'x' })).toEqual([])
  })
})

describe('HF_IMAGES', () => {
  it('creates through fal: submit, poll, result, then the CDN download without the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${ROUTER}/fal-ai/fal-ai/flux/schnell?_subdomain=queue`,
        answer: jsonResponse(submitted),
      },
      {
        method: 'GET',
        url: `${QUEUE}/status?_subdomain=queue`,
        answer: [jsonResponse({ status: 'IN_PROGRESS' }), jsonResponse({ status: 'COMPLETED' })],
      },
      {
        method: 'GET',
        url: `${QUEUE}?_subdomain=queue`,
        answer: jsonResponse({
          images: [{ url: CDN, content_type: 'image/jpeg' }],
          has_nsfw_concepts: [false],
        }),
      },
      { method: 'GET', url: CDN, answer: bytesResponse(JPEG_STUB, 'application/octet-stream') },
    ])
    const seen: RemoteProgress[] = []
    const images = await HF_IMAGES.generate(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ size: '1344x768', seed: 42, n: 2 }),
      (p) => seen.push(p)
    )
    expect(images).toEqual([{ bytes: JPEG_STUB, mime: 'image/jpeg' }])
    expect(requests[0]?.json).toEqual({
      prompt: 'a cat',
      image_size: { width: 1344, height: 768 },
      num_images: 2,
      seed: 42,
    })
    expect(requests.at(-1)?.headers.get('authorization')).toBeNull()
    expect(seen).toEqual([{ phase: 'generating' }, { phase: 'generating' }])
  })

  it('refuses a result whose every image fal flagged', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'POST', url: /\?_subdomain=queue$/, answer: jsonResponse(submitted) },
      {
        method: 'GET',
        url: `${QUEUE}/status?_subdomain=queue`,
        answer: jsonResponse({ status: 'COMPLETED' }),
      },
      {
        method: 'GET',
        url: `${QUEUE}?_subdomain=queue`,
        answer: jsonResponse({ images: [{ url: CDN }], has_nsfw_concepts: [true] }),
      },
    ])
    await expect(
      HF_IMAGES.generate(mediaContext({ fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
  })

  it('cancels the fal request when the job is cancelled', async () => {
    const controller = new AbortController()
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: /\?_subdomain=queue$/, answer: jsonResponse(submitted) },
      {
        method: 'GET',
        url: `${QUEUE}/status?_subdomain=queue`,
        answer: () => {
          controller.abort()
          return jsonResponse({ status: 'IN_QUEUE' })
        },
      },
      {
        method: 'PUT',
        url: `${QUEUE}/cancel?_subdomain=queue`,
        answer: jsonResponse({ status: 'CANCELLATION_REQUESTED' }, 202),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE, signal: controller.signal })
    await expect(HF_IMAGES.generate(ctx, job(), () => {})).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', url: `${QUEUE}/cancel?_subdomain=queue` })
  })

  it('refuses a fal model without a provider model, and other workflows', async () => {
    const { fetch } = fakeMediaFetch([])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(
      HF_IMAGES.generate(ctx, job({ model: model({ options: { hf_provider: 'fal-ai' } }) }), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_NOT_CONFIGURED' })
    await expect(
      HF_IMAGES.generate(
        ctx,
        job({ workflow: 'edit', images: [{ bytes: PNG_1X1, mime: 'image/png' }] }),
        () => {}
      )
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
    await expect(
      HF_IMAGES.generate(ctx, job({ model: model({ options: { hf_provider: 'replicate' } }) }), () => {})
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
  })

  it('creates through hf-inference, one call per image, reading the bytes', async () => {
    const url = `${ROUTER}/hf-inference/models/stabilityai/sdxl`
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url, answer: bytesResponse(PNG_1X1, 'image/png') },
    ])
    const seen: RemoteProgress[] = []
    const images = await HF_IMAGES.generate(
      mediaContext({ fetch, baseUrl: BASE }),
      job({
        model: model({ id: 'stabilityai/sdxl', options: { hf_provider: 'hf-inference' } }),
        n: 2,
        width: 768,
        height: 512,
        steps: 20,
        cfgScale: 6,
        negativePrompt: 'blur',
        seed: 5,
      }),
      (p) => seen.push(p)
    )
    expect(images.map((i) => i.mime)).toEqual(['image/png', 'image/png'])
    expect(requests.map((r) => r.json)).toEqual([
      {
        inputs: 'a cat',
        parameters: {
          width: 768,
          height: 512,
          num_inference_steps: 20,
          guidance_scale: 6,
          negative_prompt: 'blur',
          seed: 5,
        },
      },
      {
        inputs: 'a cat',
        parameters: {
          width: 768,
          height: 512,
          num_inference_steps: 20,
          guidance_scale: 6,
          negative_prompt: 'blur',
          seed: 6,
        },
      },
    ])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(seen.at(-1)).toEqual({ phase: 'generating', fraction: 1 })
  })

  it('transforms through hf-inference with the source as inputs, and takes a JSON answer', async () => {
    const url = `${ROUTER}/hf-inference/models/m/i2i`
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url, answer: jsonResponse({ data: [{ b64_json: PNG_1X1.toString('base64') }] }) },
    ])
    const images = await HF_IMAGES.generate(
      mediaContext({ fetch, baseUrl: BASE }),
      job({
        model: model({ id: 'm/i2i', options: {} }),
        workflow: 'transform',
        size: '512x512',
        images: [{ bytes: PNG_1X1, mime: 'image/png' }],
      }),
      () => {}
    )
    expect(images[0]?.mime).toBe('image/png')
    expect(requests[0]?.json).toEqual({
      inputs: PNG_1X1.toString('base64'),
      parameters: { target_size: { width: 512, height: 512 }, prompt: 'a cat' },
    })
  })

  it('maps an hf-inference error to a REMOTE code with its words', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: /hf-inference/,
        answer: jsonResponse({ error: 'You have exceeded your monthly included credits' }, 402),
      },
    ])
    await expect(
      HF_IMAGES.generate(
        mediaContext({ fetch, baseUrl: BASE }),
        job({ model: model({ options: { hf_provider: 'hf-inference' } }) }),
        () => {}
      )
    ).rejects.toMatchObject({
      code: 'REMOTE_QUOTA',
      details: expect.stringContaining('monthly included credits'),
    })
  })

  it('lists the Hub without the key, only for the real router', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: /^https:\/\/huggingface\.co\/api\/models\?/,
        answer: jsonResponse([
          {
            id: 'Qwen/Qwen-Image',
            inferenceProviderMapping: [
              { provider: 'fal-ai', providerId: 'fal-ai/qwen-image', status: 'live' },
            ],
          },
        ]),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE, customHeaders: [{ header: 'X-Bill-To', value: 'org' }] })
    expect(await HF_IMAGES.listModels?.(ctx)).toEqual([
      { id: 'Qwen/Qwen-Image', options: { hf_provider: 'fal-ai', provider_model: 'fal-ai/qwen-image' } },
    ])
    const url = new URL(requests[0]?.url as string)
    expect(url.searchParams.get('pipeline_tag')).toBe('text-to-image')
    expect(url.searchParams.get('expand[]')).toBe('inferenceProviderMapping')
    expect(requests[0]?.headers.get('authorization')).toBeNull()
    expect(requests[0]?.headers.get('x-bill-to')).toBeNull()

    const other = fakeMediaFetch([])
    expect(
      await HF_IMAGES.listModels?.(
        mediaContext({ fetch: other.fetch, baseUrl: 'https://proxy.example.com/v1' })
      )
    ).toEqual([])
    expect(other.requests).toHaveLength(0)
  })
})
