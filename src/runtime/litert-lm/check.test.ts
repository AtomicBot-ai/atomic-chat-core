import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { LiteRtLmFileMetadata } from '../../contracts/index.js'
import { ModelRegistry, serializeModelYml } from '../../models/index.js'
import { LiteRtLmCheckService, liteRtLmVerdict, parseLiteRtLmCheckRequest } from './check.js'
import type { LiteRtLmCheckFacts } from './check.js'

const FACTS: LiteRtLmCheckFacts = {
  platform: 'win-x64',
  build: { dir: '/b/0.18.1/win-x64', version: '0.18.1' },
  npu: 'intel-lnl',
  openVinoPrepared: true,
}

const INFO: LiteRtLmFileMetadata = {
  model_type: 'llm',
  max_context_tokens: 32003,
  dynamic_context: true,
  function_calling: false,
  thinking: false,
  modalities: ['text', 'vision'],
  backends: ['cpu', 'gpu'],
  vision_backends: ['cpu'],
  npu: null,
  speculative_decoding: true,
  min_runtime_version: null,
}

describe('liteRtLmVerdict', () => {
  it.each<[string, Partial<LiteRtLmCheckFacts>, Record<string, string>, string]>([
    ['cpu anywhere', {}, { backend: 'cpu' }, 'ok'],
    ['gpu on macOS', { platform: 'macos-arm64', npu: null }, { backend: 'gpu' }, 'ok'],
    ['an unknown backend', {}, { backend: 'tpu' }, 'platform-unsupported'],
    [
      'npu off Windows',
      { platform: 'linux-x64' },
      { backend: 'npu', npu: 'intel-lnl' },
      'platform-unsupported',
    ],
    [
      'npu without one LiteRT-LM targets',
      { npu: null },
      { backend: 'npu', npu: 'intel-lnl' },
      'accelerator-unavailable',
    ],
    [
      'a Panther Lake file on Lunar Lake',
      {},
      { backend: 'npu', npu: 'intel-ptl' },
      'accelerator-unavailable',
    ],
    ['an unknown NPU', {}, { backend: 'npu', npu: 'qualcomm-sm8750' }, 'platform-unsupported'],
    ['no build', { build: null }, { backend: 'cpu' }, 'engine-not-installed'],
    ['a newer runtime', {}, { backend: 'cpu', min_runtime_version: '0.19' }, 'requires-newer-engine'],
    ['the same runtime', {}, { backend: 'cpu', min_runtime_version: '0.18' }, 'ok'],
    [
      'OpenVINO not prepared',
      { openVinoPrepared: false },
      { backend: 'npu', npu: 'intel-lnl' },
      'accelerator-not-prepared',
    ],
    ['npu prepared', {}, { backend: 'npu', npu: 'intel-lnl' }, 'ok'],
  ])('%s → %s', (_name, facts, request, verdict) => {
    const result = liteRtLmVerdict({ ...FACTS, ...facts }, request, null)
    expect(result.verdict).toBe(verdict)
    expect(result.reason === null).toBe(verdict === 'ok')
  })

  it('judges a file on disk by its own facts: a GPU variant whose file has only CPU is unsupported', () => {
    expect(liteRtLmVerdict(FACTS, { backend: 'gpu' }, { ...INFO, backends: ['cpu'] })).toEqual({
      verdict: 'platform-unsupported',
      reason: expect.stringMatching(/cpu/),
      metadata: { ...INFO, backends: ['cpu'] },
    })
    expect(
      liteRtLmVerdict(FACTS, { backend: 'cpu' }, { ...INFO, min_runtime_version: '0.20.0' }).verdict
    ).toBe('requires-newer-engine')
    expect(liteRtLmVerdict(FACTS, { backend: 'gpu' }, INFO)).toEqual({
      verdict: 'ok',
      reason: null,
      metadata: INFO,
    })
  })
})

describe('parseLiteRtLmCheckRequest', () => {
  it('takes a variant, a path with a backend, or a model id', () => {
    expect(
      parseLiteRtLmCheckRequest({ backend: 'npu', npu: 'intel-lnl', min_runtime_version: '0.18' })
    ).toEqual({
      backend: 'npu',
      npu: 'intel-lnl',
      min_runtime_version: '0.18',
    })
    expect(parseLiteRtLmCheckRequest({ path: '/d/x.litertlm', backend: 'gpu' })).toEqual({
      path: '/d/x.litertlm',
      backend: 'gpu',
    })
    expect(parseLiteRtLmCheckRequest({ model_id: 'm' })).toEqual({ model_id: 'm' })
  })

  it.each([
    [null],
    [[]],
    [{}],
    [{ backend: 1 }],
    [{ path: 'x' }],
    [{ model_id: 'm', path: '/x', backend: 'cpu' }],
    [{ backend: 'cpu', extra: 1 }],
  ])('refuses %j', (body) => {
    expect(() => parseLiteRtLmCheckRequest(body)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    )
  })
})

describe('LiteRtLmCheckService', () => {
  let data: TmpDataFolder
  beforeEach(async () => {
    data = await makeTmpDataFolder('atomic-litert-check-')
  })
  afterEach(() => data.cleanup())

  function service() {
    const inspected: string[] = []
    const svc = new LiteRtLmCheckService({
      platform: 'macos-arm64',
      modelsDir: data.layout.provider('litert-lm').modelsDir,
      registry: new ModelRegistry(data.layout, 'litert-lm'),
      resolveBuild: async () => ({ dir: '/b', version: '0.18.1' }),
      npuGeneration: async () => null,
      openVinoLibs: async () => undefined,
      inspect: async (_build, file) => {
        inspected.push(file)
        return INFO
      },
    })
    return { svc, inspected }
  }

  it('checks a variant before download without reading anything', async () => {
    const { svc, inspected } = service()
    expect(await svc.check({ backend: 'gpu' })).toEqual({ verdict: 'ok', reason: null })
    expect(inspected).toEqual([])
  })

  it('checks a downloaded file by path inside the models root, with its metadata', async () => {
    const { svc, inspected } = service()
    const file = join(data.layout.provider('litert-lm').modelsDir, 'v', 'f.litertlm')
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'x')
    expect(await svc.check({ path: file, backend: 'gpu' })).toEqual({
      verdict: 'ok',
      reason: null,
      metadata: INFO,
    })
    expect(inspected).toEqual([file])
  })

  it('refuses a path outside the models root, through .. or not', async () => {
    const { svc } = service()
    const root = data.layout.provider('litert-lm').modelsDir
    await expect(
      svc.check({ path: join(data.root, 'secret.litertlm'), backend: 'cpu' })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(
      svc.check({ path: join(root, '..', '..', 'x.litertlm'), backend: 'cpu' })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(svc.check({ path: 'relative.litertlm', backend: 'cpu' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('refuses a link inside the models root that leads outside it', async () => {
    const { svc } = service()
    const root = data.layout.provider('litert-lm').modelsDir
    await writeFile(join(data.root, 'outside.litertlm'), 'x')
    await mkdir(join(root, 'v'), { recursive: true })
    await symlink(join(data.root, 'outside.litertlm'), join(root, 'v', 'link.litertlm'))
    await expect(svc.check({ path: join(root, 'v', 'link.litertlm'), backend: 'cpu' })).rejects.toMatchObject(
      {
        code: 'INVALID_ARGUMENT',
      }
    )
  })

  it('checks an installed model by id, its backend from model.yml', async () => {
    const { svc } = service()
    const dir = join(data.layout.provider('litert-lm').modelsDir, 'gemma-gpu')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'f.litertlm'), 'x')
    await writeFile(
      join(dir, 'model.yml'),
      serializeModelYml({
        model_path: 'litert-lm/models/gemma-gpu/f.litertlm',
        name: 'gemma-gpu',
        size_bytes: 1,
        litert_lm: {
          model_id: 'gemma',
          variant_id: 'gemma-gpu',
          backend: 'gpu',
          repo: 'o/r',
          revision: 'a'.repeat(40),
          file: 'f.litertlm',
          tools: false,
          reasoning: false,
          vision: false,
          source: 'huggingface',
        },
      })
    )
    expect(await svc.check({ model_id: 'gemma-gpu' })).toEqual({
      verdict: 'ok',
      reason: null,
      metadata: INFO,
    })
  })
})
