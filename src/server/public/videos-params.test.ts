import { describe, expect, it } from 'vitest'
import type { GalleryVideoItem, VideoJob } from '../../contracts/index.js'
import { sampleVideoRecipe } from '../../../test/helpers/diffusion-fixtures.js'
import { ParamError } from './images-params.js'
import {
  allowedVideoMethods,
  buildVideoRequest,
  matchVideoPath,
  parseListQuery,
  parseVideoParams,
  parseVideoSize,
  videoObjectFromItem,
  videoObjectFromJob,
  videoStatusOf,
} from './videos-params.js'
import type { LoadedVideoModel } from './videos-params.js'

const LTX: LoadedVideoModel = {
  modelId: 'ltx-2:q4_k_m',
  displayName: 'LTX-2.3 Distilled',
  modality: 'video',
  defaults: {
    steps: 8,
    cfgScale: 1,
    samplingMethod: 'euler',
    width: 768,
    height: 512,
    video: { fps: 24, frames: 121, frameStep: 8, frameOffset: 1, resolutionPresets: [[768, 512]] },
  },
  ranges: { steps: [1, 50], dims: [256, 1216], dimMultiple: 32, frames: [9, 257] },
}

const refusal = (run: () => unknown): ParamError => {
  try {
    run()
  } catch (e) {
    expect(e).toBeInstanceOf(ParamError)
    return e as ParamError
  }
  throw new Error('expected a refusal')
}

describe('parseVideoParams', () => {
  it('takes the OpenAI fields, seconds as a number or a string, and refuses a reference input', () => {
    expect(parseVideoParams({ prompt: ' a cat ' })).toEqual({ prompt: 'a cat' })
    expect(
      parseVideoParams({
        model: 'LTX-2.3 Distilled',
        prompt: 'x',
        seconds: '4',
        size: '1216x704',
        seed: 7,
        negative_prompt: 'blurry',
      })
    ).toEqual({
      model: 'LTX-2.3 Distilled',
      prompt: 'x',
      seconds: 4,
      size: { width: 1216, height: 704 },
      seed: 7,
      negativePrompt: 'blurry',
    })
    expect(
      parseVideoParams({ prompt: 'x', seconds: 2.5, size: 'auto', negative_prompt: ' ', model: null })
    ).toEqual({
      prompt: 'x',
      seconds: 2.5,
    })
    const table: Array<[unknown, string]> = [
      [null, 'body'],
      [{}, 'prompt'],
      [{ prompt: 7 }, 'prompt'],
      [{ prompt: 'x', input_reference: 'data:...' }, 'input_reference'],
      [{ prompt: 'x', seconds: 0 }, 'seconds'],
      [{ prompt: 'x', seconds: '601' }, 'seconds'],
      [{ prompt: 'x', seconds: 'four' }, 'seconds'],
      [{ prompt: 'x', size: 7 }, 'size'],
      [{ prompt: 'x', size: '100' }, 'size'],
      [{ prompt: 'x', seed: 1.5 }, 'seed'],
      [{ prompt: 'x', negative_prompt: 1 }, 'negative_prompt'],
      [{ prompt: 'x', model: 1 }, 'model'],
    ]
    for (const [body, param] of table)
      expect(refusal(() => parseVideoParams(body)).param, JSON.stringify(body)).toBe(param)
  })
})

describe('parseVideoSize', () => {
  it('parses auto and any positive dimensions; the family decides the rest', () => {
    expect(parseVideoSize('auto')).toBeUndefined()
    expect(parseVideoSize('')).toBeUndefined()
    expect(parseVideoSize(' 64 X 32 ')).toEqual({ width: 64, height: 32 })
    expect(parseVideoSize('1216x704')).toEqual({ width: 1216, height: 704 })
    for (const bad of ['large', '512x', 'x512', '0x512', '512x-16', '5.12x512', '512x99999999999'])
      expect(refusal(() => parseVideoSize(bad)).param, bad).toBe('size')
  })
})

describe('buildVideoRequest', () => {
  it('binds the family defaults, and snaps seconds to the frame lattice', () => {
    expect(buildVideoRequest({ prompt: 'a cat' }, LTX)).toEqual({
      prompt: 'a cat',
      width: 768,
      height: 512,
      frames: 121,
      fps: 24,
      steps: 8,
      cfgScale: 1,
      samplingMethod: 'euler',
    })
    const bound = buildVideoRequest(
      { prompt: 'a cat', seconds: 2, size: { width: 1216, height: 704 }, seed: 5, negativePrompt: 'blurry' },
      { ...LTX, defaults: { ...LTX.defaults, guidance: 3, flowShift: 2 } }
    )
    expect(bound).toMatchObject({
      frames: 49,
      width: 1216,
      height: 704,
      seed: 5,
      negativePrompt: 'blurry',
      guidance: 3,
      flowShift: 2,
    })
    // 4 s at 24 fps is 96 frames: the nearest 8k+1 is 97; the ends clamp to the range.
    expect(buildVideoRequest({ prompt: 'x', seconds: 4 }, LTX).frames).toBe(97)
    expect(buildVideoRequest({ prompt: 'x', seconds: 600 }, LTX).frames).toBe(257)
    expect(buildVideoRequest({ prompt: 'x', seconds: 0.1 }, LTX).frames).toBe(9)
    const { video: _video, ...imageDefaults } = LTX.defaults
    const image = refusal(() => buildVideoRequest({ prompt: 'x' }, { ...LTX, defaults: imageDefaults }))
    expect(image.param).toBe('model')
  })
})

describe('the video object', () => {
  const job = (over: Partial<VideoJob> = {}): VideoJob => ({
    id: 'j1',
    state: 'generating',
    modelId: 'ltx-2:q4_k_m',
    request: { prompt: 'a cat', width: 768, height: 512, frames: 49, fps: 24, steps: 8, cfgScale: 1 },
    createdAtMs: 1_700_000_000_500,
    progress: { phase: 'sampling', step: 4, totalSteps: 8, fraction: 0.5, etaSeconds: 3, elapsedMs: 10 },
    outputs: [],
    ...over,
  })

  it('reads a running job, a finished one, a failed and a cancelled one', () => {
    expect(videoObjectFromJob(job())).toEqual({
      id: 'j1',
      object: 'video',
      model: 'ltx-2:q4_k_m',
      status: 'in_progress',
      progress: 50,
      created_at: 1_700_000_000,
      completed_at: null,
      expires_at: null,
      seconds: '2.04',
      size: '768x512',
      prompt: 'a cat',
      remixed_from_video_id: null,
      error: null,
      atomic: { job_id: 'j1', seed: null, path: null, poster_path: null },
    })
    expect(videoObjectFromJob(job({ state: 'queued', progress: null }))).toMatchObject({
      status: 'queued',
      progress: 0,
    })
    const item: GalleryVideoItem = {
      id: 'j1',
      path: '/videos/j1.webm',
      posterPath: '/videos/j1.thumb.png',
      width: 768,
      height: 512,
      fps: 24,
      frameCount: 49,
      durationSecs: 49 / 24,
      sizeBytes: 691,
      createdAtMs: 1_700_000_000_000,
      pinned: false,
      archived: false,
      recipe: sampleVideoRecipe({ jobId: 'j1', frames: 49, frameCount: 49, seed: 5, durationMs: 4_000 }),
    }
    expect(
      videoObjectFromJob(job({ state: 'completed', finishedAtMs: 1_700_000_004_000, outputs: [item] }))
    ).toMatchObject({
      status: 'completed',
      progress: 100,
      completed_at: 1_700_000_004,
      seconds: '2.04',
      atomic: { job_id: 'j1', seed: 5, path: '/videos/j1.webm', poster_path: '/videos/j1.thumb.png' },
    })
    expect(
      videoObjectFromJob(
        job({ state: 'failed', error: { code: 'OUT_OF_MEMORY', message: 'oom' }, finishedAtMs: 1 })
      )
    ).toMatchObject({ status: 'failed', error: { code: 'out_of_memory', message: 'oom' }, completed_at: 0 })
    expect(videoObjectFromJob(job({ state: 'cancelled' }))).toMatchObject({
      status: 'failed',
      error: { code: 'cancelled', message: 'Generation was cancelled.' },
    })
    expect(videoObjectFromItem(item)).toEqual({
      id: 'j1',
      object: 'video',
      model: 'ltx-2:q4_k_m',
      status: 'completed',
      progress: 100,
      created_at: 1_700_000_000,
      completed_at: 1_700_000_004,
      expires_at: null,
      seconds: '2.04',
      size: '768x512',
      prompt: 'a cat walking through a rainy alley',
      remixed_from_video_id: null,
      error: null,
      atomic: { job_id: 'j1', seed: 5, path: '/videos/j1.webm', poster_path: '/videos/j1.thumb.png' },
    })
    expect(videoObjectFromItem({ ...item, fps: 0 }).seconds).toBe('0')
    for (const [state, status] of [
      ['queued', 'queued'],
      ['generating', 'in_progress'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'failed'],
    ] as const)
      expect(videoStatusOf(state)).toBe(status)
  })
})

describe('the paths and the listing query', () => {
  it('matches the three routes and names their methods', () => {
    expect(matchVideoPath('/videos')).toEqual({ kind: 'collection' })
    expect(matchVideoPath('/videos/abc')).toEqual({ kind: 'video', id: 'abc' })
    expect(matchVideoPath('/videos/a%20b/content')).toEqual({ kind: 'content', id: 'a b' })
    for (const other of ['/videos/', '/videos/a/b', '/videos/a/content/x', '/video', '/images/generations'])
      expect(matchVideoPath(other), other).toBeUndefined()
    expect(allowedVideoMethods({ kind: 'collection' })).toEqual(['GET', 'POST'])
    expect(allowedVideoMethods({ kind: 'video', id: 'a' })).toEqual(['GET', 'DELETE'])
    expect(allowedVideoMethods({ kind: 'content', id: 'a' })).toEqual(['GET'])
  })

  it('reads limit and after, with bounds', () => {
    expect(parseListQuery(undefined)).toEqual({ limit: 20 })
    expect(parseListQuery('limit=5&after=x&order=asc')).toEqual({ limit: 5, after: 'x' })
    expect(parseListQuery('limit=')).toEqual({ limit: 20 })
    for (const bad of ['limit=0', 'limit=101', 'limit=2.5', 'limit=abc'])
      expect(refusal(() => parseListQuery(bad)).param, bad).toBe('limit')
  })
})
