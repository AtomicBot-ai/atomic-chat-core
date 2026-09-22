/**
 * Error reports from the compiled app binary, caught by a fake Sentry ingest: nothing leaves without
 * the app's consent, and with it a start-up failure, a load the engine failed, an engine that
 * crashed after loading and a compute failure each arrive once, scrubbed.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { APP_BIN, BIN } = core

interface SentEvent {
  level: string
  release: string
  environment: string
  user: { id?: string; ip_address: null }
  tags: Record<string, string>
  fingerprint?: string[]
  exception: { values: Array<{ type: string; value: string }> }
  extra?: Record<string, string>
}

let dataFolder: string
let pidFile: string
let ingest: Server
let events: SentEvent[]
let dsn: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-telemetry-'))
  pidFile = join(dataFolder, 'fake-llama.pids')
  events = []
  ingest = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      expect(req.url).toBe('/api/42/envelope/')
      expect(req.headers['x-sentry-auth']).toContain('sentry_key=pubkey')
      events.push(JSON.parse(body.split('\n')[2] as string) as SentEvent)
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', resolve))
  dsn = `http://pubkey@127.0.0.1:${(ingest.address() as AddressInfo).port}/42`
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await new Promise((resolve) => ingest.close(resolve))
  await rm(dataFolder, { recursive: true, force: true })
})

const env = () => ({ ATOMIC_CORE_SENTRY_DSN: dsn, ATOMIC_CORE_SENTRY_ENVIRONMENT: 'e2e' })

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, init)

const putTelemetry = (ready: ReadyLine, body: unknown) =>
  control(ready, '/telemetry', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const load = (ready: ReadyLine, modelId: string) =>
  control(ready, `/models/llamacpp-upstream/${modelId}/load`, { method: 'POST', body: '{}' })

async function eventually(count: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (events.length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} events, got ${JSON.stringify(events)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** No home folder, no user name, no data folder in anything that left the machine. */
function expectScrubbed(): void {
  const sent = JSON.stringify(events)
  expect(sent).not.toContain(homedir())
  expect(sent).not.toContain(dataFolder)
}

describe.skipIf(!existsSync(APP_BIN) || process.platform === 'win32')('error reports', () => {
  it('sends nothing without consent, and a failed load once the app consents', async () => {
    await core.writeModel(dataFolder, 'Owner/Broken-Q4_K_M')
    await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_MODE: 'exit-3' })
    const { ready } = await core.startDaemon(dataFolder, daemons, ['--telemetry', 'off'], env(), APP_BIN)

    expect((await load(ready, 'Owner/Broken-Q4_K_M')).status).toBeGreaterThanOrEqual(400)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(events).toEqual([])

    const consent = await putTelemetry(ready, {
      enabled: true,
      user_id: 'device-42',
      tags: { gpu_model: 'Apple M3', password: 'hunter2' },
    })
    expect(await consent.json()).toEqual({
      enabled: true,
      reporting: true,
      has_user: true,
      tags: { gpu_model: 'Apple M3' },
      source: 'host',
      host: 'atomic-chat',
    })
    expect((await load(ready, 'Owner/Broken-Q4_K_M')).status).toBeGreaterThanOrEqual(400)
    await eventually(1)
    const [event] = events as [SentEvent]
    expect(event).toMatchObject({
      level: 'error',
      release: 'atomic-chat-core@0.3.0',
      environment: 'e2e',
      user: { id: 'device-42', ip_address: null },
      tags: { source: 'model_load', provider: 'llamacpp-upstream', quant: 'Q4_K_M', gpu_model: 'Apple M3' },
    })
    expect(event.fingerprint?.slice(0, 2)).toEqual(['model-load-failure', 'llamacpp-upstream'])
    expect(JSON.stringify(event)).not.toContain('hunter2')
    expectScrubbed()

    // The same failure again is one issue already reported.
    await load(ready, 'Owner/Broken-Q4_K_M')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(events).toHaveLength(1)
  })

  it('reports a start-up failure as fatal and still exits 1', async () => {
    const notAFolder = join(dataFolder, 'not-a-folder')
    await writeFile(notAFolder, 'x')
    const child = spawn(APP_BIN, ['daemon', '--data-folder', notAFolder, '--telemetry', 'on'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...env() },
    })
    daemons.push(child)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    expect(await new Promise((resolve) => child.once('exit', resolve))).toBe(1)
    expect(stderr).toContain('ENOTDIR')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ level: 'fatal', tags: { source: 'startup', error_code: 'ENOTDIR' } })
    expect(events[0]?.exception.values[0]?.value).toContain('<data>/atomic-core')
    expectScrubbed()
  })

  it('reports an engine that crashes after loading, and a compute failure behind the public API', async () => {
    const marker = join(dataFolder, 'compute-error.marker')
    await core.writeModel(dataFolder, 'crashy')
    await core.writeFakeBackend(dataFolder, {
      FAKE_LLAMA_PID_FILE: pidFile,
      FAKE_LLAMA_COMPUTE_ERROR_MARKER: marker,
    })
    const { ready } = await core.startDaemon(dataFolder, daemons, ['--telemetry', 'on'], env(), APP_BIN)
    expect((await load(ready, 'crashy')).status).toBe(200)

    const started = await control(ready, '/server/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 0 }),
    })
    const { port } = (await started.json()) as { port: number }
    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'crashy', messages: [{ role: 'user', content: 'my secret prompt' }] }),
    })
    expect(chat.status).toBe(400)
    await eventually(1)
    expect(events[0]).toMatchObject({
      level: 'warning',
      fingerprint: ['inference-failure', 'llamacpp-upstream', 'compute'],
      exception: { values: [{ type: 'InferenceFailure', value: 'Compute error.' }] },
    })

    const pid = Number(readFileSync(pidFile, 'utf8').trim().split('\n').at(-1))
    process.kill(pid, 'SIGSEGV')
    await eventually(2)
    expect(events[1]).toMatchObject({
      level: 'error',
      fingerprint: ['backend-crash', 'llamacpp-upstream', 'sigsegv'],
      tags: { source: 'backend_crash', signal: 'SIGSEGV' },
    })
    expect(JSON.stringify(events)).not.toContain('my secret prompt')
    expectScrubbed()
  })

  it('reports from the CLI by itself, says so once, and stops after `telemetry off`', async () => {
    const notAFolder = join(dataFolder, 'not-a-folder')
    await writeFile(notAFolder, 'x')
    const cliDaemon = async (folder: string) => {
      const child = spawn(BIN, ['daemon', '--data-folder', folder, '--control-port', '0'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, ...env() },
      })
      daemons.push(child)
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      const code = await new Promise((resolve) => child.once('exit', resolve))
      return { code, stderr }
    }
    const first = await cliDaemon(notAFolder)
    expect(first.code).toBe(1)
    expect(first.stderr).toContain('Turn them off with `atomic-chat-core telemetry off` or DO_NOT_TRACK=1.')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      level: 'fatal',
      tags: { source: 'startup', host: 'cli', owner_scope: 'cli' },
    })
    expect(events[0]?.user.id).toMatch(/^[0-9a-f-]{36}$/)
    expectScrubbed()

    // A folder the CLI owns: the notice once, then the user's `telemetry off` silences the next crash.
    await core.writeModel(dataFolder, 'cli-crashy')
    await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_PID_FILE: pidFile })
    const noticed = await core.startDaemon(dataFolder, daemons, [], env(), BIN)
    expect((await control(noticed.ready, '/telemetry')).status).toBe(200)
    expect(await (await control(noticed.ready, '/telemetry')).json()).toMatchObject({
      enabled: true,
      source: 'default',
      host: 'cli',
    })
    expect(JSON.parse(readFileSync(join(dataFolder, 'atomic-core', 'telemetry.json'), 'utf8'))).toMatchObject(
      {
        notice_shown: true,
        install_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }
    )
    noticed.child.kill('SIGKILL')
    const off = core.runCli(dataFolder, ['telemetry', 'off'])
    expect(off.stdout).toContain('Error reports: off (your choice)')
    const { ready } = await core.startDaemon(dataFolder, daemons, [], env(), BIN)
    expect(await (await control(ready, '/telemetry')).json()).toMatchObject({
      enabled: false,
      source: 'stored',
    })
    expect((await load(ready, 'cli-crashy')).status).toBe(200)
    const pid = Number(readFileSync(pidFile, 'utf8').trim().split('\n').at(-1))
    process.kill(pid, 'SIGSEGV')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(events).toHaveLength(1)
  })
})
