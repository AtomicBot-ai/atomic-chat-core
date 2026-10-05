import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { TensorrtLlmModelRegistry } from './registry.js'

let data: TmpDataFolder
let modelsDir: string
let registry: TensorrtLlmModelRegistry

beforeEach(async () => {
  data = await makeTmpDataFolder('trt-registry-')
  modelsDir = data.layout.provider('tensorrt-llm').modelsDir
  registry = new TensorrtLlmModelRegistry(modelsDir)
})
afterEach(() => data.cleanup())

async function install(id: string, yml: string): Promise<string> {
  const dir = join(modelsDir, ...id.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.yml'), yml)
  return dir
}

const QWEN = `repository: Qwen/Qwen3-8B-FP8
revision: deadbeef
architectures:
  - Qwen3ForCausalLM
quantization: fp8
files:
  - path: model.safetensors
    size: 8000000000
    sha256: ${'a'.repeat(64)}
`

describe('TensorrtLlmModelRegistry', () => {
  it('lists a model that has a model.yml', async () => {
    const dir = await install('Qwen/Qwen3-8B-FP8', QWEN)
    const entries = await registry.list()
    expect(entries).toEqual([
      {
        id: 'Qwen/Qwen3-8B-FP8',
        dir,
        yml: {
          repository: 'Qwen/Qwen3-8B-FP8',
          revision: 'deadbeef',
          architectures: ['Qwen3ForCausalLM'],
          quantization: 'fp8',
          files: [{ path: 'model.safetensors', size: 8_000_000_000, sha256: 'a'.repeat(64) }],
        },
      },
    ])
  })

  it('does not show a directory with files but no model.yml (spec "Недокачанный каталог")', async () => {
    const dir = join(modelsDir, 'half-downloaded')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model-00001-of-00002.safetensors'), 'partial')
    expect(await registry.list()).toEqual([])
  })

  it('a model that finishes downloading (model.yml written last) appears on the very next list(), no restart needed', async () => {
    const dir = join(modelsDir, 'downloading')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), 'partial')
    expect((await registry.list()).map((e) => e.id)).toEqual([])

    await writeFile(join(dir, 'model.yml'), QWEN.replace('Qwen/Qwen3-8B-FP8', 'downloading'))
    expect((await registry.list()).map((e) => e.id)).toEqual(['downloading'])
  })

  it('sorts nested ids ascending and never descends into a model directory', async () => {
    await install('Owner/Repo-A', QWEN)
    await install('alpha', QWEN)
    await mkdir(join(modelsDir, 'Owner', 'Repo-A', 'nested'), { recursive: true })
    await writeFile(join(modelsDir, 'Owner', 'Repo-A', 'nested', 'model.yml'), QWEN)
    expect((await registry.list()).map((e) => e.id)).toEqual(['Owner/Repo-A', 'alpha'])
  })

  it('skips a broken model.yml and still lists the good ones', async () => {
    await install('good', QWEN)
    await install('broken', 'repository: [unclosed\n')
    const result = await registry.scan()
    expect(result.entries.map((e) => e.id)).toEqual(['good'])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.dir).toContain('broken')
  })

  it('is empty when the models folder does not exist yet', async () => {
    expect(await registry.list()).toEqual([])
    expect((await registry.scan()).skipped).toEqual([])
  })

  it('ignores files sitting next to model folders', async () => {
    await install('m', QWEN)
    await writeFile(join(modelsDir, 'README.txt'), 'hi')
    expect((await registry.list()).map((e) => e.id)).toEqual(['m'])
  })
})

describe('a root core learns only at scan time (change add-tensorrt-llm-windows, task 2.8)', () => {
  it('scans the root it is given each time, and lists nothing while there is none (Windows before the import)', async () => {
    let root: string | null = null
    const lazy = new TensorrtLlmModelRegistry(async () => root)
    expect(await lazy.list()).toEqual([])
    await install('acme/m', QWEN)
    root = modelsDir
    expect((await lazy.list()).map((entry) => entry.id)).toEqual(['acme/m'])
  })
})
