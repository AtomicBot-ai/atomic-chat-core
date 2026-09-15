/**
 * The phase-1 exit criteria, run against the compiled binary (PLAN.md §4, §5.1 "E2E (бинарь)"):
 * a daemon that owns a data folder, two clients attached at once, the public listener stopping and
 * starting without control noticing, a second owner refused, a crashed owner recovered, and an
 * explicit shutdown that leaves no backend process behind.
 *
 * Everything here goes through the binary's own stdout/exit codes — no imports from `src/` — so a
 * packaging change that breaks the CLI cannot pass by type-checking.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TRIPLE =
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin'
    : process.platform === 'win32'
      ? 'x86_64-pc-windows-msvc.exe'
      : 'x86_64-unknown-linux-gnu'
const BIN = join(ROOT, 'dist/bin', `atomic-chat-core-${TRIPLE}`)
const FAKE_LLAMA = join(ROOT, 'test/helpers/fake-llama-server.mjs')

interface ReadyLine {
  event: string
  pid: number
  instance_id: string
  protocol: number
  version: string
  control_host: string
  control_port: number
}

let dataFolder: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    daemon.kill('SIGKILL')
  }
  await rm(dataFolder, { recursive: true, force: true })
})

const run = (args: string[]) =>
  spawnSync(BIN, [...args, '--data-folder', dataFolder], { encoding: 'utf8', timeout: 30_000 })

const runAsync = (args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(BIN, [...args, '--data-folder', dataFolder], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', reject)
    child.once('exit', (status) => resolve({ status, stdout, stderr }))
  })

/** Start `daemon` and wait for the ready line it prints on stdout. */
async function startDaemon(extra: string[] = []): Promise<{ ready: ReadyLine; child: ChildProcess }> {
  const child = spawn(BIN, ['daemon', '--data-folder', dataFolder, '--control-port', '0', ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemons.push(child)
  let stdout = ''
  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
  const ready = await new Promise<ReadyLine>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const line = stdout.split('\n')[0]
      if (line && stdout.includes('\n')) {
        try {
          resolve(JSON.parse(line) as ReadyLine)
        } catch (e) {
          reject(new Error(`ready line is not JSON: ${line} (${(e as Error).message})`))
        }
      }
    })
    child.once('exit', (code) => reject(new Error(`daemon exited with ${code}\n${stderr}`)))
    setTimeout(() => reject(new Error(`no ready line in 20s\n${stderr}`)), 20_000).unref()
  })
  return { ready, child }
}

const controlToken = () => readFileSync(join(dataFolder, 'atomic-core', 'control-token'), 'utf8').trim()

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  fetch(`http://${ready.control_host}:${ready.control_port}/atomic/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${controlToken()}`, ...(init.headers ?? {}) },
  })

async function writeModel(id: string): Promise<void> {
  const dir = join(dataFolder, 'llamacpp', 'models', ...id.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.gguf'), Buffer.alloc(64, 0x47))
  await writeFile(
    join(dir, 'model.yml'),
    `model_path: llamacpp/models/${id}/model.gguf\nname: ${id}\nsize_bytes: 64\nmodel_size_bytes: 64\n`
  )
}

/** A backend pack whose `llama-server` is the fake one, so `serve` can actually load something. */
async function writeFakeBackend(): Promise<void> {
  const dir = join(dataFolder, 'llamacpp-upstream', 'backends', 'b6325', 'macos-arm64', 'build', 'bin')
  await mkdir(dir, { recursive: true })
  const exe = join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
  await writeFile(
    exe,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_LLAMA)} "$@"\n`,
    {
      mode: 0o755,
    }
  )
}

describe.skipIf(!existsSync(BIN))('the compiled core as an owner', () => {
  it('prints a ready line, answers control, and refuses a second owner', async () => {
    const { ready } = await startDaemon()
    expect(ready).toMatchObject({ event: 'core:ready', protocol: 1 })
    expect(ready.control_port).toBeGreaterThan(0)
    expect(ready.pid).toBeGreaterThan(0)

    const health = await control(ready, '/health')
    expect(health.status).toBe(200)
    expect((await health.json()) as object).toMatchObject({ ok: true, instance_id: ready.instance_id })

    expect((await control(ready, '/health', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)

    const second = spawnSync(BIN, ['daemon', '--data-folder', dataFolder, '--control-port', '0'], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(second.status).toBe(1)
    expect(second.stderr).toContain('CORE_ALREADY_RUNNING')
  })

  it('serves a model over /v1 and keeps it loaded after the command exits', async () => {
    await writeModel('demo')
    await writeFakeBackend()
    const { ready } = await startDaemon()

    const serve = run(['serve', 'demo', '--port', '0', '--json'])
    expect(serve.status, serve.stderr).toBe(0)
    const served = JSON.parse(serve.stdout) as {
      session: { model_id: string; pid: number; port: number }
      server: { port: number; running: boolean }
    }
    expect(served.session.model_id).toBe('demo')
    expect(served.server.running).toBe(true)

    const models = await fetch(`http://127.0.0.1:${served.server.port}/v1/models`)
    expect(models.status, `GET /v1/models on ${served.server.port}: ${await models.clone().text()}`).toBe(200)
    expect((await models.json()) as { data: Array<{ id: string }> }).toMatchObject({
      data: [{ id: 'demo' }],
    })

    const completion = await fetch(`http://127.0.0.1:${served.server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(completion.status).toBe(200)
    expect(
      ((await completion.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message
        .content
    ).toContain('fake backend')

    // The session belongs to the core, not to the command that asked for it.
    const sessions = (await (await control(ready, '/sessions')).json()) as {
      sessions: Array<{ model_id: string }>
    }
    expect(sessions.sessions.map((s) => s.model_id)).toEqual(['demo'])
  })

  it('streams and cancels a completion', async () => {
    await writeModel('demo')
    await writeFakeBackend()
    await startDaemon()
    const serve = run(['serve', 'demo', '--port', '0', '--json'])
    const { server } = JSON.parse(serve.stdout) as { server: { port: number } }

    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('chat.completion.chunk')
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
  })

  it('stops and restarts the public listener while control stays up', async () => {
    const { ready } = await startDaemon()
    const started = (await (
      await control(ready, '/server/start', { method: 'POST', body: JSON.stringify({ port: 0 }) })
    ).json()) as { port: number; running: boolean }
    expect(started.running).toBe(true)
    expect((await fetch(`http://127.0.0.1:${started.port}/`)).status).toBe(200)

    await control(ready, '/server/stop', { method: 'POST' })
    await expect(fetch(`http://127.0.0.1:${started.port}/`)).rejects.toThrow()
    expect((await control(ready, '/health')).status, 'control survives').toBe(200)

    const restarted = (await (
      await control(ready, '/server/start', { method: 'POST', body: JSON.stringify({ port: 0 }) })
    ).json()) as { port: number }
    expect((await fetch(`http://127.0.0.1:${restarted.port}/`)).status).toBe(200)
  })

  it('lets two clients attach at once and refuses shutdown until one is gone', async () => {
    const { ready } = await startDaemon()
    const app = (await (
      await control(ready, '/clients', { method: 'POST', body: JSON.stringify({ name: 'app' }) })
    ).json()) as { client: { id: string } }
    const cli = (await (
      await control(ready, '/clients', { method: 'POST', body: JSON.stringify({ name: 'cli' }) })
    ).json()) as { client: { id: string } }

    const refused = await control(ready, '/shutdown', {
      method: 'POST',
      body: JSON.stringify({ client_id: cli.client.id }),
    })
    expect(refused.status).toBe(409)
    expect((await control(ready, '/health')).status).toBe(200)

    await control(ready, `/clients/${app.client.id}`, { method: 'DELETE' })
    const accepted = await control(ready, '/shutdown', {
      method: 'POST',
      body: JSON.stringify({ client_id: cli.client.id }),
    })
    expect(accepted.status).toBe(200)
  })

  it('recovers a data folder whose owner was killed, and reaps its backend', async () => {
    await writeModel('demo')
    await writeFakeBackend()
    const first = await startDaemon()
    const serve = run(['serve', 'demo', '--port', '0', '--json'])
    const { session } = JSON.parse(serve.stdout) as { session: { pid: number } }
    expect(isAlive(session.pid)).toBe(true)

    first.child.kill('SIGKILL')
    await waitFor(() => !isAlive(first.ready.pid))

    const second = await startDaemon()
    expect(second.ready.instance_id).not.toBe(first.ready.instance_id)
    await waitFor(() => !isAlive(session.pid))
    expect(isAlive(session.pid), 'the orphaned backend must not outlive its owner').toBe(false)
    const sessions = (await (await control(second.ready, '/sessions')).json()) as { sessions: unknown[] }
    expect(sessions.sessions, 'a new owner starts with no sessions').toEqual([])
  })

  it('shuts down on request, leaving no lock and no backend process', async () => {
    await writeModel('demo')
    await writeFakeBackend()
    const { ready, child } = await startDaemon()
    const serve = run(['serve', 'demo', '--port', '0', '--json'])
    const { session } = JSON.parse(serve.stdout) as { session: { pid: number } }

    const result = run(['shutdown'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Core is stopping')
    await waitFor(() => !isAlive(ready.pid))
    await waitFor(() => !isAlive(session.pid))
    expect(existsSync(join(dataFolder, 'atomic-core', 'instance.lock'))).toBe(false)
    expect(child.exitCode === 0 || child.signalCode !== null).toBe(true)

    expect(run(['shutdown']).stdout).toContain('No core is running')
  })

  it('starts a core by itself when `serve` finds none running', async () => {
    await writeModel('demo')
    await writeFakeBackend()
    const serve = run(['serve', 'demo', '--port', '0', '--json'])
    expect(serve.status, serve.stderr).toBe(0)
    const served = JSON.parse(serve.stdout) as { session: { pid: number }; server: { port: number } }
    expect((await fetch(`http://127.0.0.1:${served.server.port}/v1/models`)).status).toBe(200)

    // The core it started is a real owner: the lock names it, and `shutdown` finds it.
    const status = run(['server', 'status'])
    expect(status.status).toBe(0)
    const stopped = run(['shutdown'])
    expect(stopped.status, stopped.stderr).toBe(0)
    await waitFor(() => !isAlive(served.session.pid))
  })

  it('lets two simultaneous serve commands converge on one newly launched owner', async () => {
    await writeModel('demo')
    await writeFakeBackend()
    const [first, second] = await Promise.all([
      runAsync(['serve', 'demo', '--port', '0', '--json']),
      runAsync(['serve', 'demo', '--port', '0', '--json']),
    ])
    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    const a = JSON.parse(first.stdout) as { session: { pid: number }; server: { port: number } }
    const b = JSON.parse(second.stdout) as { session: { pid: number }; server: { port: number } }
    expect(b.session.pid).toBe(a.session.pid)
    expect(b.server.port).toBe(a.server.port)
    expect(run(['shutdown']).status).toBe(0)
    await waitFor(() => !isAlive(a.session.pid))
  })

  it('lists models and reports server status without a running core', async () => {
    await writeModel('one')
    await writeModel('two/nested')
    const list = run(['models', 'list', '--json'])
    expect(list.status).toBe(0)
    expect((JSON.parse(list.stdout) as Array<{ id: string }>).map((m) => m.id)).toEqual(['one', 'two/nested'])

    const table = run(['models', 'list'])
    expect(table.stdout).toContain('MODEL ID')

    const status = run(['server', 'status'])
    expect(status.status, 'no server means exit 1').toBe(1)
    expect(status.stdout).toContain('No Local API Server')
  })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 50))
  }
}
