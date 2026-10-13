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
  OPENROUTER_VIDEOS,
  openrouterVideoBody,
  openrouterVideoModels,
  openrouterVideoParams,
  ownPollingUrl,
  readOpenrouterVideo,
} from './openrouter-videos.js'
import type { VideoGenerationJob } from './types.js'

const BASE = 'https://openrouter.ai/api/v1'

// Entries of OpenRouter's live `GET /api/v1/videos/models` (2026-10), trimmed to what the adapter reads.
const VEO_LITE = {
  id: 'google/veo-3.1-lite',
  name: 'Google: Veo 3.1 Lite',
  supported_resolutions: ['720p', '1080p'],
  supported_aspect_ratios: ['16:9', '9:16'],
  supported_sizes: ['1280x720', '720x1280', '1920x1080', '1080x1920'],
  supported_durations: [8, 4, 6],
  supported_frame_images: ['first_frame', 'last_frame'],
  generate_audio: true,
  seed: true,
}
const GROK = {
  id: 'x-ai/grok-imagine-video-1.5',
  name: 'SpaceXAI: Grok Imagine Video 1.5',
  supported_resolutions: ['480p', '720p', '1080p'],
  supported_aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
  supported_sizes: null,
  supported_durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  supported_frame_images: ['first_frame'],
  generate_audio: null,
  seed: null,
}
const HAILUO = {
  id: 'minimax/hailuo-3',
  name: 'MiniMax: H3',
  supported_resolutions: ['2K'],
  supported_aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  supported_sizes: null,
  supported_durations: [5, 6, 7, 10],
  supported_frame_images: ['first_frame', 'last_frame'],
  generate_audio: true,
  seed: false,
}
const ALEPH = {
  id: 'runway/aleph-2',
  name: 'Runway: Aleph 2.0',
  supported_resolutions: null,
  supported_aspect_ratios: ['16:9', '4:3'],
  supported_sizes: null,
  supported_durations: null,
  supported_frame_images: null,
  generate_audio: false,
  seed: true,
}

function model(overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor {
  return {
    id: 'google/veo-3.1-fast',
    name: 'Veo 3.1 Fast',
    api: 'openrouter-videos',
    kind: 'video',
    source: 'catalog',
    workflows: ['create', 'image-to-video'],
    params: {
      durations: { values: [4, 6, 8], default: 8 },
      resolutions: { values: ['720p', '1080p', '4K'], default: '720p' },
      aspect_ratios: { values: ['16:9', '9:16'], default: '16:9' },
      audio: true,
      seed: true,
      last_frame: true,
    },
    ...overrides,
  }
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: model(), prompt: 'a lighthouse in a storm', workflow: 'create', ...overrides }
}

const frame = { bytes: PNG_1X1, mime: 'image/png' }

describe('openrouterVideoBody', () => {
  it('sends what the job set and the model offers', () => {
    expect(
      openrouterVideoBody(
        job({
          durationSecs: 6,
          resolution: '1080p',
          aspectRatio: '9:16',
          generateAudio: false,
          seed: 42,
          size: '1280x720',
        })
      )
    ).toEqual({
      model: 'google/veo-3.1-fast',
      prompt: 'a lighthouse in a storm',
      duration: 6,
      resolution: '1080p',
      aspect_ratio: '9:16',
      generate_audio: false,
      seed: 42,
    })
  })

  it('leaves out what the model does not offer', () => {
    expect(
      openrouterVideoBody(
        job({ model: model({ params: {} }), durationSecs: 6, seed: 1, generateAudio: true })
      )
    ).toEqual({
      model: 'google/veo-3.1-fast',
      prompt: 'a lighthouse in a storm',
    })
  })

  it('sends the first and last frames as data URLs', () => {
    const body = openrouterVideoBody(job({ workflow: 'image-to-video', firstFrame: frame, lastFrame: frame }))
    const frames = body['frame_images'] as Array<{
      type: string
      image_url: { url: string }
      frame_type: string
    }>
    expect(frames.map((f) => [f.type, f.frame_type])).toEqual([
      ['image_url', 'first_frame'],
      ['image_url', 'last_frame'],
    ])
    expect(frames[0]?.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('refuses image to video without a first frame, and a last frame the model does not take', () => {
    expect(() => openrouterVideoBody(job({ workflow: 'image-to-video' }))).toThrow(
      expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' })
    )
    const firstOnly = model({ params: { durations: { values: [8] } } })
    expect(() =>
      openrouterVideoBody(
        job({ model: firstOnly, workflow: 'image-to-video', firstFrame: frame, lastFrame: frame })
      )
    ).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('ownPollingUrl', () => {
  it.each([
    ['/api/v1/videos/job-1', 'https://openrouter.ai/api/v1/videos/job-1'],
    ['https://openrouter.ai/api/v1/videos/job-1', 'https://openrouter.ai/api/v1/videos/job-1'],
    ['https://evil.example.com/api/v1/videos/job-1', undefined],
    ['', undefined],
    [42, undefined],
  ])('%j → %j', (value, expected) => {
    expect(ownPollingUrl(BASE, value)).toBe(expected)
  })
})

describe('readOpenrouterVideo', () => {
  it.each([
    [{ status: 'pending' }, { state: 'queued' }],
    [{ status: 'in_progress' }, { state: 'running' }],
    [
      { status: 'in_progress', progress: 25 },
      { state: 'running', progress: 0.25 },
    ],
    [
      { status: 'completed', unsigned_urls: ['https://openrouter.ai/api/v1/videos/job-1/content?index=0'] },
      { state: 'completed', result: { url: 'https://openrouter.ai/api/v1/videos/job-1/content?index=0' } },
    ],
    [{ status: 'completed' }, { state: 'completed', result: {} }],
  ])('maps %j', (answer, expected) => {
    expect(readOpenrouterVideo('OpenRouter', answer)).toEqual(expected)
  })

  it.each([
    [
      { status: 'failed', error: 'The prompt was flagged by the provider moderation.' },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [
      { status: 'failed', error: { message: 'Provider returned error', code: 'upstream_error' } },
      'REMOTE_UNAVAILABLE',
    ],
    [{ status: 'cancelled' }, 'REMOTE_UNAVAILABLE'],
    [{ status: 'expired' }, 'REMOTE_UNAVAILABLE'],
  ])('fails %j as %s', (answer, code) => {
    const poll = readOpenrouterVideo('OpenRouter', answer)
    expect(poll.state === 'failed' && poll.error.code).toBe(code)
  })
})

describe('openrouterVideoParams', () => {
  it('translates a listing entry like conf does', () => {
    expect(openrouterVideoParams(VEO_LITE)).toEqual({
      workflows: ['create', 'image-to-video'],
      params: {
        durations: { values: [4, 6, 8], default: 8 },
        resolutions: { values: ['720p', '1080p'], default: '720p' },
        aspect_ratios: { values: ['16:9', '9:16'], default: '16:9' },
        audio: true,
        seed: true,
        last_frame: true,
      },
    })
    expect(openrouterVideoParams(HAILUO)).toEqual({
      workflows: ['create', 'image-to-video'],
      params: {
        durations: { values: [5, 6, 7, 10], default: 5 },
        resolutions: { values: ['2K'], default: '2K' },
        aspect_ratios: { values: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: '16:9' },
        audio: true,
        last_frame: true,
      },
    })
  })
})

describe('openrouterVideoModels', () => {
  it('names models without the vendor and drops those without durations', () => {
    const models = openrouterVideoModels({ data: [GROK, ALEPH, GROK, VEO_LITE] })
    expect(models.map((m) => [m.id, m.name, m.workflows])).toEqual([
      ['x-ai/grok-imagine-video-1.5', 'Grok Imagine Video 1.5', ['create', 'image-to-video']],
      ['google/veo-3.1-lite', 'Veo 3.1 Lite', ['create', 'image-to-video']],
    ])
    expect(models[0]?.params).toEqual({
      durations: { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], default: 8 },
      resolutions: { values: ['480p', '720p', '1080p'], default: '720p' },
      aspect_ratios: { values: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'], default: '16:9' },
    })
  })
})

describe('OPENROUTER_VIDEOS', () => {
  it('submits with the key and keeps an own-origin polling_url', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/videos`,
        answer: jsonResponse({ id: 'job-1', polling_url: '/api/v1/videos/job-1', status: 'pending' }, 202),
      },
    ])
    const submission = await OPENROUTER_VIDEOS.submit(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ durationSecs: 8 })
    )
    expect(submission).toEqual({ id: 'job-1', data: { polling_url: `${BASE}/videos/job-1` } })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toEqual({
      model: 'google/veo-3.1-fast',
      prompt: 'a lighthouse in a storm',
      duration: 8,
    })
  })

  it('drops a polling_url off its origin', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/videos`,
        answer: jsonResponse(
          { id: 'job-2', polling_url: 'https://evil.example.com/poll', status: 'pending' },
          202
        ),
      },
    ])
    expect(await OPENROUTER_VIDEOS.submit(mediaContext({ fetch, baseUrl: BASE }), job())).toEqual({
      id: 'job-2',
    })
  })

  it('polls the polling_url, else the job route', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/videos/job-1`,
        answer: jsonResponse({ id: 'job-1', status: 'in_progress' }),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    expect(
      await OPENROUTER_VIDEOS.poll(ctx, { id: 'job-1', data: { polling_url: `${BASE}/videos/job-1` } })
    ).toEqual({
      state: 'running',
    })
    expect(
      await OPENROUTER_VIDEOS.poll(ctx, {
        id: 'job-1',
        data: { polling_url: 'https://evil.example.com/poll' },
      })
    ).toEqual({ state: 'running' })
    expect(requests.map((r) => r.url)).toEqual([`${BASE}/videos/job-1`, `${BASE}/videos/job-1`])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('downloads the unsigned URL with the key on its own origin, else the content route', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${BASE}/videos/job-1/content?index=0`,
        answer: bytesResponse(MP4_STUB, 'video/mp4'),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    const clip = await OPENROUTER_VIDEOS.download(
      ctx,
      { id: 'job-1' },
      { url: `${BASE}/videos/job-1/content?index=0` }
    )
    expect(clip.mime).toBe('video/mp4')
    await OPENROUTER_VIDEOS.download(ctx, { id: 'job-1' }, {})
    expect(requests.map((r) => r.url)).toEqual([
      `${BASE}/videos/job-1/content?index=0`,
      `${BASE}/videos/job-1/content?index=0`,
    ])
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('downloads an unsigned URL off its origin bare', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: 'https://cdn.example.net/clip.mp4',
        answer: bytesResponse(MP4_STUB, 'video/mp4'),
      },
    ])
    await OPENROUTER_VIDEOS.download(
      mediaContext({ fetch, baseUrl: BASE }),
      { id: 'job-1' },
      { url: 'https://cdn.example.net/clip.mp4' }
    )
    expect(requests[0]?.headers.get('authorization')).toBeNull()
  })

  it('refuses a download that is not a video', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: `${BASE}/videos/job-1/content?index=0`, answer: jsonResponse({ status: 'ok' }) },
    ])
    await expect(
      OPENROUTER_VIDEOS.download(mediaContext({ fetch, baseUrl: BASE }), { id: 'job-1' }, {})
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('lists /videos/models translated', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: `${BASE}/videos/models`, answer: jsonResponse({ data: [VEO_LITE, ALEPH] }) },
    ])
    const models = await OPENROUTER_VIDEOS.listModels?.(mediaContext({ fetch, baseUrl: BASE }))
    expect(models?.map((m) => m.id)).toEqual(['google/veo-3.1-lite'])
  })
})
