import { connect, createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { cores, createCore, createOnPort, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { CoreClient } from '../client/index.js'
import { AtomicCore } from './index.js'

useCoreHarness()

/** A non-internal IPv4 address of this machine, which is what a LAN client would dial. */
function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces()))
    for (const entry of addresses ?? [])
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
        return entry.address
  return undefined
}

/** The status of one `GET /v1/models` sent to `connectTo` with exactly this `Host`. */
function hostRequest(port: number, connectTo: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, connectTo)
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (raw += chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(Number(raw.split(' ')[1])))
    socket.write(`GET /v1/models HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`)
  })
}

describe('cloud routing through the core', () => {
  it('routes a registered cloud model with the stored key, and still does after the core restarts', async () => {
    const { startStub, json } = await import('../../test/helpers/chatgpt-stub.js')
    const upstream = await startStub((_req, res) => json(res, 200, { ok: true }))
    try {
      const first = await createCore()
      await first.cloud.upsert({
        provider: 'cloudprov',
        api_key: 'sk-stored',
        base_url: `${upstream.url}/v1`,
        custom_headers: [{ header: 'X-Org', value: 'org-1' }],
        models: ['cloud-model'],
      })
      await first.shutdown()
      cores.splice(cores.indexOf(first), 1)

      const core = await createCore()
      const { port } = await core.startPublicServer({ port: 0 })
      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'cloud-model', messages: [] }),
      })

      expect(answer.status).toBe(200)
      expect(upstream.requests[0]).toMatchObject({ path: '/v1/chat/completions' })
      expect(upstream.requests[0]?.headers).toMatchObject({
        'authorization': 'Bearer sk-stored',
        'x-org': 'org-1',
      })
      const listed = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
        data: Array<{ id: string }>
      }
      expect(listed.data.map((m) => m.id)).toEqual(['cloud-model'])
    } finally {
      await upstream.close()
    }
  })

  it('serves the ChatGPT subscription from the shared token file', async () => {
    const { startStub, responsesStream } = await import('../../test/helpers/chatgpt-stub.js')
    const { saveTokens } = await import('../credentials/index.js')
    const subscription = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesStream('subscribed'))
    })
    try {
      await saveTokens(data.layout.chatgptAuthFile, {
        version: 1,
        access_token: 'app-token',
        refresh_token: 'r',
        id_token: null,
        account_id: 'acct_app',
        plan_type: 'plus',
        email: 'app@example.test',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
      const core = await AtomicCore.create({
        dataFolder: data.root,
        controlPort: 0,
        env: { ...process.env, ATOMIC_CHATGPT_BASE_URL: subscription.url },
      })
      cores.push(core)
      expect(await core.chatgpt.status()).toMatchObject({ connected: true, email: 'app@example.test' })
      await core.cloud.upsert({ provider: 'chatgpt', models: ['gpt-5'] })
      const { port } = await core.startPublicServer({ port: 0 })

      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
      })

      expect(await answer.json()).toMatchObject({ choices: [{ message: { content: 'subscribed' } }] })
      expect(subscription.requests[0]?.headers).toMatchObject({
        'authorization': 'Bearer app-token',
        'chatgpt-account-id': 'acct_app',
      })
    } finally {
      await subscription.close()
    }
  })
})

describe('the public listener is independent', () => {
  it('starts, reports, stops and leaves control alive throughout', async () => {
    const core = await createCore()
    expect(core.publicState()).toMatchObject({ running: false, pid: null })

    const started = await core.startPublicServer({ port: 0 })
    expect(started).toMatchObject({ running: true, host: '127.0.0.1', prefix: '/v1', pid: process.pid })
    const probe = await fetch(`http://127.0.0.1:${started.port}/`)
    expect(probe.status).toBe(200)

    const stopped = await core.stopPublicServer()
    expect(stopped).toMatchObject({ running: false, pid: null, port: started.port })
    await expect(fetch(`http://127.0.0.1:${started.port}/`)).rejects.toThrow()

    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    expect(await client.health(), 'control must survive the public listener').toMatchObject({ ok: true })
  })

  it('falls back to a free port when asked, and treats a repeat of that request as the same server', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const taken = (blocker.address() as AddressInfo).port
    try {
      const core = await createCore()
      const first = await core.startPublicServer({ port: taken, fallbackPort: true })
      expect(first.port).not.toBe(taken)
      expect(await core.startPublicServer({ port: taken, fallbackPort: true })).toEqual(first)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('writes the app state file only when handed the server, and marks it stopped afterwards', async () => {
    const core = await createCore()
    const alone = await core.startPublicServer({ port: 0 })
    await expect(readFile(data.layout.serverStateFile, 'utf8')).rejects.toThrow()
    await core.stopPublicServer()

    const handed = await core.startPublicServer({ port: 0, apiKey: 'k', writeStateFile: true })
    expect(JSON.parse(await readFile(data.layout.serverStateFile, 'utf8'))).toEqual({
      running: true,
      host: '127.0.0.1',
      port: handed.port,
      prefix: '/v1',
      requires_api_key: true,
      pid: process.pid,
    })
    await expect(core.startPublicServer({ port: handed.port, apiKey: 'k' })).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
    })
    await core.stopPublicServer()
    expect(JSON.parse(await readFile(data.layout.serverStateFile, 'utf8'))).toMatchObject({
      running: false,
      port: handed.port,
      pid: 0,
    })
    expect(alone.port).toBeGreaterThan(0)
  })

  it('makes identical starts idempotent and rejects incompatible starts without dropping traffic', async () => {
    const core = await createCore()
    const first = await core.startPublicServer({ port: 0, prefix: '/v1' })
    const [sameA, sameB] = await Promise.all([
      core.startPublicServer({ port: 0, prefix: '/v1' }),
      core.startPublicServer({ port: first.port, prefix: '/v1/' }),
    ])
    expect(sameA.port).toBe(first.port)
    expect(sameB.port).toBe(first.port)

    await expect(core.startPublicServer({ port: first.port, apiKey: 'different' })).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
    })
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200)
    expect(core.publicState()).toMatchObject({ running: true, port: first.port, requires_api_key: false })
  })

  it.skipIf(lanAddress() === undefined)(
    'lets a LAN client in by the address it reached, without a Trusted Hosts entry and without a restart',
    async () => {
      const address = lanAddress() as string
      const core = await createCore()
      const { port } = await core.startPublicServer({ host: '0.0.0.0', port: 0 })

      const reached = await fetch(`http://${address}:${port}/v1/models`)
      expect(reached.status).toBe(200)
      // The same listener still refuses a name that is not the socket's own address.
      const stranger = await hostRequest(port, address, 'evil.example')
      expect(stranger).toBe(403)
      // Nothing about the group is part of the listener's identity: a repeated start is still idempotent.
      await expect(core.startPublicServer({ host: '0.0.0.0', port })).resolves.toMatchObject({ port })
    }
  )

  it("publishes its address in the core's own file, never the app's", async () => {
    const core = await createCore()
    const appState = {
      running: true,
      host: '127.0.0.1',
      port: 1337,
      prefix: '/v1',
      requires_api_key: false,
      pid: 999,
    }
    await writeFile(data.layout.serverStateFile, JSON.stringify(appState))

    const started = await core.startPublicServer({ port: 0 })
    const published = JSON.parse(await readFile(data.layout.core.publicServerState, 'utf8')) as {
      running: boolean
      port: number
      pid: number
    }
    expect(published).toMatchObject({ running: true, port: started.port, pid: process.pid })
    expect(
      JSON.parse(await readFile(data.layout.serverStateFile, 'utf8')),
      "the app's state file belongs to the legacy server until phase 4"
    ).toEqual(appState)

    await core.stopPublicServer()
    const afterStop = JSON.parse(await readFile(data.layout.core.publicServerState, 'utf8')) as {
      running: boolean
      pid: number | null
    }
    expect(afterStop).toMatchObject({ running: false, pid: null })
  })

  it('reports a bind failure as an event instead of silently running nowhere', async () => {
    const core = await createCore()
    const first = await core.startPublicServer({ port: 0 })
    await core.stopPublicServer()
    const squatter = await createOnPort(first.port)
    const failures: unknown[] = []
    core.events.on('server:bind-failed', (payload) => failures.push(payload))
    await expect(core.startPublicServer({ port: first.port })).rejects.toMatchObject({ code: 'IO_ERROR' })
    expect(failures).toMatchObject([{ port: first.port }])
    expect(core.publicState().running).toBe(false)
    await squatter.close()
  })
})
