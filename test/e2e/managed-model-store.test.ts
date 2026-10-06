/**
 * The managed model store through the compiled binary (change `add-vllm-runtime`, task 2.5; spec
 * `managed-model-store`): TensorRT-LLM's models move from `<data>/tensorrt-llm/models` into
 * `<data>/managed-models` when core starts, keep their engine caches, leave an id the store already
 * has alone (and say so in the environment diagnostics), and a loaded model is deleted through the
 * store's route with its container stopped first.
 *
 * The machine is the test host (`ATOMIC_MANAGED_TEST_HOST`), as in `tensorrt-llm-provider.test.ts`:
 * a fake `docker` and `nvidia-smi`, a `ready` installation written where the setup would leave it.
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
const DESCRIPTOR_JSON = JSON.parse(readFileSync(DESCRIPTOR, 'utf8')) as {
  descriptor_id: string
  image: Record<string, { repository: string; digest: string }>
}
const DESCRIPTOR_ID = DESCRIPTOR_JSON.descriptor_id
/** The descriptor's image for the CPU this test runs on, as the setup would have pulled it. */
const PLATFORM = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
const ENGINE_IMAGE = DESCRIPTOR_JSON.image[PLATFORM] as { repository: string; digest: string }

let dataFolder: string
let managedRoot: string
let host: string
const daemons: ChildProcess[] = []

interface FakeContainer {
  status: string
  pid: number | null
  gpus: string
  user: string | null
}
interface FakeDockerState {
  containers: Record<string, FakeContainer>
  calls: string[]
  images_removed?: string[]
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

/** A model folder as the app writes it, `model.yml` last; `root` is the old TRT root or the store. */
async function installModel(root: string, id: string): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' })
  )
  await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(20, 1))
  await writeFile(
    join(dir, 'model.yml'),
    `name: ${id}\nrepository: acme/${id}\nrevision: deadbeef\narchitectures:\n  - LlamaForCausalLM\nquantization: bf16\nfiles:\n` +
      `  - path: model.safetensors\n    size: 20\n    sha256: null\n`
  )
  return dir
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
      image: ENGINE_IMAGE,
      platform: PLATFORM,
      installed_at: '2026-09-29T00:00:00.000Z',
    })
  )
}

const legacyRoot = () => join(dataFolder, 'tensorrt-llm', 'models')
const storeRoot = () => join(dataFolder, 'managed-models')
/** `<data>/atomic-core/managed-runtimes/caches/<descriptor>/<model>`: both ids are plain here. */
const cacheDir = (model: string) =>
  join(dataFolder, 'atomic-core', 'managed-runtimes', 'caches', DESCRIPTOR_ID, model)

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-store-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-store-'))
  host = await mkdtemp(join(tmpdir(), 'atomic-store-host-'))
  await mkdir(join(host, 'bin'))
  await wrap(join(host, 'bin', 'docker'), FAKE_DOCKER, { FAKE_DOCKER_STATE: join(host, 'docker.json') })
  await wrap(join(host, 'bin', 'nvidia-smi'), FAKE_NVIDIA_SMI)
  await writeInstallation()
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
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

describe('the managed model store', () => {
  it('Обновление с двумя моделями TRT: both move into the store at startup, are listed and load with their engine cache kept', async () => {
    await installModel(legacyRoot(), 'llama-3')
    await installModel(legacyRoot(), 'qwen3')
    // An engine cache the model built before the update: its key is the descriptor and the model id.
    await mkdir(cacheDir('llama-3'), { recursive: true })
    await writeFile(join(cacheDir('llama-3'), 'engine.bin'), 'built before the update')

    const { ready } = await start()

    expect(existsSync(join(storeRoot(), 'llama-3', 'model.yml'))).toBe(true)
    expect(existsSync(join(storeRoot(), 'qwen3', 'model.yml'))).toBe(true)
    expect(existsSync(legacyRoot())).toBe(false)
    const location = (await (await control(ready, '/managed-models/location')).json()) as { root: string }
    expect(location.root).toBe(storeRoot())

    const res = await post(ready, '/models/tensorrt-llm/llama-3/load')
    expect(res.status, await res.clone().text()).toBe(200)
    // The same cache folder, with what the first build left in it.
    expect(readFileSync(join(cacheDir('llama-3'), 'engine.bin'), 'utf8')).toBe('built before the update')
    // It loaded from the store: the old root is gone, so nothing else could have served it.
    expect(Object.keys(dockerState().containers)).toHaveLength(1)
  })

  it('Конфликт id: an id already in the store leaves both folders alone, and the diagnostics name it', async () => {
    const old = await installModel(legacyRoot(), 'llama-3')
    await writeFile(join(old, 'from'), 'the old root')
    const current = await installModel(storeRoot(), 'llama-3')
    await writeFile(join(current, 'from'), 'the store')

    const { ready } = await start()

    expect(readFileSync(join(old, 'from'), 'utf8')).toBe('the old root')
    expect(readFileSync(join(current, 'from'), 'utf8')).toBe('the store')
    const diagnostics = (await (await control(ready, '/environments/default/diagnostics')).json()) as {
      store_migration: { conflicts: { model_id: string }[] } | null
    }
    expect(diagnostics.store_migration?.conflicts.map((conflict) => conflict.model_id)).toEqual(['llama-3'])
  })

  it('deletes a loaded model through the store’s route: the container stops first, then its caches and its folder go', async () => {
    await installModel(storeRoot(), 'llama-3')
    const { ready } = await start()
    const loaded = await post(ready, '/models/tensorrt-llm/llama-3/load')
    expect(loaded.status, await loaded.clone().text()).toBe(200)

    const res = await control(ready, '/managed-models/llama-3', { method: 'DELETE' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ model_id: 'llama-3', was_loaded: true })
    expect(Object.keys(dockerState().containers)).toEqual([])
    expect(existsSync(join(storeRoot(), 'llama-3'))).toBe(false)
    expect(existsSync(cacheDir('llama-3'))).toBe(false)
  })
})
