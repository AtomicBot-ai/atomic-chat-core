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
 * where the setup operation would leave them, under `ATOMIC_CORE_MANAGED_ROOT`; removing it through
 * the environment's own operation unloads a loaded model first (spec "Удаление при загруженной модели").
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

/**
 * A real `config.json` and an actually-present weight file at its declared size (a small one — the
 * pre-launch check, task 2.16, re-verifies both before any container is created, and this test does
 * not need a realistic checkpoint size to exercise the provider). `dtype: bfloat16` picks the
 * fixture's `bf16` format, whose minimum compute capability (`8.0`, no exclusions) the fake RTX 4090
 * (`8.9`) clears.
 */
async function installModel(id: string, architecture: string): Promise<void> {
  const dir = join(dataFolder, 'tensorrt-llm', 'models', id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ architectures: [architecture], dtype: 'bfloat16' })
  )
  await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(20, 1))
  await writeFile(
    join(dir, 'model.yml'),
    `name: ${id}\nrepository: acme/${id}\nrevision: deadbeef\narchitectures:\n  - ${architecture}\nquantization: bf16\nfiles:\n` +
      `  - path: model.safetensors\n    size: 20\n    sha256: null\n`
  )
}

/**
 * `MistralForCausalLM`: a real, descriptor-supported architecture whose `model_families` entry has
 * no tool parser (`tool_parser: null`) but does support structured output — used for the "no tool
 * calling" half of the capabilities-gating e2e below.
 *
 * Round 1 of this task's own review (finding 5) is why this is a *real* architecture rather than a
 * made-up one `model_families` has no entry for: `family` is now read off the architecture the
 * pre-launch check just verified against `config.json` on disk, never off `model.yml`'s own
 * (possibly stale) copy, and the real published descriptor's `model_families` and
 * `supported_architectures` are the exact same set — so an architecture the descriptor's family map
 * has no entry for is, by construction, also not in `supported_architectures`, and is refused before
 * it can ever load at all. There is no longer a "loads, but with no family entry" case to exercise.
 */
async function installExoticModel(): Promise<void> {
  await installModel('exotic', 'MistralForCausalLM')
}

async function writeInstallation(): Promise<void> {
  await mkdir(join(managedRoot, 'descriptors'), { recursive: true })
  await copyFile(DESCRIPTOR, join(managedRoot, 'descriptors', `${DESCRIPTOR_ID}.json`))
  const dir = join(managedRoot, 'installations', 'trt-1')
  await mkdir(dir, { recursive: true })
  // The record exactly as the setup operation's activation writes it (`InstallationStore`).
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
  await installExoticModel()
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
  api_key: string
  model_id: string
  execution?: string
  generation?: string
}

async function load(ready: ReadyLine, model: string): Promise<Session> {
  const res = await post(ready, `/models/tensorrt-llm/${model}/load`)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { session: Session }).session
}

interface Operation {
  operation_id: string
  phase: string
  revision: number
  plan_digest: string | null
  error: unknown
}

async function pollOperation(
  ready: ReadyLine,
  operationId: string,
  done: (operation: Operation) => boolean
): Promise<Operation> {
  const read = async () =>
    (await (await control(ready, `/environments/operations/${operationId}`)).json()) as Operation
  const deadline = Date.now() + 15_000
  let current = await read()
  while (!done(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    current = await read()
  }
  expect(done(current), `stuck at ${current.phase}: ${JSON.stringify(current.error)}`).toBe(true)
  return current
}

const publicPost = (port: number, path: string, body: unknown, key?: string) =>
  fetch(`http://127.0.0.1:${port}/v1${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
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
    // Run as the core's own uid:gid, so the engine cache it writes stays removable (final review I-1).
    expect(first[0]?.[1]).toMatchObject({
      status: 'running',
      gpus: `device=${GPU}`,
      user: `${process.getuid?.()}:${process.getgid?.()}`,
    })

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

  it('answers on SessionInfo.port itself the way :1337 does: mapped overflow, tools refused but structured output allowed, the session key only', async () => {
    const { ready } = await start()
    const session = await load(ready, 'exotic')
    const chat = { model: 'exotic', messages: [{ role: 'user', content: 'hi' }] }

    const plain = await publicPost(
      session.port,
      '/chat/completions',
      { ...chat, max_tokens: 50_000 },
      session.api_key
    )
    expect(plain.status, await plain.clone().text()).toBe(200)
    const answer = (await plain.json()) as { received: { max_tokens: number }; auth: string | null }
    expect(answer.received.max_tokens).toBe(4096)
    // The session key stops at the gateway; the engine never sees any key.
    expect(answer.auth).toBeNull()

    const streamed = await publicPost(
      session.port,
      '/chat/completions',
      { ...chat, stream: true },
      session.api_key
    )
    expect(streamed.headers.get('content-type')).toContain('text/event-stream')
    expect(await streamed.text()).toContain('data: [DONE]')

    const overflow = await publicPost(
      session.port,
      '/chat/completions',
      { ...chat, messages: [{ role: 'user', content: 'OVERFLOW' }] },
      session.api_key
    )
    expect(overflow.status).toBe(400)
    const overflowBody = (await overflow.json()) as { error: { code: string; message: string } }
    expect(overflowBody.error.code).toBe('context_length_exceeded')
    expect(overflowBody.error.message).toContain('8192')
    expect(overflowBody.error.message).toContain('9000')

    // MistralForCausalLM's family entry has no tool parser: both tool-calling shapes are refused.
    for (const [extra, what] of [
      [{ tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] }, 'tool calling'],
      [{ tool_choice: 'required' }, 'tool calling'],
    ] as const) {
      const refused = await publicPost(
        session.port,
        '/chat/completions',
        { ...chat, ...extra },
        session.api_key
      )
      expect(refused.status).toBe(400)
      expect(await refused.json()).toEqual({
        error: {
          message: `The model 'exotic' does not support ${what}.`,
          type: 'invalid_request_error',
          code: 'unsupported_capability',
        },
      })
    }

    // ...but its family entry does support structured output, so this is let through, not refused.
    const structured = await publicPost(
      session.port,
      '/chat/completions',
      { ...chat, response_format: { type: 'json_object' } },
      session.api_key
    )
    expect(structured.status, await structured.clone().text()).toBe(200)

    // An OpenAI json_schema wrapper reaches the engine as the bare schema trtllm-serve 1.2.1 reads
    // as `json_schema` (ADR 2026-09-29-tensorrt-llm-json-schema-wrapper-unwrapped-by-the-session-gateway).
    const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }
    const wrapped = await publicPost(
      session.port,
      '/chat/completions',
      {
        ...chat,
        response_format: { type: 'json_schema', json_schema: { name: 'r', strict: true, schema } },
      },
      session.api_key
    )
    expect(wrapped.status, await wrapped.clone().text()).toBe(200)
    expect(
      ((await wrapped.json()) as { received: { response_format: unknown } }).received.response_format
    ).toEqual({ type: 'json_schema', json_schema: schema })
    const noSchema = await publicPost(
      session.port,
      '/chat/completions',
      { ...chat, response_format: { type: 'json_schema' } },
      session.api_key
    )
    expect(noSchema.status).toBe(400)
    expect(await noSchema.json()).toMatchObject({
      error: {
        message: "response_format.json_schema must be an object when response_format.type is 'json_schema'.",
        type: 'invalid_request_error',
      },
    })

    const embeddings = await publicPost(
      session.port,
      '/embeddings',
      { model: 'exotic', input: 'x' },
      session.api_key
    )
    expect(embeddings.status).toBe(404)
    expect((await publicPost(session.port, '/chat/completions', chat, 'not-the-key')).status).toBe(401)
  })

  it(':1337 with an API key: the client key is checked there and stripped, the session key reaches the gateway', async () => {
    const { ready } = await start()
    await load(ready, 'llama-3')
    const serverRes = await post(ready, '/server/start', { port: 0, api_key: 'client-secret' })
    expect(serverRes.status, await serverRes.clone().text()).toBe(200)
    const { port } = (await serverRes.json()) as { port: number }
    const chat = { model: 'llama-3', messages: [{ role: 'user', content: 'hi' }] }

    expect((await publicPost(port, '/chat/completions', chat)).status).toBe(401)
    const res = await publicPost(port, '/chat/completions', chat, 'client-secret')
    expect(res.status, await res.clone().text()).toBe(200)
    const answer = (await res.json()) as { auth: string | null }
    // The gateway only let this through with the session key; neither key reached the engine.
    expect(answer.auth).toBeNull()
    const tools = await publicPost(
      port,
      '/chat/completions',
      { ...chat, tools: [{ type: 'function', function: { name: 'f' } }] },
      'client-secret'
    )
    expect(await tools.json()).toMatchObject({ error: { code: 'unsupported_capability' } })
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

  it('removing the engine while a model is loaded unloads it first, with the container confirmed stopped, then removes the image', async () => {
    const { ready } = await start()
    const session = await load(ready, 'llama-3')
    const [container] = Object.values(dockerState().containers)
    expect(alive(container?.pid ?? null)).toBe(true)

    const begin = await post(ready, '/environments/default/operations', {
      request_id: 'rm-1',
      target: { kind: 'runtime', installation_id: 'trt-1', engine_id: 'tensorrt-llm' },
      kind: 'remove',
    })
    expect(begin.status, await begin.clone().text()).toBeLessThan(300)
    const operationId = ((await begin.json()) as Operation).operation_id
    const asking = await pollOperation(ready, operationId, (o) => o.phase === 'awaiting-consent')
    await post(ready, `/environments/operations/${operationId}/resume`, {
      expected_revision: asking.revision,
      approved_plan_digest: asking.plan_digest,
    })
    const done = await pollOperation(ready, operationId, (o) => o.phase === 'removed' || o.phase === 'failed')
    expect(done.phase, JSON.stringify(done.error)).toBe('removed')

    // The model's container was stopped (and removed) before the engine image was touched.
    const calls = dockerState().calls
    const stop = calls.indexOf('stop')
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('image')).toBeGreaterThan(stop)
    expect(dockerState().images_removed).toEqual([`${ENGINE_IMAGE.repository}@${ENGINE_IMAGE.digest}`])
    expect(Object.keys(dockerState().containers)).toEqual([])
    expect(alive(container?.pid ?? null)).toBe(false)
    const sessions = (await (await control(ready, '/sessions')).json()) as { sessions: unknown[] }
    expect(sessions.sessions).toEqual([])
    const gone = await fetch(`http://127.0.0.1:${session.port}/v1/models`).catch(() => null)
    expect(gone === null || gone.status >= 400).toBe(true)
    // The installation is gone, so the next load is refused; the downloaded model stays.
    expect(existsSync(join(managedRoot, 'installations', 'trt-1'))).toBe(false)
    expect(existsSync(join(dataFolder, 'tensorrt-llm', 'models', 'llama-3'))).toBe(true)
    const again = await post(ready, '/models/tensorrt-llm/llama-3/load')
    expect(await again.json()).toMatchObject({ error: { code: 'MANAGED_ADAPTER_UNAVAILABLE' } })
  })

  it('refuses to load with MANAGED_ADAPTER_UNAVAILABLE while the engine installation is not ready', async () => {
    await rm(join(managedRoot, 'installations'), { recursive: true, force: true })
    const { ready } = await start()
    const res = await post(ready, '/models/tensorrt-llm/llama-3/load')
    expect(await res.json()).toMatchObject({ error: { code: 'MANAGED_ADAPTER_UNAVAILABLE' } })
    expect(dockerState().calls).not.toContain('create')
  })
})
