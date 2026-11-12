import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAll, localSession, postJson, startPublic } from '../../../test/helpers/public-server.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { CoreEvents } from '../../contracts/index.js'
import { ModelRegistry, serializeModelYml } from '../../models/index.js'
import { spawnAndAwaitReady } from '../shared/index.js'
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
  it('checks preparation against the exact build selected for load', async () => {
    await variant('gpu-build-scope', { execution_provider: 'webgpu', device: 'gpu' })
    let checked: string | undefined
    const { rt } = runtime({
      preparedAccelerators: async (build) => {
        checked = build
        return []
      },
    })
    await expect(rt.load('gpu-build-scope')).rejects.toMatchObject({
      code: 'FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED',
    })
    expect(checked).toBe(BUILD)
    expect(await starts()).toEqual([])
  })

  it('uses the Linux ARM64 CUDA cache only after the active runtime reaches 2.4.0', async () => {
    await variant('arm-cuda-gpu', { execution_provider: 'cuda', device: 'gpu' })
    let build = '/build/v2.1.0/linux-arm64'
    const cached = vi.fn(async () => '/private/cuda')
    const spawn: typeof spawnAndAwaitReady = (spec, options) => {
      expect(spec.env?.['LD_LIBRARY_PATH']).toBe('/private/cuda:/driver/lib')
      return spawnAndAwaitReady(spec, options)
    }
    const { rt } = runtime({
      platform: 'linux',
      arch: 'arm64',
      resolveBuild: async () => build,
      preparedAccelerators: async () => ['CUDAExecutionProvider'],
      cuda: { cached },
      baseEnv: { ...process.env, LD_LIBRARY_PATH: '/driver/lib' },
      spawn,
    })
    await expect(rt.load('arm-cuda-gpu')).rejects.toMatchObject({ code: 'ENGINE_UPDATE_REQUIRED' })
    expect(cached).not.toHaveBeenCalled()
    build = '/build/v2.4.0/linux-arm64'
    const session = await rt.load('arm-cuda-gpu')
    try {
      expect(session.model_id).toBe('arm-cuda-gpu')
      expect(cached).toHaveBeenCalledExactlyOnceWith(build)
    } finally {
      await rt.unload('arm-cuda-gpu')
    }
  })

  it('starts the host for a variant, registered explicitly, behind a gateway that names the model as core does', async () => {
    await variant('qwen3-0.6b-generic-gpu', {
      execution_provider: 'webgpu',
      device: 'gpu',
      tools: true,
      tool_call_start: '<tool_call>',
      tool_call_end: '</tool_call>',
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
        '--tool-call-start=<tool_call>',
        '--tool-call-end=</tool_call>',
        '--reasoning-start',
        '<think>',
        '--reasoning-end',
        '</think>',
        '--context-length',
        '40960',
      ])
      // Design D8: the optional telemetry off through the environment; nothing that fakes CI (on a CI
      // runner the host inherits the runner's own CI, and only that).
      expect(start).toMatchObject({ ort_telemetry_disabled: '1', ci: process.env.CI ?? null })
      // cuDNN flash attention off: on Blackwell (sm_120) cuDNN 9.20 cannot build its graph and every
      // completion fails (microsoft/foundry-local#1179).
      expect(start).toMatchObject({ ort_enable_cudnn_flash_attention: '0' })
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

  it.each(['fragmented', 'interrupted'])(
    'forwards %s Claude tool results to Foundry in one contiguous group',
    async (scenario) => {
      const interrupted = scenario === 'interrupted'
      const model = 'parallel-tools'
      await variant(model, { execution_provider: 'cpu', device: 'cpu', tools: true })
      const { rt } = runtime({ mode: 'echo-chat-request' })
      const session = await rt.load(model)
      try {
        const policy = rt.routePolicy(model)
        if (!policy) throw new Error('Missing Foundry route policy')
        const server = await startPublic({
          sessions: [
            localSession(session.port, {
              provider: 'foundry-local',
              modelId: model,
              apiKey: session.api_key,
              policy,
            }),
          ],
        })
        const response = await postJson(server, '/messages', {
          model,
          tools: [{ name: 'read', input_schema: { type: 'object' } }],
          tool_choice: { type: 'tool', name: 'read', disable_parallel_tool_use: true },
          messages: [
            { role: 'user', content: 'Read both files.' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } }],
            },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.txt' } }],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'call_b', content: 'second file' },
                { type: 'text', text: 'Include both names.' },
              ],
            },
            ...(interrupted
              ? []
              : [
                  {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'first file' }],
                  },
                ]),
          ],
        })

        expect(response.status).toBe(200)
        const body = (await response.json()) as { content: [{ text: string }] }
        expect(JSON.parse(body.content[0].text)).toMatchObject({
          model: `${model}:1`,
          tool_choice: { type: 'function', function: { name: 'read' } },
          parallel_tool_calls: false,
          messages: [
            { role: 'user', content: 'Read both files.' },
            { role: 'assistant', tool_calls: [{ id: 'call_a' }] },
            { role: 'assistant', tool_calls: [{ id: 'call_b' }] },
            { role: 'tool', tool_call_id: 'call_b', content: 'second file' },
            {
              role: 'tool',
              tool_call_id: 'call_a',
              content: interrupted
                ? 'No tool result was provided for this call in the conversation history.'
                : 'first file',
            },
            { role: 'user', content: 'Include both names.' },
          ],
        })
      } finally {
        await closeAll()
        await rt.unload(model)
      }
    }
  )

  it('keeps cuDNN flash attention as the person set it in the environment', async () => {
    await variant('phi-4-cuda-gpu', { execution_provider: 'webgpu', device: 'gpu' })
    const { rt } = runtime({
      baseEnv: {
        ...process.env,
        FAKE_FOUNDRY_ARGV: argvFile,
        ORT_ENABLE_CUDNN_FLASH_ATTENTION: '1',
      } as NodeJS.ProcessEnv,
    })
    await rt.load('phi-4-cuda-gpu')
    try {
      const [start] = await starts()
      expect(start).toMatchObject({ ort_enable_cudnn_flash_attention: '1' })
    } finally {
      await rt.unload('phi-4-cuda-gpu')
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
