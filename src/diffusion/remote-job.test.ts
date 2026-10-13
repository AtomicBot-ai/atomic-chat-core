/**
 * Remote jobs through the real `DiffusionService`, with in-memory adapters standing in for providers:
 * the shared job table, the events, the galleries, cancel, the capacity cap, and a clip followed again
 * after a restart without a second submit.
 */
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import type {
  ImageGenerateRequest,
  ImageModelDescriptor,
  MediaTarget,
  VideoGenerateRequest,
  VideoModelDescriptor,
} from '../contracts/index.js'
import { fakeMediaFetch, JPEG_STUB, mediaContext, MP4_STUB, PNG_1X1 } from '../../test/helpers/media-fetch.js'
import { abortableSleep } from '../media/index.js'
import type { ImageAdapter, VideoAdapter, VideoPoll } from '../media/index.js'
import { diffusionError } from './errors.js'
import {
  checkRemoteImageRequest,
  checkRemoteVideoRequest,
  imageGenerationJob,
  timeFraction,
  videoGenerationJob,
} from './remote-job.js'
import type { RemoteMediaGateway } from './remote-job.js'
import { RemoteJobStore } from './remote-store.js'
import { DiffusionService } from './service.js'

let dataFolder: string
let layout: DataLayout
const services: DiffusionService[] = []
beforeEach(async () => {
  dataFolder = await realpath(await mkdtemp(join(tmpdir(), 'atomic-core-remote-')))
  layout = dataLayout(dataFolder)
})
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()))
  await rm(dataFolder, { recursive: true, force: true })
})

const imageModel = (overrides: Partial<ImageModelDescriptor> = {}): ImageModelDescriptor => ({
  id: 'img-1',
  name: 'Image One',
  api: 'openai-images',
  kind: 'image',
  source: 'catalog',
  workflows: ['create', 'edit', 'inpaint'],
  params: {
    n: { max: 2 },
    seed: true,
    output_format: { values: ['png', 'jpeg'] },
    size: { kind: 'enum', values: ['auto', '1024x1024'], default: 'auto' },
  },
  ...overrides,
})

const videoModel = (overrides: Partial<VideoModelDescriptor> = {}): VideoModelDescriptor => ({
  id: 'vid-1',
  name: 'Video One',
  api: 'openrouter-videos',
  kind: 'video',
  source: 'catalog',
  workflows: ['create', 'image-to-video'],
  params: {
    durations: { values: [4, 8], default: 8 },
    resolutions: { values: ['720p'], default: '720p' },
    audio: true,
  },
  ...overrides,
})

interface Fakes {
  image: ImageAdapter
  video: VideoAdapter
  submits: number
  polls: VideoPoll[]
  signals: AbortSignal[]
}

function fakes(): Fakes {
  const state: Fakes = {
    submits: 0,
    polls: [
      { state: 'queued' },
      { state: 'running', progress: 0.5 },
      { state: 'completed', result: { url: 'x' } },
    ],
    signals: [],
    image: {
      dialect: 'openai-images',
      kind: 'image',
      generate: async (ctx, job) => {
        state.signals.push(ctx.signal)
        return Array.from({ length: job.n }, () => ({ bytes: PNG_1X1, mime: 'image/png' }))
      },
    },
    video: {
      dialect: 'openrouter-videos',
      kind: 'video',
      pollIntervalMs: { first: 1, max: 2 },
      submit: async () => {
        state.submits += 1
        return { id: 'up-1', data: { poll: 'x' } }
      },
      poll: async () => state.polls.shift() ?? { state: 'running' },
      download: async () => ({ bytes: MP4_STUB, mime: 'video/mp4' }),
    },
  }
  return state
}

function gateway(f: Fakes): RemoteMediaGateway {
  // A real (1 ms) wait: a poll loop must yield to timers, as it does in production.
  const context = (signal: AbortSignal) => ({
    ...mediaContext({ fetch: fakeMediaFetch([]).fetch, signal }),
    sleep: () => abortableSleep(1, signal),
  })
  const check = (target: MediaTarget) => {
    if (target.provider !== 'acme') throw diffusionError('REMOTE_NOT_CONFIGURED', 'not connected')
  }
  return {
    image: async (target) => (check(target), { target, descriptor: imageModel(), adapter: f.image, context }),
    video: async (target) => (check(target), { target, descriptor: videoModel(), adapter: f.video, context }),
    find: (model, kind) =>
      model === 'named' ? { provider: 'acme', model: kind === 'image' ? 'img-1' : 'vid-1' } : undefined,
  }
}

function service(f: Fakes, options: { gateway?: boolean; maxRemoteJobs?: number } = {}) {
  const events: Array<{ name: string; payload: unknown }> = []
  const s = new DiffusionService({
    paths: layout.diffusion,
    dataFolder,
    emit: (name, payload) => events.push({ name, payload }),
    log: () => {},
    sleep: async () => {},
    ...(options.gateway === false ? {} : { remoteMedia: gateway(f) }),
    ...(options.maxRemoteJobs !== undefined ? { maxRemoteJobs: options.maxRemoteJobs } : {}),
  })
  services.push(s)
  return { s, events }
}

const imageRequest = (overrides: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest => ({
  prompt: 'a cat',
  width: 0,
  height: 0,
  steps: 0,
  cfgScale: 0,
  batchSize: 1,
  target: { provider: 'acme', model: 'img-1' },
  ...overrides,
})

const videoRequest = (overrides: Partial<VideoGenerateRequest> = {}): VideoGenerateRequest => ({
  prompt: 'waves',
  width: 0,
  height: 0,
  steps: 0,
  cfgScale: 0,
  target: { provider: 'acme', model: 'vid-1' },
  remote: { durationSecs: 4 },
  ...overrides,
})

async function settled(s: DiffusionService, id: string, kind: 'image' | 'video' = 'image') {
  for (let i = 0; i < 200; i++) {
    const job = kind === 'image' ? s.getJob(id) : s.getVideoJob(id)
    if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('job never settled')
}

describe('pure parts', () => {
  it('check an image request against the model', () => {
    const model = imageModel()
    expect(checkRemoteImageRequest(imageRequest(), model)).toBe('create')
    expect(() => checkRemoteImageRequest(imageRequest({ prompt: ' ' }), model)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
    expect(() => checkRemoteImageRequest(imageRequest({ workflow: 'upscale' }), model)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_WORKFLOW' })
    )
    expect(() => checkRemoteImageRequest(imageRequest({ workflow: 'edit' }), model)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
    expect(() =>
      checkRemoteImageRequest(imageRequest({ workflow: 'inpaint', initImage: { base64: 'eA==' } }), model)
    ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => checkRemoteImageRequest(imageRequest({ batchSize: 3 }), model)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
  })

  it('build the adapter job with the model defaults and PNG when offered', () => {
    const job = imageGenerationJob(
      imageRequest({ remote: { quality: 'high' } }),
      imageModel(),
      'create',
      { images: [] },
      7
    )
    expect(job).toMatchObject({ n: 1, seed: 7, size: 'auto', outputFormat: 'png' })
    // A control the model does not have is not sent.
    expect(job.quality).toBeUndefined()
  })

  it('check and build a video job', () => {
    const model = videoModel()
    expect(checkRemoteVideoRequest(videoRequest(), model)).toBe('create')
    expect(() => checkRemoteVideoRequest(videoRequest({ remote: { durationSecs: 5 } }), model)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
    expect(() => checkRemoteVideoRequest(videoRequest({ workflow: 'image-to-video' }), model)).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    )
    expect(
      videoGenerationJob(videoRequest({ remote: { generateAudio: true } }), model, 'create', {}, undefined)
    ).toMatchObject({
      durationSecs: 8,
      resolution: '720p',
      generateAudio: true,
    })
  })

  it('creep a time fraction toward its cap', () => {
    expect(timeFraction(0, 1000)).toBe(0)
    expect(timeFraction(1000, 1000)).toBeGreaterThan(0.5)
    expect(timeFraction(1e9, 1000)).toBeCloseTo(0.95)
  })
})

describe('remote image jobs', () => {
  it('run through the shared table and events into the gallery, without the local busy slot', async () => {
    const f = fakes()
    const { s, events } = service(f)
    const { jobId } = await s.generate(imageRequest({ batchSize: 2, seed: 10 }))
    expect((await s.getStatus()).activeJob).toBeNull()
    const job = await settled(s, jobId)
    expect(job.state).toBe('completed')
    expect(job.outputs).toHaveLength(2)
    expect(job.outputs[0]?.recipe).toMatchObject({
      engine: { kind: 'remote', provider: 'acme', api: 'openai-images' },
      model: { modelId: 'img-1', family: 'acme', displayName: 'Image One' },
      seed: 10,
    })
    expect(events.filter((e) => e.name === 'diffusion:job').length).toBeGreaterThanOrEqual(3)
    expect(events.some((e) => e.name === 'diffusion:progress')).toBe(true)
    expect((await s.listGallery({ offset: 0, limit: 10 }).catch(() => ({ total: -1 }))).total).toBe(-1)
  })

  it('keep a JPEG as it came', async () => {
    const f = fakes()
    f.image = { ...f.image, generate: async () => [{ bytes: JPEG_STUB, mime: 'image/jpeg' }] }
    const { s } = service(f)
    const { jobId } = await s.generate(imageRequest())
    const job = await settled(s, jobId)
    expect(job.outputs[0]?.path.endsWith('.jpg')).toBe(true)
  })

  it('fail with the provider code and say so in an error event', async () => {
    const f = fakes()
    f.image = {
      ...f.image,
      generate: async () => Promise.reject(diffusionError('REMOTE_CONTENT_BLOCKED', 'blocked')),
    }
    const { s, events } = service(f)
    const { jobId } = await s.generate(imageRequest())
    const job = await settled(s, jobId)
    expect(job).toMatchObject({ state: 'failed', error: { code: 'REMOTE_CONTENT_BLOCKED' } })
    expect(events.some((e) => e.name === 'diffusion:error')).toBe(true)
  })

  it('cancel by aborting the provider call, never stopping a server', async () => {
    const f = fakes()
    f.image = {
      ...f.image,
      generate: (ctx) =>
        new Promise((_resolve, reject) => {
          f.signals.push(ctx.signal)
          ctx.signal.addEventListener('abort', () => reject(diffusionError('CANCELLED', 'x')))
        }),
    }
    const { s } = service(f)
    const { jobId } = await s.generate(imageRequest())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await s.cancelJob(jobId)).toEqual({ cancelled: true, serverStopped: false })
    expect(f.signals[0]?.aborted).toBe(true)
    expect((await settled(s, jobId)).state).toBe('cancelled')
  })

  it('refuse past the cap, without a gateway, and for an unknown provider', async () => {
    const f = fakes()
    f.image = { ...f.image, generate: () => new Promise(() => {}) }
    const { s } = service(f, { maxRemoteJobs: 1 })
    await s.generate(imageRequest())
    await expect(s.generate(imageRequest())).rejects.toMatchObject({ code: 'JOB_BUSY' })
    await expect(
      s.generate(imageRequest({ target: { provider: 'other', model: 'x' } }))
    ).rejects.toMatchObject({
      code: 'REMOTE_NOT_CONFIGURED',
    })
    const bare = service(fakes(), { gateway: false }).s
    await expect(bare.generate(imageRequest())).rejects.toMatchObject({ code: 'REMOTE_NOT_CONFIGURED' })
  })
})

describe('remote video jobs', () => {
  it('submit once, poll to the end, save an MP4 and forget the stored job', async () => {
    const f = fakes()
    const { s } = service(f)
    const { jobId } = await s.generateVideo(videoRequest())
    const job = await settled(s, jobId, 'video')
    expect(job.state).toBe('completed')
    expect(f.submits).toBe(1)
    expect(job.outputs[0]).toMatchObject({ durationSecs: 4 })
    expect(job.outputs[0]?.path.endsWith('.mp4')).toBe(true)
    expect(await new RemoteJobStore(layout.diffusion.remoteJobsFile).list()).toEqual([])
  })

  it('retry a poll that failed in transit, and fail the job on a provider failure', async () => {
    const f = fakes()
    let n = 0
    f.video = {
      ...f.video,
      poll: async () => {
        n += 1
        if (n === 1) throw diffusionError('REMOTE_UNAVAILABLE', 'flaky')
        return { state: 'failed', error: diffusionError('REMOTE_REJECTED', 'bad prompt') }
      },
    }
    const { s } = service(f)
    const { jobId } = await s.generateVideo(videoRequest())
    expect(await settled(s, jobId, 'video')).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_REJECTED' },
    })
    expect(n).toBe(2)
  })

  it('are followed again after a restart, without a second submit', async () => {
    const store = new RemoteJobStore(layout.diffusion.remoteJobsFile)
    await store.put({
      jobId: 'a'.repeat(32),
      target: { provider: 'acme', model: 'vid-1' },
      submission: { id: 'up-9' },
      request: videoRequest(),
      createdAtMs: Date.now() - 2000,
      startedAtMs: Date.now() - 1000,
    })
    const f = fakes()
    f.polls = [{ state: 'completed', result: { url: 'x' } }]
    const { s } = service(f)
    await s.configure({ dataFolder })
    s.start()
    const job = await settled(s, 'a'.repeat(32), 'video')
    expect(job.state).toBe('completed')
    expect(f.submits).toBe(0)
    expect(await readdir(layout.diffusion.defaultVideoOutputDir)).toContain(`${'a'.repeat(32)}.mp4`)
  })

  it('keep the stored job when the core shuts down mid-clip', async () => {
    const f = fakes()
    f.video = { ...f.video, poll: async () => ({ state: 'running' }) }
    const { s } = service(f)
    await s.generateVideo(videoRequest())
    await new Promise((resolve) => setTimeout(resolve, 20))
    await s.shutdown()
    expect(
      (await new RemoteJobStore(layout.diffusion.remoteJobsFile).list()).map((j) => j.submission.id)
    ).toEqual(['up-1'])
  })

  it('refuse an estimate: a provider says nothing in advance', async () => {
    const { s } = service(fakes())
    await expect(s.estimateVideo(videoRequest())).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
  })
})

describe('a clip resumed long after its start', () => {
  it('fails as timed out instead of polling for ever', async () => {
    const store = new RemoteJobStore(layout.diffusion.remoteJobsFile)
    await store.put({
      jobId: 'b'.repeat(32),
      target: { provider: 'acme', model: 'vid-1' },
      submission: { id: 'up-old' },
      request: videoRequest(),
      createdAtMs: 1,
      startedAtMs: 2,
    })
    const { s } = service(fakes())
    await s.configure({ dataFolder })
    s.start()
    expect(await settled(s, 'b'.repeat(32), 'video')).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_TIMEOUT' },
    })
    expect(await store.list()).toEqual([])
  })
})

describe('the facades on remote models', () => {
  it('run an image job to its end, and throw its error', async () => {
    const f = fakes()
    const { s } = service(f)
    const outcome = await s.runImageJob(imageRequest())
    expect(outcome.images).toHaveLength(1)
    f.image = {
      ...f.image,
      generate: async () => Promise.reject(diffusionError('REMOTE_QUOTA', 'no credit')),
    }
    await expect(s.runImageJob(imageRequest())).rejects.toMatchObject({ code: 'REMOTE_QUOTA' })
  })

  it('run a clip to its end, and throw its error', async () => {
    const f = fakes()
    const { s } = service(f)
    expect((await s.runVideoJob(videoRequest())).job.state).toBe('completed')
    f.video = {
      ...f.video,
      submit: async () => Promise.reject(diffusionError('REMOTE_AUTH_FAILED', 'bad key')),
    }
    await expect(s.runVideoJob(videoRequest())).rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' })
  })

  it('find a public model and start through the backends the public server uses', async () => {
    const { s } = service(fakes())
    const images = s.imagesBackend()
    expect(images.find?.('named')).toEqual({ provider: 'acme', model: 'img-1' })
    expect((await (await images.start(imageRequest())).done).ok).toBe(true)
    const videos = s.videosBackend()
    expect(videos.find?.('named')).toEqual({ provider: 'acme', model: 'vid-1' })
    expect((await (await videos.start(videoRequest())).done).ok).toBe(true)
    const bare = service(fakes(), { gateway: false }).s
    expect(bare.imagesBackend().find).toBeUndefined()
  })
})
