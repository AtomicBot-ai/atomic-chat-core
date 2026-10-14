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
  DASHSCOPE_VIDEO,
  dashscopeCodeKind,
  dashscopeError,
  dashscopeHttpError,
  dashscopeOrigin,
  dashscopeVideoBody,
  dashscopeVideoModels,
} from './dashscope-video.js'
import type { VideoGenerationJob } from './types.js'

const BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
const ORIGIN = 'https://dashscope-intl.aliyuncs.com'
const SUBMIT = `${ORIGIN}/api/v1/services/aigc/video-generation/video-synthesis`
const TASK = `${ORIGIN}/api/v1/tasks/task-1`
const OSS = 'https://dashscope-result-sh.oss-accelerate.aliyuncs.com/1/out.mp4?Expires=1&Signature=x'

const T2V_27: VideoModelDescriptor = {
  id: 'wan2.7-t2v',
  name: 'Wan 2.7 Text to Video',
  api: 'dashscope-video',
  kind: 'video',
  source: 'catalog',
  workflows: ['create'],
  params: {
    durations: { min: 2, max: 15, default: 5 },
    resolutions: { values: ['720P', '1080P'], default: '720P' },
    aspect_ratios: { values: ['16:9', '9:16'], default: '16:9' },
    seed: true,
    negative_prompt: true,
  },
}

const I2V_27: VideoModelDescriptor = {
  ...T2V_27,
  id: 'wan2.7-i2v',
  name: 'Wan 2.7 Image to Video',
  workflows: ['image-to-video'],
  params: {
    durations: { min: 2, max: 15, default: 5 },
    resolutions: { values: ['720P', '1080P'], default: '720P' },
    seed: true,
    negative_prompt: true,
    last_frame: true,
  },
}

const T2V_26: VideoModelDescriptor = {
  ...T2V_27,
  id: 'wan2.6-t2v',
  name: 'Wan 2.6 Text to Video',
  params: {
    durations: { min: 2, max: 15, default: 5 },
    sizes: { values: ['1280x720', '720x1280'], default: '1280x720' },
    seed: true,
  },
}

const I2V_26: VideoModelDescriptor = {
  ...T2V_27,
  id: 'wan2.6-i2v',
  name: 'Wan 2.6 Image to Video',
  workflows: ['image-to-video'],
  params: { durations: { min: 2, max: 15 }, resolutions: { values: ['720P', '1080P'] } },
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: T2V_27, prompt: 'a kitten on the moon', workflow: 'create', ...overrides }
}

const frame = { bytes: PNG_1X1, mime: 'image/png' }
const dataUrl = `data:image/png;base64,${PNG_1X1.toString('base64')}`

function ctx(fetchImpl: typeof fetch) {
  return mediaContext({ fetch: fetchImpl, baseUrl: BASE })
}

describe('dashscopeOrigin', () => {
  it.each([
    [BASE, ORIGIN],
    [
      'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      'https://ws-1.ap-southeast-1.maas.aliyuncs.com',
    ],
  ])('%s → %s', (base, expected) => {
    expect(dashscopeOrigin(base)).toBe(expected)
  })
})

describe('dashscopeCodeKind', () => {
  it.each([
    ['DataInspectionFailed', 'REMOTE_CONTENT_BLOCKED'],
    ['IPInfringementSuspect', 'REMOTE_CONTENT_BLOCKED'],
    ['InvalidParameter.DataInspection', 'REMOTE_CONTENT_BLOCKED'],
    ['Throttling.RateQuota', 'REMOTE_RATE_LIMITED'],
    ['Throttling.AllocationQuota', 'REMOTE_RATE_LIMITED'],
    ['Arrearage', 'REMOTE_QUOTA'],
    ['InvalidApiKey', 'REMOTE_AUTH_FAILED'],
    ['AccessDenied.Unpurchased', 'REMOTE_AUTH_FAILED'],
    ['InvalidParameter', 'REMOTE_REJECTED'],
    ['InternalError', undefined],
    [undefined, undefined],
  ])('%s → %s', (code, expected) => {
    expect(dashscopeCodeKind(code)).toBe(expected)
  })
})

describe('dashscopeError', () => {
  it('names the code and the words, falling back for an unknown code', () => {
    expect(
      dashscopeError(
        'qwen',
        'DataInspectionFailed',
        'Input data may contain inappropriate content.',
        'REMOTE_UNAVAILABLE'
      )
    ).toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
      message: 'qwen: Input data may contain inappropriate content.',
      details: 'DataInspectionFailed: Input data may contain inappropriate content.',
    })
    expect(dashscopeError('qwen', 'InternalError', undefined, 'REMOTE_UNAVAILABLE', 500)).toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
      message: 'qwen failed (InternalError).',
      details: 'HTTP 500: InternalError',
    })
  })
})

describe('dashscopeHttpError', () => {
  it('reads a known code before the status, and the status otherwise', () => {
    expect(dashscopeHttpError('qwen', 400, { code: 'DataInspectionFailed', message: 'x' })).toMatchObject({
      code: 'REMOTE_CONTENT_BLOCKED',
    })
    expect(dashscopeHttpError('qwen', 400, { code: 'Arrearage', message: 'overdue' })).toMatchObject({
      code: 'REMOTE_QUOTA',
    })
    expect(dashscopeHttpError('qwen', 400, { code: 'Whatever', message: 'odd' })).toMatchObject({
      code: 'REMOTE_REJECTED',
    })
    expect(dashscopeHttpError('qwen', 401, { message: 'no key' })).toMatchObject({
      code: 'REMOTE_AUTH_FAILED',
    })
  })
})

describe('dashscopeVideoBody', () => {
  it('sends Wan 2.7 text to video with resolution, ratio and no prompt rewriting', () => {
    expect(
      dashscopeVideoBody(
        job({
          resolution: '1080P',
          aspectRatio: '9:16',
          durationSecs: 7,
          seed: 42,
          negativePrompt: 'blur',
          size: '1280x720',
        })
      )
    ).toEqual({
      model: 'wan2.7-t2v',
      input: { prompt: 'a kitten on the moon', negative_prompt: 'blur' },
      parameters: {
        resolution: '1080P',
        ratio: '9:16',
        duration: 7,
        prompt_extend: false,
        watermark: false,
        seed: 42,
      },
    })
  })

  it('sends an older model its size as W*H and leaves out what it does not offer', () => {
    expect(
      dashscopeVideoBody(
        job({
          model: T2V_26,
          size: '1280x720',
          resolution: '720P',
          aspectRatio: '16:9',
          durationSecs: 5,
          negativePrompt: 'x',
        })
      )
    ).toEqual({
      model: 'wan2.6-t2v',
      input: { prompt: 'a kitten on the moon' },
      parameters: { size: '1280*720', duration: 5, prompt_extend: false, watermark: false },
    })
  })

  it('sends Wan 2.7 frames as media', () => {
    const body = dashscopeVideoBody(
      job({
        model: I2V_27,
        workflow: 'image-to-video',
        firstFrame: frame,
        lastFrame: frame,
        aspectRatio: '16:9',
      })
    )
    expect(body['input']).toEqual({
      prompt: 'a kitten on the moon',
      media: [
        { type: 'first_frame', url: dataUrl },
        { type: 'last_frame', url: dataUrl },
      ],
    })
    expect((body['parameters'] as Record<string, unknown>)['ratio']).toBeUndefined()
  })

  it('sends an older model its first frame as img_url', () => {
    const body = dashscopeVideoBody(
      job({ model: I2V_26, workflow: 'image-to-video', firstFrame: frame, resolution: '720P' })
    )
    expect(body['input']).toEqual({ prompt: 'a kitten on the moon', img_url: dataUrl })
    expect(body['parameters']).toEqual({ resolution: '720P', prompt_extend: false, watermark: false })
  })

  it.each([
    ['a workflow the model lacks', job({ workflow: 'image-to-video', firstFrame: frame })],
    ['image to video without a frame', job({ model: I2V_27, workflow: 'image-to-video' })],
    [
      'a last frame on an img_url model',
      job({
        model: { ...I2V_26, params: { last_frame: true } },
        workflow: 'image-to-video',
        firstFrame: frame,
        lastFrame: frame,
      }),
    ],
  ])('refuses %s', (_name, input) => {
    expect(() => dashscopeVideoBody(input)).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('dashscopeVideoModels', () => {
  it('keeps video models whose id says text or image to video', () => {
    expect(
      dashscopeVideoModels({
        success: true,
        output: {
          total: 5,
          models: [
            { model: 'wan2.7-t2v', name: 'Wan 2.7 T2V', description: 'Text to video', capabilities: ['VG'] },
            { model: 'wan2.6-i2v-flash', capabilities: ['VG'] },
            { model: 'wan2.7-r2v', capabilities: ['VG'] },
            { model: 'qwen-max', capabilities: ['TG'] },
            { model: 'wan2.7-t2v', capabilities: ['VG'] },
          ],
        },
      })
    ).toEqual([
      { id: 'wan2.7-t2v', name: 'Wan 2.7 T2V', description: 'Text to video', workflows: ['create'] },
      { id: 'wan2.6-i2v-flash', workflows: ['image-to-video'] },
    ])
  })

  it('tolerates a data[] listing with ids and no capabilities', () => {
    expect(
      dashscopeVideoModels({ data: [{ id: 'wan2.5-t2v-preview' }, { id: 'text-embedding-v4' }] })
    ).toEqual([{ id: 'wan2.5-t2v-preview', workflows: ['create'] }])
    expect(dashscopeVideoModels(undefined)).toEqual([])
  })
})

describe('DASHSCOPE_VIDEO', () => {
  it('submits on the native origin with X-DashScope-Async, once', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: SUBMIT,
        answer: jsonResponse({ output: { task_id: 'task-1', task_status: 'PENDING' }, request_id: 'r' }),
      },
    ])
    expect(await DASHSCOPE_VIDEO.submit(ctx(fetch), job({ durationSecs: 5 }))).toEqual({ id: 'task-1' })
    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request?.headers.get('x-dashscope-async')).toBe('enable')
    expect(request?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(request?.headers.get('content-type')).toBe('application/json')
    expect(request?.json).toEqual({
      model: 'wan2.7-t2v',
      input: { prompt: 'a kitten on the moon' },
      parameters: { duration: 5, prompt_extend: false, watermark: false },
    })
  })

  it.each([
    [
      400,
      { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [400, { code: 'InvalidParameter', message: 'bad size' }, 'REMOTE_REJECTED'],
    [400, { code: 'Arrearage', message: 'overdue' }, 'REMOTE_QUOTA'],
    [401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 'REMOTE_AUTH_FAILED'],
    [429, { code: 'Throttling.RateQuota', message: 'slow down' }, 'REMOTE_RATE_LIMITED'],
    [500, { code: 'InternalError', message: 'boom' }, 'REMOTE_UNAVAILABLE'],
  ])('throws a submit answered %i %j as %s', async (status, body, expected) => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'POST', url: SUBMIT, answer: jsonResponse(body, status) },
    ])
    await expect(DASHSCOPE_VIDEO.submit(ctx(fetch), job())).rejects.toMatchObject({ code: expected })
    expect(requests).toHaveLength(1)
  })

  it('refuses a submit answer without a task id', async () => {
    const coded = fakeMediaFetch([
      {
        method: 'POST',
        url: SUBMIT,
        answer: jsonResponse({ code: 'InvalidParameter', message: 'no async' }),
      },
    ])
    await expect(DASHSCOPE_VIDEO.submit(ctx(coded.fetch), job())).rejects.toMatchObject({
      code: 'REMOTE_REJECTED',
    })
    const bare = fakeMediaFetch([{ method: 'POST', url: SUBMIT, answer: jsonResponse({ output: {} }) }])
    await expect(DASHSCOPE_VIDEO.submit(ctx(bare.fetch), job())).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it.each([
    [{ task_id: 'task-1', task_status: 'PENDING' }, { state: 'queued' }],
    [{ task_id: 'task-1', task_status: 'RUNNING' }, { state: 'running' }],
    [
      { task_id: 'task-1', task_status: 'SUCCEEDED', video_url: OSS },
      { state: 'completed', result: { url: OSS } },
    ],
  ])('polls %j as %j', async (output, expected) => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'GET', url: TASK, answer: jsonResponse({ request_id: 'r', output }) },
    ])
    expect(await DASHSCOPE_VIDEO.poll(ctx(fetch), { id: 'task-1' })).toEqual(expected)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]?.headers.get('x-dashscope-async')).toBeNull()
  })

  it.each([
    [
      {
        task_status: 'FAILED',
        code: 'DataInspectionFailed',
        message: 'Output data may contain inappropriate content.',
      },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [
      { task_status: 'FAILED', code: 'InvalidParameter', message: 'The size is not match' },
      'REMOTE_REJECTED',
    ],
    [{ task_status: 'FAILED', code: 'InternalError', message: 'boom' }, 'REMOTE_UNAVAILABLE'],
    [{ task_status: 'CANCELED' }, 'CANCELLED'],
    [{ task_status: 'UNKNOWN' }, 'REMOTE_UNAVAILABLE'],
    [{ task_status: 'SUCCEEDED' }, 'REMOTE_UNAVAILABLE'],
  ])('reports %j as failed with %s', async (output, expected) => {
    const { fetch } = fakeMediaFetch([{ method: 'GET', url: TASK, answer: jsonResponse({ output }) }])
    expect(await DASHSCOPE_VIDEO.poll(ctx(fetch), { id: 'task-1' })).toMatchObject({
      state: 'failed',
      error: { code: expected },
    })
  })

  it('downloads the signed link without the key and refuses a non-video', async () => {
    const { fetch, requests } = fakeMediaFetch([
      { method: 'GET', url: OSS, answer: bytesResponse(MP4_STUB, 'video/mp4') },
    ])
    expect(await DASHSCOPE_VIDEO.download(ctx(fetch), { id: 'task-1' }, { url: OSS })).toEqual({
      bytes: MP4_STUB,
      mime: 'video/mp4',
    })
    expect(requests[0]?.headers.get('authorization')).toBeNull()
    const bad = fakeMediaFetch([{ method: 'GET', url: OSS, answer: bytesResponse(PNG_1X1, 'video/mp4') }])
    await expect(
      DASHSCOPE_VIDEO.download(ctx(bad.fetch), { id: 'task-1' }, { url: OSS })
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
    await expect(DASHSCOPE_VIDEO.download(ctx(bad.fetch), { id: 'task-1' }, {})).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('cancels with POST …/cancel and ignores a refusal', async () => {
    const ok = fakeMediaFetch([
      { method: 'POST', url: `${TASK}/cancel`, answer: jsonResponse({ request_id: 'r' }) },
    ])
    await DASHSCOPE_VIDEO.cancel?.(ctx(ok.fetch), { id: 'task-1' })
    expect(ok.requests[0]?.method).toBe('POST')
    expect(ok.requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    const refused = fakeMediaFetch([
      { method: 'POST', url: `${TASK}/cancel`, answer: jsonResponse({ code: 'UnsupportedOperation' }, 400) },
    ])
    await expect(DASHSCOPE_VIDEO.cancel?.(ctx(refused.fetch), { id: 'task-1' })).resolves.toBeUndefined()
  })

  it('lists video models, and nothing where the listing is missing', async () => {
    const LIST = `${ORIGIN}/api/v1/models?page_no=1&page_size=100&capabilities=VG`
    const listed = fakeMediaFetch([
      {
        method: 'GET',
        url: LIST,
        answer: jsonResponse({ output: { models: [{ model: 'wan2.7-i2v', capabilities: ['VG'] }] } }),
      },
    ])
    expect(await DASHSCOPE_VIDEO.listModels?.(ctx(listed.fetch))).toEqual([
      { id: 'wan2.7-i2v', workflows: ['image-to-video'] },
    ])
    expect(listed.requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    const missing = fakeMediaFetch([
      { method: 'GET', url: LIST, answer: jsonResponse({ code: 'NotFound' }, 404) },
    ])
    expect(await DASHSCOPE_VIDEO.listModels?.(ctx(missing.fetch))).toEqual([])
  })

  it('polls every 10 to 20 s', () => {
    expect(DASHSCOPE_VIDEO.pollIntervalMs).toEqual({ first: 10000, max: 20000 })
  })
})
