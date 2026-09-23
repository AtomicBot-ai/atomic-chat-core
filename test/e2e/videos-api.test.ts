/**
 * `/v1/videos` on the compiled binary's public listener (stage 9e): OpenAI's error envelope
 * before and after a model is loaded, a clip queued, polled, downloaded, listed and deleted, a
 * running clip cancelled by DELETE, a finished clip still answered after the daemon restarts (the
 * gallery is its record), and the listener's key and Host gates in front with the request reported
 * as `atomic-diffusion` and never with the prompt.
 *
 * No imports from `src/`. POSIX only: the fake engine is a shell launcher.
 */
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext } from '../helpers/compiled-diffusion.js'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { BIN } = core
const { alive, control, json, waitFor } = sd

let ctx: SdContext
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-videos-api-')
})
afterEach(() => sd.sdCleanup(ctx))

async function startServer(ready: ReadyLine, options: Record<string, unknown> = {}): Promise<number> {
  return (
    await json<{ port: number }>(
      await control(ctx, ready, '/server/start', {
        method: 'POST',
        body: JSON.stringify({ port: 0, ...options }),
      })
    )
  ).port
}

const videos = (port: number, path: string, init: RequestInit = {}, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}/v1/videos${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
const create = (port: number, body: unknown) => videos(port, '', { method: 'POST' }, body)

/** A request with headers `fetch` will not send (`Host`), through `node:http`. */
function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = ''
        res.on('data', (c: Buffer) => (text += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

interface Video {
  id: string
  object: string
  status: string
  progress: number
  seconds: string
  size: string
  error: { code: string } | null
  atomic: { path: string | null; seed: number | null }
}

const pollUntil = async (port: number, id: string, done: (v: Video) => boolean, what: string) => {
  let last: Video | undefined
  await waitFor(async () => {
    last = (await (await videos(port, `/${id}`)).json()) as Video
    return done(last)
  }, what)
  return last as Video
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('the videos facade', () => {
  it("answers in OpenAI's error envelope: 400 before 503, 503 with nothing loaded or an image model, and 405 for a wrong method", async () => {
    const dir = await sd.writeSdEngine(ctx, { env: { FAKE_SD_MODES: 'img_gen,vid_gen' } })
    const imageFile = await sd.writeSdFile(ctx)
    const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
    await sd.configure(ctx, ready)
    await sd.finalizeEngine(ctx, ready, dir)
    const port = await startServer(ready)

    const noPrompt = await create(port, { seconds: 4 })
    expect(noPrompt.status).toBe(400)
    expect(await noPrompt.json()).toMatchObject({ error: { param: 'prompt', message: 'prompt is required' } })
    const nothing = await create(port, { prompt: 'a cat' })
    expect(nothing.status).toBe(503)
    expect(await nothing.json()).toMatchObject({
      error: {
        type: 'server_error',
        code: 'model_not_loaded',
        message: 'No video model loaded. Load a video model in Atomic Chat first.',
      },
    })
    const broken = await create(port, '{"prompt": ')
    expect(broken.status).toBe(400)
    const wrongMethod = await videos(port, '', { method: 'PUT' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST')
    expect((await videos(port, '/nope')).status).toBe(404)
    expect((await videos(port, '')).status).toBe(200)

    // An image model is not a video model.
    await json(
      await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: imageFile })),
      })
    )
    const image = await create(port, { prompt: 'a cat' })
    expect(image.status).toBe(503)
    expect(await image.json()).toMatchObject({ error: { code: 'model_not_loaded' } })
    await json(await control(ctx, ready, '/diffusion/model/unload', { method: 'POST' }))
    await json(
      await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(
          sd.sdVideoLoadRequest({ diffusionModel: await sd.writeSdFile(ctx, 'ltx-2/ltx.gguf') })
        ),
      })
    )
    const size = await create(port, { prompt: 'a cat', size: '100' })
    expect(size.status).toBe(400)
    expect(await size.json()).toMatchObject({ error: { param: 'size' } })
    const seconds = await create(port, { prompt: 'a cat', seconds: 'four' })
    expect(await seconds.json()).toMatchObject({ error: { param: 'seconds' } })
    const other = await create(port, { prompt: 'a cat', model: 'sora-2' })
    expect(other.status).toBe(503)
    // The family holds the request to its grid: a size off it is the runner's refusal, as a 400.
    const offGrid = await create(port, { prompt: 'a cat', size: '70x30' })
    expect(offGrid.status).toBe(400)
    expect(await offGrid.json()).toMatchObject({
      error: { code: 'invalid_request', message: 'width must be a multiple of 16. (width=70)' },
    })

    // A clip started from the Video page makes the facade answer busy, in OpenAI's shape.
    const { jobId } = await json<{ jobId: string }>(
      await control(ctx, ready, '/diffusion/video/jobs', {
        method: 'POST',
        body: JSON.stringify(sd.sdVideoRequest({ steps: 20 })),
      })
    )
    const busy = await create(port, { prompt: 'a cat' })
    expect(busy.status).toBe(429)
    expect(await busy.json()).toMatchObject({
      error: { type: 'server_error', code: 'busy', message: 'A video is already being generated.' },
    })
    // The Video page's job is listed by the facade too, as running.
    const listed = (await (await videos(port, '')).json()) as { data: Video[] }
    expect(listed.data.map((v) => v.id)).toEqual([jobId])
    expect(['queued', 'in_progress']).toContain(listed.data[0]?.status)
    await json(await control(ctx, ready, `/diffusion/video/jobs/${jobId}/cancel`, { method: 'POST' }))
  }, 60_000)

  it('queues, polls, downloads, lists, cancels by DELETE, deletes, and still answers a finished clip after a restart', async () => {
    const { ready, pid } = await sd.loadedOwner(ctx, {
      video: true,
      env: { FAKE_SD_STEP_MS: '400', FAKE_SD_CANCEL: '1' },
    })
    const port = await startServer(ready)
    const events = await sd.collectEvents(ctx, ready)

    const queued = await create(port, { prompt: 'a cat', seconds: 0.5, seed: 5, model: 'LTX-2.3 Distilled' })
    expect(queued.status, await queued.clone().text()).toBe(200)
    const video = (await queued.json()) as Video
    expect(video).toMatchObject({
      object: 'video',
      status: 'queued',
      progress: 0,
      seconds: '0.38',
      size: '64x32',
    })
    const running = await pollUntil(
      port,
      video.id,
      (v) => v.status === 'in_progress' && v.progress > 0,
      'the clip to make progress'
    )
    expect(running.error).toBeNull()
    expect((await videos(port, `/${video.id}/content`)).status).toBe(404)
    const done = await pollUntil(port, video.id, (v) => v.status === 'completed', 'the clip to complete')
    expect([done.progress, done.atomic.seed]).toEqual([100, 5])
    expect(done.atomic.path?.startsWith(join(ctx.dataFolder, 'videos'))).toBe(true)
    const content = await videos(port, `/${video.id}/content`)
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('video/webm')
    expect(content.headers.get('content-disposition')).toBe(`inline; filename="${video.id}.webm"`)
    const bytes = Buffer.from(await content.arrayBuffer())
    expect(bytes.equals(await readFile(sd.WEBM_FIXTURE))).toBe(true)
    expect(bytes.subarray(0, 4).equals(sd.WEBM_MAGIC)).toBe(true)
    expect((await videos(port, `/${video.id}/content?variant=thumbnail`)).status).toBe(404)
    const list = (await (await videos(port, '?limit=10')).json()) as {
      object: string
      data: Video[]
      has_more: boolean
    }
    expect(list.object).toBe('list')
    expect(list.data.map((v) => v.id)).toEqual([video.id])
    expect(
      (await json<{ total: number }>(await control(ctx, ready, '/diffusion/video/gallery?offset=0&limit=10')))
        .total
    ).toBe(1)
    // The video model is not a chat model.
    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()
    expect(JSON.stringify(models)).not.toContain('ltx-2')

    // A slow clip, cancelled by DELETE: the engine honours it and stays up.
    const slow = (await (await create(port, { prompt: 'a dog', seconds: 20 })).json()) as Video
    await pollUntil(port, slow.id, (v) => v.status === 'in_progress', 'the slow clip to start')
    const deleted = await videos(port, `/${slow.id}`, { method: 'DELETE' })
    expect(await deleted.json()).toEqual({ id: slow.id, object: 'video', deleted: true })
    const cancelled = await pollUntil(
      port,
      slow.id,
      (v) => v.status === 'failed',
      'the slow clip to be cancelled'
    )
    expect(cancelled.error).toEqual({ code: 'cancelled', message: 'Generation was cancelled.' })
    expect(alive(pid)).toBe(true)

    // The finished clip survives a restart of the core: the gallery is its record.
    for (const daemon of ctx.daemons.splice(0)) daemon.kill('SIGKILL')
    const { ready: next } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
    await sd.configure(ctx, next)
    const port2 = await startServer(next)
    const after = (await (await videos(port2, `/${video.id}`)).json()) as Video
    expect(after).toMatchObject({ status: 'completed', progress: 100, atomic: { seed: 5 } })
    expect((await videos(port2, `/${video.id}/content`)).status).toBe(200)
    expect((await videos(port2, `/${slow.id}`)).status).toBe(404)
    const gone = await videos(port2, `/${video.id}`, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect((await videos(port2, `/${video.id}`)).status).toBe(404)
    expect(
      (await json<{ total: number }>(await control(ctx, next, '/diffusion/video/gallery?offset=0&limit=10')))
        .total
    ).toBe(0)
    expect(events.some((e) => e.event === 'diffusion:video-job')).toBe(true)
    expect(events.some((e) => e.event === 'diffusion:job')).toBe(false)
  }, 90_000)

  it("stays behind the listener's key and Host gates, and is reported as atomic-diffusion on videos without the prompt", async () => {
    const { ready } = await sd.loadedOwner(ctx, { video: true })
    const port = await startServer(ready, { api_key: 'secret' })
    const host = `127.0.0.1:${port}`
    const body = JSON.stringify({ prompt: 'private words', seed: 3 })
    const events = await sd.collectEvents(ctx, ready)

    const noKey = await raw(port, 'POST', '/v1/videos', { host }, body)
    expect([noKey.status, noKey.body]).toEqual([401, 'Invalid or missing authorization token'])
    const evil = await raw(
      port,
      'POST',
      '/v1/videos',
      { host: 'evil.example', authorization: 'Bearer secret' },
      body
    )
    expect(evil.status).toBe(403)
    const served = await raw(port, 'POST', '/v1/videos', { host, authorization: 'Bearer secret' }, body)
    expect(served.status, served.body).toBe(200)
    const { id } = JSON.parse(served.body) as Video
    expect((await raw(port, 'GET', `/v1/videos/${id}`, { host })).status).toBe(401)
    expect(
      (await raw(port, 'GET', `/v1/videos/${id}`, { host, authorization: 'Bearer secret' })).status
    ).toBe(200)

    await waitFor(
      () => events.some((e) => e.event === 'api:request' && (e.data['phase'] as string) === 'finished'),
      'the request report'
    )
    const reports = events.filter((e) => e.event === 'api:request' && e.data['phase'] === 'finished')
    const served200 = reports
      .map((e) => e.data['observation'] as { endpoint: string; backend: string; status: number })
      .filter((o) => o.status === 200)
    // The one POST is reported as atomic-diffusion on videos; the two GET polls are not.
    expect(served200).toEqual([expect.objectContaining({ endpoint: 'videos', backend: 'atomic-diffusion' })])
    expect(JSON.stringify(events.filter((e) => e.event === 'api:request'))).not.toContain('private words')
    await json(await control(ctx, ready, `/diffusion/video/jobs/${id}/cancel`, { method: 'POST' }))
  }, 60_000)
})
