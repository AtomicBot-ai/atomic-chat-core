import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { CoreEvents } from '../../contracts/index.js'
import { ModelRegistry, serializeModelYml } from '../../models/index.js'
import type { GpuClaimHook } from '../shared/index.js'
import { FoundryLocalRuntime } from './runtime.js'
import type { FoundryLocalRuntimeOptions } from './runtime.js'

vi.setConfig({ testTimeout: 30_000 })

const POSIX = process.platform !== 'win32'
const FAKE_HOST = fileURLToPath(new URL('../../../test/helpers/fake-foundry-host.mjs', import.meta.url))
const BUILD = '/data/foundry-local/backends/v2.1.0/macos-arm64'

let data: TmpDataFolder
let argvFile: string
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-foundry-runtime-')
  argvFile = join(data.root, 'host-argv.jsonl')
})
afterEach(() => data.cleanup())

/** A Foundry Local variant on disk, as the app's installer lays it out (design D4). */
async function variant(id: string, block: Record<string, unknown>): Promise<void> {
  const dir = join(data.layout.provider('foundry-local').modelsDir, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'genai_config.json'), '{}')
  await writeFile(
    join(dir, 'model.yml'),
    serializeModelYml({
      model_path: `foundry-local/models/${id}`,
      name: id,
      size_bytes: 1,
      foundry_local: { model_id: id, variant_id: id, tools: false, reasoning: false, ...block },
    })
  )
}

function runtime(over: Partial<FoundryLocalRuntimeOptions> & { mode?: string } = {}) {
  const events: Array<{ name: string; payload: unknown }> = []
  const { mode, ...rest } = over
  const rt = new FoundryLocalRuntime({
    layout: data.layout,
    registry: new ModelRegistry(data.layout, 'foundry-local'),
    instanceId: 'test',
    platform: 'darwin',
    arch: 'arm64',
    hostCommand: { exe: process.execPath, args: [FAKE_HOST] },
    resolveBuild: async () => BUILD,
    preparedAccelerators: async () => ['WebGpuExecutionProvider'],
    trustedHosts: [],
    readSettings: async () => ({ timeout: 20 }),
    baseEnv: {
      ...process.env,
      FAKE_FOUNDRY_ARGV: argvFile,
      FAKE_FOUNDRY_MODE: mode ?? 'ready',
    } as NodeJS.ProcessEnv,
    emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) =>
      void events.push({ name, payload }),
    ...rest,
  })
  return { rt, events }
}

const starts = async () =>
  existsSync(argvFile)
    ? (await readFile(argvFile, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { argv: string[]; ort_telemetry_disabled: string | null; ci: string | null }
        )
    : []

const chat = (
  port: number,
  key: string | null,
  body: Record<string, unknown>,
  path = '/v1/chat/completions'
) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  })

describe.skipIf(!POSIX)('FoundryLocalRuntime (task 6.3)', () => {
  it('starts the host for a variant, registered explicitly, behind a gateway that names the model as core does', async () => {
    await variant('qwen3-0.6b-generic-gpu', {
      execution_provider: 'webgpu',
      device: 'gpu',
      tools: true,
      reasoning: true,
      reasoning_start: '<think>',
      reasoning_end: '</think>',
      context_length: 40960,
    })
    const { rt, events } = runtime()
    const session = await rt.load('qwen3-0.6b-generic-gpu')
    try {
      expect(session).toMatchObject({ model_id: 'qwen3-0.6b-generic-gpu', is_embedding: false })
      expect(session.api_key.length).toBeGreaterThan(20)
      const [start] = await starts()
      expect(start?.argv).toEqual([
        'serve',
        '--lib',
        BUILD,
        '--app-data',
        data.layout.provider('foundry-local').runtimeDir,
        '--logs',
        data.layout.provider('foundry-local').logsDir,
        '--model',
        join(data.layout.provider('foundry-local').modelsDir, 'qwen3-0.6b-generic-gpu'),
        '--ep',
        'webgpu',
        '--port',
        expect.stringMatching(/^\d+$/),
        '--cache',
        expect.stringContaining(join('foundry-local', 'tmp')),
        '--id',
        'qwen3-0.6b-generic-gpu:1',
        '--tools',
        '--reasoning-start',
        '<think>',
        '--reasoning-end',
        '</think>',
        '--context-length',
        '40960',
      ])
      // Design D8: the optional telemetry off through the environment; nothing that fakes CI.
      expect(start).toMatchObject({ ort_telemetry_disabled: '1', ci: null })
      expect(Number(start?.argv[start.argv.indexOf('--port') + 1])).not.toBe(session.port)

      const answer = await chat(session.port, session.api_key, {
        model: 'qwen3-0.6b-generic-gpu',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(answer.status).toBe(200)
      expect(await answer.json()).toMatchObject({
        model: 'qwen3-0.6b-generic-gpu',
        choices: [{ message: { content: 'hi from fake foundry' } }],
      })
      expect(events.map((e) => e.name)).toContain('session:started')
    } finally {
      await rt.unload('qwen3-0.6b-generic-gpu')
    }
  })

  it('lets nobody through without the session key, and serves only chat completions and the model list', async () => {
    await variant('cpu-variant', { execution_provider: 'cpu', device: 'cpu' })
    const { rt } = runtime()
    const session = await rt.load('cpu-variant')
    try {
      expect((await chat(session.port, null, { model: 'cpu-variant', messages: [] })).status).toBe(401)
      const legacy = await chat(
        session.port,
        session.api_key,
        { model: 'cpu-variant', prompt: 'hi' },
        '/v1/completions'
      )
      expect(legacy.status).toBe(404)
      const models = await fetch(`http://127.0.0.1:${session.port}/v1/models`, {
        headers: { authorization: `Bearer ${session.api_key}` },
      })
      expect(models.status).toBe(200)
      expect(rt.routePolicy('cpu-variant')).toMatchObject({
        routes: [
          { method: 'POST', path: '/v1/chat/completions' },
          { method: 'GET', path: '/v1/models' },
        ],
        tools: false,
        structuredOutput: false,
      })
    } finally {
      await rt.unload('cpu-variant')
    }
  })

  it('refuses a variant whose accelerator is not prepared, or that this platform cannot run, without starting a host', async () => {
    await variant('webgpu-variant', { execution_provider: 'webgpu', device: 'gpu' })
    await variant('qnn-variant', { execution_provider: 'qnn', device: 'npu' })
    const { rt } = runtime({ preparedAccelerators: async () => [] })
    await expect(rt.load('webgpu-variant')).rejects.toMatchObject({
      code: 'FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED',
    })
    await expect(rt.load('qnn-variant')).rejects.toMatchObject({ code: 'FOUNDRY_LOCAL_VARIANT_UNSUPPORTED' })
    const noBuild = runtime({ resolveBuild: async () => undefined }).rt
    await variant('cpu-variant', { execution_provider: 'cpu', device: 'cpu' })
    await expect(noBuild.load('cpu-variant')).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' })
    expect(await starts()).toEqual([])
  })

  it('names what the host said when it refuses to start', async () => {
    await variant('webgpu-variant', { execution_provider: 'webgpu', device: 'gpu' })
    await expect(runtime({ mode: 'exit-5' }).rt.load('webgpu-variant')).rejects.toMatchObject({
      code: 'FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED',
    })
    await expect(runtime({ mode: 'exit-3' }).rt.load('webgpu-variant')).rejects.toMatchObject({
      code: 'FOUNDRY_LOCAL_HOST_ERROR',
      details: expect.stringContaining('libatomic.so.1'),
    })
  })

  it('holds every card for a GPU variant and none for a CPU or NPU one, claiming the GPU only for the former', async () => {
    await variant('webgpu-variant', { execution_provider: 'webgpu', device: 'gpu' })
    await variant('cpu-variant', { execution_provider: 'cpu', device: 'cpu' })
    const claims: unknown[] = []
    const claimGpu: GpuClaimHook = async (footprint) => void claims.push(footprint)
    const { rt } = runtime({ claimGpu })
    await rt.load('webgpu-variant', { bypassAutoUnload: true })
    await rt.load('cpu-variant', { bypassAutoUnload: true })
    try {
      expect(claims).toEqual([{ model_id: 'webgpu-variant', cards: 'all', auxiliary: false }])
      expect(rt.gpuOccupancy()).toEqual(
        expect.arrayContaining([
          { model_id: 'webgpu-variant', cards: 'all', auxiliary: false, state: 'ready' },
          { model_id: 'cpu-variant', cards: [], auxiliary: false, state: 'ready' },
        ])
      )
      expect(await rt.engineHost().inUse()).toEqual([BUILD])
    } finally {
      await rt.unload('webgpu-variant')
      await rt.unload('cpu-variant')
    }
  })

  it('waits for the host to exit on unload, its cache gone and its gateway closed', async () => {
    await variant('cpu-variant', { execution_provider: 'cpu', device: 'cpu' })
    const { rt, events } = runtime()
    const session = await rt.load('cpu-variant')
    const argv = (await starts())[0]?.argv ?? []
    const cache = argv[argv.indexOf('--cache') + 1] as string
    expect(existsSync(cache)).toBe(true)
    expect(await rt.unload('cpu-variant')).toEqual({ success: true })
    expect(existsSync(cache)).toBe(false)
    await expect(
      chat(session.port, session.api_key, { model: 'cpu-variant', messages: [] })
    ).rejects.toThrow()
    expect(rt.getLoadedModels()).toEqual([])
    expect(await rt.engineHost().inUse()).toEqual([])
    expect(events.map((e) => e.name)).toContain('session:unloaded')
  })

  it('reports session:died when the host crashes, and closes its gateway', async () => {
    await variant('cpu-variant', { execution_provider: 'cpu', device: 'cpu' })
    const { rt, events } = runtime({ mode: 'crash-after-ready' })
    const session = await rt.load('cpu-variant')
    await vi.waitFor(() => expect(events.map((e) => e.name)).toContain('session:died'), { timeout: 5000 })
    expect(events.find((e) => e.name === 'session:died')?.payload).toMatchObject({
      provider: 'foundry-local',
      model_id: 'cpu-variant',
      exit_code: 134,
      message: expect.stringContaining('fatal error in the generator'),
    })
    expect(rt.getLoadedModels()).toEqual([])
    await vi.waitFor(async () => {
      await expect(
        chat(session.port, session.api_key, { model: 'cpu-variant', messages: [] })
      ).rejects.toThrow()
    })
  })
})
