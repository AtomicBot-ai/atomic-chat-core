import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeZip } from '../../../../../test/helpers/make-zip.js'
import { ensureMacWebGpu, MAC_WEBGPU } from './store.js'

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-mac-webgpu-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))
function setup(library = Buffer.from('qualified test EP')) {
  const archive = makeZip([{ name: MAC_WEBGPU.fileName, data: library }])
  const pin = {
    ...MAC_WEBGPU,
    archiveSize: archive.length,
    archiveSha256: digest(archive),
    librarySize: library.length,
    librarySha256: digest(library),
  }
  const fetcher = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Response(init?.method === 'HEAD' ? null : archive, {
        headers: { 'content-length': String(archive.length) },
      })
  )
  const options = { runtimeDir: dir, allowDownload: true, fetch: fetcher, pin }
  return { library, archive, fetcher, options }
}

describe('ensureMacWebGpu', () => {
  it('preserves the disk failure tag when the provider cache cannot be created', async () => {
    const { options } = setup()
    await writeFile(join(dir, 'v2.4.0'), 'not a directory')
    await expect(ensureMacWebGpu(options)).rejects.toThrow(/\[disk_io\]/)
  })

  it('installs verified native bytes and reuses the cache offline in a later host', async () => {
    const { library, fetcher, options } = setup()
    const progress = vi.fn()
    const file = await ensureMacWebGpu({ ...options, onProgress: progress })
    expect(await readFile(file)).toEqual(library)
    expect(file).toContain(join('v2.4.0', 'macos-arm64', 'webgpu-ep', '0.2.1'))
    expect(progress).toHaveBeenCalled()
    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error('offline')
    })
    expect(await ensureMacWebGpu({ ...options, allowDownload: false, fetch: offline })).toBe(file)
    expect(offline).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalled()
  })

  it('never downloads during model loading when preparation is missing', async () => {
    const { fetcher, options } = setup()
    await expect(ensureMacWebGpu({ ...options, allowDownload: false })).rejects.toThrow(/prepare.*WebGPU/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not activate an archive with a mismatching digest', async () => {
    const { options } = setup()
    options.pin.archiveSha256 = '0'.repeat(64)
    await expect(ensureMacWebGpu(options)).rejects.toThrow(/Hash verification failed/)
    expect(await readdir(join(dir, 'v2.4.0', 'macos-arm64', 'webgpu-ep', '0.2.1'))).toEqual([])
  })

  it('verifies the extracted library independently of the archive hash', async () => {
    const { options } = setup()
    options.pin.librarySha256 = '0'.repeat(64)
    await expect(ensureMacWebGpu(options)).rejects.toThrow(/Hash verification failed/)
    expect(await readdir(join(dir, 'v2.4.0', 'macos-arm64', 'webgpu-ep', '0.2.1'))).toEqual([])
  })

  it('rejects a tampered cache on load and repairs it only on explicit preparation', async () => {
    const { library, fetcher, options } = setup()
    const file = await ensureMacWebGpu(options)
    await writeFile(file, Buffer.alloc(library.length))
    fetcher.mockClear()
    await expect(ensureMacWebGpu({ ...options, allowDownload: false })).rejects.toThrow(/prepare.*WebGPU/i)
    expect(fetcher).not.toHaveBeenCalled()
    await ensureMacWebGpu(options)
    expect(await readFile(file)).toEqual(library)
    expect(fetcher).toHaveBeenCalled()
  })
})
