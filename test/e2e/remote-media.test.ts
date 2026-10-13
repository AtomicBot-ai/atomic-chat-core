/**
 * Remote media through the compiled binary (ADR 2026-10-13-remote-media-shares-the-diffusion-job-table):
 * a self-hosted OpenAI-compatible server registered over control serves an image job started over
 * control, `/v1/images/generations` and `/v1/videos`; results land in the galleries; the key stays
 * on the provider's own origin. The provider is a local stub; nothing touches the network.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import { json, startStub } from '../helpers/chatgpt-stub.js'
import type { Stub } from '../helpers/chatgpt-stub.js'

let dataFolder: string
const daemons: ChildProcess[] = []
const stubs: Stub[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-remote-media-e2e-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await Promise.all(stubs.splice(0).map((s) => s.close()))
  await rm(dataFolder, { recursive: true, force: true })
})

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
)
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(64)])

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

async function settle(ready: ReadyLine, path: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const job = ((await (await control(ready, path)).json()) as { job: Record<string, unknown> | null }).job
    if (job && ['completed', 'failed', 'cancelled'].includes(job['state'] as string)) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${path} never settled`)
}

describe.skipIf(!existsSync(core.BIN))('the compiled core serves remote media', () => {
  it('runs images and clips at a registered self-hosted server, into the galleries', async () => {
    const upstream = await startStub((req, res) => {
      if (req.method === 'POST' && req.path === '/v1/images/generations')
        return json(res, 200, { data: [{ b64_json: PNG.toString('base64') }] })
      if (req.method === 'POST' && req.path === '/v1/videos')
        return json(res, 200, { id: 'up-1', status: 'queued' })
      if (req.method === 'GET' && req.path === '/v1/videos/up-1')
        return json(res, 200, { id: 'up-1', status: 'completed', progress: 100 })
      if (req.method === 'GET' && req.path === '/v1/videos/up-1/content') {
        res.writeHead(200, { 'content-type': 'video/mp4' })
        return res.end(MP4)
      }
      json(res, 404, { error: { message: 'no route' } })
    })
    stubs.push(upstream)
    const { ready } = await core.startDaemon(dataFolder, daemons)

    const registered = await control(ready, '/cloud/providers/my-server', {
      method: 'PUT',
      body: JSON.stringify({
        api_key: 'sk-local',
        base_url: `${upstream.url}/v1`,
        models: [],
        media: {
          image_api: 'openai-images',
          video_api: 'openai-videos',
          models: [
            { id: 'sd-turbo', kind: 'image' },
            { id: 'clip-1', kind: 'video' },
          ],
        },
      }),
    })
    expect(registered.status).toBe(200)
    await control(ready, '/diffusion/config', { method: 'PUT', body: JSON.stringify({ dataFolder }) })

    // Over control, the way the Images page starts it.
    const started = await control(ready, '/diffusion/jobs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'a cat',
        width: 0,
        height: 0,
        steps: 0,
        cfgScale: 0,
        batchSize: 1,
        target: { provider: 'my-server', model: 'sd-turbo' },
      }),
    })
    const { jobId } = (await started.json()) as { jobId: string }
    const job = await settle(ready, `/diffusion/jobs/${jobId}`)
    expect(job['state']).toBe('completed')
    expect(await readdir(join(dataFolder, 'images'))).toContain(`${jobId}-00.png`)
    const sent = upstream.requests.find((r) => r.path === '/v1/images/generations')
    expect(sent?.headers['authorization']).toBe('Bearer sk-local')
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({ model: 'sd-turbo', prompt: 'a cat' })

    // Over /v1, the way an API client asks.
    const port = (
      (await (
        await control(ready, '/server/start', { method: 'POST', body: JSON.stringify({ port: 0 }) })
      ).json()) as { port: number }
    ).port
    const base = `http://127.0.0.1:${port}/v1`
    const generated = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'my-server/sd-turbo', prompt: 'a dog' }),
    })
    expect(generated.status).toBe(200)
    const body = (await generated.json()) as {
      data: Array<{ b64_json: string }>
      atomic: { provider: string }
    }
    expect(body.atomic.provider).toBe('my-server')
    expect(Buffer.from(body.data[0]?.b64_json ?? '', 'base64').subarray(0, 4)).toEqual(PNG.subarray(0, 4))
    const models = (await (await fetch(`${base}/models`)).json()) as { data: Array<{ id: string }> }
    expect(models.data.map((m) => m.id)).not.toContain('sd-turbo')

    const queued = await fetch(`${base}/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'clip-1', prompt: 'waves', seconds: 4 }),
    })
    expect(queued.status).toBe(200)
    const video = (await queued.json()) as { id: string }
    let status = ''
    for (let i = 0; i < 200 && status !== 'completed' && status !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      status = ((await (await fetch(`${base}/videos/${video.id}`)).json()) as { status: string }).status
    }
    expect(status).toBe('completed')
    const content = await fetch(`${base}/videos/${video.id}/content`)
    expect(content.headers.get('content-type')).toBe('video/mp4')
    expect(await readdir(join(dataFolder, 'videos'))).toContain(`${video.id}.mp4`)
  })

  it('refuses a provider that is not connected and keeps local jobs untouched', async () => {
    const { ready } = await core.startDaemon(dataFolder, daemons)
    await control(ready, '/diffusion/config', { method: 'PUT', body: JSON.stringify({ dataFolder }) })
    const refused = await control(ready, '/diffusion/jobs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'a cat',
        width: 0,
        height: 0,
        steps: 0,
        cfgScale: 0,
        batchSize: 1,
        target: { provider: 'nowhere', model: 'x' },
      }),
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: 'REMOTE_NOT_CONFIGURED' } })
    const catalog = await control(ready, '/media/catalog')
    expect(catalog.status).toBe(200)
  })
})
