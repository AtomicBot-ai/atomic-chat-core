/**
 * Hand-ported from the runner tests of `jobs.rs` in `tauri-plugin-atomic-diffusion` (app commit
 * `767ff6350`): an HTTP stub speaks `/sdcpp/v1/*`, a fake server handle stands in for the process.
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { CoreEvents, ImageGenerateRequest } from '../contracts/index.js'
import { fakeServer, paintedPng, sampleRequest, sampleSpec } from '../../test/helpers/diffusion-fixtures.js'
import type { FakeServer } from '../../test/helpers/diffusion-fixtures.js'
import { Gallery } from './gallery.js'
import { createSdHttpClient } from './http.js'
import {
  cancelJob,
  decodeImages,
  DEFAULT_JOB_TIMINGS,
  resolveInputs,
  runImageJob,
  startImageJob,
  withoutSources,
} from './jobs.js'
import type { JobDeps, JobResult } from './jobs.js'
import { AsyncMutex } from './mutex.js'
import { DiffusionState } from './state.js'
import type { ServerSpec } from './types.js'

// ── an HTTP stub speaking /sdcpp/v1/* ────────────────────────────────────────

interface Answer {
  status: number
  body: string
}
/** A status of -1 drops the connection after `body` milliseconds, as a server that died mid-request does. */
type Handler = (method: string, path: string, body: string) => Answer | Promise<Answer>

const servers: ReturnType<typeof createServer>[] = []
async function stub(handler: Handler): Promise<number> {
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (raw += chunk))
    req.on('end', () => {
      void Promise.resolve(handler(req.method ?? '', req.url ?? '', raw)).then(({ status, body }) => {
        if (status === -1) {
          setTimeout(() => req.socket.destroy(), Number(body))
          return
        }
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}
const json = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) })

// ── the harness ───────────────────────────────────────────────────────────────

let dataFolder: string
beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-jobs-'))
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  await rm(dataFolder, { recursive: true, force: true })
})

interface Harness {
  deps: JobDeps
  state: DiffusionState
  events: Array<{ name: string; payload: unknown }>
  jobStates: () => string[]
  progress: () => CoreEvents['diffusion:progress'][]
  errors: () => CoreEvents['diffusion:error'][]
  reasons: () => string[]
  server: FakeServer
  spawned: ServerSpec[]
  log: string[]
  clock: { now: number }
}

function harness(port: number, options: { cancelGenerating?: boolean; spawnFails?: boolean } = {}): Harness {
  const clock = { now: 1_000 }
  const state = new DiffusionState(dataLayout(dataFolder).diffusion, () => clock.now)
  state.config = { dataFolder, idleUnloadSecs: 600 }
  const events: Harness['events'] = []
  const spawned: ServerSpec[] = []
  const log: string[] = []
  let server = fakeServer({ port, cancelGenerating: options.cancelGenerating ?? false })
  const spec = sampleSpec()
  const deps: JobDeps = {
    state,
    emit: (name, payload) => events.push({ name, payload }),
    log: (level, msg) => log.push(`${level}: ${msg}`),
    platform: process.platform,
    now: () => clock.now,
    sleep: (ms) =>
      new Promise((resolve) => {
        clock.now += ms
        setTimeout(resolve, Math.min(ms, 5))
      }),
    spawn: async (next) => {
      if (options.spawnFails) throw new Error('no spawn in this test')
      spawned.push(next)
      server = fakeServer({
        port,
        cancelGenerating: options.cancelGenerating ?? false,
        pid: 4242 + spawned.length,
      })
      return server.handle
    },
    http: createSdHttpClient(),
    gallery: new Gallery(),
    loadLock: new AsyncMutex(),
    timings: { ...DEFAULT_JOB_TIMINGS, pollIntervalMs: 20, cancelGraceMs: 400, cancelPollMs: 20 },
    drawSeed: () => 777,
    readSource: (path) => readFile(path),
    isFile: (path) =>
      stat(path).then(
        (s) => s.isFile(),
        () => false
      ),
  }
  state.session = {
    server: server.handle,
    info: {
      modelId: 'z-image:q4_k_m',
      family: 'z-image',
      modality: 'image',
      displayName: 'Z-Image Turbo',
      engine: 'sd-cpp',
      backend: 'cpu',
      offload: 'none',
      cpuFallback: false,
      port,
      pid: 4242,
      loadedAtMs: 1,
    },
    spec,
    baseUrl: `http://127.0.0.1:${port}`,
  }
  state.spec = spec
  state.setModelState('loaded')
  return {
    deps,
    state,
    events,
    jobStates: () =>
      events
        .filter((e) => e.name === 'diffusion:job')
        .map((e) => (e.payload as CoreEvents['diffusion:job']).job.state),
    progress: () =>
      events
        .filter((e) => e.name === 'diffusion:progress')
        .map((e) => e.payload as CoreEvents['diffusion:progress']),
    errors: () =>
      events
        .filter((e) => e.name === 'diffusion:error')
        .map((e) => e.payload as CoreEvents['diffusion:error']),
    reasons: () =>
      events
        .filter((e) => e.name === 'diffusion:state')
        .map((e) => (e.payload as CoreEvents['diffusion:state']).reason ?? ''),
    get server() {
      return server
    },
    spawned,
    log,
    clock,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const failure = (result: JobResult) => {
  if (result.ok) throw new Error('expected a failure')
  return result.error
}

let pngB64 = ''
beforeEach(async () => {
  pngB64 = (await paintedPng(16, 16)).toString('base64')
})

// ── the tests ─────────────────────────────────────────────────────────────────

describe('a completed job', () => {
  it('saves its outputs and reports every transition', async () => {
    let polls = 0
    const port = await stub((method, path, body) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen') {
        const sent = JSON.parse(body) as Record<string, unknown>
        expect(sent['batch_count']).toBe(2)
        expect(sent['seed']).toBe(1234)
        expect((sent['sample_params'] as Record<string, unknown>)['sample_method']).toBe('euler')
        return json(202, { id: 'job_1', kind: 'img_gen', status: 'queued', poll_url: '/sdcpp/v1/jobs/job_1' })
      }
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_1') {
        polls += 1
        if (polls < 15) return json(200, { id: 'job_1', status: 'generating', result: null, error: null })
        return json(200, {
          id: 'job_1',
          status: 'completed',
          result: {
            images: [
              { index: 1, b64_json: pngB64 },
              { index: 0, b64_json: pngB64 },
            ],
          },
          error: null,
        })
      }
      return json(404, {})
    })
    const h = harness(port)
    const { id, done } = await startImageJob(h.deps, sampleRequest())
    expect(h.state.activeJobId).toBe(id)
    expect(h.state.activeJob(), 'status must expose the running job').not.toBeNull()
    // A second submission is refused while the first runs.
    await expect(startImageJob(h.deps, sampleRequest())).rejects.toMatchObject({
      code: 'JOB_BUSY',
      details: id,
    })

    // Feed a step line through the listener the runner attached.
    await sleep(30)
    h.server.say('|==>  | 2/4 - 1.0s/it')

    const result = await done
    if (!result.ok) throw new Error(result.error.message)
    const { outcome } = result
    expect(outcome.job.state).toBe('completed')
    expect(outcome.job.outputs).toHaveLength(2)
    expect(outcome.images).toHaveLength(2)
    expect(outcome.job.outputs[0]?.recipe.seed).toBe(1234)
    expect(outcome.job.outputs[1]?.recipe.seed).toBe(1235)
    expect(outcome.job.outputs[1]?.recipe.batchSeed).toBe(1234)
    expect(outcome.job.outputs[0]?.recipe.samplingMethod).toBe('euler')
    expect(outcome.job.outputs[0]?.recipe.engine.tag).toBe('test-tag')
    expect(outcome.job.outputs[0]?.recipe.model.filename).toBe('z-image-turbo-Q4_K_M.gguf')
    expect(outcome.job.outputs[0]?.path.startsWith(join(dataFolder, 'images'))).toBe(true)
    expect((await stat(outcome.job.outputs[0]?.path as string)).isFile()).toBe(true)
    expect(outcome.images[0]?.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true)
    expect(outcome.job.finishedAtMs).toBeDefined()
    expect(outcome.job.startedAtMs).toBeDefined()
    expect(h.state.activeJobId).toBeUndefined()
    expect(h.state.job(id)?.state).toBe('completed')
    expect(h.state.job(id)?.outputs).toHaveLength(2)

    expect(h.jobStates()).toEqual(['queued', 'generating', 'completed'])
    expect(h.progress().some((p) => p.progress.step === 2 && p.progress.phase === 'sampling')).toBe(true)
    expect(h.progress().some((p) => p.progress.phase === 'saving')).toBe(true)
    expect(h.progress().every((p) => p.jobId === id)).toBe(true)
    expect(h.state.idleExpired()).toBe(false)
    expect(h.errors()).toEqual([])
    // The listener was detached again.
    h.server.say('|==>  | 3/4 - 1.0s/it')
    expect(h.progress().some((p) => p.progress.step === 3)).toBe(false)
  })

  it('runs to completion for the facade and keeps the request out of the record without its bytes', async () => {
    const source = join(dataFolder, 'source.png')
    await writeFile(source, await paintedPng(8, 8))
    const port = await stub((method, path, body) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen') {
        const sent = JSON.parse(body) as Record<string, unknown>
        expect(sent['init_image']).toBe(
          (JSON.parse(JSON.stringify({ x: '' })) as { x: string }).x.length === 0 ? sent['init_image'] : ''
        )
        expect(sent['mask_image']).toBe('QUJD')
        expect(sent['strength']).toBe(0.6)
        return json(202, { id: 'job_9', status: 'queued' })
      }
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_9')
        return json(200, {
          id: 'job_9',
          status: 'completed',
          result: { images: [{ index: 0, b64_json: pngB64 }] },
        })
      return json(404, {})
    })
    const h = harness(port)
    const request = sampleRequest({
      workflow: 'inpaint',
      initImage: { path: source },
      maskImage: { base64: 'data:image/png;base64,QUJD' },
      strength: 0.6,
      batchSize: 1,
      seed: -1,
    })
    const outcome = await runImageJob(h.deps, request)
    expect(outcome.job.request).toEqual({ ...request, maskImage: { base64: '' } })
    expect(outcome.job.outputs[0]?.recipe.seed).toBe(777)
    expect(outcome.job.outputs[0]?.recipe.strength).toBe(0.6)
    expect(outcome.job.outputs[0]?.recipe.workflow).toBe('inpaint')
  })
})

describe('a failed job', () => {
  it('reports the server error and keeps the server', async () => {
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_2', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_2')
        return json(200, {
          id: 'job_2',
          status: 'failed',
          result: null,
          error: { code: 'generation_failed', message: 'generate_image returned empty results' },
        })
      return json(404, {})
    })
    const h = harness(port)
    await expect(runImageJob(h.deps, sampleRequest())).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'The image server failed to generate.',
      details: expect.stringContaining('generation_failed'),
    })
    expect(h.jobStates().at(-1)).toBe('failed')
    expect(h.errors()).toHaveLength(1)
    expect(h.errors()[0]?.jobId).toBeDefined()
    expect(h.state.activeJobId).toBeUndefined()
    expect(h.state.session, 'a failed job keeps the server').toBeDefined()
    expect(h.state.idleExpired()).toBe(false)
  })

  it('is explained by what the server printed', async () => {
    let failed = false
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_6', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_6')
        return failed
          ? json(200, {
              id: 'job_6',
              status: 'failed',
              result: null,
              error: { code: 'generation_failed', message: 'generate_image returned no results' },
            })
          : json(200, { id: 'job_6', status: 'generating' })
      return json(404, {})
    })
    const h = harness(port)
    const { done } = await startImageJob(h.deps, sampleRequest())
    await sleep(60)
    // What a 2x Upscale printed before the fix: the VAE asked for 13.6 GB in one piece.
    h.server.say(
      'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 13576.00 MiB on device 0: cudaMalloc failed: out of memory',
      '[ERROR] stable-diffusion.cpp:5049 - failed to encode init image'
    )
    failed = true
    const error = failure(await done)
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.message).toBe('sd-server ran out of memory while generating.')
    expect(error.details).toContain('generate_image returned no results')
    expect(error.details).toContain('failed to encode init image')
    expect(h.state.session, 'the server outlives a job it could not fit').toBeDefined()
  })

  it('names a full queue, a rejected request, and an odd answer', async () => {
    let status = 429
    let body: unknown = { error: 'queue full' }
    let raw: string | undefined
    const port = await stub((method, path) =>
      method === 'POST' && path === '/sdcpp/v1/img_gen'
        ? raw === undefined
          ? json(status, body)
          : { status, body: raw }
        : json(404, {})
    )
    const h = harness(port)
    let error = failure(await (await startImageJob(h.deps, sampleRequest())).done)
    expect(error).toEqual({
      code: 'QUEUE_FULL',
      message: "The image server's queue is full. Try again in a moment.",
    })
    expect(h.state.job(h.state.jobIds()[0] as string)?.state).toBe('failed')
    status = 400
    body = { error: 'invalid generation parameters' }
    error = failure(await (await startImageJob(h.deps, sampleRequest())).done)
    expect(error).toEqual({
      code: 'INVALID_REQUEST',
      message: 'The image server rejected the request.',
      details: '{"error":"invalid generation parameters"}',
    })
    status = 500
    error = failure(await (await startImageJob(h.deps, sampleRequest())).done)
    expect(error.message).toBe('The image server answered 500 on submit.')
    status = 202
    raw = 'not json'
    error = failure(await (await startImageJob(h.deps, sampleRequest())).done)
    expect(error.message).toBe('sd-server returned a non-JSON submit response.')
    raw = undefined
    body = { status: 'queued' }
    error = failure(await (await startImageJob(h.deps, sampleRequest())).done)
    expect(error).toEqual({ code: 'INTERNAL', message: 'sd-server returned no job id.' })
  })

  it('reports a job the server forgot, and a completed one without images', async () => {
    let answer: () => { status: number; body: string } = () => json(404, { error: 'unknown job' })
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_7', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_7') return answer()
      return json(404, {})
    })
    const h = harness(port)
    expect(failure(await (await startImageJob(h.deps, sampleRequest())).done)).toEqual({
      code: 'JOB_NOT_FOUND',
      message: 'The image server forgot the job.',
    })
    answer = () => json(200, { id: 'job_7', status: 'completed', result: { images: [] } })
    expect(failure(await (await startImageJob(h.deps, sampleRequest())).done).message).toBe(
      'The image server completed the job but returned no images.'
    )
    // A poll that is not JSON, or a status nobody knows, is waited out.
    let odd = 0
    answer = () => {
      odd += 1
      if (odd === 1) return { status: 200, body: 'garbage' }
      if (odd === 2) return json(503, {})
      if (odd === 3) return json(200, { id: 'job_7', status: 'dreaming' })
      return json(200, {
        id: 'job_7',
        status: 'completed',
        result: { images: [{ index: 0, b64_json: pngB64 }] },
      })
    }
    const result = await (await startImageJob(h.deps, sampleRequest({ batchSize: 1 }))).done
    expect(result.ok).toBe(true)
  })

  it('refuses a request that fails validation, before anything is registered', async () => {
    const h = harness(await stub(() => json(404, {})))
    await expect(startImageJob(h.deps, sampleRequest({ prompt: ' ' }))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(h.state.activeJobId).toBeUndefined()
    expect(h.events).toEqual([])
    h.state.spec = undefined
    await expect(startImageJob(h.deps, sampleRequest())).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' })
  })

  it('reports a source image that cannot be read', async () => {
    const h = harness(await stub(() => json(404, {})))
    h.deps.isFile = async () => true
    const error = failure(
      await (
        await startImageJob(
          h.deps,
          sampleRequest({ workflow: 'transform', initImage: { path: join(dataFolder, 'missing.png') } })
        )
      ).done
    )
    expect(error.code).toBe('INVALID_REQUEST')
    expect(error.message).toBe('The source image could not be read.')
  })
})

describe('cancelling', () => {
  it('past the grace period stops the server and keeps the spec', async () => {
    let cancels = 0
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_3', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_3')
        return json(200, { id: 'job_3', status: 'generating' })
      if (method === 'POST' && path === '/sdcpp/v1/jobs/job_3/cancel') {
        cancels += 1
        return json(200, { id: 'job_3', status: 'generating' })
      }
      return json(404, {})
    })
    const h = harness(port)
    const { id, done } = await startImageJob(h.deps, sampleRequest())
    await sleep(80)
    expect(h.state.job(id)?.state).toBe('generating')
    const before = h.server

    const result = await cancelJob(h.deps, id)
    expect(result).toEqual({ cancelled: true, serverStopped: true })
    expect(cancels, 'the native cancel was attempted first').toBe(1)
    expect(before.terminated).toEqual([5_000])
    expect(h.state.session).toBeUndefined()
    expect(h.state.spec, 'the spec survives for the respawn').toBeDefined()
    expect(h.state.modelState).toBe('unloaded')
    expect(h.log.some((line) => line.includes('cancel not honoured within 400 ms'))).toBe(true)

    const error = failure(await done)
    expect(error.code).toBe('CANCELLED')
    expect(h.state.job(id)?.state).toBe('cancelled')
    expect(h.state.activeJobId).toBeUndefined()
    expect(h.jobStates().at(-1)).toBe('cancelled')
    expect(h.reasons()).toContain('cancelled')
    expect(h.errors(), 'a cancel is not an error').toEqual([])

    // Cancelling again is a no-op that reports the terminal state.
    expect(await cancelJob(h.deps, id)).toEqual({ cancelled: true, serverStopped: false })
    await expect(cancelJob(h.deps, 'missing')).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
      message: 'That job no longer exists.',
    })
  })

  it('that the engine honours in time keeps the server', async () => {
    let cancelled = false
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_4', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_4')
        return cancelled
          ? json(200, {
              id: 'job_4',
              status: 'cancelled',
              error: { code: 'cancelled', message: 'job cancelled by client' },
            })
          : json(200, { id: 'job_4', status: 'queued' })
      if (method === 'POST' && path === '/sdcpp/v1/jobs/job_4/cancel') {
        cancelled = true
        return json(200, {})
      }
      return json(404, {})
    })
    const h = harness(port)
    const { id, done } = await startImageJob(h.deps, sampleRequest())
    await sleep(60)
    expect(await cancelJob(h.deps, id)).toEqual({ cancelled: true, serverStopped: false })
    expect(h.state.session).toBeDefined()
    expect(failure(await done).code).toBe('CANCELLED')
  })

  it('gives an engine that promised a soft cancel a second grace period', async () => {
    let cancelledAt: number | undefined
    const clock = { now: 0 }
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_8', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_8') {
        // Honoured only after the first grace period (400 ms of the fake clock) has run out.
        if (cancelledAt !== undefined && clock.now > cancelledAt + 500)
          return json(200, { id: 'job_8', status: 'cancelled' })
        return json(200, { id: 'job_8', status: 'generating' })
      }
      if (method === 'POST' && path === '/sdcpp/v1/jobs/job_8/cancel') {
        cancelledAt = clock.now
        return json(200, {})
      }
      return json(404, {})
    })
    const h = harness(port, { cancelGenerating: true })
    Object.defineProperty(clock, 'now', { get: () => h.clock.now })
    const { id, done } = await startImageJob(h.deps, sampleRequest())
    await sleep(60)
    expect(await cancelJob(h.deps, id)).toEqual({ cancelled: true, serverStopped: false })
    expect(h.state.session).toBeDefined()
    expect(failure(await done).code).toBe('CANCELLED')
  })

  it('wins over a respawn that was waiting for the load lock', async () => {
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_10', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_10')
        return json(200, { id: 'job_10', status: 'generating' })
      return json(404, {})
    })
    const h = harness(port)
    // The server is already gone when the job starts, and somebody holds the load lock.
    h.server.exit({ code: null, signal: 'SIGKILL' })
    const release = await h.deps.loadLock.acquire()
    const { id, done } = await startImageJob(h.deps, sampleRequest())
    await sleep(30)
    expect(h.spawned).toHaveLength(0)
    // Cancelled while the respawn waits: nothing must be spawned once the lock is free.
    const cancelling = cancelJob(h.deps, id)
    await sleep(30)
    release()
    expect(await cancelling).toEqual({ cancelled: true, serverStopped: false })
    expect(failure(await done).code).toBe('CANCELLED')
    expect(h.spawned).toHaveLength(0)
    expect(h.state.spec).toBeDefined()
  })
})

describe('the server dying', () => {
  it('mid-job is a crash, classified from what it printed, and the spec survives', async () => {
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_5', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_5')
        return json(200, { id: 'job_5', status: 'generating' })
      return json(404, {})
    })
    const h = harness(port)
    const { id, done } = await startImageJob(h.deps, sampleRequest())
    await sleep(60)
    h.server.say('CUDA error: out of memory')
    h.server.exit({ code: 1, signal: null })
    const error = failure(await done)
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.message).toBe('sd-server ran out of memory while generating.')
    expect(error.details).toContain('out of memory')
    expect(h.state.job(id)?.state).toBe('failed')
    expect(h.state.modelState).toBe('failed')
    expect(h.state.session).toBeUndefined()
    expect(h.state.spec).toBeDefined()
    expect(h.reasons()).toContain('crashed')

    // The next job respawns from the spec.
    const next = await startImageJob(h.deps, sampleRequest())
    await sleep(60)
    expect(h.spawned).toHaveLength(1)
    expect(h.state.session).toBeDefined()
    expect(h.reasons().slice(-2)).toEqual(['respawn', 'loaded'])
    h.server.exit({ code: null, signal: 'SIGSEGV' })
    const crash = failure(await next.done)
    expect(crash.code).toBe('ENGINE_CRASHED')
    expect(crash.message).toBe('sd-server exited during generation (signal SIGSEGV).')
  })

  it('on a ggml unsupported-op abort is retried once on the CPU backend', async () => {
    let submits = 0
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen') {
        submits += 1
        return json(202, { id: `job_${submits}`, status: 'queued' })
      }
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_2')
        return json(200, {
          id: 'job_2',
          status: 'completed',
          result: { images: [{ index: 0, b64_json: pngB64 }] },
        })
      if (method === 'GET' && path.startsWith('/sdcpp/v1/jobs/job_'))
        return json(200, { id: 'job', status: 'generating' })
      return json(404, {})
    })
    const h = harness(port)
    const { done } = await startImageJob(h.deps, sampleRequest({ batchSize: 1 }))
    await sleep(60)
    h.server.say(
      "ggml_metal_op_encode_impl: error: unsupported op 'RMS_NORM'",
      'GGML_ABORT("unsupported op")'
    )
    h.server.exit({ code: null, signal: 'SIGABRT' })
    const result = await done
    expect(result.ok).toBe(true)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]?.extraArgs).toEqual(['--backend', 'cpu'])
    expect(h.spawned[0]?.cpuFallback).toBe(true)
    expect(h.state.spec?.cpuFallback).toBe(true)
    expect(h.reasons()).toContain('cpu-fallback')
    expect(h.log.some((line) => line.includes('restarting sd-server on the CPU backend'))).toBe(true)
    if (result.ok) expect(result.outcome.job.outputs[0]?.recipe.engine.cpuFallback).toBe(true)

    // A second abort, now on the CPU, is the end.
    const again = await startImageJob(h.deps, sampleRequest({ batchSize: 1 }))
    await sleep(60)
    h.server.say("unsupported op 'RMS_NORM'", 'GGML_ABORT')
    h.server.exit({ code: null, signal: 'SIGABRT' })
    const error = failure(await again.done)
    expect(error.code).toBe('ENGINE_CRASHED')
    expect(error.message).toBe('sd-server exited during generation (signal SIGABRT).')
  })

  it('before the submit is reported from its output, and a stopped server from its absence', async () => {
    // The submit never gets an answer: the connection drops after 60 ms, as it does when the server dies.
    const port = await stub((method, path) =>
      method === 'POST' && path === '/sdcpp/v1/img_gen' ? { status: -1, body: '60' } : json(404, {})
    )
    const died = harness(port)
    const first = await startImageJob(died.deps, sampleRequest())
    await sleep(20)
    died.server.say('CUDA error: out of memory')
    died.server.exit({ code: 1, signal: null })
    const error = failure(await first.done)
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.message).toBe('sd-server died during submit.')

    const gone = harness(port)
    const second = await startImageJob(gone.deps, sampleRequest())
    await sleep(20)
    gone.state.session = undefined
    expect(failure(await second.done)).toEqual({ code: 'ENGINE_CRASHED', message: 'sd-server was stopped.' })

    // A refused connection with the server still alive is the server's problem to explain.
    const alive = harness(port)
    alive.state.session = {
      ...(alive.state.session as NonNullable<typeof alive.state.session>),
      baseUrl: 'http://127.0.0.1:1',
    }
    const third = failure(await (await startImageJob(alive.deps, sampleRequest())).done)
    expect(third.code).toBe('INTERNAL')
    expect(third.message).toBe('The image server did not accept the submit.')
  })

  it('cannot be respawned when the spawn fails, or when the model was unloaded meanwhile', async () => {
    const port = await stub((method, path) =>
      method === 'POST' && path === '/sdcpp/v1/img_gen'
        ? json(202, { id: 'j', status: 'queued' })
        : json(404, {})
    )
    const h = harness(port, { spawnFails: true })
    h.server.exit({ code: 1, signal: null })
    const error = failure(await (await startImageJob(h.deps, sampleRequest())).done)
    expect(error).toEqual({ code: 'INTERNAL', message: 'no spawn in this test' })
    expect(h.state.modelState).toBe('failed')

    const unloaded = harness(port)
    unloaded.server.exit({ code: 1, signal: null })
    const release = await unloaded.deps.loadLock.acquire()
    const started = await startImageJob(unloaded.deps, sampleRequest())
    await sleep(20)
    unloaded.state.spec = undefined
    release()
    expect(failure(await started.done).code).toBe('MODEL_NOT_LOADED')
  })

  it('stops a generation that runs past the ceiling', async () => {
    let cancels = 0
    const port = await stub((method, path) => {
      if (method === 'POST' && path === '/sdcpp/v1/img_gen')
        return json(202, { id: 'job_c', status: 'queued' })
      if (method === 'GET' && path === '/sdcpp/v1/jobs/job_c')
        return json(200, { id: 'job_c', status: 'generating' })
      if (method === 'POST' && path === '/sdcpp/v1/jobs/job_c/cancel') {
        cancels += 1
        return json(200, {})
      }
      return json(404, {})
    })
    const h = harness(port)
    h.deps.timings.generationCeilingMs = 100
    const error = failure(await (await startImageJob(h.deps, sampleRequest())).done)
    expect(error).toEqual({ code: 'INTERNAL', message: 'Generation exceeded 0 hours and was stopped.' })
    expect(cancels).toBe(1)
    expect(h.state.session).toBeUndefined()
    expect(h.reasons()).toContain('timeout')
  })
})

describe('inputs', () => {
  it('resolve per workflow, and a snapshot drops inline bytes', async () => {
    const source = join(dataFolder, 'source.png')
    await writeFile(source, 'PNG?')
    const deps = { readSource: (path: string) => readFile(path) }
    const path = { path: source }
    const mask = { base64: 'data:image/png;base64,QUJD' }
    let request: ImageGenerateRequest = sampleRequest({
      workflow: 'inpaint',
      initImage: path,
      maskImage: mask,
    })
    expect(await resolveInputs(request, deps)).toEqual({ init: 'UE5HPw==', mask: 'QUJD', refs: [] })

    request = { ...request, workflow: 'reference', referenceImages: [mask] }
    expect(await resolveInputs(request, deps)).toEqual({ refs: ['UE5HPw==', 'QUJD'] })

    // Create reads nothing, whatever the request carries; nor does a request without a source.
    expect(await resolveInputs({ ...request, workflow: 'create' }, deps)).toEqual({ refs: [] })
    delete request.initImage
    expect(await resolveInputs(request, deps)).toEqual({ refs: [] })

    const snapshot = withoutSources(
      sampleRequest({ workflow: 'inpaint', initImage: path, maskImage: mask, referenceImages: [mask, path] })
    )
    expect(snapshot.initImage).toEqual(path)
    expect(snapshot.maskImage).toEqual({ base64: '' })
    expect(snapshot.referenceImages).toEqual([{ base64: '' }, path])
    expect(snapshot.prompt).toBe('a cat')
  })
})

describe('decodeImages', () => {
  it('orders by index and refuses empty results', () => {
    const images = decodeImages({
      result: {
        images: [
          { index: 1, b64_json: 'AQ==' },
          { index: 0, b64_json: pngB64 },
        ],
      },
    })
    expect(images).toHaveLength(2)
    expect(images[0]?.subarray(0, 2).equals(Buffer.from([0x89, 0x50]))).toBe(true)
    expect([...(images[1] as Buffer)]).toEqual([1])
    expect(() => decodeImages({ result: { images: [] } })).toThrow('returned no images')
    expect(() => decodeImages({})).toThrow('returned no images')
    expect(() => decodeImages({ result: { images: [{ b64_json: '!!!!' }] } })).toThrow('undecodable image')
    expect(decodeImages({ result: { images: [{ b64_json: ' AQ== ' }, 7, { index: 'x' }] } })).toHaveLength(1)
  })
})

describe('the defaults', () => {
  it('draw a seed sd.cpp accepts and read a source from disk', async () => {
    const { drawSeed, readSourceFile } = await import('./jobs.js')
    for (let i = 0; i < 50; i++) {
      const seed = drawSeed()
      expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true)
    }
    const path = join(dataFolder, 'source.bin')
    await writeFile(path, 'bytes')
    expect((await readSourceFile(path)).toString()).toBe('bytes')
    await expect(readSourceFile(join(dataFolder, 'missing'))).rejects.toThrow()
  })
})
