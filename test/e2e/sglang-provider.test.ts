/**
 * The `sglang` provider through the compiled binary (change `add-sglang-runtime`, task 2.4; spec
 * `sglang-runtime`): a model of the managed store loads into a fake `sglang.launch_server` container,
 * is served on `:1337/v1` through its session gateway, refuses what SGLang does not declare, fails fast
 * and classified when SGLang dies before it is ready or cannot generate, maps SGLang's context
 * overflow, starts its container with the network-free env and the isolated `docker create` flags, is
 * stopped by the next core after a crash, follows the card in its settings, shares cards with vLLM by
 * the residency rule, takes a model over from vLLM, and gives its card to llama.cpp.
 *
 * The machine is the test host (`ATOMIC_MANAGED_TEST_HOST`): `bin/docker` is
 * `test/helpers/fake-model-docker.mjs`, which runs `fake-sglang-engine.mjs` for an
 * `sglang.launch_server` command; `bin/nvidia-smi` is `fake-nvidia-smi.mjs`. The engines'
 * installations are `ready` because their records and pinned descriptors (the conf fixtures) are
 * written where the setup would leave them.
 *
 * No imports from `src/`: a packaging change that breaks a route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const FAKE_DOCKER = fileURLToPath(new URL('../helpers/fake-model-docker.mjs', import.meta.url))
const FAKE_NVIDIA_SMI = fileURLToPath(new URL('../helpers/fake-nvidia-smi.mjs', import.meta.url))
const PLATFORM = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
const descriptorOf = (file: string) => {
  const path = fileURLToPath(new URL(`../fixtures/runtimes/${file}`, import.meta.url))
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    descriptor_id: string
    engine_id: string
    image: Record<string, { repository: string; digest: string }>
  }
  return { path, id: json.descriptor_id, engine: json.engine_id, image: json.image[PLATFORM] }
}
const SGLANG = descriptorOf('sglang.json')
const VLLM = descriptorOf('vllm.json')
/** The one card `fake-nvidia-smi.mjs` reports by default. */
const GPU = 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11'
const SECOND_GPU = 'GPU-7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
/** Upstream llama.cpp on a GPU build, as `gpu-residency.test.ts` names it. */
const GPU_PACK = { provider: 'llamacpp-upstream' as const, version: 'b6325', backend: 'linux-vulkan-x64' }

let dataFolder: string
let managedRoot: string
let host: string
const daemons: ChildProcess[] = []

interface FakeContainer {
  status: string
  pid: number | null
  gpus: string
  engine: string
  args: string[]
}
interface FakeDockerState {
  containers: Record<string, FakeContainer>
  calls: string[]
}

const dockerState = (): FakeDockerState =>
  existsSync(join(host, 'docker.json'))
    ? (JSON.parse(readFileSync(join(host, 'docker.json'), 'utf8')) as FakeDockerState)
    : { containers: {}, calls: [] }
const containersOf = (engine: string) =>
  Object.values(dockerState().containers).filter((c) => c.engine === engine)

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

/** A model of the store: a small Qwen3-shaped `config.json`, a 20-byte weight file, `model.yml` last. */
async function installModel(id: string, architecture = 'Qwen3ForCausalLM'): Promise<void> {
  const dir = join(dataFolder, 'managed-models', id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      architectures: [architecture],
      dtype: 'bfloat16',
      num_hidden_layers: 4,
      num_attention_heads: 8,
      num_key_value_heads: 2,
      head_dim: 64,
      hidden_size: 512,
    })
  )
  await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(20, 1))
  await writeFile(
    join(dir, 'model.yml'),
    `name: ${id}\nrepository: acme/${id}\nrevision: deadbeef\narchitectures:\n  - ${architecture}\nfiles:\n` +
      `  - path: model.safetensors\n    size: 20\n    sha256: null\n`
  )
}

async function writeInstallation(descriptor: typeof SGLANG): Promise<void> {
  await mkdir(join(managedRoot, 'descriptors'), { recursive: true })
  await copyFile(descriptor.path, join(managedRoot, 'descriptors', `${descriptor.id}.json`))
  const dir = join(managedRoot, 'installations', descriptor.engine)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'installation.json'),
    JSON.stringify({
      schema_version: 1,
      installation: {
        installation_id: descriptor.engine,
        engine_id: descriptor.engine,
        environment_id: 'default',
        active_descriptor_id: descriptor.id,
        candidate_descriptor_id: null,
        availability: 'supported',
        status: 'ready',
      },
      image: descriptor.image,
      platform: PLATFORM,
      installed_at: '2026-10-13T00:00:00.000Z',
    })
  )
}

const twoCards = () =>
  wrap(join(host, 'bin', 'nvidia-smi'), FAKE_NVIDIA_SMI, {
    FAKE_NVIDIA_SMI_GPUS: JSON.stringify([
      { 'uuid': GPU, 'memory.total': '24564', 'memory.free': '24000' },
      {
        'uuid': SECOND_GPU,
        'memory.total': '24564',
        'memory.free': '23000',
        'pci.bus_id': '00000000:02:00.0',
      },
    ]),
  })

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-sglang-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-sglang-'))
  host = await mkdtemp(join(tmpdir(), 'atomic-sglang-host-'))
  await mkdir(join(host, 'bin'))
  await wrap(join(host, 'bin', 'docker'), FAKE_DOCKER, { FAKE_DOCKER_STATE: join(host, 'docker.json') })
  await wrap(join(host, 'bin', 'nvidia-smi'), FAKE_NVIDIA_SMI)
  await writeInstallation(SGLANG)
  await installModel('qwen3')
  await installModel('other')
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
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
    // Never conf main in a test: SGLang's descriptor is the fixture the installation already pinned.
    ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG: pathToFileURL(SGLANG.path).href,
  })

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
const post = (ready: ReadyLine, path: string, body: unknown = {}) =>
  control(ready, path, { method: 'POST', body: JSON.stringify(body) })
const patchSettings = (ready: ReadyLine, provider: string, values: Record<string, unknown>) =>
  control(ready, `/settings/${provider}`, { method: 'PATCH', body: JSON.stringify({ values }) })
const publicPost = (port: number, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

interface Session {
  port: number
  api_key: string
  model_id: string
  execution?: string
  pid: number | null
}

async function load(ready: ReadyLine, provider: string, model: string): Promise<Session> {
  const res = await post(ready, `/models/${provider}/${model}/load`)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { session: Session }).session
}

async function publicPort(ready: ReadyLine): Promise<number> {
  const res = await post(ready, '/server/start', { port: 0 })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { port: number }).port
}

const argOf = (args: string[], name: string) => args[args.indexOf(name) + 1]

describe.skipIf(!existsSync(core.BIN) || process.platform === 'win32')('the sglang provider', () => {
  it('Чат через публичный API: chat and stream through :1337 reach the SGLang container; what SGLang does not declare is refused', async () => {
    const { ready } = await start()
    const session = await load(ready, 'sglang', 'qwen3')
    expect(session).toMatchObject({ execution: 'container', pid: null, model_id: 'qwen3' })
    const port = await publicPort(ready)

    const chat = await publicPost(port, '/chat/completions', {
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100_000,
    })
    expect(chat.status, await chat.clone().text()).toBe(200)
    const answer = (await chat.json()) as {
      choices: { message: { content: string } }[]
      received: { max_tokens: number }
    }
    expect(answer.choices[0]?.message.content).toBe('hello from sglang')
    expect(answer.received.max_tokens).toBe(4096)

    // Длинный промпт без max_tokens: nothing is written into the request; SGLang's own limit
    // (SGLANG_MAX_NEW_TOKENS_LIMIT) caps the reply within the room the context has left.
    const uncapped = (await (
      await publicPost(port, '/chat/completions', {
        model: 'qwen3',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).json()) as { received: Record<string, unknown> }
    expect(uncapped.received).not.toHaveProperty('max_tokens')
    expect(containersOf('sglang')[0]?.args).toContain('SGLANG_MAX_NEW_TOKENS_LIMIT=4096')

    const streamed = await publicPost(port, '/chat/completions', {
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(await streamed.text()).toContain('hello from sglang')

    const listed = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
      data: { id: string; owned_by: string }[]
    }
    expect(listed.data).toContainEqual(expect.objectContaining({ id: 'qwen3', owned_by: 'sglang' }))

    const embeddings = await publicPost(port, '/embeddings', { model: 'qwen3', input: 'x' })
    expect(embeddings.status).toBe(400)
    const responses = await publicPost(port, '/responses', { model: 'qwen3', input: 'hi' })
    expect(responses.status).toBe(400)

    // Изображение в запросе: refused, and the session stays.
    const image = await publicPost(port, '/chat/completions', {
      model: 'qwen3',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
      ],
    })
    expect(image.status).toBe(400)
    expect(await image.json()).toMatchObject({ error: { code: 'unsupported_capability' } })

    // Длинная переписка: OpenAI's context_length_exceeded with both numbers, the session kept.
    const overflow = await publicPost(port, '/chat/completions', {
      model: 'qwen3',
      messages: [{ role: 'user', content: 'OVERFLOW' }],
    })
    expect(overflow.status).toBe(400)
    const overflowBody = (await overflow.json()) as { error: { code: string; message: string } }
    expect(overflowBody.error.code).toBe('context_length_exceeded')
    expect(overflowBody.error.message).toMatch(/8192.*9000/)

    // Служебный маршрут движка: the session port answers 404 itself, nothing reaches the container.
    for (const [method, path] of [
      ['POST', '/v1/embeddings'],
      ['GET', '/server_info'],
      ['POST', '/flush_cache'],
      ['GET', '/metrics'],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${session.port}${path}`, {
        method,
        headers: { 'authorization': `Bearer ${session.api_key}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect(res.status, path).toBe(404)
      expect(await res.text()).not.toContain('reached')
    }
    expect(containersOf('sglang')).toHaveLength(1)
  })

  it('Проверка параметров запуска / Окружение и аргументы контейнера: isolated flags, a read-only model, no network, core’s memory share', async () => {
    const { ready } = await start()
    await load(ready, 'sglang', 'qwen3')
    const [container] = containersOf('sglang')
    const args = container?.args ?? []
    expect(args).toContain('--restart=no')
    expect(args).not.toContain('--privileged')
    expect(args).not.toContain('--ipc=host')
    expect(args.join(' ')).not.toContain('docker.sock:')
    expect(args.find((a) => a.endsWith(':/atomic/model:ro'))).toContain(join('managed-models', 'qwen3'))
    expect(args[args.indexOf('-p') + 1]).toMatch(/^127\.0\.0\.1:/)
    expect(container?.gpus).toBe(`device=${GPU}`)
    expect(args).toEqual(expect.arrayContaining(['python3', '-m', 'sglang.launch_server']))
    for (const env of ['HF_HUB_OFFLINE=1', 'TRANSFORMERS_OFFLINE=1', 'DO_NOT_TRACK=1']) {
      expect(args).toContain(env)
    }
    expect(args.some((a) => a.startsWith('SGLANG_CACHE_DIR=/atomic/engine-cache/'))).toBe(true)
    for (const forbidden of [
      '--trust-remote-code',
      '--log-requests',
      '--api-key',
      '--admin-api-key',
      '--enable-metrics',
    ]) {
      expect(args).not.toContain(forbidden)
    }
    // SGLang sizes its own KV cache within its share unless the KV token limit fixes it.
    expect(args).not.toContain('--max-total-tokens')
    const share = Number(argOf(args, '--mem-fraction-static'))
    expect(share).toBeGreaterThanOrEqual(0.5)
    expect(share).toBeLessThanOrEqual(0.95)
    expect(argOf(args, '--max-running-requests')).toBe('1')
    expect(argOf(args, '--cuda-graph-max-bs-decode')).toBe('1')
  })

  it('Доля задана вручную: the memory share setting reaches SGLang as it is', async () => {
    const { ready } = await start()
    expect((await patchSettings(ready, 'sglang', { mem_fraction_static: 0.7 })).status).toBe(200)
    await load(ready, 'sglang', 'qwen3')
    expect(argOf(containersOf('sglang')[0]?.args ?? [], '--mem-fraction-static')).toBe('0.7')
  })

  it('Загрузка без готовой установки: MANAGED_ADAPTER_UNAVAILABLE, no container', async () => {
    await rm(join(managedRoot, 'installations'), { recursive: true, force: true })
    const { ready } = await start()
    const res = await post(ready, '/models/sglang/qwen3/load')
    expect(await res.json()).toMatchObject({ error: { code: 'MANAGED_ADAPTER_UNAVAILABLE' } })
    expect(dockerState().calls).not.toContain('create')
  })

  it('Веса не оставляют места под KV-cache: the load fails at once, as out of memory with SGLang’s numbers and its log', async () => {
    await installModel('oom-model')
    const { ready } = await start()
    const started = Date.now()
    const res = await post(ready, '/models/sglang/oom-model/load')
    expect(res.status).not.toBe(200)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('OUT_OF_MEMORY')
    expect(body.error.message).toMatch(/0\.75/)
    expect(body.error.message).toMatch(/0\.812/)
    expect(Date.now() - started).toBeLessThan(30_000)
    const logs = (await (await control(ready, '/models/sglang/oom-model/logs')).json()) as {
      source: string
      log_tail: string
    }
    expect(logs.source).toBe('last-attempt')
    expect(logs.log_tail).toContain('Loaded weights leave no GPU memory for the KV cache')
  })

  it('Движок отвечает на health, но не генерирует: the load is never ready and fails with the log', async () => {
    await installModel('nogen-model')
    const { ready } = await start()
    const res = await post(ready, '/models/sglang/nogen-model/load')
    expect(res.status).not.toBe(200)
    const body = (await res.json()) as { error: { code: string; message: string; details?: string } }
    expect(body.error.message).toMatch(/test request/)
    const sessions = (await (await control(ready, '/sessions')).json()) as {
      sessions: { provider: string }[]
    }
    expect(sessions.sessions.filter((s) => s.provider === 'sglang')).toEqual([])
    const logs = (await (await control(ready, '/models/sglang/nogen-model/logs')).json()) as {
      log_tail: string
    }
    expect(logs.log_tail).toContain('The server is fired up and ready to roll!')
  })

  it('Core убит: the next core stops the container the dead one left', async () => {
    const first = await start()
    await load(first.ready, 'sglang', 'qwen3')
    expect(containersOf('sglang')).toHaveLength(1)
    first.child.kill('SIGKILL')
    await new Promise((resolve) => first.child.once('exit', resolve))
    const { ready } = await start()
    // Startup reconcile stops and removes it before the core answers anything else about it.
    await expect.poll(() => containersOf('sglang').length, { timeout: 15_000 }).toBe(0)
    const sessions = (await (await control(ready, '/sessions')).json()) as {
      sessions: { provider: string }[]
    }
    expect(sessions.sessions.filter((s) => s.provider === 'sglang')).toEqual([])
  })

  it('Две карты: the card saved in the sglang settings is the only one the container gets', async () => {
    await twoCards()
    const { ready } = await start()
    const saved = await patchSettings(ready, 'sglang', { gpu_id: SECOND_GPU })
    expect(saved.status, await saved.clone().text()).toBe(200)
    await load(ready, 'sglang', 'qwen3')
    expect(containersOf('sglang')[0]?.gpus).toBe(`device=${SECOND_GPU}`)
  })

  it('Невалидная настройка: zero parallel requests refuses the load with INVALID_ARGUMENT before any container', async () => {
    const { ready } = await start()
    const res = await post(ready, '/models/sglang/qwen3/load', { overrides: { max_running_requests: 0 } })
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
    expect(dockerState().calls).not.toContain('create')
  })
})

describe.skipIf(!existsSync(core.BIN) || process.platform === 'win32')('sglang next to vllm', () => {
  beforeEach(async () => {
    await writeInstallation(VLLM)
    await twoCards()
  })

  const onTwoCards = async (ready: ReadyLine) => {
    expect((await patchSettings(ready, 'vllm', { gpu_id: GPU })).status).toBe(200)
    expect((await patchSettings(ready, 'sglang', { gpu_id: SECOND_GPU })).status).toBe(200)
  }

  it('Две карты, два движка: vLLM on the first card and SGLang on the second both stay loaded', async () => {
    const { ready } = await start()
    await onTwoCards(ready)
    await load(ready, 'vllm', 'qwen3')
    await load(ready, 'sglang', 'other')
    expect(containersOf('vllm')).toHaveLength(1)
    expect(containersOf('sglang')).toHaveLength(1)
  })

  it('Та же модель другим движком: the model leaves vLLM with a confirmed stop, and :1337 answers from SGLang', async () => {
    const { ready } = await start()
    await onTwoCards(ready)
    await load(ready, 'vllm', 'qwen3')
    await load(ready, 'sglang', 'qwen3')
    expect(containersOf('vllm')).toHaveLength(0)
    expect(containersOf('sglang')).toHaveLength(1)
    const port = await publicPort(ready)
    const chat = await publicPost(port, '/chat/completions', {
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(
      ((await chat.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message.content
    ).toBe('hello from sglang')
  })
})

describe.skipIf(!existsSync(core.BIN) || process.platform === 'win32')(
  'sglang and llama.cpp on one card',
  () => {
    it('llama.cpp после SGLang: the SGLang container stops with Docker’s confirmation, then llama-server starts', async () => {
      const pidFile = join(dataFolder, 'fake-llama-pids')
      await core.writeModel(dataFolder, 'chat')
      await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_PID_FILE: pidFile }, GPU_PACK)
      const { ready } = await start()
      const chosen = await patchSettings(ready, GPU_PACK.provider, {
        version_backend: `${GPU_PACK.version}/${GPU_PACK.backend}`,
        fit: false,
      })
      expect(chosen.status, await chosen.clone().text()).toBe(200)
      await load(ready, 'sglang', 'qwen3')
      const [container] = containersOf('sglang')
      expect(alive(container?.pid ?? null)).toBe(true)

      const chat = await load(ready, GPU_PACK.provider, 'chat')
      expect(alive(chat.pid)).toBe(true)
      expect(alive(container?.pid ?? null)).toBe(false)
      expect(dockerState().calls).toEqual(expect.arrayContaining(['stop', 'rm']))
      expect(containersOf('sglang')).toEqual([])
      const sessions = (await (await control(ready, '/sessions')).json()) as {
        sessions: { provider: string; model_id: string }[]
      }
      expect(sessions.sessions.map((s) => `${s.provider}/${s.model_id}`)).toEqual([
        `${GPU_PACK.provider}/chat`,
      ])
      if (alive(chat.pid)) process.kill(chat.pid as number, 'SIGKILL')
    })
  }
)
