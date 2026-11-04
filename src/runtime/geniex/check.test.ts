import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { GeniexModelMetadata } from '../../contracts/index.js'
import { ModelRegistry, serializeModelYml } from '../../models/index.js'
import { GeniexCheckService, geniexVerdict, parseGeniexCheckRequest } from './check.js'
import type { GeniexCheckFacts } from './check.js'

const BUILD = { dir: '/b/0.9.3/win-arm64', version: '0.9.3', devices: ['HTP0', 'GPUOpenCL', 'CPU'] }
const FACTS: GeniexCheckFacts = { chip: 'x-elite', build: BUILD }
const GGUF: GeniexModelMetadata = {
  kind: 'gguf',
  architecture: 'qwen3',
  max_context_tokens: 40960,
  quantization: 'Q4_0',
  chat_template: true,
  vision: false,
}
const BUNDLE: GeniexModelMetadata = {
  kind: 'qairt',
  chip: 'x-elite',
  max_context_tokens: 4096,
  precision: 'w4a16',
  min_runtime_version: '0.9.3',
}

describe('geniexVerdict (task 6.5)', () => {
  it.each<[string, Partial<GeniexCheckFacts>, Parameters<typeof geniexVerdict>[1], string]>([
    ['unknown plugin', {}, { plugin: 'onnx', device: 'cpu' }, 'platform-unsupported'],
    ['unknown device', {}, { plugin: 'llama_cpp', device: 'tpu' }, 'platform-unsupported'],
    ['bundle off the NPU', {}, { plugin: 'qairt', device: 'gpu', chip: 'x-elite' }, 'platform-unsupported'],
    ['bundle without a chip', {}, { plugin: 'qairt', device: 'npu' }, 'platform-unsupported'],
    [
      'bundle for another chip',
      {},
      { plugin: 'qairt', device: 'npu', chip: 'x2-elite' },
      'platform-unsupported',
    ],
    [
      'bundle for an unknown chip',
      {},
      { plugin: 'qairt', device: 'npu', chip: 'x3-elite' },
      'platform-unsupported',
    ],
    ['not installed', { build: null }, { plugin: 'llama_cpp', device: 'cpu' }, 'engine-not-installed'],
    [
      'NPU not found',
      { build: { ...BUILD, devices: ['GPUOpenCL', 'CPU'] } },
      { plugin: 'llama_cpp', device: 'npu' },
      'accelerator-unavailable',
    ],
    [
      'hybrid without the NPU',
      { build: { ...BUILD, devices: ['GPUOpenCL', 'CPU'] } },
      { plugin: 'llama_cpp', device: 'hybrid' },
      'accelerator-unavailable',
    ],
    [
      'GPU not found',
      { build: { ...BUILD, devices: ['HTP0', 'CPU'] } },
      { plugin: 'llama_cpp', device: 'gpu' },
      'accelerator-unavailable',
    ],
    [
      'CPU with nothing else',
      { build: { ...BUILD, devices: ['GPUOpenCL', 'CPU'] } },
      { plugin: 'llama_cpp', device: 'cpu' },
      'ok',
    ],
    [
      'newer GenieX needed',
      {},
      { plugin: 'llama_cpp', device: 'npu', min_runtime_version: '0.10.0' },
      'requires-newer-engine',
    ],
    ['GGUF on the NPU', {}, { plugin: 'llama_cpp', device: 'npu' }, 'ok'],
    ['bundle for this chip', {}, { plugin: 'qairt', device: 'npu', chip: 'x-elite' }, 'ok'],
  ])('%s → %s', (_name, facts, request, expected) => {
    const result = geniexVerdict({ ...FACTS, ...facts }, request, null)
    expect(result.verdict).toBe(expected)
    expect(result.reason === null).toBe(expected === 'ok')
  })

  it('judges a model on disk by its own facts, which come back in the answer', () => {
    expect(geniexVerdict(FACTS, { plugin: 'llama_cpp', device: 'npu' }, GGUF)).toEqual({
      verdict: 'ok',
      reason: null,
      metadata: GGUF,
    })
    expect(geniexVerdict(FACTS, { plugin: 'qairt', device: 'npu' }, BUNDLE)).toEqual({
      verdict: 'ok',
      reason: null,
      metadata: BUNDLE,
    })
    expect(
      geniexVerdict(FACTS, { plugin: 'qairt', device: 'npu' }, { ...BUNDLE, chip: 'x2-elite' })
    ).toMatchObject({
      verdict: 'platform-unsupported',
      reason: expect.stringMatching(/x2-elite/),
    })
    expect(
      geniexVerdict(FACTS, { plugin: 'qairt', device: 'npu' }, { ...BUNDLE, min_runtime_version: '0.10' })
    ).toMatchObject({
      verdict: 'requires-newer-engine',
      reason: expect.stringMatching(/0\.10/),
    })
    expect(geniexVerdict(FACTS, { plugin: 'llama_cpp', device: 'cpu' }, BUNDLE)).toMatchObject({
      verdict: 'platform-unsupported',
      reason: expect.stringMatching(/qairt plugin/),
    })
    expect(
      geniexVerdict({ ...FACTS, build: null }, { plugin: 'llama_cpp', device: 'cpu' }, GGUF)
    ).toMatchObject({
      verdict: 'engine-not-installed',
      metadata: GGUF,
    })
  })
})

describe('parseGeniexCheckRequest', () => {
  it('takes a variant, a path with its plugin and device, or a model id', () => {
    expect(
      parseGeniexCheckRequest({
        plugin: 'qairt',
        device: 'npu',
        chip: 'x-elite',
        min_runtime_version: '0.9.3',
      })
    ).toEqual({
      plugin: 'qairt',
      device: 'npu',
      chip: 'x-elite',
      min_runtime_version: '0.9.3',
    })
    expect(parseGeniexCheckRequest({ path: '/d/x.gguf', plugin: 'llama_cpp', device: 'gpu' })).toEqual({
      path: '/d/x.gguf',
      plugin: 'llama_cpp',
      device: 'gpu',
    })
    expect(parseGeniexCheckRequest({ model_id: 'm' })).toEqual({ model_id: 'm' })
  })

  it.each([
    [null],
    [[]],
    [{}],
    [{ plugin: 1 }],
    [{ path: '/x' }],
    [{ model_id: 'm', path: '/x', plugin: 'llama_cpp', device: 'cpu' }],
    [{ plugin: 'llama_cpp', device: 'cpu', extra: 1 }],
  ])('refuses %j', (body) => {
    expect(() => parseGeniexCheckRequest(body)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })
})

describe('GeniexCheckService', () => {
  let data: TmpDataFolder
  beforeEach(async () => {
    data = await makeTmpDataFolder('atomic-geniex-check-')
  })
  afterEach(() => data.cleanup())

  function service(build: typeof BUILD | null = BUILD) {
    const inspected: string[] = []
    const svc = new GeniexCheckService({
      chip: 'x-elite',
      modelsDir: data.layout.provider('geniex').modelsDir,
      registry: new ModelRegistry(data.layout, 'geniex'),
      resolveBuild: async () => build ?? undefined,
      inspect: async (path) => {
        inspected.push(path)
        return path.endsWith('.gguf') ? GGUF : BUNDLE
      },
    })
    return { svc, inspected }
  }

  it('checks a variant before download without reading anything', async () => {
    const { svc, inspected } = service()
    expect(await svc.check({ plugin: 'llama_cpp', device: 'gpu' })).toEqual({ verdict: 'ok', reason: null })
    expect(inspected).toEqual([])
  })

  it('checks a downloaded file or bundle folder by path inside the models root, with its facts, even before the engine is installed', async () => {
    const { svc, inspected } = service()
    const root = data.layout.provider('geniex').modelsDir
    const file = join(root, 'qwen3-4b', 'Qwen3-4B-Q4_0.gguf')
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'x')
    expect(await svc.check({ path: file, plugin: 'llama_cpp', device: 'npu' })).toEqual({
      verdict: 'ok',
      reason: null,
      metadata: GGUF,
    })
    const bundle = join(root, 'qwen3-4b-x-elite')
    await mkdir(bundle, { recursive: true })
    expect(await svc.check({ path: bundle, plugin: 'qairt', device: 'npu' })).toEqual({
      verdict: 'ok',
      reason: null,
      metadata: BUNDLE,
    })
    expect(inspected).toEqual([file, bundle])
    expect(await service(null).svc.check({ path: file, plugin: 'llama_cpp', device: 'npu' })).toMatchObject({
      verdict: 'engine-not-installed',
      metadata: GGUF,
    })
  })

  it('refuses a path outside the models root, through .. or not', async () => {
    const { svc } = service()
    const root = data.layout.provider('geniex').modelsDir
    await expect(
      svc.check({ path: join(data.root, 'secret.gguf'), plugin: 'llama_cpp', device: 'cpu' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      svc.check({ path: join(root, '..', 'secret.gguf'), plugin: 'llama_cpp', device: 'cpu' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      svc.check({ path: 'relative.gguf', plugin: 'llama_cpp', device: 'cpu' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('checks an installed model by its model.yml, the device being the default of the record', async () => {
    const { svc, inspected } = service({ ...BUILD, devices: ['GPUOpenCL', 'CPU'] })
    const dir = join(data.layout.provider('geniex').modelsDir, 'qwen3-4b')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'Qwen3-4B-Q4_0.gguf'), 'x')
    await writeFile(
      join(dir, 'model.yml'),
      serializeModelYml({
        model_path: 'geniex/models/qwen3-4b/Qwen3-4B-Q4_0.gguf',
        name: 'qwen3-4b',
        size_bytes: 1,
        geniex: {
          model_id: 'qwen3-4b',
          variant_id: 'qwen3-4b',
          plugin: 'llama_cpp',
          backend: 'npu',
          repo: 'unsloth/Qwen3-4B-GGUF',
          revision: 'a'.repeat(40),
          file: 'Qwen3-4B-Q4_0.gguf',
          context_length: 40960,
          tools: true,
          reasoning: true,
          vision: false,
          source: 'curated',
        },
      })
    )
    expect(await svc.check({ model_id: 'qwen3-4b' })).toMatchObject({
      verdict: 'accelerator-unavailable',
      reason: expect.stringMatching(/NPU/),
      metadata: GGUF,
    })
    expect(inspected).toEqual([join(dir, 'Qwen3-4B-Q4_0.gguf')])
  })
})
