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
  MINIMAX_VIDEO_V2,
  minimaxTaskError,
  minimaxV2Base,
  minimaxV2Body,
  minimaxV2HttpError,
} from './minimax-video-v2.js'
import type { VideoGenerationJob } from './types.js'

const BASE = 'https://api.minimax.io/v1'
const V2 = 'https://api.minimax.io/v2'
const CDN = 'https://video-cdn.minimax.example.com/out.mp4?sig=1'

function model(overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor {
  return {
    id: 'MiniMax-H3',
    name: 'MiniMax H3',
    api: 'minimax-video-v2',
    kind: 'video',
    source: 'catalog',
    workflows: ['create', 'image-to-video'],
    params: {
      durations: { min: 4, max: 15, default: 6 },
      resolutions: { values: ['768P', '2K'], default: '768P' },
      aspect_ratios: { values: ['16:9', '9:16', '1:1'], default: '16:9' },
      last_frame: true,
    },
    ...overrides,
  }
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: model(), prompt: 'a boy playing basketball by the sea', workflow: 'create', ...overrides }
}

const frame = { bytes: PNG_1X1, mime: 'image/png' }
const dataUrl = `data:image/png;base64,${PNG_1X1.toString('base64')}`

function ctx(fetchImpl: typeof fetch) {
  return mediaContext({ fetch: fetchImpl, baseUrl: BASE })
}

describe('minimaxV2Base', () => {
  it.each([
    ['https://api.minimax.io/v1', 'https://api.minimax.io/v2'],
    ['https://api.minimaxi.com/v1/', 'https://api.minimaxi.com/v2'],
    ['https://api.minimax.io/v2', 'https://api.minimax.io/v2'],
    ['https://proxy.example.com/minimax', 'https://proxy.example.com/minimax/v2'],
  ])('%s → %s', (base, expected) => {
    expect(minimaxV2Base(base)).toBe(expected)
  })
})

describe('minimaxV2HttpError', () => {
  it('reads 422 and a 1026 message as a content refusal, the rest as any HTTP error', () => {
    const body = (message: string) => ({ type: 'error', error: { type: 'x', message, http_code: '400' } })
    expect(minimaxV2HttpError('minimax', 422, body('input sensitive'))).toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
    expect(minimaxV2HttpError('minimax', 400, body('prompt sensitive (1026)'))).toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
    expect(minimaxV2HttpError('minimax', 400, body('invalid params (2013)'))).toMatchObject({
      code: 'REMOTE_REJECTED',
      message: 'minimax: invalid params (2013)',
    })
    expect(minimaxV2HttpError('minimax', 402, body('no balance'))).toMatchObject({ code: 'REMOTE_QUOTA' })
  })
})

describe('minimaxTaskError', () => {
  it.each([
    [{ code: '1026', message: 'video description contains sensitive content' }, 'REMOTE_CONTENT_BLOCKED'],
    [{ code: 1008, message: 'balance' }, 'REMOTE_QUOTA'],
    [{ code: 'moderation', message: 'flagged by moderation' }, 'REMOTE_CONTENT_BLOCKED'],
    [{ code: 'internal', message: 'boom' }, 'REMOTE_UNAVAILABLE'],
    [undefined, 'REMOTE_UNAVAILABLE'],
  ])('maps %j to %s', (error, expected) => {
    expect(minimaxTaskError('minimax', error).code).toBe(expected)
  })
})

describe('minimaxV2Body', () => {
  it('sends text to video with the required fields and a concrete ratio', () => {
    expect(minimaxV2Body(job({ resolution: '2K', durationSecs: 5, aspectRatio: '9:16', seed: 3 }))).toEqual({
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: 'a boy playing basketball by the sea' }],
      resolution: '2K',
      duration: 5,
      ratio: '9:16',
    })
  })

  it("fills the required fields from the model's defaults", () => {
    expect(minimaxV2Body(job())).toMatchObject({ resolution: '768P', duration: 6, ratio: '16:9' })
    expect(minimaxV2Body(job({ model: model({ params: {} }) }))).toMatchObject({
      resolution: '768P',
      duration: 6,
      ratio: '16:9',
    })
  })

  it('sends the frames as image_url items with their roles and no ratio', () => {
    const body = minimaxV2Body(
      job({ workflow: 'image-to-video', firstFrame: frame, lastFrame: frame, aspectRatio: '16:9' })
    )
    expect(body['content']).toEqual([
      { type: 'text', text: 'a boy playing basketball by the sea' },
      { type: 'image_url', image_url: { url: dataUrl }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: dataUrl }, role: 'last_frame' },
    ])
    expect(body['ratio']).toBeUndefined()
  })

  it.each([
    ['image to video without a first frame', job({ workflow: 'image-to-video' })],
    ['a workflow the model lacks', job({ model: model({ workflows: ['image-to-video'] }) })],
    [
      'a last frame on a model without one',
      job({ model: model({ params: {} }), workflow: 'image-to-video', firstFrame: frame, lastFrame: frame }),
    ],
  ])('refuses %s', (_name, input) => {
    expect(() => minimaxV2Body(input)).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('MINIMAX_VIDEO_V2', () => {
  it('submits to the V2 base derived from the V1 one, once', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: `${V2}/video_generation`, answer: jsonResponse({ task_id: '424010985738629' }) },
    ])
    expect(await MINIMAX_VIDEO_V2.submit(ctx(fetch), job())).toEqual({ id: '424010985738629' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.json).toMatchObject({
      model: 'MiniMax-H3',
      resolution: '768P',
      duration: 6,
      ratio: '16:9',
    })
  })

  it.each([
    [422, 'REMOTE_CONTENT_BLOCKED'],
    [401, 'REMOTE_AUTH_FAILED'],
    [402, 'REMOTE_QUOTA'],
    [429, 'REMOTE_RATE_LIMITED'],
    [400, 'REMOTE_REJECTED'],
    [500, 'REMOTE_UNAVAILABLE'],
  ])('throws a submit answered %i as %s', async (status, expected) => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${V2}/video_generation`,
        answer: jsonResponse(
          { type: 'error', error: { type: 'x', message: 'nope', http_code: String(status) } },
          status
        ),
      },
    ])
    await expect(MINIMAX_VIDEO_V2.submit(ctx(fetch), job())).rejects.toMatchObject({ code: expected })
    expect(requests).toHaveLength(1)
  })

  const QUERY = `${V2}/query/video_generation/t-1`

  it.each([
    [{ task: { id: 't-1', status: 'queued' } }, { state: 'queued' }],
    [{ task: { id: 't-1', status: 'running' } }, { state: 'running' }],
    [
      { task: { id: 't-1', status: 'succeeded', content: { url: CDN } } },
      { state: 'completed', result: { url: CDN } },
    ],
  ])('polls %j as %j', async (answer, expected) => {
    const { fetch, requests } = fakeMediaFetch([{ method: 'GET', url: QUERY, answer: jsonResponse(answer) }])
    expect(await MINIMAX_VIDEO_V2.poll(ctx(fetch), { id: 't-1' })).toEqual(expected)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it.each([
    [
      { status: 'failed', error: { code: '1026', message: 'video description contains sensitive content' } },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [{ status: 'failed', error: { code: '1000', message: 'unknown' } }, 'REMOTE_UNAVAILABLE'],
    [{ status: 'cancelled' }, 'CANCELLED'],
    [{ status: 'succeeded', content: {} }, 'REMOTE_UNAVAILABLE'],
  ])('reports task %j as failed with %s', async (task, expected) => {
    const { fetch } = fakeMediaFetch([{ method: 'GET', url: QUERY, answer: jsonResponse({ task }) }])
    expect(await MINIMAX_VIDEO_V2.poll(ctx(fetch), { id: 't-1' })).toMatchObject({
      state: 'failed',
      error: { code: expected },
    })
  })

  it('throws a query the provider refuses', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: QUERY, answer: jsonResponse({ error: { message: 'invalid task_id' } }, 400) },
    ])
    await expect(MINIMAX_VIDEO_V2.poll(ctx(fetch), { id: 't-1' })).rejects.toMatchObject({
      code: 'REMOTE_REJECTED',
    })
  })

  it('downloads the clip without the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'GET', url: CDN, answer: bytesResponse(MP4_STUB, 'video/mp4') },
    ])
    expect(await MINIMAX_VIDEO_V2.download(ctx(fetch), { id: 't-1' }, { url: CDN })).toEqual({
      bytes: MP4_STUB,
      mime: 'video/mp4',
    })
    expect(requests[0]?.headers.get('authorization')).toBeNull()
  })

  it('asks the task for a fresh link when the old one expired', async () => {
    const fresh = 'https://video-cdn.minimax.example.com/out.mp4?sig=2'
    const { fetch, requests } = fakeMediaFetch([
      { method: 'GET', url: CDN, answer: new Response('expired', { status: 403 }) },
      {
        method: 'GET',
        url: QUERY,
        answer: jsonResponse({ task: { status: 'succeeded', content: { url: fresh } } }),
      },
      { method: 'GET', url: fresh, answer: bytesResponse(MP4_STUB, 'video/mp4') },
    ])
    expect(await MINIMAX_VIDEO_V2.download(ctx(fetch), { id: 't-1' }, { url: CDN })).toMatchObject({
      mime: 'video/mp4',
    })
    expect(requests.map((r) => r.url)).toEqual([CDN, QUERY, fresh])
  })

  it('refuses a download that is not a video', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: CDN, answer: bytesResponse(PNG_1X1, 'video/mp4') },
    ])
    await expect(MINIMAX_VIDEO_V2.download(ctx(fetch), { id: 't-1' }, { url: CDN })).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('cancels with DELETE and ignores a refusal', async () => {
    const ok = fakeMediaFetch([
      {
        method: 'DELETE',
        url: `${V2}/video_generation/t-1`,
        answer: jsonResponse({ task_id: 't-1', action: 'cancelled', status: 'cancelled' }),
      },
    ])
    await MINIMAX_VIDEO_V2.cancel?.(ctx(ok.fetch), { id: 't-1' })
    expect(ok.requests[0]?.method).toBe('DELETE')
    expect(ok.requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    const refused = fakeMediaFetch([
      {
        method: 'DELETE',
        url: `${V2}/video_generation/t-1`,
        answer: jsonResponse({ error: { message: 'running' } }, 400),
      },
    ])
    await expect(MINIMAX_VIDEO_V2.cancel?.(ctx(refused.fetch), { id: 't-1' })).resolves.toBeUndefined()
  })

  it('has no listing and polls every 5 to 15 s', () => {
    expect(MINIMAX_VIDEO_V2.listModels).toBeUndefined()
    expect(MINIMAX_VIDEO_V2.pollIntervalMs).toEqual({ first: 5000, max: 15000 })
  })
})
