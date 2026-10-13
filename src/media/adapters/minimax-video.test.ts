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
import { MINIMAX_VIDEO, minimaxCodeError, minimaxStatusError, minimaxV1Body } from './minimax-video.js'
import type { VideoGenerationJob } from './types.js'

const BASE = 'https://api.minimax.io/v1'
const OK = { status_code: 0, status_msg: 'success' }

function model(overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor {
  return {
    id: 'MiniMax-Hailuo-02',
    name: 'Hailuo 02',
    api: 'minimax-video',
    kind: 'video',
    source: 'catalog',
    workflows: ['create', 'image-to-video'],
    params: {
      durations: { values: [6, 10], default: 6 },
      resolutions: { values: ['512P', '768P', '1080P'], default: '768P' },
      last_frame: true,
    },
    ...overrides,
  }
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: model(), prompt: 'a cat surfing', workflow: 'create', ...overrides }
}

const frame = { bytes: PNG_1X1, mime: 'image/png' }

describe('minimaxCodeError', () => {
  it.each([
    [1002, 'REMOTE_RATE_LIMITED'],
    [1039, 'REMOTE_RATE_LIMITED'],
    [1004, 'REMOTE_AUTH_FAILED'],
    [2049, 'REMOTE_AUTH_FAILED'],
    [1008, 'REMOTE_QUOTA'],
    [1026, 'REMOTE_CONTENT_BLOCKED'],
    [1027, 'REMOTE_CONTENT_BLOCKED'],
    [2013, 'REMOTE_REJECTED'],
    [1000, 'REMOTE_UNAVAILABLE'],
    [1013, 'REMOTE_UNAVAILABLE'],
  ])('maps %i to %s', (code, expected) => {
    const error = minimaxCodeError('minimax', code, 'words')
    expect(error.code).toBe(expected)
    expect(error.details).toBe(`status_code ${code}: words`)
  })
})

describe('minimaxStatusError', () => {
  it('reads a non-zero base_resp of an HTTP 200 answer with its words', () => {
    expect(
      minimaxStatusError('minimax', {
        task_id: '',
        base_resp: { status_code: 1026, status_msg: 'sensitive prompt' },
      })
    ).toMatchObject({ code: 'REMOTE_CONTENT_BLOCKED', details: 'status_code 1026: sensitive prompt' })
    expect(minimaxStatusError('minimax', { base_resp: { status_code: '1008' } })).toMatchObject({
      code: 'REMOTE_QUOTA',
    })
  })

  it('is undefined for success or an answer without base_resp', () => {
    expect(minimaxStatusError('minimax', { base_resp: OK })).toBeUndefined()
    expect(minimaxStatusError('minimax', { task_id: '1' })).toBeUndefined()
    expect(minimaxStatusError('minimax', undefined)).toBeUndefined()
  })
})

describe('minimaxV1Body', () => {
  it('sends what the job set and the model offers', () => {
    expect(
      minimaxV1Body(job({ durationSecs: 10, resolution: '512P', seed: 4, aspectRatio: '16:9' }))
    ).toEqual({
      model: 'MiniMax-Hailuo-02',
      prompt: 'a cat surfing',
      prompt_optimizer: true,
      duration: 10,
      resolution: '512P',
    })
  })

  it('leaves out duration and resolution for a model without them', () => {
    expect(minimaxV1Body(job({ model: model({ params: {} }), durationSecs: 6, resolution: '768P' }))).toEqual(
      { model: 'MiniMax-Hailuo-02', prompt: 'a cat surfing', prompt_optimizer: true }
    )
  })

  it('sends the frames as data URLs for image to video', () => {
    const body = minimaxV1Body(job({ workflow: 'image-to-video', firstFrame: frame, lastFrame: frame }))
    expect(body['first_frame_image']).toBe(`data:image/png;base64,${PNG_1X1.toString('base64')}`)
    expect(body['last_frame_image']).toBe(body['first_frame_image'])
  })

  it('ignores frames on create', () => {
    expect(minimaxV1Body(job({ firstFrame: frame }))['first_frame_image']).toBeUndefined()
  })

  it.each([
    ['a workflow the model lacks', job({ model: model({ workflows: ['image-to-video'] }) })],
    ['image to video without a first frame', job({ workflow: 'image-to-video' })],
    [
      'a last frame on a model without one',
      job({ model: model({ params: {} }), workflow: 'image-to-video', firstFrame: frame, lastFrame: frame }),
    ],
  ])('refuses %s', (_name, input) => {
    expect(() => minimaxV1Body(input)).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('MINIMAX_VIDEO', () => {
  it('submits to /video_generation with the key and answers the task id', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/video_generation`,
        answer: jsonResponse({ task_id: '106916112212032', base_resp: OK }),
      },
    ])
    const submission = await MINIMAX_VIDEO.submit(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ durationSecs: 6 })
    )
    expect(submission).toEqual({ id: '106916112212032' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.headers.get('content-type')).toBe('application/json')
    expect(requests[0]?.json).toEqual({
      model: 'MiniMax-Hailuo-02',
      prompt: 'a cat surfing',
      prompt_optimizer: true,
      duration: 6,
    })
  })

  it.each([
    [1002, 'REMOTE_RATE_LIMITED'],
    [1004, 'REMOTE_AUTH_FAILED'],
    [1008, 'REMOTE_QUOTA'],
    [1026, 'REMOTE_CONTENT_BLOCKED'],
    [2013, 'REMOTE_REJECTED'],
    [1000, 'REMOTE_UNAVAILABLE'],
  ])('throws an HTTP 200 answer with status_code %i as %s, once', async (code, expected) => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/video_generation`,
        answer: jsonResponse({ task_id: '', base_resp: { status_code: code, status_msg: 'nope' } }),
      },
    ])
    await expect(MINIMAX_VIDEO.submit(mediaContext({ fetch, baseUrl: BASE }), job())).rejects.toMatchObject({
      code: expected,
    })
    expect(requests).toHaveLength(1)
  })

  it('maps a real HTTP error too', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/video_generation`, answer: jsonResponse({ error: 'bad key' }, 401) },
    ])
    await expect(MINIMAX_VIDEO.submit(mediaContext({ fetch, baseUrl: BASE }), job())).rejects.toMatchObject({
      code: 'REMOTE_AUTH_FAILED',
    })
  })

  it('refuses an answer without a task id', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/video_generation`, answer: jsonResponse({ base_resp: OK }) },
    ])
    await expect(MINIMAX_VIDEO.submit(mediaContext({ fetch, baseUrl: BASE }), job())).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  const QUERY = `${BASE}/query/video_generation?task_id=t-1`

  it.each([
    [{ status: 'Preparing', base_resp: OK }, { state: 'queued' }],
    [{ status: 'Queueing', base_resp: OK }, { state: 'queued' }],
    [{ status: 'Processing', base_resp: OK }, { state: 'running' }],
    [
      { status: 'Success', file_id: '176844028768320', base_resp: OK },
      { state: 'completed', result: { data: { file_id: '176844028768320' } } },
    ],
    [
      { status: 'Success', file_id: 176844028768320, base_resp: OK },
      { state: 'completed', result: { data: { file_id: '176844028768320' } } },
    ],
  ])('polls %j as %j', async (answer, expected) => {
    const { fetch, requests } = fakeMediaFetch([{ method: 'GET', url: QUERY, answer: jsonResponse(answer) }])
    expect(await MINIMAX_VIDEO.poll(mediaContext({ fetch, baseUrl: BASE }), { id: 't-1' })).toEqual(expected)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('reports a failed task with the code base_resp gives, or a generic failure', async () => {
    const blocked = fakeMediaFetch([
      {
        method: 'GET',
        url: QUERY,
        answer: jsonResponse({
          status: 'Fail',
          base_resp: { status_code: 1027, status_msg: 'sensitive video' },
        }),
      },
    ])
    expect(
      await MINIMAX_VIDEO.poll(mediaContext({ fetch: blocked.fetch, baseUrl: BASE }), { id: 't-1' })
    ).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_CONTENT_BLOCKED' },
    })
    const plain = fakeMediaFetch([
      { method: 'GET', url: QUERY, answer: jsonResponse({ status: 'Fail', base_resp: OK }) },
    ])
    expect(
      await MINIMAX_VIDEO.poll(mediaContext({ fetch: plain.fetch, baseUrl: BASE }), { id: 't-1' })
    ).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_UNAVAILABLE' },
    })
  })

  it('ends the job on a content refusal but throws any other query failure', async () => {
    const blocked = fakeMediaFetch([
      {
        method: 'GET',
        url: QUERY,
        answer: jsonResponse({ status: '', base_resp: { status_code: 1026, status_msg: 'x' } }),
      },
    ])
    expect(
      await MINIMAX_VIDEO.poll(mediaContext({ fetch: blocked.fetch, baseUrl: BASE }), { id: 't-1' })
    ).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_CONTENT_BLOCKED' },
    })
    const limited = fakeMediaFetch([
      {
        method: 'GET',
        url: QUERY,
        answer: jsonResponse({ base_resp: { status_code: 1002, status_msg: 'rpm' } }),
      },
    ])
    await expect(
      MINIMAX_VIDEO.poll(mediaContext({ fetch: limited.fetch, baseUrl: BASE }), { id: 't-1' })
    ).rejects.toMatchObject({
      code: 'REMOTE_RATE_LIMITED',
    })
  })

  it('fails a success without a file', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: QUERY, answer: jsonResponse({ status: 'Success', base_resp: OK }) },
    ])
    expect(await MINIMAX_VIDEO.poll(mediaContext({ fetch, baseUrl: BASE }), { id: 't-1' })).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_UNAVAILABLE' },
    })
  })

  const RETRIEVE = `${BASE}/files/retrieve?file_id=176844028768320`
  const CDN = 'https://public-cdn-video.example.com/output_aigc.mp4?Expires=1'

  it('downloads through files/retrieve with the key, then the CDN link without it', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: RETRIEVE,
        answer: jsonResponse({ file: { file_id: 176844028768320, download_url: CDN }, base_resp: OK }),
      },
      { method: 'GET', url: CDN, answer: bytesResponse(MP4_STUB, 'application/octet-stream') },
    ])
    const clip = await MINIMAX_VIDEO.download(
      mediaContext({ fetch, baseUrl: BASE }),
      { id: 't-1' },
      { data: { file_id: '176844028768320' } }
    )
    expect(clip).toEqual({ bytes: MP4_STUB, mime: 'video/mp4' })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[1]?.headers.get('authorization')).toBeNull()
  })

  it('refuses a download that is not a video, and a retrieve error in base_resp', async () => {
    const notVideo = fakeMediaFetch([
      { method: 'GET', url: RETRIEVE, answer: jsonResponse({ file: { download_url: CDN }, base_resp: OK }) },
      { method: 'GET', url: CDN, answer: bytesResponse(PNG_1X1, 'video/mp4') },
    ])
    await expect(
      MINIMAX_VIDEO.download(
        mediaContext({ fetch: notVideo.fetch, baseUrl: BASE }),
        { id: 't-1' },
        { data: { file_id: '176844028768320' } }
      )
    ).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
    const failed = fakeMediaFetch([
      {
        method: 'GET',
        url: RETRIEVE,
        answer: jsonResponse({ base_resp: { status_code: 1004, status_msg: 'auth' } }),
      },
    ])
    await expect(
      MINIMAX_VIDEO.download(
        mediaContext({ fetch: failed.fetch, baseUrl: BASE }),
        { id: 't-1' },
        { data: { file_id: '176844028768320' } }
      )
    ).rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' })
  })

  it('takes a result URL when there is no file id, and refuses a result with neither', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'GET', url: CDN, answer: bytesResponse(MP4_STUB, 'video/mp4') },
    ])
    expect(
      await MINIMAX_VIDEO.download(mediaContext({ fetch, baseUrl: BASE }), { id: 't-1' }, { url: CDN })
    ).toEqual({
      bytes: MP4_STUB,
      mime: 'video/mp4',
    })
    await expect(
      MINIMAX_VIDEO.download(mediaContext({ fetch, baseUrl: BASE }), { id: 't-1' }, {})
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('has no cancel and no listing, and polls every 5 to 15 s', () => {
    expect(MINIMAX_VIDEO.cancel).toBeUndefined()
    expect(MINIMAX_VIDEO.listModels).toBeUndefined()
    expect(MINIMAX_VIDEO.pollIntervalMs).toEqual({ first: 5000, max: 15000 })
  })
})
