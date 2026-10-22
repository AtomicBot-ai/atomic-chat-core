import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeZip } from '../../test/helpers/make-zip.js'
import { extractArchive } from '../downloads/index.js'
import { INSTALL_RECORD, OWNER_MARKER } from '../diffusion/install.js'
import {
  listLiteRtLmBuilds,
  liteRtLmLibraryFile,
  prepareLiteRtLmTree,
  writeLiteRtLmInstallRecord,
} from './litert-lm.js'

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else out.push(relative(dir, path).split('\\').join('/'))
    }
  }
  await walk(dir)
  return out.sort()
}

/** What `litert_lm_api-0.18.1-py3-none-win_amd64.whl` holds, shortened. */
const WINDOWS_WHEEL = [
  { name: 'litert_lm/__init__.py', data: Buffer.from('py') },
  { name: 'litert_lm/_ffi.py', data: Buffer.from('py') },
  { name: 'litert_lm/litert-lm.dll', data: Buffer.from('dll'), mode: 0o777 },
  { name: 'litert_lm/dxcompiler.dll', data: Buffer.from('dxc'), mode: 0o777 },
  { name: 'litert_lm/dxil.dll', data: Buffer.from('dxil'), mode: 0o777 },
  {
    name: 'litert_lm/vendors/intel_openvino/dispatch/LiteRtDispatch.dll',
    data: Buffer.from('dispatch'),
    mode: 0o777,
  },
  { name: 'litert_lm_api-0.18.1.dist-info/RECORD', data: Buffer.from('record') },
  { name: 'litert_lm_api-0.18.1.dist-info/METADATA', data: Buffer.from('meta') },
]

async function unpacked(entries: typeof WINDOWS_WHEEL): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-litert-'))
  await writeFile(join(dir, 'w.whl'), makeZip(entries))
  const staging = join(dir, 'staging')
  await extractArchive(join(dir, 'w.whl'), staging)
  return staging
}

describe('prepareLiteRtLmTree', () => {
  it('keeps only the native files of litert_lm/, vendors included, under lib/', async () => {
    const staging = await unpacked(WINDOWS_WHEEL)
    await prepareLiteRtLmTree(staging)
    expect(await files(staging)).toEqual([
      'lib/dxcompiler.dll',
      'lib/dxil.dll',
      'lib/litert-lm.dll',
      'lib/vendors/intel_openvino/dispatch/LiteRtDispatch.dll',
    ])
    expect(await readFile(join(staging, 'lib/litert-lm.dll'), 'utf8')).toBe('dll')
  })

  it('takes the library of macOS and Linux and drops the world-writable mode wheels carry', async () => {
    const staging = await unpacked([
      { name: 'litert_lm/liblitert-lm.so', data: Buffer.from('so'), mode: 0o777 },
      { name: 'litert_lm/engine.py', data: Buffer.from('py') },
      { name: 'litert_lm/liblitert-lm.dylib', data: Buffer.from('dylib'), mode: 0o777 },
    ])
    await prepareLiteRtLmTree(staging)
    expect(await files(staging)).toEqual(['lib/liblitert-lm.dylib', 'lib/liblitert-lm.so'])
    if (process.platform !== 'win32')
      expect((await stat(join(staging, 'lib/liblitert-lm.so'))).mode & 0o777).toBe(0o755)
  })

  it('refuses a wheel without a LiteRT-LM library', async () => {
    const staging = await unpacked([{ name: 'litert_lm/__init__.py', data: Buffer.from('py') }])
    await expect(prepareLiteRtLmTree(staging)).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED' })
  })
})

describe('liteRtLmLibraryFile', () => {
  it('names the library of each system', () => {
    expect(liteRtLmLibraryFile('darwin')).toBe('liblitert-lm.dylib')
    expect(liteRtLmLibraryFile('linux')).toBe('liblitert-lm.so')
    expect(liteRtLmLibraryFile('win32')).toBe('litert-lm.dll')
    expect(liteRtLmLibraryFile('freebsd')).toBeNull()
  })
})

describe('LiteRT-LM install records', () => {
  it('lists marked builds with a record and a library, newest install first, with their ABI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-litert-root-'))
    const make = async (version: string, installedAtMs: number, abi: number | null, library = true) => {
      const dir = join(root, version, 'macos-arm64')
      await mkdir(join(dir, 'lib'), { recursive: true })
      if (library) await writeFile(join(dir, 'lib', 'liblitert-lm.dylib'), 'dylib')
      await writeLiteRtLmInstallRecord(dir, {
        tag: version,
        backendId: 'macos-arm64',
        sha256: 'e'.repeat(64),
        installedAtMs,
        publishedAt: '2026-10-19T22:44:33Z',
        abi,
      })
      return dir
    }
    const older = await make('0.17.0', 1, 1)
    const newer = await make('0.18.1', 2, 1)
    await make('0.18.2', 3, 1, false)
    const unmarked = join(root, '0.16.0', 'macos-arm64')
    await mkdir(join(unmarked, 'lib'), { recursive: true })
    await writeFile(join(unmarked, 'lib', 'liblitert-lm.dylib'), 'dylib')
    expect(await readFile(join(newer, OWNER_MARKER), 'utf8')).toBe('atomic-chat\n')
    expect(JSON.parse(await readFile(join(newer, INSTALL_RECORD), 'utf8'))).toEqual({
      tag: '0.18.1',
      backendId: 'macos-arm64',
      sha256: 'e'.repeat(64),
      installedAtMs: 2,
      publishedAt: '2026-10-19T22:44:33Z',
      abi: 1,
    })
    const builds = await listLiteRtLmBuilds(root)
    expect(builds.map((build) => [build.tag, build.dir, build.abi])).toEqual([
      ['0.18.1', newer, 1],
      ['0.17.0', older, 1],
    ])
  })
})
