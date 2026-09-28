/**
 * The `tensorrt-llm` provider through the compiled binary (task 2.14): a model loads into a fake
 * container, is served on `:1337/v1/chat/completions` through its session gateway, refuses
 * `/v1/embeddings` with a clear error, keeps one session at a time, cancels, and unloads with the
 * container stopped.
 *
 * The machine is the test host (`ATOMIC_MANAGED_TEST_HOST`, the same hook the managed environment's
 * own probe reads): `bin/docker` is `test/helpers/fake-model-docker.mjs`, `bin/nvidia-smi` is
 * `test/helpers/fake-nvidia-smi.mjs`, so this runs on any host without Docker or a GPU. The engine
 * installation is `ready` because its record and its pinned descriptor (the conf fixture) are written
 * where the setup operation would leave them, under `ATOMIC_CORE_MANAGED_ROOT`.
 *
 * No imports from `src/`: a packaging change that breaks a route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const FAKE_DOCKER = fileURLToPath(new URL('../helpers/fake-model-docker.mjs', import.meta.url))
const FAKE_NVIDIA_SMI = fileURLToPath(new URL('../helpers/fake-nvidia-smi.mjs', import.meta.url))
const DESCRIPTOR = fileURLToPath(new URL('../fixtures/runtimes/tensorrt-llm.json', import.meta.url))
const DESCRIPTOR_ID = (JSON.parse(readFileSync(DESCRIPTOR, 'utf8')) as { descriptor_id: string })
  .descriptor_id
/** The one card `fake-nvidia-smi.mjs` reports. */
const GPU = 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11'

let dataFolder: string
let managedRoot: string
let host: string
const daemons: ChildProcess[] = []

interface FakeContainer {
  status: string
  pid: number | null
  gpus: string
}
interface FakeDockerState {
  containers: Record<string, FakeContainer>
  calls: string[]
}

const dockerState = (): FakeDockerState =>
  existsSync(join(host, 'docker.json'))
    ? (JSON.parse(readFileSync(join(host, 'docker.json'), 'utf8')) as FakeDockerState)
    : { containers: {}, calls: [] }

const alive = (pid: number | null): boolean => {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function wrap(path: string, script: string, env: Record<string, string> = {}): Promise<void> {
  const exports = Object.entries(env)
    .map(([name, value]) => `export ${name}=${JSON.stringify(value)}\n`)
    .join('')
  await writeFile(
    path,
    `#!/bin/sh\n${exports}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`
  )
  await chmod(path, 0o755)
}

async function installModel(id: string, architecture: string): Promise<void> {
  const dir = join(dataFolder, 'tensorrt-llm', 'models', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ architectures: [architecture] }))
  await writeFile(
    join(dir, 'model.yml'),
    `name: ${id}\narchitectures:\n  - ${architecture}\nquantization: fp8\nfiles:\n` +
      `  - path: model.safetensors\n    size: 1000000000\n    sha256: null\n`
  )
}

async function writeInstallation(): Promise<void> {
  await mkdir(join(managedRoot, 'descriptors'), { recursive: true })
  await copyFile(DESCRIPTOR, join(managedRoot, 'descriptors', `${DESCRIPTOR_ID}.json`))
  const dir = join(managedRoot, 'installations', 'trt-1')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'installation.json'),
    JSON.stringify({
      schema_version: 1,
      installation: {
        installation_id: 'trt-1',
        engine_id: 'tensorrt-llm',
        environment_id: 'default',
        active_descriptor_id: DESCRIPTOR_ID,
        candidate_descriptor_id: null,
        availability: 'supported',
        status: 'ready',
      },
    })
  )
}

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-trt-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-trt-'))
  host = await mkdtemp(join(tmpdir(), 'atomic-trt-host-'))
  await mkdir(join(host, 'bin'))
  await wrap(join(host, 'bin', 'docker'), FAKE_DOCKER, { FAKE_DOCKER_STATE: join(host, 'docker.json') })
  await wrap(join(host, 'bin', 'nvidia-smi'), FAKE_NVIDIA_SMI)
  await writeInstallation()
  await installModel('llama-3', 'LlamaForCausalLM')
  await installModel('qwen3', 'Qwen3ForCausalLM')
  await installModel('slow-model', 'LlamaForCausalLM')
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  // The daemon had no chance to stop its "containers": end the fake engines it left running.
  for (const container of Object.values(dockerState().containers)) {
    if (alive(container.pid)) process.kill(container.pid as number, 'SIGKILL')
  }
  for (const dir of [dataFolder, managedRoot, host])
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const start = () =>
  core.startDaemon(dataFolder, daemons, [], {
    ATOMIC_CORE_MANAGED_ROOT: managedRoot,
    ATOMIC_MANAGED_TEST_HOST: host,
  })

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

const post = (ready: ReadyLine, path: string, body: unknown = {}) =>
  control(ready, path, { method: 'POST', body: JSON.stringify(body) })

interface Session {
  pid: number | null
  port: number
  model_id: string
  execution?: string
  generation?: string
}

async function load(ready: ReadyLine, model: string): Promise<Session> {
  const res = await post(ready, `/models/tensorrt-llm/${model}/load`)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { session: Session }).session
}

const publicPost = (port: number, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe.skipIf(!existsSync(core.BIN) || process.platform === 'win32')('the tensorrt-llm provider', () => {
  it('loads into a container, serves :1337 through the gateway, refuses embeddings, keeps one session and unloads', async () => {
    const { ready } = await start()

    const session = await load(ready, 'llama-3')
    expect(session).toMatchObject({ pid: null, execution: 'container', model_id: 'llama-3' })
    expect(session.generation).toEqual(expect.any(String))
    const first = Object.entries(dockerState().containers)
    expect(first).toHaveLength(1)
    expect(first[0]?.[1]).toMatchObject({ status: 'running', gpus: `device=${GPU}` })

    const serverRes = await post(ready, '/server/start', { port: 0 })
    expect(serverRes.status, await serverRes.clone().text()).toBe(200)
    const { port } = (await serverRes.json()) as { port: number }

    // Chat through :1337 → session gateway → container; the gateway caps the reply length.
    const chat = await publicPost(port, '/chat/completions', {
      model: 'llama-3',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100_000,
    })
    expect(chat.status, await chat.clone().text()).toBe(200)
    const answer = (await chat.json()) as {
      choices: Array<{ message: { content: string } }>
      received: { max_tokens: number }
    }
    expect(answer.choices[0]?.message.content).toBe('hello from the container')
    expect(answer.received.max_tokens).toBe(4096)

    const streamed = await publicPost(port, '/chat/completions', {
      model: 'llama-3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(streamed.status).toBe(200)
    expect(await streamed.text()).toContain('data: [DONE]')

    const listed = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>
    }
    expect(listed.data).toContainEqual(expect.objectContaining({ id: 'llama-3', owned_by: 'tensorrt-llm' }))

    // What the provider does not declare is refused with a clear error, not forwarded.
    const embeddings = await publicPost(port, '/embeddings', { model: 'llama-3', input: 'hello' })
    expect(embeddings.status).toBe(400)
    expect(await embeddings.json()).toMatchObject({
      error: { message: "The model 'llama-3' does not support embeddings.", code: 'unsupported_endpoint' },
    })
    const tools = await publicPost(port, '/chat/completions', {
      model: 'llama-3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    })
    expect(tools.status).toBe(400)
    expect(await tools.json()).toMatchObject({ error: { code: 'unsupported_capability' } })

    // A context overflow is an honest error with both numbers, and the session stays loaded.
    const overflow = await publicPost(port, '/chat/completions', {
      model: 'llama-3',
      messages: [{ role: 'user', content: 'OVERFLOW' }],
    })
    expect(overflow.status).toBe(400)
    const overflowBody = JSON.stringify(await overflow.json())
    expect(overflowBody).toContain('context_length_exceeded')
    expect(overflowBody).toContain('8192')
    expect(overflowBody).toContain('9000')

    const capabilities = await control(ready, '/models/tensorrt-llm/llama-3/capabilities')
    expect(await capabilities.json()).toMatchObject({ tools: false, embeddings: false, responses: false })
    const logs = await control(ready, '/models/tensorrt-llm/llama-3/logs')
    expect(await logs.json()).toMatchObject({
      source: 'session',
      log_tail: expect.stringContaining('fake engine starting'),
    })

    // One session at a time: the second model's load stops the first container first.
    await load(ready, 'qwen3')
    const sessions = (await (await control(ready, '/sessions')).json()) as {
      sessions: Array<{ provider: string; model_id: string }>
    }
    expect(sessions.sessions.filter((s) => s.provider === 'tensorrt-llm').map((s) => s.model_id)).toEqual([
      'qwen3',
    ])
    expect(Object.keys(dockerState().containers)).toHaveLength(1)
    expect(alive(first[0]?.[1].pid ?? null)).toBe(false)

    const unload = await post(ready, '/models/tensorrt-llm/qwen3/unload')
    expect(await unload.json()).toEqual({ success: true })
    expect(Object.keys(dockerState().containers)).toEqual([])
    const gone = await publicPost(port, '/chat/completions', { model: 'qwen3', messages: [] })
    expect(gone.status).toBe(503)
  })

  it('cancels a load that has not become ready: the container is stopped and no session is published', async () => {
    const { ready } = await start()
    const loading = post(ready, '/models/tensorrt-llm/slow-model/load')
    await expect.poll(() => Object.keys(dockerState().containers).length, { timeout: 15_000 }).toBe(1)

    const cancelled = await post(ready, '/models/tensorrt-llm/slow-model/load/cancel')
    expect(await cancelled.json()).toEqual({ cancelled: true })
    const res = await loading
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'MODEL_LOAD_CANCELLED' } })

    expect(Object.keys(dockerState().containers)).toEqual([])
    expect(dockerState().calls).toContain('stop')
    const sessions = (await (await control(ready, '/sessions')).json()) as { sessions: unknown[] }
    expect(sessions.sessions).toEqual([])
  })

  it('refuses to load with MANAGED_ADAPTER_UNAVAILABLE while the engine installation is not ready', async () => {
    await rm(join(managedRoot, 'installations'), { recursive: true, force: true })
    const { ready } = await start()
    const res = await post(ready, '/models/tensorrt-llm/llama-3/load')
    expect(await res.json()).toMatchObject({ error: { code: 'MANAGED_ADAPTER_UNAVAILABLE' } })
    expect(dockerState().calls).not.toContain('create')
  })
})
