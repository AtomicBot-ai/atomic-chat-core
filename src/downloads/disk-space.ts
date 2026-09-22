/**
 * How much room is left where a download would land. The app asks before it starts an engine or a
 * model download, to refuse one that cannot fit instead of failing it half way.
 *
 * Replaces the llama.cpp plugin's `available_disk_space`, which the core migration removed. Unlike
 * that command this one answers for the data folder only: the core has no business probing arbitrary
 * volumes on behalf of a caller, and every current caller asks about a path under `<data>`.
 */

import { isAbsolute, relative } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import { canonicalizeExistingPrefix, defaultAvailableSpace } from './downloader.js'

export interface DiskSpaceDeps {
  /** Free bytes on the volume holding `path`, or `undefined` when unknown. */
  availableSpace?: (path: string) => Promise<number | undefined>
}

/**
 * Free bytes on the volume that holds `path` (or the data folder, when no path is given); `null`
 * when the platform cannot say. The path need not exist yet — a download target usually does not —
 * but it has to resolve inside the data folder once symlinks in its existing part are followed.
 */
export async function availableDiskSpace(
  dataFolder: string,
  path: unknown,
  deps: DiskSpaceDeps = {}
): Promise<number | null> {
  const probe = deps.availableSpace ?? defaultAvailableSpace
  const root = await canonicalizeExistingPrefix(dataFolder)
  let target = root
  if (path !== undefined && path !== null) {
    if (typeof path !== 'string' || path === '' || path.includes('\0') || !isAbsolute(path))
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Disk space needs an absolute path.')
    target = await canonicalizeExistingPrefix(path)
    const rel = relative(root, target)
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        'Disk space is only reported inside the data folder.',
        `${path} is outside ${dataFolder}`
      )
  }
  const bytes = await probe(target)
  return bytes === undefined ? null : bytes
}
