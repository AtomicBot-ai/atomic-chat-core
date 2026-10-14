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
import type { VideoGenerationJob } from './types.js'
import { readXaiVideo, XAI_VIDEOS, xaiVideoBody, xaiVideoError, xaiVideoModels } from './xai-videos.js'

const BASE = 'https://api.x.ai/v1'

function model(overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor {
  return {
    id: 'grok-imagine-video-1.5',
    name: 'Grok Imagine Video 1.5',
    api: 'xai-videos',
    kind: 'video',
    source: 'catalog',
    workflows: ['create', 'image-to-video'],
    params: {
      durations: { min: 1, max: 15, default: 8 },
      resolutions: { values: ['480p', '720p', '1080p'], default: '720p' },
      aspect_ratios: { values: ['16:9', '9:16'], default: '16:9' },
      audio: true,
      last_frame: true,
    },
    ...overrides,
  }
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: model(), prompt: 'waves crash on rocks', workflow: 'create', ...overrides }
}

const frame = { bytes: PNG_1X1, mime: 'image/png' }

describe('xaiVideoBody', () => {
  it('sends what the job set and the model offers', () => {
    expect(
      xaiVideoBody(
        job({ durationSecs: 12, aspectRatio: '9:16', resolution: '1080p', generateAudio: false, seed: 5 })
      )
    ).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'waves crash on rocks',
      duration: 12,
      aspect_ratio: '9:16',
      resolution: '1080p',
      generate_audio: false,
    })
  })

  it('sends the frames as data URLs', () => {
    const body = xaiVideoBody(job({ workflow: 'image-to-video', firstFrame: frame, lastFrame: frame }))
    expect((body['image'] as { url: string }).url.startsWith('data:image/png;base64,')).toBe(true)
    expect((body['last_frame'] as { url: string }).url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('refuses image to video without a first frame, and a last frame the model does not take', () => {
    expect(() => xaiVideoBody(job({ workflow: 'image-to-video' }))).toThrow(
      expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' })
    )
    const older = model({ id: 'grok-imagine-video', params: { durations: { min: 1, max: 15 } } })
    expect(() =>
      xaiVideoBody(job({ model: older, workflow: 'image-to-video', firstFrame: frame, lastFrame: frame }))
    ).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('xaiVideoError', () => {
  it.each([
    [
      { code: 'invalid_argument', message: 'Prompt cannot be empty. Please provide a prompt.' },
      'REMOTE_REJECTED',
    ],
    [
      { code: 'invalid_argument', message: 'Request rejected by content moderation.' },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [{ code: 'permission_denied', message: 'Team has no access to the model' }, 'REMOTE_AUTH_FAILED'],
    [{ code: 'resource_exhausted', message: 'Too many requests' }, 'REMOTE_RATE_LIMITED'],
    [{ code: 'internal', message: 'Something broke' }, 'REMOTE_UNAVAILABLE'],
    [undefined, 'REMOTE_UNAVAILABLE'],
  ])('%j → %s', (error, code) => {
    expect(xaiVideoError('xAI', error).code).toBe(code)
  })
})

describe('readXaiVideo', () => {
  it.each([
    [{ status: 'pending' }, { state: 'running' }],
    [
      { status: 'pending', progress: 30 },
      { state: 'running', progress: 0.3 },
    ],
    [
      {
        status: 'done',
        video: { url: 'https://vidgen.x.ai/a/video.mp4', duration: 8, respect_moderation: true },
      },
      { state: 'completed', result: { url: 'https://vidgen.x.ai/a/video.mp4' } },
    ],
  ])('maps %j', (answer, expected) => {
    expect(readXaiVideo('xAI', answer)).toEqual(expected)
  })

  it.each([
    [{ status: 'done', video: { url: '', respect_moderation: false } }, 'REMOTE_CONTENT_BLOCKED'],
    [{ status: 'done', video: {} }, 'REMOTE_UNAVAILABLE'],
    [{ status: 'failed', error: { code: 'invalid_argument', message: 'Bad duration' } }, 'REMOTE_REJECTED'],
    [{ status: 'expired' }, 'REMOTE_UNAVAILABLE'],
  ])('fails %j as %s', (answer, code) => {
    const poll = readXaiVideo('xAI', answer)
    expect(poll.state === 'failed' && poll.error.code).toBe(code)
  })
})

describe('xaiVideoModels', () => {
  it('reads the ids of the listing', () => {
    expect(
      xaiVideoModels({
        models: [{ id: 'grok-imagine-video-1.5' }, { id: 'grok-imagine-video-1.5' }, { x: 1 }],
      })
    ).toEqual([{ id: 'grok-imagine-video-1.5' }])
  })
})

describe('XAI_VIDEOS', () => {
  it('submits to /videos/generations with the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/videos/generations`, answer: jsonResponse({ request_id: 'req-1' }) },
    ])
    const submission = await XAI_VIDEOS.submit(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ durationSecs: 8 })
    )
    expect(submission).toEqual({ id: 'req-1' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'waves crash on rocks',
      duration: 8,
    })
  })

  it('throws a submit refused by the provider, and an answer without an id', async () => {
    const refused = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/videos/generations`,
        answer: jsonResponse({ code: 'x', error: 'Incorrect API key' }, 401),
      },
    ])
    await expect(
      XAI_VIDEOS.submit(mediaContext({ fetch: refused.fetch, baseUrl: BASE }), job())
    ).rejects.toMatchObject({
      code: 'REMOTE_AUTH_FAILED',
    })
    const empty = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/videos/generations`, answer: jsonResponse({}) },
    ])
    await expect(
      XAI_VIDEOS.submit(mediaContext({ fetch: empty.fetch, baseUrl: BASE }), job())
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('polls /videos/{request_id}, a 202 being a pending job', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/videos/req-1`,
        answer: [
          jsonResponse({ status: 'pending' }, 202),
          jsonResponse({
            status: 'done',
            video: { url: 'https://vidgen.x.ai/r/video.mp4', respect_moderation: true },
          }),
        ],
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    expect(await XAI_VIDEOS.poll(ctx, { id: 'req-1' })).toEqual({ state: 'running' })
    expect(await XAI_VIDEOS.poll(ctx, { id: 'req-1' })).toEqual({
      state: 'completed',
      result: { url: 'https://vidgen.x.ai/r/video.mp4' },
    })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('downloads the clip URL without the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'GET', url: 'https://vidgen.x.ai/r/video.mp4', answer: bytesResponse(MP4_STUB, 'video/mp4') },
    ])
    const clip = await XAI_VIDEOS.download(
      mediaContext({ fetch, baseUrl: BASE }),
      { id: 'req-1' },
      { url: 'https://vidgen.x.ai/r/video.mp4' }
    )
    expect(clip).toEqual({ bytes: MP4_STUB, mime: 'video/mp4' })
    expect(requests[0]?.headers.get('authorization')).toBeNull()
  })

  it('refuses a download without a URL or of something that is not a video', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: 'https://vidgen.x.ai/r/video.mp4', answer: bytesResponse(PNG_1X1, 'video/mp4') },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(XAI_VIDEOS.download(ctx, { id: 'req-1' }, {})).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
    await expect(
      XAI_VIDEOS.download(ctx, { id: 'req-1' }, { url: 'https://vidgen.x.ai/r/video.mp4' })
    ).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
  })

  it('lists /video-generation-models, and nothing where the route is missing', async () => {
    const listed = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/video-generation-models`,
        answer: jsonResponse({ models: [{ id: 'grok-imagine-video-1.5' }, { id: 'grok-imagine-video' }] }),
      },
    ])
    expect(await XAI_VIDEOS.listModels?.(mediaContext({ fetch: listed.fetch, baseUrl: BASE }))).toEqual([
      { id: 'grok-imagine-video-1.5' },
      { id: 'grok-imagine-video' },
    ])
    const missing = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/video-generation-models`,
        answer: jsonResponse({ error: 'not found' }, 404),
      },
    ])
    expect(await XAI_VIDEOS.listModels?.(mediaContext({ fetch: missing.fetch, baseUrl: BASE }))).toEqual([])
  })
})
