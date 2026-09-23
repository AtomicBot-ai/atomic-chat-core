import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvents, GalleryVideoItem, VideoGenerateRequest, VideoJob } from '../../contracts/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import { sampleVideoRecipe } from '../../../test/helpers/diffusion-fixtures.js'
import { closeAll, postJson, startPublic } from '../../../test/helpers/public-server.js'
import type { PublicServer } from './index.js'
import type { VideosBackend } from './types.js'
import { NO_VIDEO_MODEL_MESSAGE } from './videos.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-videos-'))
})
afterEach(async () => {
  await closeAll()
  await rm(dir, { recursive: true, force: true })
})

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5])

interface FakeVideos extends VideosBackend {
  requests: VideoGenerateRequest[]
  cancelled: string[]
  deleted: string[]
  records: Map<string, VideoJob>
  items: Map<string, GalleryVideoItem>
  modality: 'image' | 'video'
  present: boolean
}

function item(id: string, over: Partial<GalleryVideoItem> = {}): GalleryVideoItem {
  return {
    id,
    path: join(dir, `${id}.webm`),
    posterPath: null,
    width: 768,
    height: 512,
    fps: 24,
    frameCount: 25,
    durationSecs: 25 / 24,
    sizeBytes: WEBM.length,
    createdAtMs: 1_700_000_000_000,
    pinned: false,
    archived: false,
    recipe: sampleVideoRecipe({ jobId: id, seed: 5 }),
    ...over,
  }
}

function fakeVideos(): FakeVideos {
  let next = 1
  const fake: FakeVideos = {
    requests: [],
    cancelled: [],
    deleted: [],
    records: new Map(),
    items: new Map(),
    modality: 'video',
    present: true,
    loaded: () =>
      fake.present
        ? {
            modelId: 'ltx-2:q4_k_m',
            displayName: 'LTX-2.3 Distilled',
            modality: fake.modality,
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
        : undefined,
    start: async (request) => {
      fake.requests.push(request)
      const id = `v${next++}`
      fake.records.set(id, {
        id,
        state: 'queued',
        modelId: 'ltx-2:q4_k_m',
        request,
        createdAtMs: 1_700_000_000_000,
        progress: null,
        outputs: [],
      })
      return { id, done: new Promise(() => {}) }
    },
    job: (id) => fake.records.get(id) ?? null,
    jobs: () => [...fake.records.values()].reverse(),
    item: async (id) => fake.items.get(id) ?? null,
    list: async (options) => {
      const all = [...fake.items.values()].filter((i) => options.includeArchived || !i.archived)
      return {
        items: all.slice(options.offset, options.offset + options.limit),
        hasMore: false,
        total: all.length,
      }
    },
    cancel: async (id) => {
      fake.cancelled.push(id)
      const record = fake.records.get(id)
      if (record) record.state = 'cancelled'
    },
    delete: async (id) => {
      fake.deleted.push(id)
      fake.items.delete(id)
    },
  }
  return fake
}

async function server(videos?: VideosBackend) {
  const events: CoreEvents['api:request'][] = []
  const started = await startPublic({
    ...(videos ? { videos } : {}),
    emit: (name, payload) => {
      if (name === 'api:request') events.push(payload as CoreEvents['api:request'])
    },
    inspecting: () => false,
  })
  return { started, events }
}

const get = (started: PublicServer, path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${started.port}/v1${path}`, init)
const errorOf = async (res: Response) => ((await res.json()) as { error: Record<string, unknown> }).error
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('POST /v1/videos', () => {
  it('answers 503 without a video model, 400 for a bad body before that, and 405 for the wrong method', async () => {
    const { started, events } = await server()
    const none = await postJson(started, '/videos', { prompt: 'a cat' })
    expect(none.status).toBe(503)
    expect(await errorOf(none)).toEqual({
      message: NO_VIDEO_MODEL_MESSAGE,
      type: 'server_error',
      param: null,
      code: 'model_not_loaded',
    })
    // An image model is not a video model.
    const videos = fakeVideos()
    videos.modality = 'image'
    const { started: withImage } = await server(videos)
    expect((await postJson(withImage, '/videos', { prompt: 'a cat' })).status).toBe(503)
    videos.modality = 'video'
    expect((await postJson(withImage, '/videos', { prompt: 'a cat', model: 'sora-2' })).status).toBe(503)
    expect(videos.requests).toEqual([])
    const bad = await postJson(withImage, '/videos', { prompt: 'a cat', seconds: 'four' })
    expect(bad.status).toBe(400)
    expect(await errorOf(bad)).toMatchObject({ type: 'invalid_request_error', param: 'seconds' })
    const garbage = await get(withImage, '/videos', {
      method: 'POST',
      body: '{broken',
      headers: { 'content-type': 'application/json' },
    })
    expect(garbage.status).toBe(400)
    expect((await errorOf(garbage))['message']).toMatch(/^Invalid JSON body: /)
    const put = await get(withImage, '/videos', { method: 'PUT' })
    expect(put.status).toBe(405)
    expect(put.headers.get('allow')).toBe('GET, POST')
    expect((await get(withImage, '/videos/x/content', { method: 'DELETE' })).headers.get('allow')).toBe('GET')
    await settle()
    const finished = events
      .filter((e) => e.phase === 'finished')
      .map((e) => (e.phase === 'finished' ? e.observation : null))
    expect(finished.map((o) => [o?.endpoint, o?.status, o?.error_kind])).toEqual([
      ['videos', 503, 'not_found'],
    ])
  })

  it('queues a clip and answers its object at once, with the family defaults bound', async () => {
    const videos = fakeVideos()
    const { started, events } = await server(videos)
    const res = await postJson(started, '/videos', {
      prompt: ' a cat ',
      seconds: '2',
      seed: 42,
      model: 'LTX-2.3 Distilled',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: 'v1',
      object: 'video',
      model: 'ltx-2:q4_k_m',
      status: 'queued',
      progress: 0,
      created_at: 1_700_000_000,
      completed_at: null,
      expires_at: null,
      seconds: '2.04',
      size: '768x512',
      prompt: 'a cat',
      remixed_from_video_id: null,
      error: null,
      atomic: { job_id: 'v1', seed: null, path: null, poster_path: null },
    })
    expect(videos.requests).toEqual([
      {
        prompt: 'a cat',
        width: 768,
        height: 512,
        frames: 49,
        fps: 24,
        steps: 8,
        cfgScale: 1,
        seed: 42,
        samplingMethod: 'euler',
      },
    ])
    await settle()
    const finished = events.find((e) => e.phase === 'finished')
    expect(finished?.phase === 'finished' ? finished.observation : null).toMatchObject({
      endpoint: 'videos',
      status: 200,
      backend: 'atomic-diffusion',
      model_id: 'ltx-2:q4_k_m',
      error_kind: null,
    })
  })

  it('maps a refusal to start like the images facade', async () => {
    const videos = fakeVideos()
    videos.start = async () => {
      throw new AtomicCoreError('INVALID_REQUEST', 'Frames must be 8k+1 between 9 and 257.', 'frames=24')
    }
    const { started } = await server(videos)
    const res = await postJson(started, '/videos', { prompt: 'a cat' })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toEqual({
      message: 'Frames must be 8k+1 between 9 and 257. (frames=24)',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_request',
    })
    videos.start = async () => {
      throw new AtomicCoreError('JOB_BUSY', 'A video is already being generated.', 'v9')
    }
    expect((await postJson(started, '/videos', { prompt: 'a cat' })).status).toBe(429)
    videos.start = async () => ({ id: 'ghost', done: new Promise(() => {}) })
    const ghost = await postJson(started, '/videos', { prompt: 'a cat' })
    expect(ghost.status).toBe(500)
  })
})

describe('GET and DELETE /v1/videos/{id}', () => {
  it('polls the runner, falls back to the gallery, streams the clip and the poster, and 404s otherwise', async () => {
    const videos = fakeVideos()
    const { started, events } = await server(videos)
    await postJson(started, '/videos', { prompt: 'a cat' })
    const running = videos.records.get('v1') as VideoJob
    running.state = 'generating'
    running.progress = {
      phase: 'sampling',
      step: 2,
      totalSteps: 8,
      fraction: 0.25,
      etaSeconds: 9,
      elapsedMs: 5,
    }
    expect(await (await get(started, '/videos/v1')).json()).toMatchObject({
      status: 'in_progress',
      progress: 25,
    })
    expect((await get(started, '/videos/v1/content')).status).toBe(404)

    await writeFile(join(dir, 'v1.webm'), WEBM)
    const poster = Buffer.from('PNG-ish')
    await writeFile(join(dir, 'v1.thumb.png'), poster)
    const finished = item('v1', { posterPath: join(dir, 'v1.thumb.png') })
    running.state = 'completed'
    running.finishedAtMs = 1_700_000_004_000
    running.outputs = [finished]
    videos.items.set('v1', finished)
    expect(await (await get(started, '/videos/v1')).json()).toMatchObject({
      status: 'completed',
      progress: 100,
      atomic: { path: join(dir, 'v1.webm'), poster_path: join(dir, 'v1.thumb.png'), seed: 5 },
    })
    const content = await get(started, '/videos/v1/content')
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('video/webm')
    expect(content.headers.get('content-length')).toBe(String(WEBM.length))
    expect(content.headers.get('content-disposition')).toBe('inline; filename="v1.webm"')
    expect(Buffer.from(await content.arrayBuffer()).equals(WEBM)).toBe(true)
    const thumb = await get(started, '/videos/v1/content?variant=thumbnail')
    expect(thumb.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await thumb.arrayBuffer()).equals(poster)).toBe(true)
    expect((await get(started, '/videos/v1/content?variant=spritesheet')).status).toBe(404)

    // The runner forgot the job; the gallery still answers.
    videos.records.delete('v1')
    expect(await (await get(started, '/videos/v1')).json()).toMatchObject({ status: 'completed', id: 'v1' })
    expect((await get(started, '/videos/v1/content')).status).toBe(200)
    // A clip whose file went missing, and an unknown id.
    videos.items.set('gone', item('gone', { path: join(dir, 'missing.webm') }))
    expect((await get(started, '/videos/gone/content')).status).toBe(404)
    videos.items.set('noposter', item('noposter'))
    expect((await get(started, '/videos/noposter/content?variant=thumbnail')).status).toBe(404)
    const unknown = await get(started, '/videos/nope')
    expect(unknown.status).toBe(404)
    expect(await errorOf(unknown)).toEqual({
      message: 'Video not found.',
      type: 'invalid_request_error',
      param: null,
      code: 'not_found',
    })
    await settle()
    // Polls and downloads are not reported; the one POST is.
    expect(events.filter((e) => e.phase === 'finished')).toHaveLength(1)
  })

  it('cancels a running job, deletes a finished clip, and knows nothing else', async () => {
    const videos = fakeVideos()
    const { started, events } = await server(videos)
    await postJson(started, '/videos', { prompt: 'a cat' })
    const deleted = await get(started, '/videos/v1', { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ id: 'v1', object: 'video', deleted: true })
    expect(videos.cancelled).toEqual(['v1'])
    expect(videos.deleted).toEqual([])
    videos.items.set('v7', item('v7'))
    expect((await get(started, '/videos/v7', { method: 'DELETE' })).status).toBe(200)
    expect(videos.deleted).toEqual(['v7'])
    expect((await get(started, '/videos/v8', { method: 'DELETE' })).status).toBe(404)
    await settle()
    expect(
      events
        .filter((e) => e.phase === 'finished')
        .map((e) => (e.phase === 'finished' ? e.observation?.status : 0))
    ).toEqual([200, 200, 200, 404])
  })
})

describe('GET /v1/videos', () => {
  it('lists running jobs before the gallery, newest first, without duplicates, and pages by cursor', async () => {
    const videos = fakeVideos()
    const { started } = await server(videos)
    await postJson(started, '/videos', { prompt: 'first' })
    await postJson(started, '/videos', { prompt: 'second' })
    // v1 finished into the gallery; v2 still runs. Two older clips only the gallery knows.
    const done = item('v1')
    const v1 = videos.records.get('v1') as VideoJob
    v1.state = 'completed'
    v1.outputs = [done]
    videos.items.set('old-b', item('old-b', { createdAtMs: 1_600_000_000_000 }))
    videos.items.set('v1', done)
    videos.items.set('old-a', item('old-a', { createdAtMs: 1_500_000_000_000, archived: true }))
    const all = (await (await get(started, '/videos')).json()) as {
      object: string
      data: Array<{ id: string }>
      first_id: string
      last_id: string
      has_more: boolean
    }
    expect(all.object).toBe('list')
    expect(all.data.map((v) => v.id)).toEqual(['v2', 'old-b', 'v1', 'old-a'])
    expect([all.first_id, all.last_id, all.has_more]).toEqual(['v2', 'old-a', false])
    const page = (await (await get(started, '/videos?limit=2')).json()) as typeof all
    expect(page.data.map((v) => v.id)).toEqual(['v2', 'old-b'])
    expect(page.has_more).toBe(true)
    const next = (await (await get(started, '/videos?limit=2&after=old-b')).json()) as typeof all
    expect(next.data.map((v) => v.id)).toEqual(['v1', 'old-a'])
    expect(next.has_more).toBe(false)
    const past = (await (await get(started, '/videos?after=nowhere')).json()) as typeof all
    expect(past.data).toEqual([])
    expect(past.first_id).toBeNull()
    expect((await get(started, '/videos?limit=0')).status).toBe(400)
    // Without a backend the listing is a refusal, not a crash.
    const { started: bare } = await server()
    expect((await get(bare, '/videos')).status).toBe(503)
  })
})
