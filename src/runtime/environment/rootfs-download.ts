/**
 * Getting the rootfs Atomic Chat imports as its own WSL distribution (change
 * `add-tensorrt-llm-windows`, task 2.5; spec "Подменённый rootfs"): downloaded from the manifest's
 * HTTPS URL into a `.part` file while its sha256 is computed, and renamed into place only when that
 * matches the manifest — otherwise the file is deleted and the setup fails before anything is imported.
 * A complete earlier download that still matches is reused.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { AtomicCoreError } from '../../contracts/index.js'
import type { WslRootfs } from '../../contracts/index.js'

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

const present = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

export async function downloadVerifiedRootfs(
  fetchImpl: typeof fetch,
  rootfs: WslRootfs,
  destination: string,
  signal: AbortSignal
): Promise<void> {
  if ((await present(destination)) && (await sha256Of(destination)) === rootfs.sha256) return
  await mkdir(dirname(destination), { recursive: true })
  const part = `${destination}.part`
  try {
    const response = await fetchImpl(rootfs.url, { signal, redirect: 'follow' })
    if (!response.ok || response.body === null) {
      throw new AtomicCoreError(
        'IO_ERROR',
        `The distribution image could not be downloaded (HTTP ${response.status}).`,
        rootfs.url
      )
    }
    const hash = createHash('sha256')
    const body = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => hash.update(chunk))
    await pipeline(body, createWriteStream(part), { signal })
    const actual = hash.digest('hex')
    if (actual !== rootfs.sha256) {
      throw new AtomicCoreError(
        'MANAGED_IDENTITY_MISMATCH',
        'The downloaded distribution image does not match the sha256 the environment manifest pins; it was deleted and nothing was imported.',
        `expected ${rootfs.sha256}, got ${actual}`
      )
    }
    await rename(part, destination)
  } catch (error) {
    await rm(part, { force: true })
    await rm(destination, { force: true })
    throw error
  }
}
