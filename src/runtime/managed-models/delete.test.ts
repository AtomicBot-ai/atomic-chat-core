import { existsSync } from 'node:fs'
import { link, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { deleteManagedModelFiles } from './delete.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('trt-delete-')
})
afterEach(async () => {
  await data.cleanup()
})

const modelDir = (id: string) => join(data.layout.provider('tensorrt-llm').modelsDir, ...id.split('/'))

async function writeModel(id: string, bytes: number): Promise<string> {
  const dir = modelDir(id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(bytes))
  return dir
}

async function writeCache(descriptorId: string, id: string, bytes: number): Promise<string> {
  const dir = data.layout.managed.engineCacheDir(descriptorId, id)
  await mkdir(join(dir, 'home', '.cache'), { recursive: true })
  await writeFile(join(dir, 'home', '.cache', 'engine.bin'), Buffer.alloc(bytes))
  return dir
}

describe('deleteManagedModelFiles', () => {
  it('removes the model folder and its caches under every descriptor, and counts the bytes it freed', async () => {
    const dir = await writeModel('acme/m', 1000)
    const r1 = await writeCache('trt-r1', 'acme/m', 300)
    const r2 = await writeCache('trt-r2', 'acme/m', 200)
    const other = await writeCache('trt-r1', 'acme/other', 50)

    expect(await deleteManagedModelFiles(data.layout.managed, { id: 'acme/m', dir })).toEqual({
      freedBytes: 1500,
      engineCachesRemoved: 2,
    })
    expect([existsSync(dir), existsSync(r1), existsSync(r2)]).toEqual([false, false, false])
    expect(existsSync(other)).toBe(true)
  })

  it('counts a hard-linked file once and never follows a symlink out of the folder', async () => {
    const dir = await writeModel('acme/m', 1000)
    await link(join(dir, 'model.safetensors'), join(dir, 'same-inode.safetensors'))
    const outside = join(data.root, 'outside.bin')
    await writeFile(outside, Buffer.alloc(5000))
    await symlink(outside, join(dir, 'link.bin'))

    const freed = await deleteManagedModelFiles(data.layout.managed, { id: 'acme/m', dir })
    expect(freed).toEqual({ freedBytes: 1000, engineCachesRemoved: 0 })
    expect(existsSync(dir)).toBe(false)
    // The symlink went with the folder; what it pointed at did not.
    expect(existsSync(outside)).toBe(true)
  })

  it('answers zero for a folder already gone', async () => {
    expect(
      await deleteManagedModelFiles(data.layout.managed, { id: 'acme/m', dir: modelDir('acme/m') })
    ).toEqual({ freedBytes: 0, engineCachesRemoved: 0 })
  })
})

describe('deleteManagedModelFiles with file operations of its own (Windows, change add-tensorrt-llm-windows)', () => {
  it('sizes the caches and the model in one go and removes them in one go, caches first in the list', async () => {
    const dir = await writeModel('acme/m', 1000)
    const r1 = await writeCache('trt-r1', 'acme/m', 300)
    const calls: string[][] = []
    const freed = await deleteManagedModelFiles(
      data.layout.managed,
      { id: 'acme/m', dir },
      {
        sizes: async (paths) => {
          calls.push(['sizes', ...paths])
          return new Map(paths.map((path) => [path, path === dir ? 1000 : 300]))
        },
        remove: async (paths) => {
          calls.push(['remove', ...paths])
        },
      }
    )
    expect(freed).toEqual({ freedBytes: 1300, engineCachesRemoved: 1 })
    expect(calls).toEqual([
      ['sizes', r1, dir],
      ['remove', r1, dir],
    ])
  })
})
