import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { skipTestOnWindows } from '../../../test/helpers/platform.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ModelRegistry } from '../../models/index.js'
import {
  mlxDraftModelsDir,
  mlxModelDir,
  readMlxMaxCtxTrain,
  readMlxMemoryFacts,
  repairLegacyShardName,
  resolveLocalDraftDir,
} from './model-files.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-mlx-files-')
})
afterEach(() => data.cleanup())

describe('mlx model files', () => {
  it('reads the trained context from the top level, the text config, or not at all', async () => {
    const dir = join(data.root, 'm')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), '')
    expect(await mlxModelDir(join(dir, 'model.safetensors'))).toBe(dir)
    expect(await mlxModelDir(dir)).toBe(dir)
    expect(await readMlxMaxCtxTrain(dir)).toBeUndefined()
    for (const [config, expected] of [
      [{ max_position_embeddings: 4096 }, 4096],
      [{ text_config: { max_position_embeddings: '131072' } }, 131072],
      [{ max_position_embeddings: 0 }, undefined],
      [{ max_position_embeddings: 'many' }, undefined],
      [{}, undefined],
    ] as const) {
      await writeFile(join(dir, 'config.json'), JSON.stringify(config))
      expect(await readMlxMaxCtxTrain(join(dir, 'model.safetensors'))).toBe(expected)
    }
  })

  it('finds a drafter imported as a model or downloaded as a draft, only with config and weights', async () => {
    const repo = 'owner/drafter'
    expect(await resolveLocalDraftDir(data.layout, repo)).toBeUndefined()
    const downloaded = join(mlxDraftModelsDir(data.layout), 'owner', 'drafter')
    await mkdir(downloaded, { recursive: true })
    await writeFile(join(downloaded, 'config.json'), '{}')
    expect(await resolveLocalDraftDir(data.layout, repo)).toBeUndefined()
    await writeFile(join(downloaded, 'model-00001.SAFETENSORS'), '')
    expect(await resolveLocalDraftDir(data.layout, repo)).toBe(downloaded)
    const imported = join(data.root, 'mlx', 'models', 'owner_drafter')
    await mkdir(imported, { recursive: true })
    await writeFile(join(imported, 'config.json'), '{}')
    await writeFile(join(imported, 'model.safetensors'), '')
    expect(await resolveLocalDraftDir(data.layout, repo)).toBe(imported)
  })

  it('leaves a model alone when there is nothing to repair, and reports an unreadable index', async () => {
    const registry = new ModelRegistry(data.layout, 'mlx')
    const yml = { model_path: 'mlx/models/x/model.safetensors', name: 'x', size_bytes: 1 }
    await registry.write('x', yml)
    const warnings: string[] = []
    const doc = await registry.read('x')
    expect(await repairLegacyShardName(registry, 'x', doc, (m) => warnings.push(m))).toBe(doc)
    expect(warnings).toEqual([])
    await writeFile(join(data.root, 'mlx', 'models', 'x', 'model.safetensors.index.json'), '{not json')
    expect(await repairLegacyShardName(registry, 'x', doc, (m) => warnings.push(m))).toBe(doc)
    expect(warnings[0]).toMatch(/MLX shard-name repair failed/)
  })

  it('repoints the projector path too', async () => {
    const registry = new ModelRegistry(data.layout, 'mlx')
    const dir = join(data.root, 'mlx', 'models', 'v')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), '')
    await writeFile(
      join(dir, 'model.safetensors.index.json'),
      JSON.stringify({ weight_map: { a: 's1.safetensors' } })
    )
    await registry.write('v', {
      model_path: 'mlx/models/v/model.safetensors',
      mmproj_path: 'mlx/models/v/model.safetensors',
      name: 'v',
      size_bytes: 1,
    })
    const repaired = await repairLegacyShardName(registry, 'v', await registry.read('v'))
    expect(repaired).toMatchObject({
      model_path: 'mlx/models/v/s1.safetensors',
      mmproj_path: 'mlx/models/v/s1.safetensors',
    })
  })

  it('sums every safetensors file of the folder and sizes a token of KV cache from config.json', async () => {
    const dir = join(data.root, 'm')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model-00001-of-00002.safetensors'), Buffer.alloc(100))
    await writeFile(join(dir, 'model-00002-of-00002.safetensors'), Buffer.alloc(50))
    await writeFile(join(dir, 'README.md'), 'not weights')
    // No config.json yet: the weights are known, the KV cache is not.
    expect(await readMlxMemoryFacts(dir, 0)).toEqual({ weightsBytes: 150, kvBytesPerToken: undefined })
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ num_hidden_layers: 4, num_key_value_heads: 2, head_dim: 64 })
    )
    // 2 × 4 layers × 2 KV heads × 64 dims at 16 bits, from a shard path as well as the folder.
    expect(await readMlxMemoryFacts(join(dir, 'model-00001-of-00002.safetensors'), 0)).toEqual({
      weightsBytes: 150,
      kvBytesPerToken: 2048,
    })
    // A quantized KV cache takes its own bits.
    expect((await readMlxMemoryFacts(dir, 4)).kvBytesPerToken).toBe(512)
    // A config that does not describe the attention says nothing about the KV cache.
    await writeFile(join(dir, 'config.json'), JSON.stringify({ model_type: 'mystery' }))
    expect((await readMlxMemoryFacts(dir, 0)).kvBytesPerToken).toBeUndefined()
  })

  it('knows nothing of a folder that is not there', async () => {
    expect(await readMlxMemoryFacts(join(data.root, 'gone', 'model.safetensors'), 8)).toEqual({
      weightsBytes: 0,
      kvBytesPerToken: undefined,
    })
  })

  it('counts a weights entry it cannot stat as nothing', async (ctx) => {
    skipTestOnWindows(ctx, 'creating a symlink needs a privilege Windows runners do not grant')
    const dir = join(data.root, 'linked')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(10))
    await symlink(join(dir, 'missing.bin'), join(dir, 'dangling.safetensors'))
    expect((await readMlxMemoryFacts(dir, 0)).weightsBytes).toBe(10)
  })

  it('leaves a checkpoint whose shards already match its index alone', async () => {
    const registry = new ModelRegistry(data.layout, 'mlx')
    const dir = join(data.root, 'mlx', 'models', 'ok')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), '')
    await writeFile(
      join(dir, 'model.safetensors.index.json'),
      JSON.stringify({ weight_map: { a: 'model.safetensors' } })
    )
    await registry.write('ok', { model_path: 'mlx/models/ok/model.safetensors', name: 'ok', size_bytes: 1 })
    const warnings: string[] = []
    const doc = await registry.read('ok')
    expect(await repairLegacyShardName(registry, 'ok', doc, (m) => warnings.push(m))).toBe(doc)
    expect(warnings).toEqual([])
    expect((await readdir(dir)).sort()).toEqual([
      'model.safetensors',
      'model.safetensors.index.json',
      'model.yml',
    ])
  })

  it('renames the first shard of a model stored as a folder and keeps its folder path', async () => {
    const registry = new ModelRegistry(data.layout, 'mlx')
    const dir = join(data.root, 'mlx', 'models', 'f')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), '')
    await writeFile(join(dir, 'model-00002-of-00002.safetensors'), '')
    await writeFile(
      join(dir, 'model.safetensors.index.json'),
      JSON.stringify({
        weight_map: { a: 'model-00001-of-00002.safetensors', b: 'model-00002-of-00002.safetensors' },
      })
    )
    await registry.write('f', { model_path: 'mlx/models/f', name: 'f', size_bytes: 1 })
    const warnings: string[] = []
    const repaired = await repairLegacyShardName(registry, 'f', await registry.read('f'), (m) =>
      warnings.push(m)
    )
    expect(repaired.model_path).toBe('mlx/models/f')
    expect(repaired).not.toHaveProperty('mmproj_path')
    expect(await readdir(dir)).toContain('model-00001-of-00002.safetensors')
    expect(await readdir(dir)).not.toContain('model.safetensors')
    expect(warnings).toEqual([
      `Repaired mis-named MLX shard in ${dir}: model.safetensors -> model-00001-of-00002.safetensors`,
    ])
  })
})
