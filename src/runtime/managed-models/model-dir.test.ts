import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { parseManagedModelYml, readManagedModel } from './model-dir.js'

let data: TmpDataFolder
let modelsDir: string

beforeEach(async () => {
  data = await makeTmpDataFolder('trt-model-dir-')
  modelsDir = data.layout.provider('tensorrt-llm').modelsDir
})
afterEach(() => data.cleanup())

async function install(id: string, yml: string): Promise<string> {
  const dir = join(modelsDir, ...id.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.yml'), yml)
  return dir
}

const QWEN = `name: Qwen3 8B FP8
repository: Qwen/Qwen3-8B-FP8
revision: 0123456789abcdef
architectures:
  - Qwen3ForCausalLM
quantization: fp8
files:
  - path: model-00001-of-00002.safetensors
    size: 4000000000
    sha256: ${'a'.repeat(64)}
  - path: model-00002-of-00002.safetensors
    size: 4500000000
    sha256: ${'b'.repeat(64)}
  - path: config.json
    size: 1200
    sha256: null
`

describe('readManagedModel', () => {
  it('Модель, скачанная до этого change: reads a model.yml that still carries quantization, and ignores the field', async () => {
    const dir = await install('Qwen/Qwen3-8B-FP8', QWEN)
    expect(await readManagedModel(modelsDir, 'Qwen/Qwen3-8B-FP8')).toEqual({
      id: 'Qwen/Qwen3-8B-FP8',
      dir,
      repository: 'Qwen/Qwen3-8B-FP8',
      revision: '0123456789abcdef',
      architecture: 'Qwen3ForCausalLM',
      files: [
        { path: 'model-00001-of-00002.safetensors', size: 4_000_000_000, sha256: 'a'.repeat(64) },
        { path: 'model-00002-of-00002.safetensors', size: 4_500_000_000, sha256: 'b'.repeat(64) },
        { path: 'config.json', size: 1_200, sha256: null },
      ],
      weightBytes: 8_500_000_000,
    })
  })

  it('tolerates a model.yml without repository, revision, architectures or files', async () => {
    await install('bare', 'name: bare\n')
    expect(await readManagedModel(modelsDir, 'bare')).toMatchObject({
      repository: null,
      revision: null,
      architecture: null,
      files: [],
      weightBytes: 0,
    })
  })

  it('answers MODEL_NOT_FOUND for a directory with no model.yml (a download still in progress)', async () => {
    await mkdir(join(modelsDir, 'half'), { recursive: true })
    await expect(readManagedModel(modelsDir, 'half')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })

  it('rejects a model.yml with a malformed files entry, rather than silently dropping it (finding 4)', async () => {
    await install(
      'mixed',
      'files:\n  - path: model.safetensors\n    size: 10\n  - null\n  - path: model-2.safetensors\n  - size: 5\n'
    )
    await expect(readManagedModel(modelsDir, 'mixed')).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })

  it('rejects a model.yml whose files key is present but not an array', async () => {
    await install('files-not-array', 'files: "oops"\n')
    await expect(readManagedModel(modelsDir, 'files-not-array')).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })

  it.each([
    ['a non-string path', 'files:\n  - path: 42\n    size: 10\n'],
    ['an absolute path', 'files:\n  - path: /etc/passwd\n    size: 10\n'],
    ['a path that climbs out with ..', 'files:\n  - path: ../../etc/passwd\n    size: 10\n'],
    ['a size that is not a number', 'files:\n  - path: model.safetensors\n    size: "10"\n'],
    ['a negative size', 'files:\n  - path: model.safetensors\n    size: -1\n'],
    ['a non-integer size', 'files:\n  - path: model.safetensors\n    size: 10.5\n'],
    [
      'a sha256 that is neither a string nor null',
      'files:\n  - path: model.safetensors\n    size: 10\n    sha256: 42\n',
    ],
  ])('rejects a files entry with %s', async (_label, yml) => {
    await install('bad-files', yml)
    await expect(readManagedModel(modelsDir, 'bad-files')).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })

  it('accepts a safe nested path and a null/omitted sha256', async () => {
    await install(
      'nested-path',
      'files:\n  - path: variant/model.safetensors\n    size: 10\n  - path: config.json\n    size: 5\n    sha256: null\n'
    )
    const model = await readManagedModel(modelsDir, 'nested-path')
    expect(model.files).toEqual([
      { path: 'variant/model.safetensors', size: 10, sha256: null },
      { path: 'config.json', size: 5, sha256: null },
    ])
  })

  it('answers MANAGED_METADATA_INVALID for a model.yml that is not YAML at all', async () => {
    await install('garbled', 'name: [unclosed\n')
    await expect(readManagedModel(modelsDir, 'garbled')).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })

  it('answers MANAGED_METADATA_INVALID for a model.yml that is not a mapping', async () => {
    await install('broken', '- just\n- a list\n')
    await expect(readManagedModel(modelsDir, 'broken')).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })

  it.each(['../escape', 'a/../../b', '', 'a//b', '/abs'])(
    'refuses the id %j before touching the disk',
    async (id) => {
      await expect(readManagedModel(modelsDir, id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  )
})

describe('parseManagedModelYml', () => {
  it('model.yml не зависит от движка: an engine-dependent field is never part of the document or the model', async () => {
    const doc = parseManagedModelYml(QWEN, '/x/model.yml')
    expect(doc).not.toHaveProperty('quantization')
    await install('Qwen/Qwen3-8B-FP8', QWEN)
    expect(await readManagedModel(modelsDir, 'Qwen/Qwen3-8B-FP8')).not.toHaveProperty('quantization')
  })

  it('parses every field readManagedModel derives from, on its own', () => {
    expect(parseManagedModelYml(QWEN, '/x/model.yml')).toEqual({
      repository: 'Qwen/Qwen3-8B-FP8',
      revision: '0123456789abcdef',
      architectures: ['Qwen3ForCausalLM'],
      files: [
        { path: 'model-00001-of-00002.safetensors', size: 4_000_000_000, sha256: 'a'.repeat(64) },
        { path: 'model-00002-of-00002.safetensors', size: 4_500_000_000, sha256: 'b'.repeat(64) },
        { path: 'config.json', size: 1_200, sha256: null },
      ],
    })
  })

  it('drops non-string and empty-string entries from architectures', () => {
    const yml = 'architectures:\n  - Qwen3ForCausalLM\n  - ""\n  - 42\n'
    expect(parseManagedModelYml(yml, '/x/model.yml').architectures).toEqual(['Qwen3ForCausalLM'])
  })

  it('throws MANAGED_METADATA_INVALID for invalid YAML or a non-mapping document', () => {
    expect(() => parseManagedModelYml('name: [unclosed\n', '/x/model.yml')).toThrow(
      expect.objectContaining({ code: 'MANAGED_METADATA_INVALID' })
    )
    expect(() => parseManagedModelYml('- a\n- list\n', '/x/model.yml')).toThrow(
      expect.objectContaining({ code: 'MANAGED_METADATA_INVALID' })
    )
  })
})
