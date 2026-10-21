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
import { backendRunsOn, engineContext, LITERT_LM_DEFAULT_CONTEXT, LiteRtLmRuntime } from './runtime.js'
import type { LiteRtLmRuntimeOptions } from './runtime.js'
import type { LiteRtFileInfo } from './host/library.js'

vi.setConfig({ testTimeout: 30_000 })

const POSIX = process.platform !== 'win32'
const FAKE_HOST = fileURLToPath(new URL('../../../test/helpers/fake-litert-host.mjs', import.meta.url))
const BUILD = { dir: '/data/litert-lm/backends/0.18.1/macos-arm64', version: '0.18.1' }
const FILE = 'gemma-4-E2B-it.litertlm'

let data: TmpDataFolder
let argvFile: string
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-litert-runtime-')
  argvFile = join(data.root, 'host-argv.jsonl')
})
afterEach(() => data.cleanup())

/** A LiteRT-LM variant on disk as the clients lay it out (spec `litert-lm-models`). */
async function variant(id: string, block: Record<string, unknown> = {}): Promise<void> {
  const dir = join(data.layout.provider('litert-lm').modelsDir, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, FILE), 'litertlm')
  await writeFile(
    join(dir, 'model.yml'),
    serializeModelYml({
      model_path: `litert-lm/models/${id}/${FILE}`,
      name: id,
      size_bytes: 8,
      litert_lm: {
        model_id: 'gemma-4-e2b',
        variant_id: id,
        backend: 'cpu',
        repo: 'litert-community/gemma-4-E2B-it-litert-lm',
        revision: 'a'.repeat(40),
        file: FILE,
        context_length: 32003,
        tools: true,
        reasoning: false,
        vision: true,
        source: 'curated',
        ...block,
      },
    })
  )
}

function runtime(
  over: Partial<LiteRtLmRuntimeOptions> & {
    mode?: string
    inspect?: LiteRtFileInfo
    settings?: Record<string, unknown>
  } = {}
) {
  const events: Array<{ name: string; payload: unknown }> = []
  const { mode, inspect, settings, ...rest } = over
  const rt = new LiteRtLmRuntime({
    layout: data.layout,
    registry: new ModelRegistry(data.layout, 'litert-lm'),
    instanceId: 'test',
    hostPlatform: 'macos-arm64',
    hostCommand: { exe: process.execPath, args: [FAKE_HOST] },
    resolveBuild: async () => BUILD,
    openVinoLibs: async () => undefined,
    npuGeneration: async () => null,
    trustedHosts: [],
    readSettings: async () => ({ ctx_len: 0, speculative_decoding: true, timeout: 20, ...settings }),
    baseEnv: {
      ...process.env,
      FAKE_LITERT_ARGV: argvFile,
      FAKE_LITERT_MODE: mode ?? 'ready',
      ...(inspect ? { FAKE_LITERT_INSPECT: JSON.stringify(inspect) } : {}),
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
        .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
    : []

const call = (port: number, key: string | null, body: unknown, path = '/v1/chat/completions') =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  })

const INFO: LiteRtFileInfo = {
  model_type: 'llm',
  max_context_tokens: 131072,
  dynamic_context: true,
  function_calling: false,
  thinking: false,
  modalities: ['text'],
  backends: ['cpu', 'gpu'],
  vision_backends: [],
  npu: null,
  speculative_decoding: false,
  min_runtime_version: null,
}

describe.skipIf(!POSIX)('LiteRtLmRuntime (task 6.3)', () => {
  it('starts the host for a variant behind a gateway that wants the key and serves chat and models only', async () => {
    await variant('gemma-4-e2b-cpu')
    const { rt } = runtime()
    const session = await rt.load('gemma-4-e2b-cpu')
    try {
      expect(session).toMatchObject({ model_id: 'gemma-4-e2b-cpu', is_embedding: false })
      const serve = (await starts()).find((argv) => argv[0] === 'serve')
      expect(serve).toEqual([
        'serve',
        '--lib',
        BUILD.dir,
        '--engine-version',
        '0.18.1',
        '--model',
        join(data.layout.provider('litert-lm').modelsDir, 'gemma-4-e2b-cpu', FILE),
        '--backend',
        'cpu',
        '--max-tokens',
        '32003',
        '--port',
        expect.stringMatching(/^\d+$/),
        '--cache',
        data.layout.provider('litert-lm').cacheDir,
        '--id',
        'gemma-4-e2b-cpu',
        '--speculative',
      ])
      expect((await call(session.port, null, { messages: [] })).status).toBe(401)
      const embeddings = await call(session.port, session.api_key, { input: 'x' }, '/v1/embeddings')
      expect(embeddings.status).toBeGreaterThanOrEqual(400)
      const reply = (await (
        await call(session.port, session.api_key, {
          model: 'gemma-4-e2b-cpu',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).json()) as { choices: Array<{ message: { content: string } }> }
      expect(reply.choices[0]?.message.content).toBe('fake reply to hi')
      expect(rt.routePolicy('gemma-4-e2b-cpu')).toMatchObject({
        tools: true,
        structuredOutput: true,
        contextLength: 32003,
      })
      expect(rt.gpuOccupancy()).toEqual([
        { model_id: 'gemma-4-e2b-cpu', cards: [], auxiliary: false, state: 'ready' },
      ])
    } finally {
      await rt.unload('gemma-4-e2b-cpu')
    }
    expect(rt.list()).toEqual([])
  })

  it('cuts the context to the file maximum and reports what the engine got', async () => {
    await variant('gemma-gpu', { backend: 'gpu', context_length: undefined, reasoning: true })
    const { rt } = runtime({ inspect: INFO, settings: { ctx_len: 262144, speculative_decoding: false } })
    const claims: unknown[] = []
    const claimGpu: GpuClaimHook = async (claim) => void claims.push(claim)
    const withGpu = runtime({
      inspect: INFO,
      settings: { ctx_len: 262144, speculative_decoding: false },
      claimGpu,
    }).rt
    await withGpu.load('gemma-gpu')
    try {
      const serve = (await starts()).find((argv) => argv[0] === 'serve') ?? []
      expect(serve[serve.indexOf('--max-tokens') + 1]).toBe('131072')
      expect(serve).toContain('--reasoning')
      expect(serve).not.toContain('--speculative')
      expect(withGpu.routePolicy('gemma-gpu')).toMatchObject({ contextLength: 131072 })
      expect(withGpu.gpuOccupancy()).toEqual([
        { model_id: 'gemma-gpu', cards: 'all', auxiliary: false, state: 'ready' },
      ])
      expect(claims).toEqual([{ model_id: 'gemma-gpu', cards: 'all', auxiliary: false }])
    } finally {
      await withGpu.unload('gemma-gpu')
    }
    expect(rt.list()).toEqual([])
  })

  it('refuses an NPU variant off Windows, for another generation, and unprepared — before the host', async () => {
    await variant('npu-lnl', { backend: 'npu', npu: 'intel-lnl' })
    await expect(runtime().rt.load('npu-lnl')).rejects.toMatchObject({
      code: 'LITERT_LM_VARIANT_UNSUPPORTED',
    })
    const windows = { hostPlatform: 'win-x64' as const }
    await expect(
      runtime({ ...windows, npuGeneration: async () => 'intel-ptl' }).rt.load('npu-lnl')
    ).rejects.toMatchObject({
      code: 'LITERT_LM_VARIANT_UNSUPPORTED',
      message: expect.stringMatching(/intel-lnl/),
    })
    await expect(
      runtime({ ...windows, npuGeneration: async () => 'intel-lnl' }).rt.load('npu-lnl')
    ).rejects.toMatchObject({
      code: 'LITERT_LM_ACCELERATOR_NOT_PREPARED',
    })
    expect((await starts()).filter((argv) => argv[0] === 'serve')).toEqual([])
  })

  it('refuses a file for a newer LiteRT-LM and a backend the file lacks, without starting the host', async () => {
    await variant('new-file')
    await expect(
      runtime({ inspect: { ...INFO, min_runtime_version: '0.19' } }).rt.load('new-file')
    ).rejects.toMatchObject({
      code: 'LITERT_LM_MODEL_REQUIRES_NEWER_ENGINE',
      message: expect.stringMatching(/0\.19/),
    })
    await variant('gpu-on-cpu-file', { backend: 'gpu' })
    await expect(
      runtime({ inspect: { ...INFO, backends: ['cpu'] } }).rt.load('gpu-on-cpu-file')
    ).rejects.toMatchObject({
      code: 'LITERT_LM_VARIANT_UNSUPPORTED',
    })
    expect((await starts()).filter((argv) => argv[0] === 'serve')).toEqual([])
    await expect(runtime({ resolveBuild: async () => undefined }).rt.load('new-file')).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
  })

  it('maps the host exit codes, with the tail of what it printed', async () => {
    await variant('m')
    await expect(runtime({ mode: 'exit-6' }).rt.load('m')).rejects.toMatchObject({
      code: 'LITERT_LM_MODEL_REQUIRES_NEWER_ENGINE',
    })
    await expect(runtime({ mode: 'exit-7' }).rt.load('m')).rejects.toMatchObject({
      code: 'LITERT_LM_VARIANT_UNSUPPORTED',
    })
    const crashed = runtime({ mode: 'exit-3' }).rt.load('m')
    await expect(crashed).rejects.toMatchObject({
      code: 'LITERT_LM_HOST_ERROR',
      details: expect.stringMatching(/image not found/),
    })
  })

  it('reports session:died when the host exits on its own', async () => {
    await variant('m')
    const { rt, events } = runtime({ mode: 'crash-after-ready' })
    await rt.load('m')
    for (let i = 0; i < 100 && !events.some((event) => event.name === 'session:died'); i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.find((event) => event.name === 'session:died')?.payload).toMatchObject({ model_id: 'm' })
    expect(rt.list()).toEqual([])
  })

  it('reads the file once per path and modification time', async () => {
    await variant('m')
    const inspected: string[] = []
    const { rt } = runtime({
      inspectFile: async (_build, file) => {
        inspected.push(file)
        return { ...INFO, max_context_tokens: null }
      },
    })
    await rt.load('m')
    await rt.unload('m')
    await rt.load('m')
    await rt.unload('m')
    expect(inspected).toHaveLength(1)
  })
})

describe('engineContext', () => {
  const block = { context_length: 32003 } as Parameters<typeof engineContext>[1]
  const none = {} as Parameters<typeof engineContext>[1]
  it.each<[unknown, Parameters<typeof engineContext>[1], number | null, number]>([
    [0, block, 131072, 32003],
    [262144, block, 131072, 131072],
    [8192, block, 131072, 8192],
    [0, none, 131072, 131072],
    [0, none, null, LITERT_LM_DEFAULT_CONTEXT],
    ['8192', block, null, 8192],
    [-5, block, null, 32003],
  ])('settings %j, model.yml %j, file %j → %i', (setting, b, fileMax, expected) => {
    expect(engineContext(setting, b, fileMax)).toBe(expected)
  })
})

describe('backendRunsOn', () => {
  it('runs cpu and gpu everywhere, npu on Windows x64 only', () => {
    for (const platform of ['macos-arm64', 'linux-x64', 'linux-arm64', 'win-x64'] as const) {
      expect(backendRunsOn(platform, 'cpu')).toBe(true)
      expect(backendRunsOn(platform, 'gpu')).toBe(true)
      expect(backendRunsOn(platform, 'npu')).toBe(platform === 'win-x64')
    }
  })
})
