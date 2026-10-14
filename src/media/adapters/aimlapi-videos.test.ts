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
  AIMLAPI_VIDEOS,
  aimlapiVideoBody,
  aimlapiVideoError,
  aimlapiVideoModels,
  aimlapiVideoUrl,
  readAimlapiVideo,
} from './aimlapi-videos.js'
import type { VideoGenerationJob } from './types.js'

const BASE = 'https://api.aimlapi.com/v1'
const VIDEO = 'https://api.aimlapi.com/v2/video/generations'

function model(overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor {
  return {
    id: 'google/veo-3.1-t2v-fast',
    name: 'Veo 3.1 Fast',
    api: 'aimlapi-videos',
    kind: 'video',
    source: 'catalog',
    workflows: ['create'],
    params: {
      durations: { values: [4, 6, 8], default: 8 },
      resolutions: { values: ['720p', '1080p'], default: '720p' },
      aspect_ratios: { values: ['16:9', '9:16'], default: '16:9' },
      audio: true,
    },
    ...overrides,
  }
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: model(), prompt: 'a paper boat on a river', workflow: 'create', ...overrides }
}

const frame = { bytes: PNG_1X1, mime: 'image/png' }

describe('aimlapiVideoUrl', () => {
  it.each([
    [BASE, VIDEO],
    [`${BASE}/`, VIDEO],
    ['https://proxy.example.com/aiml/v1', 'https://proxy.example.com/aiml/v2/video/generations'],
    ['https://api.aimlapi.com', VIDEO],
  ])('%s → %s', (base, url) => {
    expect(aimlapiVideoUrl(base)).toBe(url)
  })
})

describe('aimlapiVideoBody', () => {
  it('sends what the job set and the model offers', () => {
    expect(
      aimlapiVideoBody(
        job({
          durationSecs: 6,
          aspectRatio: '9:16',
          resolution: '1080p',
          generateAudio: false,
          seed: 4,
          negativePrompt: 'x',
        })
      )
    ).toEqual({
      model: 'google/veo-3.1-t2v-fast',
      prompt: 'a paper boat on a river',
      duration: 6,
      aspect_ratio: '9:16',
      resolution: '1080p',
      generate_audio: false,
    })
  })

  it('sends the first frame as image_url, or into the field the model names', () => {
    const i2v = model({ id: 'google/veo-3.1-i2v-fast', workflows: ['image-to-video'] })
    const plain = aimlapiVideoBody(job({ model: i2v, workflow: 'image-to-video', firstFrame: frame }))
    expect(String(plain['image_url']).startsWith('data:image/png;base64,')).toBe(true)
    const named = aimlapiVideoBody(
      job({
        model: model({
          params: { last_frame: true },
          options: { image_field: 'first_frame_image', last_frame_field: 'last_image_url' },
        }),
        workflow: 'image-to-video',
        firstFrame: frame,
        lastFrame: frame,
      })
    )
    expect(Object.keys(named)).toEqual(['model', 'prompt', 'first_frame_image', 'last_image_url'])
  })

  it('refuses image to video without a first frame, and a last frame without a field for it', () => {
    expect(() => aimlapiVideoBody(job({ workflow: 'image-to-video' }))).toThrow(
      expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' })
    )
    expect(() =>
      aimlapiVideoBody(
        job({
          model: model({ params: { last_frame: true } }),
          workflow: 'image-to-video',
          firstFrame: frame,
          lastFrame: frame,
        })
      )
    ).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('aimlapiVideoError', () => {
  it.each([
    [{ name: 'ModerationError', message: 'The prompt was flagged.' }, 'REMOTE_CONTENT_BLOCKED'],
    [{ name: 'ValidationError', message: 'duration must be one of 4, 6, 8' }, 'REMOTE_REJECTED'],
    [{ name: 'ProviderError', message: 'Upstream failed' }, 'REMOTE_UNAVAILABLE'],
    ['Generation failed', 'REMOTE_UNAVAILABLE'],
  ])('%j → %s', (error, code) => {
    expect(aimlapiVideoError('AIMLAPI', error).code).toBe(code)
  })
})

describe('readAimlapiVideo', () => {
  it.each([
    [{ id: 'g1', status: 'queued' }, { state: 'queued' }],
    [{ id: 'g1', status: 'waiting' }, { state: 'queued' }],
    [{ id: 'g1', status: 'generating' }, { state: 'running' }],
    [{ id: 'g1', status: 'active' }, { state: 'running' }],
    [
      { id: 'g1', status: 'completed', video: { url: 'https://cdn.aimlapi.com/v/g1.mp4' } },
      { state: 'completed', result: { url: 'https://cdn.aimlapi.com/v/g1.mp4' } },
    ],
  ])('maps %j', (answer, expected) => {
    expect(readAimlapiVideo('AIMLAPI', answer)).toEqual(expected)
  })

  it.each([
    [{ id: 'g1', status: 'completed', video: null }, 'REMOTE_UNAVAILABLE'],
    [
      { id: 'g1', status: 'error', error: { name: 'Error', message: 'Content policy violation' } },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [
      { id: 'g1', status: 'error', error: { name: 'Error', message: 'Timeout upstream' } },
      'REMOTE_UNAVAILABLE',
    ],
  ])('fails %j as %s', (answer, code) => {
    const poll = readAimlapiVideo('AIMLAPI', answer)
    expect(poll.state === 'failed' && poll.error.code).toBe(code)
  })
})

describe('aimlapiVideoModels', () => {
  it('keeps video models, with the workflow their id names', () => {
    expect(
      aimlapiVideoModels({
        data: [
          { id: 'gpt-5', type: 'openai/chat-completions' },
          {
            id: 'google/veo-3.1-t2v-fast',
            type: 'internal/video-generations/submit',
            info: { name: 'Veo 3.1 Fast' },
          },
          {
            id: 'google/veo-3.1-i2v-fast',
            type: 'internal/video-generations/submit',
            info: { name: 'Veo 3.1 Fast' },
          },
          { id: 'klingai/video-v3-pro-image-to-video', type: 'internal/video-generations/submit' },
          { id: 'alibaba/wan2.6-i2v-flash', type: 'internal/video-generations/submit' },
          { id: 'klingai/video-v3-pro-text-to-video', type: 'internal/video-generations/submit' },
          {
            id: 'minimax/hailuo-2.3',
            type: 'internal/video-generations/submit',
            info: { name: 'Hailuo 2.3' },
          },
          { id: 'veo3.1/extend-video', type: 'internal/video-generations/submit' },
          { id: 'alibaba/wan-2-7-r2v', type: 'internal/video-generations/submit' },
          { id: 'kling-video/o1/video-to-video/edit', type: 'internal/video-generations/submit' },
          { id: 'klingai/avatar-pro', type: 'internal/video-generations/submit' },
          { id: 'minimax/hailuo-2.3', type: 'internal/video-generations/submit' },
        ],
      })
    ).toEqual([
      { id: 'google/veo-3.1-t2v-fast', name: 'Veo 3.1 Fast', workflows: ['create'] },
      { id: 'google/veo-3.1-i2v-fast', name: 'Veo 3.1 Fast', workflows: ['image-to-video'] },
      { id: 'klingai/video-v3-pro-image-to-video', workflows: ['image-to-video'] },
      { id: 'alibaba/wan2.6-i2v-flash', workflows: ['image-to-video'] },
      { id: 'klingai/video-v3-pro-text-to-video', workflows: ['create'] },
      { id: 'minimax/hailuo-2.3', name: 'Hailuo 2.3' },
    ])
  })
})

describe('AIMLAPI_VIDEOS', () => {
  it('submits to /v2/video/generations on the base origin with the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: VIDEO, answer: jsonResponse({ id: 'gen-1', status: 'queued' }) },
    ])
    const submission = await AIMLAPI_VIDEOS.submit(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ durationSecs: 8 })
    )
    expect(submission).toEqual({ id: 'gen-1' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toEqual({
      model: 'google/veo-3.1-t2v-fast',
      prompt: 'a paper boat on a river',
      duration: 8,
    })
  })

  it('throws a submit that failed at once, and an answer without an id', async () => {
    const failed = fakeMediaFetch([
      {
        method: 'POST',
        url: VIDEO,
        answer: jsonResponse({
          id: 'gen-2',
          status: 'error',
          error: { name: 'ValidationError', message: 'Bad ratio' },
        }),
      },
    ])
    await expect(
      AIMLAPI_VIDEOS.submit(mediaContext({ fetch: failed.fetch, baseUrl: BASE }), job())
    ).rejects.toMatchObject({
      code: 'REMOTE_REJECTED',
    })
    const empty = fakeMediaFetch([{ method: 'POST', url: VIDEO, answer: jsonResponse({ status: 'queued' }) }])
    await expect(
      AIMLAPI_VIDEOS.submit(mediaContext({ fetch: empty.fetch, baseUrl: BASE }), job())
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('polls by generation_id', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${VIDEO}?generation_id=gen-1`,
        answer: [
          jsonResponse({ id: 'gen-1', status: 'generating' }),
          jsonResponse({
            id: 'gen-1',
            status: 'completed',
            video: { url: 'https://cdn.aimlapi.com/v/gen-1.mp4' },
          }),
        ],
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    expect(await AIMLAPI_VIDEOS.poll(ctx, { id: 'gen-1' })).toEqual({ state: 'running' })
    expect(await AIMLAPI_VIDEOS.poll(ctx, { id: 'gen-1' })).toEqual({
      state: 'completed',
      result: { url: 'https://cdn.aimlapi.com/v/gen-1.mp4' },
    })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('downloads the clip URL without the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: 'https://cdn.aimlapi.com/v/gen-1.mp4',
        answer: bytesResponse(MP4_STUB, 'video/mp4'),
      },
    ])
    const clip = await AIMLAPI_VIDEOS.download(
      mediaContext({ fetch, baseUrl: BASE }),
      { id: 'gen-1' },
      { url: 'https://cdn.aimlapi.com/v/gen-1.mp4' }
    )
    expect(clip).toEqual({ bytes: MP4_STUB, mime: 'video/mp4' })
    expect(requests[0]?.headers.get('authorization')).toBeNull()
  })

  it('refuses a download without a URL or of something that is not a video', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'GET',
        url: 'https://cdn.aimlapi.com/v/gen-1.mp4',
        answer: bytesResponse(PNG_1X1, 'video/mp4'),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(AIMLAPI_VIDEOS.download(ctx, { id: 'gen-1' }, {})).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
    await expect(
      AIMLAPI_VIDEOS.download(ctx, { id: 'gen-1' }, { url: 'https://cdn.aimlapi.com/v/gen-1.mp4' })
    ).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
  })

  it('lists the video models of /models', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/models`,
        answer: jsonResponse({
          data: [
            { id: 'gpt-5', type: 'openai/chat-completions' },
            {
              id: 'google/veo-3.1-t2v',
              type: 'internal/video-generations/submit',
              info: { name: 'Veo 3.1' },
            },
          ],
        }),
      },
    ])
    expect(await AIMLAPI_VIDEOS.listModels?.(mediaContext({ fetch, baseUrl: BASE }))).toEqual([
      { id: 'google/veo-3.1-t2v', name: 'Veo 3.1', workflows: ['create'] },
    ])
  })
})
