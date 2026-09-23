import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CoreEvents } from '../contracts/index.js'
import { sampleVideoRequest, sampleVideoSpec } from '../../test/helpers/diffusion-fixtures.js'
import {
  checkWebmSupport,
  decodeVideo,
  resolveVideoInputs,
  VIDEO_JOB_KIND,
  videoProgress,
  withoutVideoSources,
} from './video-job.js'

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
    const progress = videoProgress(snapshot)
    expect(progress).toEqual({
      phase: 'sampling',
      step: 3,
      totalSteps: 8,
      fraction: 0.4,
      etaSeconds: 12,
      elapsedMs: 10,
    })
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
