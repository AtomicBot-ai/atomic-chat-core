import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeZip } from '../../test/helpers/make-zip.js'
import { extractArchive } from '../downloads/index.js'
import { INSTALL_RECORD, OWNER_MARKER } from '../diffusion/install.js'
import {
  GENIEX_LIBRARY_FILE,
  listGeniexBuilds,
  prepareGeniexTree,
  writeGeniexInstallRecord,
} from './geniex.js'

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

/** What `geniex-sdk-windows-arm64-v0.9.3.zip` holds, shortened (design: "Содержимое SDK-архива Windows"). */
const SDK = 'sdk-windows-arm64'
const WINDOWS_SDK = [
  { name: `${SDK}/lib/geniex.dll`, data: Buffer.from('core') },
  { name: `${SDK}/lib/llama_cpp/geniex_plugin.dll`, data: Buffer.from('plugin') },
  { name: `${SDK}/lib/llama_cpp/ggml-hexagon.dll`, data: Buffer.from('hexagon') },
  { name: `${SDK}/lib/llama_cpp/libggml-htp-v73.so`, data: Buffer.from('htp73') },
  { name: `${SDK}/lib/llama_cpp/libggml-htp.cat`, data: Buffer.from('cat') },
  { name: `${SDK}/lib/llama_cpp/libggml-htp.inf`, data: Buffer.from('inf') },
  { name: `${SDK}/lib/qairt/geniex_plugin.dll`, data: Buffer.from('qairt') },
  { name: `${SDK}/lib/qairt/htp-files/libQnnHtpV73Skel.so`, data: Buffer.from('skel') },
  { name: `${SDK}/bin/geniex-bench.exe`, data: Buffer.from('bench') },
  { name: `${SDK}/include/geniex.h`, data: Buffer.from('header') },
  { name: `${SDK}/README.md`, data: Buffer.from('readme') },
]

async function unpacked(entries: typeof WINDOWS_SDK): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-geniex-'))
  await writeFile(join(dir, 'sdk.zip'), makeZip(entries))
  const staging = join(dir, 'staging')
  await extractArchive(join(dir, 'sdk.zip'), staging)
  return staging
}

describe('prepareGeniexTree (task 4.2)', () => {
  it('keeps lib/** of the SDK without its top folder: the library, both plugins, QAIRT and the signed HTP files', async () => {
    const staging = await unpacked(WINDOWS_SDK)
    await prepareGeniexTree(staging)
    expect(await files(staging)).toEqual([
      'lib/geniex.dll',
      'lib/llama_cpp/geniex_plugin.dll',
      'lib/llama_cpp/ggml-hexagon.dll',
      'lib/llama_cpp/libggml-htp-v73.so',
      'lib/llama_cpp/libggml-htp.cat',
      'lib/llama_cpp/libggml-htp.inf',
      'lib/qairt/geniex_plugin.dll',
      'lib/qairt/htp-files/libQnnHtpV73Skel.so',
    ])
    expect(await readFile(join(staging, 'lib', 'qairt', 'htp-files', 'libQnnHtpV73Skel.so'), 'utf8')).toBe(
      'skel'
    )
    expect(GENIEX_LIBRARY_FILE).toBe('geniex.dll')
  })

  it('takes a zip whose lib/ is already at the root, and refuses one without geniex.dll', async () => {
    const flat = await unpacked([
      { name: 'lib/geniex.dll', data: Buffer.from('core') },
      { name: 'bin/geniex-bench.exe', data: Buffer.from('bench') },
    ])
    await prepareGeniexTree(flat)
    expect(await files(flat)).toEqual(['lib/geniex.dll'])

    const none = await unpacked([{ name: `${SDK}/bin/geniex-bench.exe`, data: Buffer.from('bench') }])
    await expect(prepareGeniexTree(none)).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED' })
  })

  it('never lets a zip write outside the staging folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-geniex-slip-'))
    await writeFile(
      join(dir, 'sdk.zip'),
      makeZip([
        { name: `${SDK}/lib/geniex.dll`, data: Buffer.from('core') },
        { name: `${SDK}/lib/../../evil.dll`, data: Buffer.from('evil') },
      ])
    )
    await expect(extractArchive(join(dir, 'sdk.zip'), join(dir, 'staging'))).rejects.toThrow(
      /Invalid zip entry path/
    )
    expect(await files(dir)).toEqual(['sdk.zip', 'staging/sdk-windows-arm64/lib/geniex.dll'])
  })
})

describe('GenieX install records', () => {
  it('lists marked builds with a record and the library, newest install first, with their ABI and devices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-geniex-root-'))
    const make = async (
      version: string,
      installedAtMs: number,
      abi: number | null,
      devices: string[],
      library = true
    ) => {
      const dir = join(root, version, 'win-arm64')
      await mkdir(join(dir, 'lib'), { recursive: true })
      if (library) await writeFile(join(dir, 'lib', 'geniex.dll'), 'dll')
      await writeGeniexInstallRecord(dir, {
        tag: version,
        backendId: 'win-arm64',
        sha256: 'e'.repeat(64),
        installedAtMs,
        publishedAt: '2026-10-19T23:09:06Z',
        abi,
        libraryVersion: version,
        devices,
      })
      return dir
    }
    const older = await make('0.9.2', 1, 1, ['CPU'])
    const newer = await make('0.9.3', 2, 1, ['HTP0', 'GPUOpenCL', 'CPU'])
    await make('0.9.4', 3, 1, [], false)
    const unmarked = join(root, '0.9.1', 'win-arm64')
    await mkdir(join(unmarked, 'lib'), { recursive: true })
    await writeFile(join(unmarked, 'lib', 'geniex.dll'), 'dll')
    expect(await readFile(join(newer, OWNER_MARKER), 'utf8')).toBe('atomic-chat\n')
    expect(JSON.parse(await readFile(join(newer, INSTALL_RECORD), 'utf8'))).toEqual({
      tag: '0.9.3',
      backendId: 'win-arm64',
      sha256: 'e'.repeat(64),
      installedAtMs: 2,
      publishedAt: '2026-10-19T23:09:06Z',
      abi: 1,
      libraryVersion: '0.9.3',
      devices: ['HTP0', 'GPUOpenCL', 'CPU'],
    })
    const builds = await listGeniexBuilds(root)
    expect(builds.map((build) => [build.tag, build.dir, build.abi, build.devices])).toEqual([
      ['0.9.3', newer, 1, ['HTP0', 'GPUOpenCL', 'CPU']],
      ['0.9.2', older, 1, ['CPU']],
    ])
    // A record written by hand without devices (or with junk in them) still lists, with none known.
    await writeFile(
      join(older, INSTALL_RECORD),
      JSON.stringify({ tag: '0.9.2', backendId: 'win-arm64', installedAtMs: 1, devices: 'HTP0' })
    )
    expect((await listGeniexBuilds(root)).find((build) => build.tag === '0.9.2')).toMatchObject({
      devices: [],
      libraryVersion: null,
      abi: null,
    })
  })
})
