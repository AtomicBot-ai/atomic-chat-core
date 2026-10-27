import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { CoreEvents, GeniexModelMetadata } from '../../contracts/index.js'
import { ModelRegistry, serializeModelYml } from '../../models/index.js'
import type { GpuClaimHook } from '../shared/index.js'
import { engineContext, GeniexRuntime, launchDevice } from './runtime.js'
import type { GeniexRuntimeOptions } from './runtime.js'

vi.setConfig({ testTimeout: 30_000 })

const POSIX = process.platform !== 'win32'
const FAKE_HOST = fileURLToPath(new URL('../../../test/helpers/fake-geniex-host.mjs', import.meta.url))
const BUILD = {
  dir: '/data/geniex/backends/0.9.3/win-arm64',
  version: '0.9.3',
  devices: ['HTP0', 'GPUOpenCL', 'CPU'],
}
const FILE = 'Qwen3-4B-Q4_0.gguf'
const GGUF: GeniexModelMetadata = {
  kind: 'gguf',
  architecture: 'qwen3',
  max_context_tokens: 40960,
  quantization: 'Q4_0',
  chat_template: true,
  vision: false,
}

let data: TmpDataFolder
let argvFile: string
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-geniex-runtime-')
  argvFile = join(data.root, 'host-argv.jsonl')
})
afterEach(() => data.cleanup())

/** A GGUF model on disk as the clients lay it out (spec `geniex-models`). */
async function gguf(
  id: string,
  block: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Promise<void> {
  const dir = join(data.layout.provider('geniex').modelsDir, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, FILE), 'gguf')
  await writeFile(
    join(dir, 'model.yml'),
    serializeModelYml({
      model_path: `geniex/models/${id}/${FILE}`,
      name: id,
      size_bytes: 4,
      ...extra,
      geniex: {
        model_id: 'qwen3-4b',
        variant_id: id,
        plugin: 'llama_cpp',
        backend: 'npu',
        repo: 'unsloth/Qwen3-4B-GGUF',
        revision: 'a'.repeat(40),
        file: FILE,
        context_length: 40960,
        tools: true,
        reasoning: false,
        vision: false,
        source: 'curated',
        ...block,
      },
    })
  )
}

/** An AI Hub bundle folder as the clients lay it out. */
async function bundle(id: string, chip = 'x-elite'): Promise<void> {
  const dir = join(data.layout.provider('geniex').modelsDir, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'geniex.json'), JSON.stringify({ chipset: chip }))
  await writeFile(
    join(dir, 'model.yml'),
    serializeModelYml({
      model_path: `geniex/models/${id}`,
      name: id,
      size_bytes: 1,
      geniex: {
        model_id: 'qwen3-4b',
        variant_id: id,
        plugin: 'qairt',
        backend: 'npu',
        chip,
        bundle_url: 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/q.zip',
        precision: 'w4a16',
        context_length: 4096,
        tools: true,
        reasoning: false,
        vision: false,
        source: 'curated',
      },
    })
  )
}

function runtime(
  over: Partial<GeniexRuntimeOptions> & {
    mode?: string
    inspect?: GeniexModelMetadata
    settings?: Record<string, unknown>
  } = {}
) {
  const events: Array<{ name: string; payload: unknown }> = []
  const { mode, inspect, settings, ...rest } = over
  const rt = new GeniexRuntime({
    layout: data.layout,
    registry: new ModelRegistry(data.layout, 'geniex'),
    instanceId: 'test',
    chip: 'x-elite',
    hostCommand: { exe: process.execPath, args: [FAKE_HOST] },
    resolveBuild: async () => BUILD,
    trustedHosts: [],
    readSettings: async () => ({ device: '', ctx_len: 0, power_mode: 'burst', timeout: 20, ...settings }),
    baseEnv: {
      ...process.env,
      FAKE_GENIEX_ARGV: argvFile,
      FAKE_GENIEX_MODE: mode ?? 'ready',
      ...(inspect ? { FAKE_GENIEX_INSPECT: JSON.stringify(inspect) } : {}),
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
const serves = async () => (await starts()).filter((argv) => argv[0] === 'serve')

const call = (port: number, key: string | null, body: unknown, path = '/v1/chat/completions') =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  })

describe.skipIf(!POSIX)('GeniexRuntime (task 6.3)', () => {
  it('starts the host for a GGUF model behind a gateway that wants the key and serves chat and models only', async () => {
    await gguf('qwen3-4b')
    const { rt } = runtime()
    const session = await rt.load('qwen3-4b')
    try {
      expect(session).toMatchObject({ model_id: 'qwen3-4b', is_embedding: false })
      const [serve] = await serves()
      expect(serve).toEqual([
        'serve',
        '--lib',
        BUILD.dir,
        '--engine-version',
        '0.9.3',
        '--model',
        join(data.layout.provider('geniex').modelsDir, 'qwen3-4b', FILE),
        '--plugin',
        'llama_cpp',
        '--device',
        'npu',
        '--nctx',
        '40960',
        '--max-tokens',
        '40960',
        '--power-mode',
        'burst',
        '--port',
        expect.stringMatching(/^\d+$/),
        '--tmp',
        expect.stringMatching(/geniex[\\/]tmp[\\/]qwen3-4b-\d+$/),
        '--id',
        'qwen3-4b',
      ])
      expect((await call(session.port, null, { messages: [] })).status).toBe(401)
      const embeddings = await call(session.port, session.api_key, { input: 'x' }, '/v1/embeddings')
      expect(embeddings.status).toBeGreaterThanOrEqual(400)
      const reply = (await (
        await call(session.port, session.api_key, {
          model: 'qwen3-4b',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).json()) as {
        choices: Array<{ message: { content: string } }>
      }
      expect(reply.choices[0]?.message.content).toBe('fake reply to hi')
      expect(rt.routePolicy('qwen3-4b')).toMatchObject({
        tools: true,
        structuredOutput: true,
        contextLength: 40960,
      })
      expect(rt.gpuOccupancy()).toEqual([
        { model_id: 'qwen3-4b', cards: [], auxiliary: false, state: 'ready' },
      ])
      expect(await rt.engineHost().inUse()).toEqual([BUILD.dir])
    } finally {
      await rt.unload('qwen3-4b')
    }
    expect(rt.list()).toEqual([])
  })

  it('takes the device from the settings, cuts the context to the model, passes mmproj, power mode and reasoning, and claims the GPU for gpu', async () => {
    await gguf(
      'gemma',
      { mmproj: 'mmproj-F16.gguf', vision: true, reasoning: true, context_length: 131072 },
      { mmproj_path: 'geniex/models/gemma/mmproj-F16.gguf' }
    )
    const claims: unknown[] = []
    const claimGpu: GpuClaimHook = async (claim) => void claims.push(claim)
    const { rt } = runtime({
      inspect: GGUF,
      settings: { device: 'gpu', ctx_len: 262144, power_mode: 'balanced' },
      claimGpu,
    })
    await rt.load('gemma')
    try {
      const [serve = []] = await serves()
      expect(serve[serve.indexOf('--device') + 1]).toBe('gpu')
      expect(serve[serve.indexOf('--nctx') + 1]).toBe('40960')
      expect(serve[serve.indexOf('--mmproj') + 1]).toBe(
        join(data.layout.provider('geniex').modelsDir, 'gemma', 'mmproj-F16.gguf')
      )
      expect(serve[serve.indexOf('--power-mode') + 1]).toBe('balanced')
      expect(serve).toContain('--reasoning')
      expect(rt.routePolicy('gemma')).toMatchObject({ contextLength: 40960 })
      expect(rt.gpuOccupancy()).toEqual([
        { model_id: 'gemma', cards: 'all', auxiliary: false, state: 'ready' },
      ])
      expect(claims).toEqual([{ model_id: 'gemma', cards: 'all', auxiliary: false }])
    } finally {
      await rt.unload('gemma')
    }
  })

  it('refuses a bundle for another chip, a bundle off the NPU, and a device the build did not find — before the host', async () => {
    await bundle('x2', 'x2-elite')
    await expect(runtime().rt.load('x2')).rejects.toMatchObject({
      code: 'GENIEX_VARIANT_UNSUPPORTED',
      message: expect.stringMatching(/x2-elite/),
    })
    await bundle('x1')
    await expect(runtime({ settings: { device: 'gpu' } }).rt.load('x1')).rejects.toMatchObject({
      code: 'GENIEX_VARIANT_UNSUPPORTED',
      message: expect.stringMatching(/NPU only/),
    })
    await gguf('npu-model')
    await expect(
      runtime({ resolveBuild: async () => ({ ...BUILD, devices: ['GPUOpenCL', 'CPU'] }) }).rt.load(
        'npu-model'
      )
    ).rejects.toMatchObject({
      code: 'GENIEX_VARIANT_UNSUPPORTED',
      message: expect.stringMatching(/NPU driver/),
    })
    await expect(runtime({ resolveBuild: async () => undefined }).rt.load('npu-model')).rejects.toMatchObject(
      { code: 'BINARY_NOT_FOUND' }
    )
    expect(await serves()).toEqual([])
  })

  it('refuses a bundle for a newer GenieX without starting the host, and runs one for this chip on the NPU', async () => {
    await bundle('new')
    const newer: GeniexModelMetadata = {
      kind: 'qairt',
      chip: 'x-elite',
      max_context_tokens: 4096,
      precision: 'w4a16',
      min_runtime_version: '0.10.0',
    }
    await expect(runtime({ inspect: newer }).rt.load('new')).rejects.toMatchObject({
      code: 'GENIEX_MODEL_REQUIRES_NEWER_ENGINE',
      message: expect.stringMatching(/0\.10\.0/),
    })
    expect(await serves()).toEqual([])
    const ok: GeniexModelMetadata = { ...newer, min_runtime_version: '0.9.0' }
    const { rt } = runtime({ inspect: ok })
    await rt.load('new')
    try {
      const [serve = []] = await serves()
      expect(serve[serve.indexOf('--plugin') + 1]).toBe('qairt')
      expect(serve[serve.indexOf('--model') + 1]).toBe(join(data.layout.provider('geniex').modelsDir, 'new'))
      expect(serve[serve.indexOf('--nctx') + 1]).toBe('4096')
    } finally {
      await rt.unload('new')
    }
  })

  it('maps the host exit codes, with the tail of what it printed', async () => {
    await gguf('m')
    await expect(runtime({ mode: 'exit-6' }).rt.load('m')).rejects.toMatchObject({
      code: 'GENIEX_MODEL_REQUIRES_NEWER_ENGINE',
    })
    await expect(runtime({ mode: 'exit-7' }).rt.load('m')).rejects.toMatchObject({
      code: 'GENIEX_VARIANT_UNSUPPORTED',
      message: 'AI Hub bundles run on the NPU only.',
    })
    await expect(runtime({ mode: 'exit-3' }).rt.load('m')).rejects.toMatchObject({
      code: 'GENIEX_HOST_ERROR',
      details: expect.stringMatching(/error 126/),
    })
  })

  it('reports session:died when the host exits on its own', async () => {
    await gguf('m')
    const { rt, events } = runtime({ mode: 'crash-after-ready' })
    await rt.load('m')
    for (let i = 0; i < 100 && !events.some((event) => event.name === 'session:died'); i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.find((event) => event.name === 'session:died')?.payload).toMatchObject({ model_id: 'm' })
    expect(rt.list()).toEqual([])
  })

  it('reads the model once per path and modification time', async () => {
    await gguf('m')
    const inspected: string[] = []
    const { rt } = runtime({
      inspectModel: async (path) => {
        inspected.push(path)
        return { ...GGUF, max_context_tokens: null }
      },
    })
    await rt.load('m')
    await rt.unload('m')
    await rt.load('m')
    await rt.unload('m')
    expect(inspected).toHaveLength(1)
    expect((await starts()).filter((argv) => argv[0] === 'inspect')).toEqual([])
  })
})

describe('engineContext and launchDevice', () => {
  const block = { context_length: 40960, backend: 'npu' } as Parameters<typeof engineContext>[1]
  it.each<[unknown, number | null, number]>([
    [0, 131072, 40960],
    [262144, 131072, 131072],
    [8192, 131072, 8192],
    [0, null, 40960],
    ['8192', null, 8192],
    [-5, null, 40960],
  ])('settings %j, model %j → %i', (setting, modelMax, expected) => {
    expect(engineContext(setting, block, modelMax)).toBe(expected)
  })

  it("takes the settings device when it is one, else model.yml's default", () => {
    expect(launchDevice('gpu', block)).toBe('gpu')
    expect(launchDevice('', block)).toBe('npu')
    expect(launchDevice('tpu', block)).toBe('npu')
    expect(launchDevice(undefined, block)).toBe('npu')
  })
})
