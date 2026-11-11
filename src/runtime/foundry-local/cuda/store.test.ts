import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeZip } from '../../../../test/helpers/make-zip.js'
import { CudaRuntimeStore } from './store.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-cuda-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

function fixture(files = ['cudart64_12.dll'], badHash = false) {
  const url = 'https://developer.download.nvidia.com/cuda-test.zip'
  const archive = makeZip([
    { name: 'runtime/bin/cudart64_12.dll', data: Buffer.from('DLL') },
    { name: 'runtime/lib/unneeded.lib', data: Buffer.from('SDK') },
    { name: 'runtime/LICENSE', data: Buffer.from('Notice') },
  ])
  const fetcher = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Response(init?.method === 'HEAD' ? null : archive, {
        headers: { 'content-length': String(archive.length) },
      })
  )
  const build = join(root, 'backends', 'v2.4.0', 'win-x64')
  const store = new CudaRuntimeStore({
    runtimeDir: join(root, 'runtime'),
    platform: 'win32',
    fetch: fetcher,
    archives: [
      {
        url,
        size: archive.length,
        sha256: badHash ? '0'.repeat(64) : createHash('sha256').update(archive).digest('hex'),
        files: [
          ...files.map((name) => ({ entry: `runtime/bin/${name}`, name, size: 3 })),
          { entry: 'runtime/LICENSE', name: 'cuda-test.LICENSE', size: 6 },
        ],
      },
    ],
  })
  return { store, build, fetcher }
}

describe('CudaRuntimeStore', () => {
  it.each([
    ['win32', 'v2.4.0', 'win-x64', true],
    ['win32', 'v2.4.0', 'win-arm64', true],
    ['linux', 'v2.4.0', 'linux-x64', true],
    ['linux', 'v2.4.0', 'linux-arm64', true],
    ['linux', 'v2.1.0', 'linux-arm64', false],
    ['linux', 'v2.4.0', 'win-x64', false],
    ['darwin', 'v2.4.0', 'macos-arm64', false],
  ] as const)('scopes CUDA preparation to %s %s/%s', (platform, tag, target, expected) => {
    const store = new CudaRuntimeStore({ runtimeDir: root, platform, fetch })
    expect(store.supports(join(root, 'backends', tag, target))).toBe(expected)
  })

  it('only installs the pinned runtime DLLs and notice, and reuses them offline', async () => {
    const { store, build, fetcher } = fixture()
    expect(await store.cached(build)).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
    const dir = await store.prepare(build, () => {})
    expect(await readFile(join(dir!, 'cudart64_12.dll'), 'utf8')).toBe('DLL')
    expect(await readdir(dir!)).toEqual(['cuda-test.LICENSE', 'cudart64_12.dll'])
    fetcher.mockClear()
    expect(await store.cached(build)).toBe(dir)
    expect(await store.prepare(build, () => {})).toBe(dir)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a mismatching archive hash before publishing DLLs', async () => {
    const { store, build } = fixture(undefined, true)
    await expect(store.prepare(build, () => {})).rejects.toThrow(/hash verification failed/i)
    expect(await store.cached(build)).toBeUndefined()
  })

  it('never publishes an incomplete DLL set', async () => {
    const { store, build } = fixture(['cudart64_12.dll', 'missing.dll'])
    await expect(store.prepare(build, () => {})).rejects.toThrow('missing.dll')
    expect(await store.cached(build)).toBeUndefined()
  })
})
