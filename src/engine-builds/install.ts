/**
 * One build onto disk, the same way for both engines (design D3): check the room, download every
 * archive under the caller's task id with `sha256` and `size` checked, unpack into
 * `<target>.incoming-<now>` beside the target, make it runnable and probe it, mark it and write its
 * record, and only then take the target with one rename. A half-unpacked or unverified tree never
 * looks installed: on any failure, a cancel included, the staging directory goes and the builds
 * already installed are untouched.
 *
 * The desktop used to unpack straight into the target, so a failed install left an unmarked tree
 * nobody removed.
 */

import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { ProxyConfig } from '../contracts/index.js'
import { DOWNLOAD_CANCELLED, extractArchive, formatBytes } from '../downloads/index.js'
import type { Downloader } from '../downloads/index.js'
import { HASH_MISMATCH_MESSAGE, VALIDATION_CANCELLED_MESSAGE } from '../downloads/index.js'

/** Archives plus what they unpack to, generously: the CUDA build of sd.cpp unpacks to ~3×. */
export const DISK_SPACE_FACTOR = 3

export interface BuildArchive {
  url: string
  name: string
  sha256: string
  size: number
}

export interface StagedInstall {
  dataFolder: string
  /** `<root>/<tag>/<backend_id>`. */
  target: string
  /** The build first, companions after; all unpack into the same directory. */
  archives: BuildArchive[]
  taskId: string
  proxy?: ProxyConfig | null
  downloader: Pick<Downloader, 'download'>
  /** Free bytes on the volume holding `path`; `undefined` when the platform cannot say. */
  availableSpace: (path: string) => Promise<number | undefined>
  now: () => number
  /** Permissions and the probe; throws `ENGINE_INSTALL_FAILED`. */
  verify: (staging: string) => Promise<void>
  /** The ownership marker and `install.json`. */
  record: (staging: string) => Promise<void>
}

/** `replaced` — the target existed (a forced reinstall) and was swapped for the new tree. */
export async function installStaged(plan: StagedInstall): Promise<{ replaced: boolean }> {
  const needed = plan.archives.reduce((sum, archive) => sum + archive.size, 0) * DISK_SPACE_FACTOR
  const free = await plan.availableSpace(plan.dataFolder).catch(() => undefined)
  if (free !== undefined && free < needed)
    throw new AtomicCoreError(
      'BACKEND_INSUFFICIENT_DISK_SPACE',
      `Not enough free disk space to install the engine: ${formatBytes(needed)} needed, ${formatBytes(free)} free.`
    )

  const stamp = plan.now()
  const staging = `${plan.target}.incoming-${stamp}`
  const downloads = `${staging}.download`
  const cleanup = async () => {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    await rm(downloads, { recursive: true, force: true }).catch(() => {})
  }
  await cleanup()
  try {
    await mkdir(staging, { recursive: true })
    await mkdir(downloads, { recursive: true })
    const items = plan.archives.map((archive) => ({
      url: archive.url,
      save_path: join(downloads, archive.name),
      sha256: archive.sha256,
      size: archive.size,
      ...(plan.proxy ? { proxy: plan.proxy } : {}),
    }))
    await plan.downloader.download(plan.taskId, items).catch((error: unknown) => {
      throw downloadError(error)
    })
    for (const item of items)
      await extractArchive(item.save_path, staging).catch((error: unknown) => {
        throw new AtomicCoreError(
          'ENGINE_INSTALL_FAILED',
          'Could not unpack the engine archive.',
          String(error)
        )
      })
    await rm(downloads, { recursive: true, force: true })
    await plan.verify(staging)
    await plan.record(staging)

    await mkdir(dirname(plan.target), { recursive: true })
    const retired = `${plan.target}.retired-${stamp}`
    let replaced = false
    try {
      await rename(plan.target, retired)
      replaced = true
    } catch {
      // No previous tree: the usual case.
    }
    await rename(staging, plan.target)
    // A session may still hold files of the old tree open (Windows refuses the delete); the next
    // install or start picks the leftovers up.
    if (replaced) await rm(retired, { recursive: true, force: true }).catch(() => {})
    return { replaced }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** The downloader speaks in message strings; the install surface speaks in codes (design D9). */
function downloadError(error: unknown): AtomicCoreError {
  if (error instanceof AtomicCoreError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message === DOWNLOAD_CANCELLED || message === VALIDATION_CANCELLED_MESSAGE)
    return new AtomicCoreError('CANCELLED', 'The engine install was cancelled.')
  if (message === HASH_MISMATCH_MESSAGE || message.startsWith('Size verification failed'))
    return new AtomicCoreError(
      'ENGINE_INSTALL_FAILED',
      'The downloaded engine archive does not match the manifest.',
      message
    )
  return new AtomicCoreError('ENGINE_INSTALL_FAILED', 'Could not download the engine.', message)
}
