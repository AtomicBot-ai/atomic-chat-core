/**
 * The Local API Server of stage 4b, run through the compiled binary (PLAN.md §5.1 "E2E (binary)").
 *
 * The wire contract itself is replayed in `test/contract/proxy-http.test.ts`; this file proves the
 * same server works when it is what users actually run: a Bun-compiled daemon, the documentation
 * embedded in the binary, gates configured through the control API, and a real (fake) llama-server
 * process behind it that overflows its context, poisons its compute backend or dies.
 *
 * Remote providers and the ChatGPT route arrive with stage 4c and are not exercised here.
 */
import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/app/proxy-http/', import.meta.url))
const POSIX = process.platform !== 'win32'

let dataFolder: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-public-e2e-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

async function startServer(ready: ReadyLine, options: Record<string, unknown> = {}): Promise<number> {
  const res = await control(ready, '/server/start', {
    method: 'POST',
    body: JSON.stringify({ port: 0, ...options }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { port: number }).port
}

async function load(ready: ReadyLine, model: string, body: object = {}): Promise<{ pid: number }> {
  const res = await control(ready, `/models/llamacpp-upstream/${model}/load`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { session: { pid: number } }).session
}

async function sessionPid(ready: ReadyLine): Promise<number | undefined> {
  const { sessions } = (await (await control(ready, '/sessions')).json()) as {
    sessions: Array<{ pid: number }>
  }
  return sessions[0]?.pid
}

/** A model loaded behind a running public server, with the fake backend configured by `env`. */
async function servedModel(env: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
  await core.writeModel(dataFolder, 'demo')
  await core.writeFakeBackend(dataFolder, env)
  const { ready } = await core.startDaemon(dataFolder, daemons)
  if (Object.keys(settings).length > 0) {
    const patched = await control(ready, '/settings/llamacpp-upstream', {
      method: 'PATCH',
      body: JSON.stringify({ values: settings }),
    })
    expect(patched.status, await patched.clone().text()).toBe(200)
  }
  const session = await load(ready, 'demo')
  const port = await startServer(ready)
  const post = (path: string, body: object) =>
    fetch(`http://127.0.0.1:${port}/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { ready, port, session, post }
}

/** GET with headers `fetch` will not send (`Host`), through `node:http`. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET'
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** A request with no `Host` header at all, which no HTTP client will produce. */
function withoutHost(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\n\r\n`))
    let raw = ''
    socket.on('data', (c: Buffer) => {
      raw += c.toString()
      const length = /content-length:\s*(\d+)/i.exec(raw)
      const split = raw.indexOf('\r\n\r\n')
      if (length && split >= 0 && raw.length - split - 4 >= Number(length[1])) {
        socket.destroy()
        resolve(raw)
      }
    })
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve(raw)
    }, 5000)
  })
}

function expectedDigest(fixture: string): { sha256: string; bytes: number } {
  const doc = JSON.parse(readFileSync(join(FIXTURES, `${fixture}.json`), 'utf8')) as {
    expected: { response: { body: { sha256: string; bytes: number } } }
  }
  return doc.expected.response.body
}

async function sseFrames(res: Response): Promise<Array<{ event: string | undefined; data: unknown }>> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((frame) => frame.trim() !== '')
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1]
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? ''
      let parsed: unknown = data
      try {
        parsed = JSON.parse(data)
      } catch {
        // `[DONE]`
      }
      return { event, data: parsed }
    })
}

describe.skipIf(!existsSync(core.BIN))('the compiled core serves the Local API', () => {
  it('serves the documentation embedded in the binary, byte for byte, with the image endpoint in the OpenAPI document', async () => {
    const { ready } = await core.startDaemon(dataFolder, daemons)
    const port = await startServer(ready, { prefix: '/api' })
    const base = `http://127.0.0.1:${port}`

    const page = await fetch(`${base}/`)
    expect(page.headers.get('content-type')).toBe('text/html')
    expect(await page.text()).toContain('SwaggerUIBundle')

    const spec = (await (await fetch(`${base}/openapi.json`)).json()) as {
      servers: Array<{ url: string }>
      paths: Record<string, { post?: { operationId?: string; tags?: string[] } }>
    }
    expect(spec.servers.length).toBeGreaterThan(0)
    expect(spec.servers.every((s) => s.url === `http://127.0.0.1:${port}/api`)).toBe(true)
    // Stage 7m: the app's document knows the local image endpoint, and the binary embeds that version.
    expect(spec.paths['/images/generations']?.post).toMatchObject({
      operationId: 'createImageGeneration',
      tags: ['Images'],
    })

    for (const [path, fixture] of [
      ['/docs/swagger-ui.css', 'docs_css_served'],
      ['/docs/swagger-ui-bundle.js', 'docs_bundle_served'],
    ] as const) {
      const bytes = Buffer.from(await (await fetch(`${base}${path}`)).arrayBuffer())
      expect({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, path).toEqual(
        expectedDigest(fixture)
      )
    }
  })

  it('enforces the host, key and CORS gates configured through control', async () => {
    const { ready } = await core.startDaemon(dataFolder, daemons)
    const port = await startServer(ready, { api_key: 'secret', trusted_hosts: ['lan.example'] })
    const host = `127.0.0.1:${port}`

    const noKey = await rawGet(port, '/v1/models', { host })
    expect([noKey.status, noKey.body]).toEqual([401, 'Invalid or missing authorization token'])
    expect((await rawGet(port, '/v1/models', { host, authorization: 'Bearer secret' })).status).toBe(200)
    expect((await rawGet(port, '/v1/models', { host, 'x-api-key': 'secret' })).status).toBe(200)
    expect((await rawGet(port, '/v1/models', { host, authorization: 'bearer secret' })).status).toBe(401)

    const evil = await rawGet(port, '/v1/models', { host: 'evil.example', authorization: 'Bearer secret' })
    expect(evil.status).toBe(403)
    expect(evil.body).toContain("Host 'evil.example' is not in Trusted Hosts")
    expect(
      (await rawGet(port, '/v1/models', { host: 'lan.example:1', authorization: 'Bearer secret' })).status,
      'a trusted host matches without its port'
    ).toBe(200)
    expect(await withoutHost(port, '/v1/models')).toMatch(/^HTTP\/1\.1 400[^]*Missing host header$/)

    expect(
      (await rawGet(port, '/openapi.json', { host: 'evil.example' })).status,
      'docs skip both gates'
    ).toBe(200)
    const hidden = await rawGet(port, '/v1/configs', { host, authorization: 'Bearer secret' })
    expect([hidden.status, hidden.body]).toEqual([404, 'Not Found'])
    const wrongMethod = await rawGet(port, '/v1/chat/completions', { host, authorization: 'Bearer secret' })
    expect([wrongMethod.status, wrongMethod.headers['allow']]).toEqual([405, 'POST'])

    const origin = 'http://localhost:3000'
    const preflight = await rawGet(
      port,
      '/v1/chat/completions',
      {
        host,
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-stainless-os',
      },
      'OPTIONS'
    )
    expect(preflight.status, 'preflight carries no key').toBe(200)
    expect(preflight.headers['access-control-allow-origin']).toBe(origin)
    expect(preflight.headers['access-control-max-age']).toBe('86400')
    const refusedHeaders = await rawGet(
      port,
      '/v1/models',
      { host, origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-evil' },
      'OPTIONS'
    )
    expect([refusedHeaders.status, refusedHeaders.body]).toEqual([403, 'Headers not allowed'])
    const reflected = await rawGet(port, '/v1/models', { host, origin, authorization: 'Bearer secret' })
    expect(reflected.headers['access-control-allow-origin']).toBe(origin)
    const untrusted = await rawGet(port, '/v1/models', {
      host,
      origin: 'http://evil.example',
      authorization: 'Bearer secret',
    })
    expect(untrusted.headers['access-control-allow-origin']).toBeUndefined()
  })

  it.skipIf(!POSIX)('tells a cold server from an unknown model and a malformed request', async () => {
    await core.writeModel(dataFolder, 'demo')
    await core.writeFakeBackend(dataFolder)
    const { ready } = await core.startDaemon(dataFolder, daemons)
    const port = await startServer(ready)
    const post = (body: string) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })

    const cold = await post(JSON.stringify({ model: 'demo' }))
    expect([cold.status, await cold.text()]).toEqual([503, 'No models are available'])

    await load(ready, 'demo')
    const unknown = await post(JSON.stringify({ model: 'ghost' }))
    expect([unknown.status, await unknown.text()]).toEqual([
      404,
      "No running session found for model 'ghost'",
    ])
    const noModel = await post('{}')
    expect([noModel.status, await noModel.text()]).toEqual([400, "Request body must contain a 'model' field"])
    const invalid = await post('{not json')
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toMatch(/^Invalid JSON body: /)
  })

  it.skipIf(!POSIX)('grows the context of an overflowing model and replays the request', async () => {
    // With fit on (the default) llama.cpp sizes the window itself and the core declines to grow it.
    const { ready, session, post } = await servedModel({ FAKE_LLAMA_MIN_CTX: '8192' }, { fit: false })

    const answer = await post('/chat/completions', {
      model: 'demo',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(answer.status, await answer.clone().text()).toBe(200)
    expect(
      ((await answer.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message
        .content
    ).toContain('fake backend')
    expect(await sessionPid(ready), 'the model was reloaded').not.toBe(session.pid)
  })

  it.skipIf(!POSIX)(
    'declines to grow under fit and hands the client a structured overflow error',
    async () => {
      const { ready, session, post } = await servedModel({ FAKE_LLAMA_MIN_CTX: '8192' })

      const answer = await post('/chat/completions', { model: 'demo', messages: [] })

      expect(answer.status).toBe(400)
      expect(await answer.json()).toMatchObject({ error: { type: 'exceed_context_size_error' } })
      expect(await sessionPid(ready), 'nothing was reloaded').toBe(session.pid)
    }
  )

  it.skipIf(!POSIX)('restarts a poisoned engine and tells the client not to retry', async () => {
    const marker = join(dataFolder, 'compute-error-once')
    const { ready, session, post } = await servedModel({ FAKE_LLAMA_COMPUTE_ERROR_MARKER: marker })

    const failed = await post('/chat/completions', { model: 'demo', messages: [] })

    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({
      error: { code: 'insufficient_memory', type: 'server_error' },
    })
    expect(await sessionPid(ready), 'a fresh engine replaced the poisoned one').not.toBe(session.pid)
    expect((await post('/chat/completions', { model: 'demo', messages: [] })).status).toBe(200)
  })

  it.skipIf(!POSIX)('answers Anthropic /messages through the chat fallback, whole and streamed', async () => {
    const { post } = await servedModel()
    const request = { model: 'demo', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }

    const whole = await post('/messages', request)
    expect(whole.status).toBe(200)
    expect(await whole.json()).toMatchObject({
      type: 'message',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hello from the fake backend' }],
    })

    const streamed = await post('/messages', { ...request, stream: true })
    expect(streamed.headers.get('content-type')).toContain('text/event-stream')
    const frames = await sseFrames(streamed)
    expect(frames.map((f) => f.event)).toEqual([
      'message_start',
      'content_block_start',
      ...Array(5).fill('content_block_delta'),
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const text = frames.map((f) => (f.data as { delta?: { text?: string } }).delta?.text ?? '').join('')
    expect(text).toBe('hello from the fake backend')
  })

  it.skipIf(!POSIX)('answers /responses by translating to chat completions, whole and streamed', async () => {
    const { post } = await servedModel()

    const whole = await post('/responses', { model: 'demo', input: 'hi' })
    expect(whole.status).toBe(200)
    const response = (await whole.json()) as {
      id: string
      status: string
      output: Array<{ content: Array<{ text: string }> }>
    }
    expect(response.id).toMatch(/^resp_[0-9a-f]{32}$/)
    expect(response.status).toBe('completed')
    expect(response.output[0]?.content[0]?.text).toBe('hello from the fake backend')

    const streamed = await post('/responses', { model: 'demo', input: 'hi', stream: true })
    const events = (await sseFrames(streamed)).map((f) => f.event)
    expect(events[0]).toBe('response.created')
    expect(events).toContain('response.output_text.delta')
    expect(events.at(-1)).toBe('response.completed')
  })

  it.skipIf(!POSIX)('serves embeddings, model listings and metrics from the sessions', async () => {
    await core.writeModel(dataFolder, 'embedder')
    const { ready, port, post } = await servedModel()
    await load(ready, 'embedder', { isEmbedding: true })

    const embedded = await post('/embeddings', { model: 'embedder', input: ['abc'] })
    expect(embedded.status, await embedded.clone().text()).toBe(200)
    expect(await embedded.json()).toMatchObject({ data: [{ embedding: [3, 0.2, 0.3], index: 0 }] })

    const metrics = await fetch(`http://127.0.0.1:${port}/v1/metrics?model=demo`)
    expect(metrics.status).toBe(200)
    expect(metrics.headers.get('content-type')).toBe('text/plain; version=0.0.4')
    expect(await metrics.text()).toContain('llamacpp:prompt_tokens_total 3')

    const listed = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>
    }
    expect(listed.data.map((m) => [m.id, m.owned_by]).sort()).toEqual([
      ['demo', 'llama.cpp-upstream'],
      ['embedder', 'llama.cpp-upstream'],
    ])
    const catalog = (await (await fetch(`http://127.0.0.1:${port}/muse-code/models`)).json()) as {
      data: Array<{ id: string }>
    }
    expect(catalog.data.map((m) => m.id).sort()).toEqual(['demo', 'embedder'])
  })

  it.skipIf(!POSIX)('reports a backend that died as temporarily unavailable', async () => {
    const { session, post } = await servedModel()

    process.kill(session.pid, 'SIGKILL')
    const answer = await post('/chat/completions', { model: 'demo', messages: [] })

    // Either the request reaches the dead port first, or the core has already noticed the exit and
    // dropped the session; both are a 503 a client may retry.
    expect(answer.status).toBe(503)
    const body = await answer.text()
    if (body !== 'No models are available') {
      expect(answer.headers.get('retry-after')).toBe('1')
      expect(JSON.parse(body)).toMatchObject({ error: { code: 'backend_unavailable', type: 'server_error' } })
    }
  })
})
