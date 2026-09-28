import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ensureEngineCacheDir, removeEngineCaches } from './engine-cache.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('engine-cache-')
})
afterEach(async () => {
  await data.cleanup()
})

async function seed(descriptorId: string, modelId: string): Promise<string> {
  const dir = await ensureEngineCacheDir(data.layout.managed, descriptorId, modelId)
  await writeFile(`${dir}/engine.plan`, 'built')
  return dir
}

describe('ensureEngineCacheDir', () => {
  it('creates the per descriptor + model directory and returns the same one every time, contents kept', async () => {
    const first = await seed('trt-r1', 'org/model')
    expect(first).toBe(data.layout.managed.engineCacheDir('trt-r1', 'org/model'))
    const second = await ensureEngineCacheDir(data.layout.managed, 'trt-r1', 'org/model')
    expect(second).toBe(first)
    expect(await readdir(second)).toEqual(['engine.plan'])
  })

  it('keeps two descriptors of one model apart, so a new engine release never reads an old cache', async () => {
    const r1 = await seed('trt-r1', 'm')
    const r2 = await ensureEngineCacheDir(data.layout.managed, 'trt-r2', 'm')
    expect(r2).not.toBe(r1)
    expect(await readdir(r2)).toEqual([])
  })
})

describe('removeEngineCaches', () => {
  it('removes one model across every descriptor, leaving other models alone', async () => {
    const a1 = await seed('trt-r1', 'a')
    const a2 = await seed('trt-r2', 'a')
    const b1 = await seed('trt-r1', 'b')
    const removed = await removeEngineCaches(data.layout.managed, { modelId: 'a' })
    expect(removed.sort()).toEqual([a1, a2].sort())
    expect(existsSync(a1) || existsSync(a2)).toBe(false)
    expect(existsSync(b1)).toBe(true)
  })

  it('removes every model of one descriptor (the installation went away)', async () => {
    const a1 = await seed('trt-r1', 'a')
    const b1 = await seed('trt-r1', 'b')
    const a2 = await seed('trt-r2', 'a')
    expect(await removeEngineCaches(data.layout.managed, { descriptorId: 'trt-r1' })).toEqual([
      data.layout.managed.descriptorCachesDir('trt-r1'),
    ])
    expect(existsSync(a1) || existsSync(b1)).toBe(false)
    expect(existsSync(a2)).toBe(true)
  })

  it('removes exactly one cache when given both', async () => {
    const a1 = await seed('trt-r1', 'a')
    const b1 = await seed('trt-r1', 'b')
    expect(await removeEngineCaches(data.layout.managed, { descriptorId: 'trt-r1', modelId: 'a' })).toEqual([
      a1,
    ])
    expect(existsSync(b1)).toBe(true)
  })

  it('is a no-op when nothing was ever cached', async () => {
    expect(await removeEngineCaches(data.layout.managed, { modelId: 'never' })).toEqual([])
    expect(await removeEngineCaches(data.layout.managed, { descriptorId: 'never' })).toEqual([])
  })

  it('ignores stray files at the descriptor level', async () => {
    await mkdir(data.layout.managed.cachesDir, { recursive: true })
    await writeFile(`${data.layout.managed.cachesDir}/stray`, '')
    const a1 = await seed('trt-r1', 'a')
    expect(await removeEngineCaches(data.layout.managed, { modelId: 'a' })).toEqual([a1])
  })

  it('refuses to remove everything when given neither', async () => {
    await expect(removeEngineCaches(data.layout.managed, {})).rejects.toThrow(AtomicCoreError)
  })
})
