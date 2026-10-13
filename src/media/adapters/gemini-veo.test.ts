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
  GEMINI_VEO,
  readVeoOperation,
  veoDuration,
  veoError,
  veoModels,
  veoNativeBase,
  veoRequest,
} from './gemini-veo.js'
import type { VideoGenerationJob } from './types.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
const NATIVE = 'https://generativelanguage.googleapis.com/v1beta'
const OPERATION = 'models/veo-3.1-fast-generate-preview/operations/op123'

function model(overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor {
  return {
    id: 'veo-3.1-fast-generate-preview',
    name: 'Veo 3.1 Fast',
    api: 'gemini-veo',
    kind: 'video',
    source: 'catalog',
    workflows: ['create', 'image-to-video'],
    params: {
      durations: { values: [4, 6, 8], default: 8 },
      resolutions: { values: ['720p', '1080p', '4k'], default: '720p' },
      aspect_ratios: { values: ['16:9', '9:16'], default: '16:9' },
      seed: true,
      last_frame: true,
    },
    ...overrides,
  }
}

function job(overrides: Partial<VideoGenerationJob> = {}): VideoGenerationJob {
  return { model: model(), prompt: 'a fox in the snow', workflow: 'create', ...overrides }
}

const frame = { bytes: PNG_1X1, mime: 'image/png' }

describe('veoNativeBase', () => {
  it.each([
    [BASE, NATIVE],
    [`${BASE}/`, NATIVE],
    [NATIVE, NATIVE],
  ])('%s → %s', (base, native) => {
    expect(veoNativeBase(base)).toBe(native)
  })
})

describe('veoDuration', () => {
  it.each([
    ['720p', 4, 4],
    ['1080p', 4, 8],
    ['4k', 6, 8],
    ['4K', 8, 8],
    [undefined, 6, 6],
    ['1080p', undefined, undefined],
  ])('%s at %s s → %s', (resolution, seconds, expected) => {
    expect(veoDuration(resolution, seconds)).toBe(expected)
  })
})

describe('veoRequest', () => {
  it('sends what the job set and the model offers', () => {
    expect(
      veoRequest(
        job({ aspectRatio: '9:16', resolution: '720p', durationSecs: 6, seed: 11, negativePrompt: 'blur' })
      )
    ).toEqual({
      instances: [{ prompt: 'a fox in the snow' }],
      parameters: {
        numberOfVideos: 1,
        aspectRatio: '9:16',
        resolution: '720p',
        durationSeconds: 6,
        seed: 11,
      },
    })
  })

  it('asks 1080p for 8 seconds, as a string when the model says so', () => {
    const body = veoRequest(
      job({ model: model({ options: { duration_as_string: true } }), resolution: '1080p', durationSecs: 4 })
    )
    expect(body['parameters']).toEqual({ numberOfVideos: 1, resolution: '1080p', durationSeconds: '8' })
  })

  it('sends a negative prompt only when the model offers it', () => {
    const offered = model({ params: { negative_prompt: true } })
    expect(veoRequest(job({ model: offered, negativePrompt: 'blur' }))['parameters']).toEqual({
      numberOfVideos: 1,
      negativePrompt: 'blur',
    })
  })

  it('sends the first and last frames inline', () => {
    const body = veoRequest(job({ workflow: 'image-to-video', firstFrame: frame, lastFrame: frame }))
    const instance = (body['instances'] as Array<Record<string, unknown>>)[0]
    const inline = { inlineData: { mimeType: 'image/png', data: PNG_1X1.toString('base64') } }
    expect(instance).toEqual({ prompt: 'a fox in the snow', image: inline, lastFrame: inline })
  })

  it('refuses image to video without a first frame, and a last frame the model does not take', () => {
    expect(() => veoRequest(job({ workflow: 'image-to-video' }))).toThrow(
      expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' })
    )
    expect(() =>
      veoRequest(
        job({ model: model({ params: {} }), workflow: 'image-to-video', firstFrame: frame, lastFrame: frame })
      )
    ).toThrow(expect.objectContaining({ code: 'REMOTE_UNSUPPORTED' }))
  })
})

describe('veoError', () => {
  it.each([
    [{ code: 3, message: 'durationSeconds must be 8 for 1080p' }, 'REMOTE_REJECTED'],
    [
      { code: 3, message: 'The prompt could not be submitted. It violates our usage guidelines.' },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [{ code: 7, message: 'Permission denied' }, 'REMOTE_AUTH_FAILED'],
    [{ code: 8, message: 'Quota exceeded' }, 'REMOTE_RATE_LIMITED'],
    [{ code: 4, message: 'Deadline exceeded' }, 'REMOTE_TIMEOUT'],
    [{ code: 13, message: 'Internal error' }, 'REMOTE_UNAVAILABLE'],
  ])('%j → %s', (error, code) => {
    expect(veoError('Google', error).code).toBe(code)
  })
})

describe('readVeoOperation', () => {
  it('reads a running and a finished operation', () => {
    expect(readVeoOperation('Google', { name: OPERATION })).toEqual({ state: 'running' })
    expect(readVeoOperation('Google', { name: OPERATION, done: false })).toEqual({ state: 'running' })
    expect(
      readVeoOperation('Google', {
        name: OPERATION,
        done: true,
        response: {
          '@type': 'type.googleapis.com/google.ai.generativelanguage.v1beta.PredictLongRunningResponse',
          'generateVideoResponse': {
            generatedSamples: [{ video: { uri: `${NATIVE}/files/abc:download?alt=media` } }],
          },
        },
      })
    ).toEqual({ state: 'completed', result: { url: `${NATIVE}/files/abc:download?alt=media` } })
  })

  it.each([
    [
      {
        done: true,
        response: {
          generateVideoResponse: {
            raiMediaFilteredCount: 1,
            raiMediaFilteredReasons: ['We encountered an issue with the audio for your prompt.'],
          },
        },
      },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [
      { done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1 } } },
      'REMOTE_CONTENT_BLOCKED',
    ],
    [{ done: true, response: { generateVideoResponse: {} } }, 'REMOTE_UNAVAILABLE'],
    [{ done: true, error: { code: 13, message: 'Video generation failed' } }, 'REMOTE_UNAVAILABLE'],
  ])('fails %j as %s', (answer, code) => {
    const poll = readVeoOperation('Google', answer)
    expect(poll.state === 'failed' && poll.error.code).toBe(code)
  })
})

describe('veoModels', () => {
  it('keeps the veo models that run long', () => {
    expect(
      veoModels({
        models: [
          { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] },
          {
            name: 'models/veo-3.1-fast-generate-preview',
            displayName: 'Veo 3.1 Fast',
            supportedGenerationMethods: ['predictLongRunning'],
          },
          { name: 'models/veo-3.1-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
          { name: 'models/veo-2.0-generate-001', supportedGenerationMethods: ['generateContent'] },
        ],
      })
    ).toEqual([
      { id: 'veo-3.1-fast-generate-preview', name: 'Veo 3.1 Fast' },
      { id: 'veo-3.1-generate-preview' },
    ])
  })
})

describe('GEMINI_VEO', () => {
  it('submits to the native predictLongRunning route with the Google key header', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${NATIVE}/models/veo-3.1-fast-generate-preview:predictLongRunning`,
        answer: jsonResponse({ name: OPERATION }),
      },
    ])
    const logs: string[] = []
    const ctx = mediaContext({ fetch, baseUrl: BASE, log: (_level, message) => logs.push(message) })
    const submission = await GEMINI_VEO.submit(ctx, job({ resolution: '4k', durationSecs: 4 }))
    expect(submission).toEqual({ id: OPERATION })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('sk-test')
    expect(requests[0]?.headers.get('authorization')).toBeNull()
    expect(requests[0]?.json).toEqual({
      instances: [{ prompt: 'a fox in the snow' }],
      parameters: { numberOfVideos: 1, resolution: '4k', durationSeconds: 8 },
    })
    expect(logs.some((line) => line.includes('8 seconds'))).toBe(true)
  })

  it('refuses an answer without a usable operation name', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${NATIVE}/models/veo-3.1-fast-generate-preview:predictLongRunning`,
        answer: jsonResponse({ name: '../../evil' }),
      },
    ])
    await expect(GEMINI_VEO.submit(mediaContext({ fetch, baseUrl: BASE }), job())).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })

  it('polls the operation by name', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${NATIVE}/${OPERATION}`,
        answer: [
          jsonResponse({ name: OPERATION }),
          jsonResponse({
            name: OPERATION,
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [{ video: { uri: `${NATIVE}/files/abc:download?alt=media` } }],
              },
            },
          }),
        ],
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    expect(await GEMINI_VEO.poll(ctx, { id: OPERATION })).toEqual({ state: 'running' })
    expect(await GEMINI_VEO.poll(ctx, { id: OPERATION })).toEqual({
      state: 'completed',
      result: { url: `${NATIVE}/files/abc:download?alt=media` },
    })
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('sk-test')
  })

  it('downloads with the key on its own host only, following the redirect to storage', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${NATIVE}/files/abc:download?alt=media`,
        answer: new Response(null, {
          status: 302,
          headers: { location: 'https://storage.googleapis.com/bucket/abc.mp4' },
        }),
      },
      {
        method: 'GET',
        url: 'https://storage.googleapis.com/bucket/abc.mp4',
        answer: bytesResponse(MP4_STUB, 'video/mp4'),
      },
    ])
    const clip = await GEMINI_VEO.download(
      mediaContext({ fetch, baseUrl: BASE }),
      { id: OPERATION },
      { url: `${NATIVE}/files/abc:download?alt=media` }
    )
    expect(clip.mime).toBe('video/mp4')
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('sk-test')
    expect(requests[1]?.headers.get('x-goog-api-key')).toBeNull()
  })

  it('refuses a download without a URL or of something that is not a video', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${NATIVE}/files/abc:download?alt=media`,
        answer: bytesResponse(PNG_1X1, 'video/mp4'),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(GEMINI_VEO.download(ctx, { id: OPERATION }, {})).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
    await expect(
      GEMINI_VEO.download(ctx, { id: OPERATION }, { url: `${NATIVE}/files/abc:download?alt=media` })
    ).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' })
  })

  it('lists the native models', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'GET',
        url: `${NATIVE}/models?pageSize=1000`,
        answer: jsonResponse({
          models: [
            {
              name: 'models/veo-3.1-lite-generate-preview',
              supportedGenerationMethods: ['predictLongRunning'],
            },
          ],
        }),
      },
    ])
    expect(await GEMINI_VEO.listModels?.(mediaContext({ fetch, baseUrl: BASE }))).toEqual([
      { id: 'veo-3.1-lite-generate-preview' },
    ])
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('sk-test')
  })
})
