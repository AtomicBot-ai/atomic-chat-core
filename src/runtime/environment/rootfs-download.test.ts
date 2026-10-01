import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadVerifiedRootfs } from './rootfs-download.js'

const BYTES = Buffer.from('a .wsl rootfs, gzip-tar in real life')
const SHA = createHash('sha256').update(BYTES).digest('hex')
const ROOTFS = {
  url: 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl',
  sha256: SHA,
  distribution: { id: 'ubuntu', version_id: '24.04', arch: 'x86_64' as const },
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rootfs-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const serving = (bytes: Buffer) => vi.fn(async () => new Response(bytes, { status: 200 }))
const signal = new AbortController().signal

describe('downloadVerifiedRootfs', () => {
  it('downloads to the destination, creating its folder, and checks sha256 before it is used', async () => {
    const destination = join(dir, 'downloads', `${SHA}.wsl`)
    const fetch = serving(BYTES)
    await downloadVerifiedRootfs(fetch, ROOTFS, destination, signal)
    expect(await readFile(destination)).toEqual(BYTES)
    expect(fetch).toHaveBeenCalledWith(ROOTFS.url, expect.objectContaining({ signal }))
  })

  it('a file that does not match the manifest’s sha256 is deleted, and the download fails', async () => {
    const destination = join(dir, `${SHA}.wsl`)
    await expect(
      downloadVerifiedRootfs(serving(Buffer.from('tampered')), ROOTFS, destination, signal)
    ).rejects.toMatchObject({ code: 'MANAGED_IDENTITY_MISMATCH', details: expect.stringContaining(SHA) })
    expect(existsSync(destination)).toBe(false)
    expect(existsSync(`${destination}.part`)).toBe(false)
  })

  it('reuses a complete earlier download that still matches, without fetching again', async () => {
    const destination = join(dir, `${SHA}.wsl`)
    await writeFile(destination, BYTES)
    const fetch = serving(Buffer.from('never read'))
    await downloadVerifiedRootfs(fetch, ROOTFS, destination, signal)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('an HTTP error is a failed download, nothing left behind', async () => {
    const destination = join(dir, `${SHA}.wsl`)
    const fetch = vi.fn(async () => new Response('gone', { status: 404 }))
    await expect(downloadVerifiedRootfs(fetch, ROOTFS, destination, signal)).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
    expect(existsSync(destination)).toBe(false)
  })
})
