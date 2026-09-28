/**
 * The managed-text lifecycle end to end against a fake `docker` executable (a real spawned process
 * per call, through `createDockerExec`), real timers, the real desktop deployment, the real readiness
 * probe and the real session gateway. The fake's `start` launches a tiny HTTP server on the host port
 * `docker create` was given, standing in for the engine behind the container's published port — so a
 * request through the gateway really reaches "the container", and an unload really stops it.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { ExecutionJournal, createDockerExec } from '../container/index.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { MANAGED_TEXT_ADAPTER_CONTRACT_VERSION, ManagedTextAdapterRegistry } from './adapter.js'
import type { ManagedTextAdapter } from './adapter.js'
import { createDesktopManagedDeployment } from './deployment.js'
import { ManagedTextLifecycle } from './lifecycle.js'
import type { ManagedLoadRequest } from './lifecycle.js'

const FAKE_DOCKER = String.raw`
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const statePath = process.env.FAKE_DOCKER_STATE
const db = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { n: 0, containers: {} }
const save = () => fs.writeFileSync(statePath, JSON.stringify(db))
const args = process.argv.slice(2).slice(2) // drop '--host <socket>'
const sub = args[0]
const id = args[args.length - 1]
const c = db.containers[id]
const stamp = (line) => new Date().toISOString().replace('Z', '000000Z') + ' ' + line
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const noSuch = () => { console.error('Error response from daemon: No such container: ' + id); process.exit(1) }
if (sub === 'create') {
  const [, hostPort] = args[args.indexOf('-p') + 1].split(':')
  const newId = 'fake' + String(++db.n).padStart(8, '0')
  db.containers[newId] = { status: 'created', hostPort: Number(hostPort), crash: args.includes('--crash'), pid: null, exitCode: 0, logs: [] }
  save()
  console.log(newId)
  process.exit(0)
}
if (!c) noSuch()
if (sub === 'start') {
  if (c.crash) {
    c.logs.push(stamp('loading weights'), stamp('CUDA out of memory. Tried to allocate 3.00 GiB'))
    c.status = 'exited'
    c.exitCode = 1
  } else {
    const engine = "require('http').createServer((q, r) => r.end(JSON.stringify({ path: q.url, auth: q.headers.authorization || null }))).listen(" + c.hostPort + ", '127.0.0.1')"
    const child = spawn(process.execPath, ['-e', engine], { detached: true, stdio: 'ignore' })
    child.unref()
    c.pid = child.pid
    c.status = 'running'
    c.logs.push(stamp('engine listening'))
  }
  save()
  process.exit(0)
}
if (sub === 'container' && args[1] === 'inspect') {
  if (c.status === 'running' && !alive(c.pid)) { c.status = 'exited'; c.exitCode = 137; save() }
  console.log(JSON.stringify([{ Id: id, State: { Status: c.status, Running: c.status === 'running', ExitCode: c.exitCode } }]))
  process.exit(0)
}
if (sub === 'stop') {
  if (c.pid && alive(c.pid)) process.kill(c.pid, 'SIGKILL')
  c.status = 'exited'
  save()
  process.exit(0)
}
if (sub === 'rm') { delete db.containers[id]; save(); process.exit(0) }
if (sub === 'logs') { console.log(c.logs.join('\n')); process.exit(0) }
console.error('fake docker: unsupported ' + args.join(' '))
process.exit(1)
`

const adapter: ManagedTextAdapter<{ crash: boolean }> = {
  id: 'integration-engine',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/health', expectedStatus: 200 },
  routes: [{ method: 'GET', path: '/v1/models' }],
  stageMarkers: [],
  validateSettings: (raw) => ({ crash: (raw as { crash?: boolean } | undefined)?.crash === true }),
  buildLaunch: (c) => ({
    engine: { container_port: 8000 },
    argv: ['serve', c.modelPath, ...(c.settings.crash ? ['--crash'] : [])],
  }),
  readinessTimeoutMs: () => 20_000,
  classifyExit: (tail) =>
    /out of memory/.test(tail)
      ? { kind: 'out-of-memory', message: 'The GPU ran out of memory.' }
      : { kind: 'other', message: 'exited' },
  capabilities: () => ({
    tools: false,
    reasoning: false,
    structured_output: false,
    vision: false,
    embeddings: false,
    responses: false,
  }),
}

let data: TmpDataFolder
let lifecycle: ManagedTextLifecycle
let journal: ExecutionJournal
let modelDir: string

beforeEach(async () => {
  data = await makeTmpDataFolder('managed-lifecycle-it-')
  const script = join(data.root, 'fake-docker.mjs')
  const wrapper = join(data.root, 'docker')
  await writeFile(script, FAKE_DOCKER)
  await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`)
  await chmod(wrapper, 0o755)
  modelDir = join(data.root, 'engine', 'models', 'm')
  await mkdir(modelDir, { recursive: true })

  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(adapter)
  journal = await ExecutionJournal.open(data.layout)
  lifecycle = new ManagedTextLifecycle({
    provider: 'llamacpp-upstream',
    adapters,
    exec: createDockerExec({
      dockerPath: wrapper,
      dockerConfigDir: data.layout.managed.dockerConfigDir,
      env: { ...process.env, FAKE_DOCKER_STATE: join(data.root, 'fake-docker.json') },
    }),
    deployment: createDesktopManagedDeployment(),
    journal,
    paths: data.layout.managed,
    instanceId: 'core-it',
    scope: 'cli',
    allowedHosts: [],
    selinuxDataRoot: data.root,
    emit: () => {},
    timings: { pollIntervalMs: 50, monitorIntervalMs: 50 },
  })
})

afterEach(async () => {
  await lifecycle.shutdown()
  await data.cleanup()
})

const load = (settings: unknown = {}): ManagedLoadRequest => ({
  modelId: 'm',
  modelPath: modelDir,
  weightBytes: 1,
  installation: {
    descriptor_id: 'it-r1',
    engine_id: 'integration',
    adapter_id: 'integration-engine',
    adapter_contract_version: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
    image: { repository: 'registry.example/it', digest: `sha256:${'e'.repeat(64)}` },
  },
  family: null,
  gpuUuid: 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  selinux: false,
  settings,
})

function get(port: number, apiKey: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/v1/models', headers: { authorization: `Bearer ${apiKey}` } },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('ManagedTextLifecycle against a fake docker binary', () => {
  it('loads, serves through the gateway without leaking its key upstream, and unloads with a confirmed stop', async () => {
    const info = await lifecycle.load(load())
    expect(journal.list()).toHaveLength(1)
    const reply = await get(info.port, info.api_key)
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ path: '/v1/models', auth: null })

    await lifecycle.unload('m')
    expect(journal.list()).toEqual([])
    expect(lifecycle.reservations()).toEqual([])
  })

  it('fails an engine that exits before readiness within a poll or two, with the classification and tail', async () => {
    const started = Date.now()
    const error = await lifecycle.load(load({ crash: true })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AtomicCoreError)
    expect((error as AtomicCoreError).code).toBe('OUT_OF_MEMORY')
    expect((error as AtomicCoreError).details).toBe(
      'loading weights\nCUDA out of memory. Tried to allocate 3.00 GiB\n'
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(journal.list()).toEqual([])
    expect(await lifecycle.logs('m')).toContain('CUDA out of memory')
  })
})
