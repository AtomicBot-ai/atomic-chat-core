import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ModelRegistry } from '../../models/index.js'
import {
  mlxDraftModelsDir,
  mlxModelDir,
  readMlxMaxCtxTrain,
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
})
