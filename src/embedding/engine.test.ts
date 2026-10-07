import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout, llamaServerExeName } from '../config/index.js'
import type { AtomicCoreError } from '../contracts/index.js'
import type { InstalledEnginePack } from '../decision/index.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { EmbeddingEngineResolver } from './engine.js'

let data: TmpDataFolder

const rejection = <T>(p: Promise<unknown>): Promise<T> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as T
  )

beforeEach(async () => {
  data = await makeTmpDataFolder()
})
afterEach(() => data.cleanup())

const pack = (version: string, backend: string): InstalledEnginePack => ({
  version,
  backend,
  path: `/packs/${version}/${backend}/llama-server`,
})

function resolver(
  packs: InstalledEnginePack[],
  mtime: (path: string) => Promise<number | undefined> = async () => 1
) {
  return new EmbeddingEngineResolver({ layout: dataLayout(data.root), listPacks: async () => packs, mtime })
}

describe('EmbeddingEngineResolver', () => {
  it('takes the newest pack at or above the floor, GPU before CPU', async () => {
    const packs = [
      pack('b11443', 'macos-arm64'),
      pack('b11463', 'win-cpu-x64'),
      pack('b11463', 'win-cuda-12.4-x64'),
    ]
    expect(await resolver(packs).resolve('', 11454)).toEqual({
      path: packs[2]!.path,
      version_backend: 'b11463/win-cuda-12.4-x64',
      provider: 'llamacpp-upstream',
    })
    // No floor: any build, still newest first.
    expect((await resolver(packs).resolve('', 0)).version_backend).toBe('b11463/win-cuda-12.4-x64')
  })

  it('names the build to update to when every pack is too old', async () => {
    const error = await rejection<AtomicCoreError>(
      resolver([pack('b11443', 'macos-arm64')]).resolve('', 11454)
    )
    expect(error.code).toBe('EMBEDDING_ENGINE_UNSUPPORTED')
    expect(error.message).toContain('Update llama.cpp to b11454 or newer')
    expect(error.details).toContain('b11443/macos-arm64: older than b11454')
  })

  it('says to install llama.cpp when there is none at all', async () => {
    const error = await rejection<AtomicCoreError>(resolver([]).resolve('', 0))
    expect(error.message).toContain('No llama.cpp build is installed')
    expect(error.details).toContain('no llama.cpp build in')
  })

  it('skips a pack readiness refused until it is forgotten or replaced', async () => {
    let mtime = 1
    const packs = [pack('b11463', 'macos-arm64'), pack('b11454', 'macos-arm64')]
    const r = resolver(packs, async () => mtime)
    await r.reject(packs[0]!.path, 'answered 501')
    expect((await r.resolve('', 11454)).path).toBe(packs[1]!.path)
    await r.reject(packs[1]!.path, 'answered 501')
    const error = await rejection<AtomicCoreError>(r.resolve('', 11454))
    expect(error.message).toContain('was refused at readiness')
    // A replaced file (new mtime) is tried again.
    mtime = 2
    expect((await r.resolve('', 11454)).path).toBe(packs[0]!.path)
    mtime = 1
    r.forgetRejected()
    expect((await r.resolve('', 11454)).path).toBe(packs[0]!.path)
  })

  it('runs an explicit engine path as long as it exists', async () => {
    const r = resolver([], async (path) => (path === '/opt/llama-server' ? 1 : undefined))
    expect(await r.resolve('/opt/llama-server', 11454)).toEqual({
      path: '/opt/llama-server',
      version_backend: null,
      provider: null,
    })
    const error = await rejection<AtomicCoreError>(r.resolve('/gone/llama-server', 0))
    expect(error).toMatchObject({
      code: 'EMBEDDING_ENGINE_UNSUPPORTED',
      details: '/gone/llama-server: no such file',
    })
    await r.reject('/gone/llama-server', 'nothing to remember')
  })

  it('scans the installed upstream packs of the data folder', async () => {
    const layout = dataLayout(data.root)
    const dir = join(
      layout.provider('llamacpp-upstream').backendsDir,
      'b11463',
      'macos-arm64',
      'build',
      'bin'
    )
    await mkdir(dir, { recursive: true })
    const exe = join(dir, llamaServerExeName('darwin'))
    await writeFile(exe, '#!/bin/sh\n')
    await chmod(exe, 0o755)
    const r = new EmbeddingEngineResolver({ layout, platform: 'darwin' })
    expect(await r.resolve('', 11454)).toEqual({
      path: exe,
      version_backend: 'b11463/macos-arm64',
      provider: 'llamacpp-upstream',
    })
  })
})
