import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import {
  backendPackDir,
  discoverBackendBinary,
  orderVersionDirs,
  resolveBackendExe,
  scanInstalledBackends,
  versionBackendFromBinPath,
} from './scan.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-scan-')
})
afterEach(() => data.cleanup())

describe('orderVersionDirs', () => {
  it('ranks by build number, not lexically, and sorts unparseable names last', () => {
    expect(orderVersionDirs(['b9000', 'b10018-1.3.0', 'b6325'])).toEqual(['b10018-1.3.0', 'b9000', 'b6325'])
    expect(orderVersionDirs(['turboquant-abc', 'b1', 'turboquant-zzz'])).toEqual([
      'b1',
      'turboquant-zzz',
      'turboquant-abc',
    ])
    expect(orderVersionDirs([])).toEqual([])
  })
})

describe('discoverBackendBinary', () => {
  it('returns nothing when no backend is installed', async () => {
    expect(await discoverBackendBinary(data.layout)).toBeUndefined()
  })

  it('picks the newest build, then the first backend by name, and reports its version_backend', async () => {
    await data.writeBackend('llamacpp-upstream', 'b9000', 'macos-arm64')
    await data.writeBackend('llamacpp-upstream', 'b10018-1.3.0', 'win-vulkan-x64')
    await data.writeBackend('llamacpp-upstream', 'b10018-1.3.0', 'macos-arm64')
    const found = await discoverBackendBinary(data.layout)
    expect(found).toMatchObject({
      version: 'b10018-1.3.0',
      backend: 'macos-arm64',
      version_backend: 'b10018-1.3.0/macos-arm64',
    })
    expect(found?.path).toContain(join('b10018-1.3.0', 'macos-arm64', 'build', 'bin'))
  })

  it('falls back to a flat executable and ignores a pack directory with no executable at all', async () => {
    await mkdir(join(data.layout.provider('llamacpp-upstream').backendsDir, 'b5000', 'empty'), {
      recursive: true,
    })
    const flatDir = join(data.layout.provider('llamacpp-upstream').backendsDir, 'b4000', 'linux-cpu-x64')
    await mkdir(flatDir, { recursive: true })
    await writeFile(join(flatDir, 'llama-server'), '#!/bin/sh\n')
    const found = await discoverBackendBinary(data.layout, 'llamacpp-upstream', 'linux')
    expect(found?.version_backend).toBe('b4000/linux-cpu-x64')
    expect(found?.path.endsWith(join('linux-cpu-x64', 'llama-server'))).toBe(true)
  })

  it('looks under the provider it was asked about', async () => {
    await data.writeBackend('llamacpp', 'b7000', 'macos-arm64')
    expect(await discoverBackendBinary(data.layout, 'llamacpp-upstream')).toBeUndefined()
    expect((await discoverBackendBinary(data.layout, 'llamacpp'))?.version).toBe('b7000')
  })
})

describe('scanInstalledBackends', () => {
  it('lists only packs that carry an executable and stamps each with its install time', async () => {
    await data.writeBackend('llamacpp-upstream', 'b1', 'macos-arm64')
    await new Promise((r) => setTimeout(r, 1100)) // mtime has one-second resolution
    await data.writeBackend('llamacpp-upstream', 'b2', 'macos-arm64')
    await mkdir(join(data.layout.provider('llamacpp-upstream').backendsDir, 'b3', 'no-exe'), {
      recursive: true,
    })
    const found = await scanInstalledBackends(data.layout, 'llamacpp-upstream')
    expect(found.map((b) => `${b.version}/${b.backend}`).sort()).toEqual(['b1/macos-arm64', 'b2/macos-arm64'])
    const byVersion = new Map(found.map((b) => [b.version, b.order ?? 0]))
    expect(byVersion.get('b2')).toBeGreaterThan(byVersion.get('b1') as number)
  })

  it('is empty for a data folder with no backends directory', async () => {
    expect(await scanInstalledBackends(data.layout, 'mlx')).toEqual([])
  })
})

describe('resolveBackendExe and path helpers', () => {
  it('finds an installed pack, misses an absent one and tolerates a BOM in the ids', async () => {
    const exe = await data.writeBackend('llamacpp-upstream', 'b1', 'macos-arm64')
    expect(await resolveBackendExe(data.layout, 'llamacpp-upstream', 'b1', 'macos-arm64')).toBe(exe)
    expect(await resolveBackendExe(data.layout, 'llamacpp-upstream', '\uFEFFb1', 'macos-arm64 ')).toBe(exe)
    expect(await resolveBackendExe(data.layout, 'llamacpp-upstream', 'b2', 'macos-arm64')).toBeUndefined()
    expect(backendPackDir(data.layout, 'llamacpp-upstream', 'b1', 'macos-arm64')).toBe(
      join(data.layout.provider('llamacpp-upstream').backendsDir, 'b1', 'macos-arm64')
    )
  })

  it('recovers the tag from a standard --bin path and refuses to guess elsewhere', () => {
    expect(
      versionBackendFromBinPath('/d/llamacpp-upstream/backends/b1/macos-arm64/build/bin/llama-server')
    ).toBe('b1/macos-arm64')
    expect(versionBackendFromBinPath('C:\\d\\backends\\b1\\win-cpu-x64\\llama-server.exe')).toBe(
      'b1/win-cpu-x64'
    )
    expect(versionBackendFromBinPath('/usr/local/bin/llama-server')).toBeUndefined()
    expect(versionBackendFromBinPath('/d/backends/b1')).toBeUndefined()
    expect(versionBackendFromBinPath('')).toBeUndefined()
  })
})
