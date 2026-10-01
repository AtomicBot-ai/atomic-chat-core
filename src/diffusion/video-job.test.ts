import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CoreEvents, VideoEstimate } from '../contracts/index.js'
import { sampleVideoRequest, sampleVideoSpec } from '../../test/helpers/diffusion-fixtures.js'
import {
  checkWebmSupport,
  decodeVideo,
  prepareVideoJob,
  resolveVideoInputs,
  VIDEO_JOB_KIND,
  VIDEO_PROGRESS_HEARTBEAT_MS,
  videoProgressModel,
  withoutVideoSources,
} from './video-job.js'
import type { VideoForecast } from './video-estimate.js'

const fixture = () => readFile(fileURLToPath(new URL('../../test/fixtures/webm/tiny.webm', import.meta.url)))

describe('decodeVideo', () => {
  it('reads the clip, its rate and its frame count, and refuses what is not a WebM answer', async () => {
    const webm = await fixture()
    const decoded = decodeVideo({
      result: {
        output_format: 'webm',
        mime_type: 'video/webm',
        fps: 24,
        frame_count: 25,
        b64_json: webm.toString('base64'),
      },
    })
    expect(decoded.bytes.equals(webm)).toBe(true)
    expect([decoded.fps, decoded.frameCount, decoded.outputFormat, decoded.mimeType]).toEqual([
      24,
      25,
      'webm',
      'video/webm',
    ])
    // Missing or odd numbers read as unknown (zero); the recipe then keeps the request's values.
    expect(decodeVideo({ result: { b64_json: 'AQ==', fps: '24', frame_count: 0.5 } })).toMatchObject({
      fps: 0,
      frameCount: 0,
      outputFormat: 'webm',
      mimeType: 'video/webm',
    })
    expect(() => decodeVideo({ result: { b64_json: '' } })).toThrow('returned no video')
    expect(() => decodeVideo({})).toThrow('returned no video')
    expect(() => decodeVideo({ result: { b64_json: '!!!!' } })).toThrow('undecodable video')
    expect(() => decodeVideo({ result: { b64_json: 'AQ==', output_format: 'avi' } })).toThrow(
      'unexpected format'
    )
  })
})

describe('the video inputs', () => {
  it('read the first and last frames of an image-to-video request only, and blank inline bytes', async () => {
    const deps = { readSource: async (path: string) => Buffer.from(`file:${path}`) }
    const create = sampleVideoRequest({ initImage: { base64: 'QUJD' } })
    expect(await resolveVideoInputs(create, deps)).toEqual({ refs: [] })
    const i2v = sampleVideoRequest({
      workflow: 'image-to-video',
      initImage: { path: '/first.png' },
      endImage: { base64: 'data:image/png;base64,QUJD' },
    })
    expect(await resolveVideoInputs(i2v, deps)).toEqual({
      refs: [],
      init: Buffer.from('file:/first.png').toString('base64'),
      end: 'QUJD',
    })
    expect(withoutVideoSources(i2v)).toEqual({ ...i2v, endImage: { base64: '' } })
    expect(withoutVideoSources(sampleVideoRequest())).toEqual(sampleVideoRequest())
  })
})

describe('VIDEO_JOB_KIND', () => {
  it('names the video route, the video events, a single clip and the engine promises', () => {
    expect(VIDEO_JOB_KIND.id).toBe('video')
    expect(VIDEO_JOB_KIND.modality).toBe('video')
    expect(VIDEO_JOB_KIND.submitPath).toBe('/sdcpp/v1/vid_gen')
    expect(VIDEO_JOB_KIND.messages).toEqual({
      busy: 'A video is already being generated.',
      wrongModel: 'The loaded model generates images, not video. Load a video model first.',
      outOfMemory:
        'sd-server ran out of memory while generating the clip: a clip this long at this size does not fit. Fewer frames or a smaller size will.',
      failed: 'The video server failed to generate.',
    })
    const spec = sampleVideoSpec()
    const job = VIDEO_JOB_KIND.newJob('j', spec, sampleVideoRequest({ endImage: { base64: 'QUJD' } }), 5)
    expect(job).toEqual({
      id: 'j',
      state: 'queued',
      modelId: 'ltx-2:q4_k_m',
      request: sampleVideoRequest({ endImage: { base64: '' } }),
      createdAtMs: 5,
      progress: null,
      outputs: [],
    })
    const emitted: Array<{ name: string; payload: unknown }> = []
    const emit = (name: string, payload: unknown) => emitted.push({ name, payload })
    VIDEO_JOB_KIND.emitJob(emit as never, job)
    const snapshot: CoreEvents['diffusion:progress']['progress'] = {
      phase: 'sampling',
      step: 3,
      totalSteps: 8,
      fraction: 0.4,
      etaSeconds: 12,
      batchIndex: 0,
      batchSize: 1,
      elapsedMs: 10,
    }
    // Without an estimate the first step is not measured yet: no ETA, the tracker's fraction.
    const progress = videoProgressModel({ kind: 'video', job, cancel: { requested: false } }, 0)(snapshot, 10)
    expect(progress).toEqual({
      phase: 'sampling',
      step: 3,
      totalSteps: 8,
      fraction: 0.4,
      etaSeconds: null,
      elapsedMs: 10,
      slowdown: false,
    })
    expect(VIDEO_JOB_KIND.progressModel).toBe(videoProgressModel)
    expect(VIDEO_JOB_KIND.heartbeatMs).toBe(VIDEO_PROGRESS_HEARTBEAT_MS)
    expect(VIDEO_PROGRESS_HEARTBEAT_MS).toBe(1_000)
    VIDEO_JOB_KIND.emitProgress(emit as never, 'j', progress)
    expect(emitted).toEqual([
      { name: 'diffusion:video-job', payload: { job } },
      { name: 'diffusion:video-progress', payload: { jobId: 'j', progress } },
    ])
    expect(VIDEO_JOB_KIND.trackerShape(sampleVideoRequest({ steps: 0 }))).toEqual({ steps: 1, batch: 1 })
    expect(VIDEO_JOB_KIND.trackerShape(sampleVideoRequest({ steps: 8 }))).toEqual({ steps: 8, batch: 1 })
    expect(VIDEO_JOB_KIND.cancelGenerating({ cancelGenerating: true })).toBe(false)
    expect(
      VIDEO_JOB_KIND.cancelGenerating({ cancelGenerating: false, vidGen: { cancelGenerating: true } })
    ).toBe(true)
    expect(VIDEO_JOB_KIND.buildBody(sampleVideoRequest(), spec, 9, { refs: [] })).toMatchObject({
      seed: 9,
      video_frames: 25,
      fps: 24,
      output_format: 'webm',
    })
    // The decode's tiles reach the wire while it decodes.
    const decoding = videoProgressModel({ kind: 'video', job, cancel: { requested: false } }, 0)(
      { ...snapshot, phase: 'decoding', step: 8 },
      20,
      { done: 2, total: 8 }
    )
    expect(decoding.decodeTiles).toEqual({ done: 2, total: 8 })
  })

  it('tiles the decode as the plan says, and by the threshold again on the CPU fallback', () => {
    const spec = sampleVideoSpec()
    // 768 × 512 × 49 is past the threshold: tiled without a plan.
    const long = sampleVideoRequest({ frames: 49 })
    const plan = { decodeTiling: { tilesX: 1, tilesY: 1 } }
    expect(VIDEO_JOB_KIND.buildBody(long, spec, 9, { refs: [] }, plan)).not.toHaveProperty(
      'vae_tiling_params'
    )
    expect(VIDEO_JOB_KIND.buildBody(long, spec, 9, { refs: [] }, {})['vae_tiling_params']).toEqual({
      enabled: true,
    })
    // The plan was made for the device; the CPU backend weighs system RAM instead.
    expect(
      VIDEO_JOB_KIND.buildBody(long, { ...spec, cpuFallback: true }, 9, { refs: [] }, plan)[
        'vae_tiling_params'
      ]
    ).toEqual({ enabled: true })
  })

  it('refuses a build without WebM before submitting, and lets an unreported one try', () => {
    expect(() =>
      checkWebmSupport({
        cancelGenerating: false,
        vidGen: { cancelGenerating: false, outputFormats: ['webp', 'avi'] },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED_BACKEND',
        message: 'This engine build was made without WebM support.',
        details: 'output formats: webp, avi',
      })
    )
    expect(() =>
      checkWebmSupport({ cancelGenerating: false, vidGen: { cancelGenerating: false, outputFormats: [] } })
    ).toThrow(expect.objectContaining({ details: 'output formats: none' }))
    expect(() =>
      checkWebmSupport({
        cancelGenerating: false,
        vidGen: { cancelGenerating: false, outputFormats: ['webm'] },
      })
    ).not.toThrow()
    expect(() =>
      checkWebmSupport({ cancelGenerating: false, vidGen: { cancelGenerating: false } })
    ).not.toThrow()
    expect(() => checkWebmSupport({ cancelGenerating: false })).not.toThrow()
    expect(() => checkWebmSupport(undefined)).not.toThrow()
    expect(VIDEO_JOB_KIND.preflight).toBe(checkWebmSupport)
  })
})

const ESTIMATE: VideoEstimate = {
  memory: { requiredBytes: 8e9, budgetBytes: 16e9, pool: 'unified', verdict: 'fits' },
  seconds: { low: 300, high: 1200 },
  basis: 'heuristic',
}
const FORECAST: VideoForecast = {
  encodeSeconds: 10,
  stepSeconds: 60,
  stepSecondsHigh: 120,
  decodeSeconds: 110,
  totalSeconds: 600,
}

describe('the video plan', () => {
  it('puts the estimate on the job from its first record, and keeps the forecast off it', () => {
    const job = VIDEO_JOB_KIND.newJob('j', sampleVideoSpec(), sampleVideoRequest(), 5, {
      estimate: ESTIMATE,
      forecast: FORECAST,
    })
    expect(job.estimate).toEqual(ESTIMATE)
    expect(job).not.toHaveProperty('forecast')
    expect(VIDEO_JOB_KIND.newJob('j', sampleVideoSpec(), sampleVideoRequest(), 5)).not.toHaveProperty(
      'estimate'
    )
  })

  it('is asked of the service, and a failure only costs the job its estimate', async () => {
    const log: string[] = []
    const deps = { log: (level: string, msg: string) => log.push(`${level}: ${msg}`) }
    expect(VIDEO_JOB_KIND.prepare).toBe(prepareVideoJob)
    expect(await prepareVideoJob(deps, sampleVideoRequest(), sampleVideoSpec())).toBeUndefined()
    const planned = await prepareVideoJob(
      { ...deps, planVideo: async () => ({ estimate: ESTIMATE, forecast: FORECAST }) },
      sampleVideoRequest(),
      sampleVideoSpec()
    )
    expect(planned).toEqual({ estimate: ESTIMATE, forecast: FORECAST })
    const failed = await prepareVideoJob(
      {
        ...deps,
        planVideo: async () => {
          throw new Error('no memory figure')
        },
      },
      sampleVideoRequest(),
      sampleVideoSpec()
    )
    expect(failed).toBeUndefined()
    expect(log).toEqual(['warn: video estimate failed: no memory figure'])
  })

  it('drives the progress from the forecast: the estimate before the first measured step', () => {
    const job = VIDEO_JOB_KIND.newJob('j', sampleVideoSpec(), sampleVideoRequest(), 5, {
      estimate: ESTIMATE,
      forecast: FORECAST,
    })
    const model = videoProgressModel(
      { kind: 'video', job, cancel: { requested: false }, forecast: FORECAST },
      1_000
    )
    const encoding: CoreEvents['diffusion:progress']['progress'] = {
      phase: 'encoding',
      step: 0,
      totalSteps: 8,
      fraction: 0.02,
      etaSeconds: null,
      batchIndex: 0,
      batchSize: 1,
      elapsedMs: 0,
    }
    const progress = model(encoding, 31_000)
    expect(progress.etaSeconds).toBeCloseTo(570, 6)
    expect(progress.elapsedMs).toBe(30_000)
    expect(progress.slowdown).toBe(false)
    // An estimate without seconds (memory exceeded) gives no ETA until steps are measured.
    const exceeded = VIDEO_JOB_KIND.newJob('k', sampleVideoSpec(), sampleVideoRequest(), 5, {
      estimate: { ...ESTIMATE, seconds: null, memory: { ...ESTIMATE.memory, verdict: 'exceeds' } },
      forecast: FORECAST,
    })
    const blind = videoProgressModel(
      { kind: 'video', job: exceeded, cancel: { requested: false }, forecast: FORECAST },
      1_000
    )
    expect(blind(encoding, 31_000).etaSeconds).toBeNull()
  })
})
