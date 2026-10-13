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
  OPENAI_VIDEOS,
  openaiVideoError,
  openaiVideoFields,
  openaiVideoModels,
  readOpenaiVideo,
} from './openai-videos.js'
import type { VideoGenerationJob } from './types.js'

const BASE = 'https://api.edenai.run/v3'

function model(overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor {
  return {
    id: 'google/veo-3.1-fast-generate-preview',
    name: 'Veo 3.1 Fast',
    api: 'openai-videos',
    kind: 'video',
    source: 'catalog',
    workflows: ['create', 'image-to-video'],
    params: {
      durations: { values: [4, 6, 8], default: 8 },
      sizes: { values: ['1280x720', '720x1280'], default: '1280x720' },
    },
    ...overrides,
  }
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: model(), prompt: 'a cat surfing', workflow: 'create', ...overrides }
}

describe('openaiVideoFields', () => {
  it('sends what the job set and the model offers, seconds as a number', () => {
    expect(
      openaiVideoFields(job({ durationSecs: 8, size: '1280x720', seed: 7, negativePrompt: 'blur' }))
    ).toEqual({
      model: 'google/veo-3.1-fast-generate-preview',
      prompt: 'a cat surfing',
      seconds: 8,
      size: '1280x720',
    })
  })

  it('sends seed and negative prompt when offered, seconds as a string when the model asks', () => {
    const offered = model({
      params: { durations: { values: [4, 8, 12] }, seed: true, negative_prompt: true },
      options: { seconds_as_string: true },
    })
    expect(
      openaiVideoFields(job({ model: offered, durationSecs: 4, seed: 3, negativePrompt: 'blur' }))
    ).toEqual({
      model: 'google/veo-3.1-fast-generate-preview',
      prompt: 'a cat surfing',
      seconds: '4',
      seed: 3,
      negative_prompt: 'blur',
    })
  })
})

describe('readOpenaiVideo', () => {
  it.each([
    [
      { status: 'queued', progress: 0 },
      { state: 'queued', progress: 0 },
    ],
    [
      { status: 'in_progress', progress: 40 },
      { state: 'running', progress: 0.4 },
    ],
    [{ status: 'in_progress' }, { state: 'running' }],
    [{ status: 'something_new' }, { state: 'running' }],
    [
      { status: 'completed', progress: 100 },
      { state: 'completed', result: {} },
    ],
  ])('maps %j', (answer, expected) => {
    expect(readOpenaiVideo('Eden AI', answer)).toEqual(expected)
  })

  it.each([
    [
      { status: 'failed', error: { code: 'moderation_blocked', message: 'Your request was blocked.' } },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [{ status: 'failed', error: { code: 'invalid_request', message: 'Bad size' } }, 'REMOTE_REJECTED'],
    [{ status: 'failed', error: { code: 'internal_error', message: 'Boom' } }, 'REMOTE_UNAVAILABLE'],
    [{ status: 'cancelled' }, 'REMOTE_UNAVAILABLE'],
    [{ status: 'expired' }, 'REMOTE_UNAVAILABLE'],
  ])('fails %j as %s', (answer, code) => {
    const poll = readOpenaiVideo('Eden AI', answer)
    expect(poll.state).toBe('failed')
    expect(poll.state === 'failed' && poll.error.code).toBe(code)
  })
})

describe('openaiVideoError', () => {
  it('keeps the provider words in the message and details', () => {
    const error = openaiVideoError('Eden AI', 'failed', { code: 'internal_error', message: 'GPU on fire' })
    expect(error.message).toBe('Eden AI failed to make the clip: GPU on fire')
    expect(error.details).toBe('internal_error: GPU on fire')
  })
})

describe('openaiVideoModels', () => {
  it('reads ids of the listing once each', () => {
    expect(
      openaiVideoModels({
        object: 'list',
        data: [{ id: 'openai/sora-2' }, { id: 'openai/sora-2' }, { id: 'x', name: 'X' }, {}],
      })
    ).toEqual([{ id: 'openai/sora-2' }, { id: 'x', name: 'X' }])
  })
})

describe('OPENAI_VIDEOS', () => {
  it('submits a create as JSON with the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/videos`,
        answer: jsonResponse({ id: 'vid_1', status: 'queued', progress: 0 }),
      },
    ])
    const submission = await OPENAI_VIDEOS.submit(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ durationSecs: 6, size: '720x1280' })
    )
    expect(submission).toEqual({ id: 'vid_1' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toEqual({
      model: 'google/veo-3.1-fast-generate-preview',
      prompt: 'a cat surfing',
      seconds: 6,
      size: '720x1280',
    })
  })

  it('submits image to video as multipart with the frame as input_reference', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/videos`, answer: jsonResponse({ id: 'vid_2', status: 'queued' }) },
    ])
    await OPENAI_VIDEOS.submit(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ workflow: 'image-to-video', durationSecs: 8, firstFrame: { bytes: PNG_1X1, mime: 'image/png' } })
    )
    const form = requests[0]?.form
    expect(form?.get('prompt')).toBe('a cat surfing')
    expect(form?.get('seconds')).toBe('8')
    const file = form?.get('input_reference') as Blob
    expect(file.type).toBe('image/png')
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG_1X1)).toBe(true)
  })

  it('submits the frame as a data URL in JSON when the model says so', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/videos`, answer: jsonResponse({ id: 'vid_3', status: 'queued' }) },
    ])
    await OPENAI_VIDEOS.submit(
      mediaContext({ fetch, baseUrl: BASE }),
      job({
        model: model({ options: { input_reference: 'image_url' } }),
        workflow: 'image-to-video',
        firstFrame: { bytes: PNG_1X1, mime: 'image/png' },
      })
    )
    const body = requests[0]?.json as { input_reference: { image_url: string } }
    expect(body.input_reference.image_url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('refuses image to video without a first frame, or with a last frame, before any request', async () => {
    const { fetch, requests } = fakeMediaFetch([])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(OPENAI_VIDEOS.submit(ctx, job({ workflow: 'image-to-video' }))).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    })
    const frame = { bytes: PNG_1X1, mime: 'image/png' }
    await expect(
      OPENAI_VIDEOS.submit(ctx, job({ workflow: 'image-to-video', firstFrame: frame, lastFrame: frame }))
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
    expect(requests).toHaveLength(0)
  })

  it('throws a submit refused by the provider, and an answer without an id', async () => {
    const refused = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/videos`,
        answer: jsonResponse({ error: { message: 'Prompt violates the content policy' } }, 400),
      },
    ])
    await expect(
      OPENAI_VIDEOS.submit(mediaContext({ fetch: refused.fetch, baseUrl: BASE }), job())
    ).rejects.toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
    expect(refused.requests).toHaveLength(1)
    const empty = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/videos`, answer: jsonResponse({ status: 'queued' }) },
    ])
    await expect(
      OPENAI_VIDEOS.submit(mediaContext({ fetch: empty.fetch, baseUrl: BASE }), job())
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('polls the video object', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/videos/vid_1`,
        answer: [
          jsonResponse({ status: 'in_progress', progress: 50 }),
          jsonResponse({ status: 'completed', progress: 100 }),
        ],
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    expect(await OPENAI_VIDEOS.poll(ctx, { id: 'vid_1' })).toEqual({ state: 'running', progress: 0.5 })
    expect(await OPENAI_VIDEOS.poll(ctx, { id: 'vid_1' })).toEqual({ state: 'completed', result: {} })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('downloads the content through a redirect, the key left home', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/videos/vid_1/content`,
        answer: new Response(null, {
          status: 302,
          headers: { location: 'https://storage.example.net/signed.mp4?sig=1' },
        }),
      },
      {
        method: 'GET',
        url: 'https://storage.example.net/signed.mp4?sig=1',
        answer: bytesResponse(MP4_STUB, 'binary/octet-stream'),
      },
    ])
    const clip = await OPENAI_VIDEOS.download(mediaContext({ fetch, baseUrl: BASE }), { id: 'vid_1' }, {})
    expect(clip.mime).toBe('video/mp4')
    expect(clip.bytes.equals(MP4_STUB)).toBe(true)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[1]?.headers.get('authorization')).toBeNull()
  })

  it('refuses content that is not a video', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: `${BASE}/videos/vid_1/content`, answer: bytesResponse(PNG_1X1, 'video/mp4') },
    ])
    await expect(
      OPENAI_VIDEOS.download(mediaContext({ fetch, baseUrl: BASE }), { id: 'vid_1' }, {})
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('cancels with DELETE even after the job signal fired, and ignores a refusal', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'DELETE',
        url: `${BASE}/videos/vid_1`,
        answer: jsonResponse({ error: { message: 'running' } }, 409),
      },
    ])
    const controller = new AbortController()
    controller.abort()
    await expect(
      OPENAI_VIDEOS.cancel?.(mediaContext({ fetch, baseUrl: BASE, signal: controller.signal }), {
        id: 'vid_1',
      })
    ).resolves.toBeUndefined()
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`DELETE ${BASE}/videos/vid_1`])
  })

  it('lists /videos/models, and nothing where the route is missing', async () => {
    const eden = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/videos/models`,
        answer: jsonResponse({ data: [{ id: 'openai/sora-2' }] }),
      },
    ])
    expect(await OPENAI_VIDEOS.listModels?.(mediaContext({ fetch: eden.fetch, baseUrl: BASE }))).toEqual([
      { id: 'openai/sora-2' },
    ])
    const core = fakeMediaFetch([
      {
        method: 'GET',
        url: 'http://127.0.0.1:1337/v1/videos/models',
        answer: jsonResponse({ error: { code: 'not_found' } }, 404),
      },
    ])
    expect(
      await OPENAI_VIDEOS.listModels?.(
        mediaContext({ fetch: core.fetch, baseUrl: 'http://127.0.0.1:1337/v1' })
      )
    ).toEqual([])
  })
})
