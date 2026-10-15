import { lstat, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listFoundryLocalBuilds,
  prepareFoundryLocalTree,
  writeFoundryLocalInstallRecord,
} from './foundry-local.js'

const POSIX = process.platform !== 'win32'
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-foundry-local-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function tree(root: string, files: string[]): Promise<void> {
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), file)
  }
}

describe.skipIf(!POSIX)('prepareFoundryLocalTree', () => {
  it('removes debug symbols at any depth and adds the ONNX Runtime soname on Linux', async () => {
    await tree(dir, [
      'lib/libfoundry_local.so',
      'lib/libfoundry_local.so.dbg',
      'lib/libonnxruntime.so',
      'lib/foundry_local.pdb',
      'lib/libfoundry_local.dylib.dSYM/Contents/Resources/DWARF/libfoundry_local.dylib',
      'include/foundry_local/foundry_local_c.h',
    ])
    await prepareFoundryLocalTree(dir, 'linux')
    expect((await readdir(join(dir, 'lib'))).sort()).toEqual([
      'libfoundry_local.so',
      'libonnxruntime.so',
      'libonnxruntime.so.1',
    ])
    expect((await lstat(join(dir, 'lib', 'libonnxruntime.so.1'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(dir, 'lib', 'libonnxruntime.so.1'))).toBe('libonnxruntime.so')
    expect(await readdir(join(dir, 'include', 'foundry_local'))).toEqual(['foundry_local_c.h'])
  })

  it('adds no soname on macOS or Windows, and none when the library is absent', async () => {
    await tree(dir, ['lib/libonnxruntime.so', 'lib/libonnxruntime.1.dylib'])
    await prepareFoundryLocalTree(dir, 'darwin')
    expect(await readdir(join(dir, 'lib'))).not.toContain('libonnxruntime.so.1')
    const empty = join(dir, 'empty')
    await tree(empty, ['lib/libfoundry_local.so'])
    await prepareFoundryLocalTree(empty, 'linux')
    expect(await readdir(join(empty, 'lib'))).toEqual(['libfoundry_local.so'])
  })
})

describe('listFoundryLocalBuilds', () => {
  it('lists marked builds with their record, newest install first, and skips unmarked or broken ones', async () => {
    const record = (tag: string, installedAtMs: number) => ({
      tag,
      backendId: 'linux-x64',
      sha256: 'a'.repeat(64),
      installedAtMs,
      publishedAt: '2026-09-30T00:43:42Z',
      cApiVersion: 2,
    })
    for (const [tag, at] of [
      ['v2.0.0', 10],
      ['v2.1.0', 20],
    ] as const) {
      await mkdir(join(dir, tag, 'linux-x64'), { recursive: true })
      await writeFoundryLocalInstallRecord(join(dir, tag, 'linux-x64'), record(tag, at))
    }
    await mkdir(join(dir, 'v9.0.0', 'linux-x64'), { recursive: true })
    await writeFile(join(dir, 'v9.0.0', 'linux-x64', 'install.json'), JSON.stringify(record('v9.0.0', 30)))
    await mkdir(join(dir, 'v8.0.0', 'linux-x64'), { recursive: true })
    await writeFile(join(dir, 'v8.0.0', 'linux-x64', '.atomic-owned'), '')
    await writeFile(join(dir, 'v8.0.0', 'linux-x64', 'install.json'), '{broken')

    const builds = await listFoundryLocalBuilds(dir)
    expect(builds.map((build) => build.tag)).toEqual(['v2.1.0', 'v2.0.0'])
    expect(builds[0]).toEqual({ ...record('v2.1.0', 20), dir: join(dir, 'v2.1.0', 'linux-x64') })
    expect(await listFoundryLocalBuilds(join(dir, 'missing'))).toEqual([])
  })
})
