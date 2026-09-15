import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { ModelRegistry } from './registry.js'

let data: TmpDataFolder
let registry: ModelRegistry
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-registry-')
  registry = new ModelRegistry(data.layout)
})
afterEach(() => data.cleanup())

describe('scan', () => {
  it('finds nested ids with forward slashes, sorts them and never descends into a model folder', async () => {
    await data.writeModel('Owner/Repo-GGUF')
    await data.writeModel('alpha')
    await mkdir(join(registry.modelsDir, 'Owner', 'Repo-GGUF', 'nested'), { recursive: true })
    await writeFile(join(registry.modelsDir, 'Owner', 'Repo-GGUF', 'nested', 'model.yml'), 'model_path: x\n')
    const ids = (await registry.list()).map((e) => e.id)
    expect(ids).toEqual(['Owner/Repo-GGUF', 'alpha'])
  })

  it('is empty when the models folder does not exist yet', async () => {
    expect(await registry.list()).toEqual([])
    expect((await registry.scan()).skipped).toEqual([])
  })

  it('skips a broken model.yml and still lists the good ones', async () => {
    await data.writeModel('good')
    await mkdir(join(registry.modelsDir, 'broken'), { recursive: true })
    await writeFile(join(registry.modelsDir, 'broken', 'model.yml'), 'model_path: [unclosed\n')
    const result = await registry.scan()
    expect(result.entries.map((e) => e.id)).toEqual(['good'])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.dir).toContain('broken')
  })

  it('excludes embedding models from the chat list only', async () => {
    await data.writeModel('chat')
    await data.writeModel('embed', { embedding: true })
    expect((await registry.list()).map((e) => e.id)).toEqual(['chat', 'embed'])
    expect((await registry.listChatModels()).map((e) => e.id)).toEqual(['chat'])
  })

  it('ignores files sitting next to model folders', async () => {
    await data.writeModel('m')
    await writeFile(join(registry.modelsDir, 'README.txt'), 'hi')
    expect((await registry.list()).map((e) => e.id)).toEqual(['m'])
  })
})

describe('get, read and write', () => {
  it('reads one model by id and preserves unknown keys on rewrite', async () => {
    await data.writeModel('m', { name: 'Model', size_bytes: 10, custom_key: 'kept' })
    const entry = await registry.get('m')
    expect(entry.yml).toMatchObject({ name: 'Model', size_bytes: 10 })
    expect((entry.yml as unknown as Record<string, unknown>)['custom_key']).toBe('kept')
    await registry.write('m', { ...entry.yml, name: 'Renamed' })
    expect((await registry.read('m')).name).toBe('Renamed')
    expect(((await registry.read('m')) as unknown as Record<string, unknown>)['custom_key']).toBe('kept')
  })

  it('creates the directory for a new nested model', async () => {
    await registry.write('a/b', { model_path: 'llamacpp/models/a/b/model.gguf', name: 'b' })
    expect((await registry.list()).map((e) => e.id)).toEqual(['a/b'])
  })

  it('reports a missing model with the CLI wording and the path it looked at', async () => {
    expect(await registry.find('nope')).toBeUndefined()
    await expect(registry.get('nope')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      message: expect.stringContaining('atomic-chat-cli models list') as unknown as string,
      details: expect.stringContaining(join('nope', 'model.yml')) as unknown as string,
    })
  })
})

describe('resolvePaths', () => {
  it('joins relative paths onto the data folder and leaves absolute ones alone', async () => {
    await data.writeModel('m', { mmproj_path: 'llamacpp/models/m/mmproj.gguf' })
    const entry = await registry.get('m')
    expect(registry.resolvePaths(entry.yml)).toEqual({
      modelPath: join(data.root, 'llamacpp', 'models', 'm', 'model.gguf'),
      mmprojPath: join(data.root, 'llamacpp', 'models', 'm', 'mmproj.gguf'),
    })
    const absolute = process.platform === 'win32' ? 'C:\\models\\x.gguf' : '/models/x.gguf'
    expect(registry.resolvePaths({ model_path: absolute, name: 'x', size_bytes: 0 })).toEqual({
      modelPath: absolute,
      mmprojPath: undefined,
    })
  })
})

describe('remove', () => {
  it('deletes the model directory and refuses an id that climbs out of the models root', async () => {
    await data.writeModel('m')
    await registry.remove('m')
    expect(await registry.list()).toEqual([])
    await expect(registry.remove('../../etc')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(registry.remove('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
