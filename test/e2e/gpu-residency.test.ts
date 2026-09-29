/**
 * GPU residency across engines through the compiled binary (task 2.15, spec `gpu-residency`): one
 * resident model per card. A llama.cpp chat model on a GPU build and a `tensorrt-llm` container
 * replace each other, each stop confirmed before the next start; a llama.cpp model on a CPU build,
 * an embedding model and the voice (transcription) model are left alone; a container Docker will
 * not stop keeps its card, and the next load is refused with `GPU_BUSY` naming it.
 *
 * The machine is the test host (`ATOMIC_MANAGED_TEST_HOST`): `bin/docker` is
 * `test/helpers/fake-model-docker.mjs`, `bin/nvidia-smi` is `test/helpers/fake-nvidia-smi.mjs`, and
 * the llama.cpp backends are packs whose `llama-server` is `test/helpers/fake-llama-server.mjs` —
 * a pack named `linux-vulkan-x64` is a GPU build, one named `linux-cpu-x64` a CPU build, exactly as
 * the core reads a real pack's name. Nothing here needs Docker or a GPU.
 *
 * No imports from `src/`: a packaging change that breaks the rule cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const FAKE_DOCKER = fileURLToPath(new URL('../helpers/fake-model-docker.mjs', import.meta.url))
const FAKE_NVIDIA_SMI = fileURLToPath(new URL('../helpers/fake-nvidia-smi.mjs', import.meta.url))
const DESCRIPTOR = fileURLToPath(new URL('../fixtures/runtimes/tensorrt-llm.json', import.meta.url))
const DESCRIPTOR_JSON = JSON.parse(readFileSync(DESCRIPTOR, 'utf8')) as {
  descriptor_id: string
  image: Record<string, { repository: string; digest: string }>
}
const PLATFORM = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
/** The one card `fake-nvidia-smi.mjs` reports. */
const GPU = 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11'
/** The model id the app loads for voice input (`speculative/transcription-registry.ts`). */
const VOICE = 'ggml-org/Voxtral-Mini-3B-2507-Q4_K_M'
/** Upstream llama.cpp on a GPU build; the TurboQuant fork on a CPU build. */
const GPU_PACK = { provider: 'llamacpp-upstream' as const, version: 'b6325', backend: 'linux-vulkan-x64' }
const CPU_PACK = { provider: 'llamacpp' as const, version: 'b10018-1.3.0', backend: 'linux-cpu-x64' }

let dataFolder: string
let managedRoot: string
let host: string
let pidFile: string
const daemons: ChildProcess[] = []

interface FakeDockerState {
  containers: Record<string, { status: string; pid: number | null; gpus: string }>
  calls: string[]
}
interface Session {
  pid: number | null
  model_id: string
  port: number
  api_key: string
  is_embedding: boolean
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

const startedLlamaPids = (): number[] =>
  existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : []

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

async function installTrtModel(id: string): Promise<void> {
  const dir = join(dataFolder, 'tensorrt-llm', 'models', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ architectures: ['LlamaForCausalLM'] }))
  await writeFile(
    join(dir, 'model.yml'),
    `name: ${id}\narchitectures:\n  - LlamaForCausalLM\nquantization: fp8\nfiles:\n` +
      `  - path: model.safetensors\n    size: 1000000000\n    sha256: null\n`
  )
}

/** The `ready` engine installation exactly as the setup operation's activation leaves it. */
async function writeInstallation(): Promise<void> {
  await mkdir(join(managedRoot, 'descriptors'), { recursive: true })
  await copyFile(DESCRIPTOR, join(managedRoot, 'descriptors', `${DESCRIPTOR_JSON.descriptor_id}.json`))
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
        active_descriptor_id: DESCRIPTOR_JSON.descriptor_id,
        candidate_descriptor_id: null,
        availability: 'supported',
        status: 'ready',
      },
      image: DESCRIPTOR_JSON.image[PLATFORM],
      platform: PLATFORM,
      installed_at: '2026-09-29T00:00:00.000Z',
    })
  )
}

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-residency-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-residency-'))
  host = await mkdtemp(join(tmpdir(), 'atomic-residency-host-'))
  pidFile = join(dataFolder, 'fake-llama-pids')
  await mkdir(join(host, 'bin'))
  await wrap(join(host, 'bin', 'docker'), FAKE_DOCKER, { FAKE_DOCKER_STATE: join(host, 'docker.json') })
  await wrap(join(host, 'bin', 'nvidia-smi'), FAKE_NVIDIA_SMI)
  await writeInstallation()
  await installTrtModel('llama-3')
  await installTrtModel('stuck-model')
  // Both llama.cpp providers read the one `llamacpp/models` folder.
  for (const id of ['chat', 'sentence-transformer-mini', VOICE, 'cpu-chat'])
    await core.writeModel(dataFolder, id)
  const fakeEnv = { FAKE_LLAMA_PID_FILE: pidFile }
  await core.writeFakeBackend(dataFolder, fakeEnv, GPU_PACK)
  await core.writeFakeBackend(dataFolder, fakeEnv, CPU_PACK)
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  for (const pid of startedLlamaPids()) if (alive(pid)) process.kill(pid, 'SIGKILL')
  for (const container of Object.values(dockerState().containers))
    if (alive(container.pid)) process.kill(container.pid as number, 'SIGKILL')
  for (const dir of [dataFolder, managedRoot, host])
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

const post = (ready: ReadyLine, path: string, body: unknown = {}) =>
  control(ready, path, { method: 'POST', body: JSON.stringify(body) })

async function start(): Promise<ReadyLine> {
  const { ready } = await core.startDaemon(dataFolder, daemons, [], {
    ATOMIC_CORE_MANAGED_ROOT: managedRoot,
    ATOMIC_MANAGED_TEST_HOST: host,
  })
  for (const pack of [GPU_PACK, CPU_PACK]) {
    const chosen = await control(ready, `/settings/${pack.provider}`, {
      method: 'PATCH',
      body: JSON.stringify({ values: { version_backend: `${pack.version}/${pack.backend}`, fit: false } }),
    })
    expect(chosen.status, await chosen.clone().text()).toBe(200)
  }
  return ready
}

async function load(ready: ReadyLine, provider: string, model: string, body: unknown = {}): Promise<Session> {
  const res = await post(ready, `/models/${provider}/${model}/load`, body)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { session: Session }).session
}

async function sessions(ready: ReadyLine): Promise<string[]> {
  const body = (await (await control(ready, '/sessions')).json()) as {
    sessions: Array<{ provider: string; model_id: string }>
  }
  return body.sessions.map((s) => `${s.provider}/${s.model_id}`).sort()
}

/** The model claims this core still holds, one file per claimed model. */
const claims = async (): Promise<string[]> =>
  (await readdir(join(dataFolder, 'atomic-core', 'model-claims')).catch(() => [])).sort()

const runningContainers = () =>
  Object.values(dockerState().containers).filter((c) => c.status === 'running' && alive(c.pid))

describe.skipIf(!existsSync(core.BIN) || process.platform === 'win32')('GPU residency', () => {
  it('llama.cpp loaded, then tensorrt-llm: the llama-server exits, then the container starts, and its claim goes with it', async () => {
    const ready = await start()
    const chat = await load(ready, 'llamacpp-upstream', 'chat')
    expect(alive(chat.pid)).toBe(true)
    const claimed = await claims()
    expect(claimed).toHaveLength(1)

    await load(ready, 'tensorrt-llm', 'llama-3')
    expect(alive(chat.pid)).toBe(false)
    expect(await sessions(ready)).toEqual(['tensorrt-llm/llama-3'])
    expect(runningContainers()).toEqual([expect.objectContaining({ gpus: `device=${GPU}` })])
    // The evicted model's cross-process claim was released with its confirmed stop.
    expect((await claims()).filter((name) => claimed.includes(name))).toEqual([])
  })

  it('tensorrt-llm loaded, then llama.cpp on the GPU: the container is stopped with Docker’s confirmation, then llama-server starts', async () => {
    const ready = await start()
    await load(ready, 'tensorrt-llm', 'llama-3')
    const [container] = runningContainers()
    expect(container).toBeDefined()

    const chat = await load(ready, 'llamacpp-upstream', 'chat')
    expect(alive(chat.pid)).toBe(true)
    expect(alive(container?.pid ?? null)).toBe(false)
    const calls = dockerState().calls
    expect(calls).toContain('stop')
    expect(calls).toContain('rm')
    expect(Object.keys(dockerState().containers)).toEqual([])
    expect(await sessions(ready)).toEqual(['llamacpp-upstream/chat'])
  })

  it('a llama.cpp model on a CPU build stays loaded when a tensorrt-llm model loads', async () => {
    const ready = await start()
    const cpu = await load(ready, 'llamacpp', 'cpu-chat')
    await load(ready, 'tensorrt-llm', 'llama-3')
    expect(alive(cpu.pid)).toBe(true)
    expect(await sessions(ready)).toEqual(['llamacpp/cpu-chat', 'tensorrt-llm/llama-3'])
  })

  it('an embedding model warmed up while tensorrt-llm is loaded starts, and the tensorrt-llm model stays with no reload', async () => {
    const ready = await start()
    const trt = await load(ready, 'tensorrt-llm', 'llama-3')
    // What a RAG turn's warm-up asks for (`EmbedService`): an embedding load of the llama.cpp model.
    const embedding = await load(ready, 'llamacpp-upstream', 'sentence-transformer-mini', {
      isEmbedding: true,
    })
    expect(embedding.is_embedding).toBe(true)
    expect(await sessions(ready)).toEqual([
      'llamacpp-upstream/sentence-transformer-mini',
      'tensorrt-llm/llama-3',
    ])
    expect(runningContainers()).toHaveLength(1)

    // The next answer is served by the same container: nothing was stopped, nothing created again.
    const again = await load(ready, 'tensorrt-llm', 'llama-3')
    expect(again.port).toBe(trt.port)
    const chat = await fetch(`http://127.0.0.1:${trt.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${trt.api_key}` },
      body: JSON.stringify({ model: 'llama-3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(chat.status, await chat.clone().text()).toBe(200)
    expect(dockerState().calls.filter((call) => call === 'create')).toHaveLength(1)
    expect(dockerState().calls).not.toContain('stop')
  })

  it('the voice model stays loaded when a tensorrt-llm model loads', async () => {
    const ready = await start()
    // Loaded the way the app's dictation loads it: next to the chat model, evicting nothing.
    const voice = await load(ready, 'llamacpp-upstream', VOICE, { bypassAutoUnload: true })
    await load(ready, 'tensorrt-llm', 'llama-3')
    expect(alive(voice.pid)).toBe(true)
    expect(await sessions(ready)).toEqual([`llamacpp-upstream/${VOICE}`, 'tensorrt-llm/llama-3'])
  })

  it('a container Docker will not stop keeps its card: the next load gets GPU_BUSY naming it, and nothing starts', async () => {
    const ready = await start()
    await load(ready, 'tensorrt-llm', 'stuck-model')
    const [stuck] = runningContainers()

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await post(ready, '/models/llamacpp-upstream/chat/load')
      expect(res.status).toBe(409)
      const { error } = (await res.json()) as { error: { code: string; message: string; details: string } }
      expect(error.code).toBe('GPU_BUSY')
      expect(error.message).toContain('tensorrt-llm/stuck-model')
      // What to do about it: loading again retries the stop, or remove the container.
      expect(error.message).toContain('docker rm -f')
      expect(error.details).toContain('holder=tensorrt-llm/stuck-model state=stop-unconfirmed')
      expect(error.details).toContain('context deadline exceeded')
    }
    // Two attempts to stop it, and no llama-server was ever started.
    expect(dockerState().calls.filter((call) => call === 'stop')).toHaveLength(2)
    expect(startedLlamaPids()).toEqual([])
    expect(alive(stuck?.pid ?? null)).toBe(true)
    expect(await sessions(ready)).toEqual([])
    // A CPU-only load is not held up by a card it does not use.
    await load(ready, 'llamacpp', 'cpu-chat')
  })
})
