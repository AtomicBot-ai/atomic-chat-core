/**
 * `POST /v1/images/generations` on the compiled binary's public listener (stage 7i): OpenAI's
 * error envelope before and after a model is loaded, a job cancelled when the client hangs up, and
 * the listener's key and Host gates in front of it with the request reported as `atomic-diffusion`
 * and never with the prompt.
 *
 * No imports from `src/`. POSIX only: the fake engine is a shell launcher.
 */
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext } from '../helpers/compiled-diffusion.js'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { BIN } = core
const { alive, control, json, waitFor } = sd

let ctx: SdContext
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-images-api-')
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

const generations = (port: number, body: unknown, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
    method: 'POST',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** POST with headers `fetch` will not send (`Host`), through `node:http`. */
function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
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

interface OpenAiError {
  error: { message: string; type: string; code: string | null; param: string | null }
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('the images facade', () => {
  it("answers in OpenAI's error envelope: 400 before 503, 503 with nothing loaded, 429 while a job runs", async () => {
    const dir = await sd.writeSdEngine(ctx, { env: { FAKE_SD_STEP_MS: '400' } })
    const modelFile = await sd.writeSdFile(ctx)
    const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
    await sd.configure(ctx, ready)
    await sd.finalizeEngine(ctx, ready, dir)
    const port = await startServer(ready)

    // The format is checked before the model: a `url` request is a 400 even with nothing loaded.
    const url = await generations(port, { prompt: 'a cat', response_format: 'url' })
    expect(url.status).toBe(400)
    expect(await url.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        param: 'response_format',
        message: "response_format 'url' is not supported; the local server only returns 'b64_json'",
      },
    })
    const nothing = await generations(port, { prompt: 'a cat' })
    expect(nothing.status).toBe(503)
    expect(await nothing.json()).toMatchObject({
      error: {
        type: 'server_error',
        code: 'model_not_loaded',
        message: 'No image model loaded. Load an image model in Atomic Chat first.',
      },
    })
    const broken = await generations(port, '{"prompt": ')
    expect(broken.status).toBe(400)
    expect(((await broken.json()) as OpenAiError).error.type).toBe('invalid_request_error')
    const noPrompt = await generations(port, { n: 1 })
    expect(noPrompt.status).toBe(400)
    expect(await noPrompt.json()).toMatchObject({ error: { param: 'prompt', message: 'prompt is required' } })

    await json(
      await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: modelFile })),
      })
    )
    const size = await generations(port, { prompt: 'a cat', size: '100x100' })
    expect(size.status).toBe(400)
    expect(await size.json()).toMatchObject({
      error: { param: 'size', message: 'width must be between 256 and 2048' },
    })
    const odd = await generations(port, { prompt: 'a cat', size: '520x520' })
    expect(await odd.json()).toMatchObject({
      error: { param: 'size', message: 'width must be a multiple of 16' },
    })
    const many = await generations(port, { prompt: 'a cat', n: 9 })
    expect(many.status).toBe(400)
    expect(await many.json()).toMatchObject({
      error: { param: 'n', message: 'n must be an integer between 1 and 4' },
    })
    const other = await generations(port, { prompt: 'a cat', model: 'gpt-image-1' })
    expect(other.status).toBe(503)
    expect(await other.json()).toMatchObject({ error: { code: 'model_not_loaded' } })

    // A job started from the Images page makes the facade answer busy, in OpenAI's shape.
    const { jobId } = await json<{ jobId: string }>(
      await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(sd.sdGenerateRequest({ steps: 20 })),
      })
    )
    const busy = await generations(port, { prompt: 'a cat' })
    expect(busy.status).toBe(429)
    expect(await busy.json()).toMatchObject({
      error: { type: 'server_error', code: 'busy', message: 'An image is already being generated.' },
    })
    await json(await control(ctx, ready, `/diffusion/jobs/${jobId}/cancel`, { method: 'POST' }))
  }, 60_000)

  it('cancels the job when the client hangs up', async () => {
    const { ready, pid } = await sd.loadedOwner(ctx, {
      env: { FAKE_SD_STEP_MS: '400', FAKE_SD_CANCEL: '1' },
      // The facade generates with the family's defaults: thirty slow steps to hang up in the middle of.
      load: { defaults: { steps: 30, cfgScale: 1, width: 256, height: 256 } },
    })
    const port = await startServer(ready)
    const client = new AbortController()
    const pending = generations(port, { prompt: 'a cat' }, { signal: client.signal }).catch(
      (error: Error) => error.name
    )
    await waitFor(async () => (await sd.sdStatus(ctx, ready)).activeJob !== null, 'the job to start')
    const { activeJob } = await sd.sdStatus(ctx, ready)
    client.abort()
    expect(await pending).toBe('AbortError')
    await waitFor(
      async () => (await sd.sdJob(ctx, ready, (activeJob as { id: string }).id))?.state === 'cancelled',
      'the job to be cancelled'
    )
    // The engine honoured the cancel: nothing was stopped, nothing was saved.
    expect(alive(pid)).toBe(true)
    expect((await sd.sdStatus(ctx, ready)).model.loaded?.pid).toBe(pid)
    expect(
      (await json<{ total: number }>(await control(ctx, ready, '/diffusion/gallery?offset=0&limit=10'))).total
    ).toBe(0)
  }, 60_000)

  it("stays behind the listener's key and Host gates, and is reported as atomic-diffusion without the prompt", async () => {
    const { ready } = await sd.loadedOwner(ctx)
    const port = await startServer(ready, { api_key: 'secret' })
    const host = `127.0.0.1:${port}`
    const body = JSON.stringify({ prompt: 'private words', seed: 3 })
    const events = await sd.collectEvents(ctx, ready)

    const noKey = await rawPost(port, '/v1/images/generations', { host }, body)
    expect([noKey.status, noKey.body]).toEqual([401, 'Invalid or missing authorization token'])
    const evil = await rawPost(
      port,
      '/v1/images/generations',
      { host: 'evil.example', authorization: 'Bearer secret' },
      body
    )
    expect(evil.status).toBe(403)
    expect(evil.body).toContain("Host 'evil.example' is not in Trusted Hosts")
    const served = await rawPost(
      port,
      '/v1/images/generations',
      { host, authorization: 'Bearer secret' },
      body
    )
    expect(served.status, served.body).toBe(200)
    expect((JSON.parse(served.body) as { atomic: { seed: number } }).atomic.seed).toBe(3)

    await waitFor(
      () =>
        events.some(
          (e) =>
            e.event === 'api:request' &&
            (e.data['observation'] as { status: number } | undefined)?.status === 200
        ),
      'the finished request event'
    )
    const finished = events.find(
      (e) => e.event === 'api:request' && (e.data['observation'] as { status: number })?.status === 200
    )
    expect(finished?.data).toMatchObject({
      phase: 'finished',
      observation: {
        endpoint: 'images/generations',
        backend: 'atomic-diffusion',
        model_id: 'z-image:q4_k_m',
        status: 200,
      },
    })
    // The job events carry the request for the Images page; the API events never carry the prompt.
    const apiEvents = () => events.filter((e) => e.event === 'api:request')
    expect(JSON.stringify(apiEvents())).not.toContain('private words')

    // Even with the API screen watching, an image prompt is not previewed.
    await control(ctx, ready, '/server/inspector', { method: 'PUT', body: '{"enabled":true}' })
    const watched = await rawPost(
      port,
      '/v1/images/generations',
      { host, authorization: 'Bearer secret' },
      body
    )
    expect(watched.status, watched.body).toBe(200)
    await waitFor(
      () =>
        apiEvents().filter((e) => e.data['phase'] === 'finished' && e.data['finish'] !== null).length >= 1,
      'the watched request to finish'
    )
    const started = apiEvents().filter((e) => e.data['phase'] === 'started')
    expect(started).toHaveLength(1)
    expect(started[0]?.data).toMatchObject({ endpoint: 'images/generations', prompt_preview: null })
    expect(JSON.stringify(apiEvents())).not.toContain('private words')
  }, 60_000)
})
