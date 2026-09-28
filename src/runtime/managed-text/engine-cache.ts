/**
 * The engine cache of a managed text model (spec `tensorrt-llm-runtime`, "Кэш движка ускоряет
 * повторный старт"; design D8): `<data>/atomic-core/managed-runtimes/caches/<descriptor_id>/<model>`,
 * mounted read-write into that model's container and kept between loads, so a second start does not
 * redo the engine's preparation. Keying by `descriptor_id` means a new engine release never reads a
 * cache an older one wrote; removing a model or an installation removes its caches with it.
 *
 * Paths come from `config/paths.ts` (`ManagedScopePaths`), which percent-encodes both ids into one
 * path segment each, so no id can climb out of the cache root.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { encodeManagedId, type ManagedScopePaths } from '../../config/index.js'

/** Creates (if missing) and returns the cache directory for one model under one pinned descriptor. */
export async function ensureEngineCacheDir(
  paths: ManagedScopePaths,
  descriptorId: string,
  modelId: string
): Promise<string> {
  const dir = paths.engineCacheDir(descriptorId, modelId)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Which caches to remove: one model everywhere, one descriptor entirely, or exactly one of each. */
export interface EngineCacheSelector {
  descriptorId?: string
  modelId?: string
}

async function descriptorDirs(cachesDir: string): Promise<string[]> {
  const entries = await readdir(cachesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(cachesDir, entry.name))
}

async function removeIfPresent(path: string): Promise<boolean> {
  const existed = await readdir(path).then(
    () => true,
    () => false
  )
  if (existed) await rm(path, { recursive: true, force: true })
  return existed
}

/**
 * Removes the selected caches and returns the directories it removed. Selecting nothing is refused
 * rather than read as "everything": wiping every cache is never what removing one thing means.
 */
export async function removeEngineCaches(
  paths: ManagedScopePaths,
  selector: EngineCacheSelector
): Promise<string[]> {
  const { descriptorId, modelId } = selector
  if (descriptorId === undefined && modelId === undefined) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Say which engine caches to remove: a model, a descriptor, or both.'
    )
  }
  const targets =
    descriptorId === undefined
      ? (await descriptorDirs(paths.cachesDir)).map((dir) => join(dir, encodeManagedId(modelId as string)))
      : [
          modelId === undefined
            ? paths.descriptorCachesDir(descriptorId)
            : paths.engineCacheDir(descriptorId, modelId),
        ]
  const removed: string[] = []
  for (const target of targets) {
    if (await removeIfPresent(target)) removed.push(target)
  }
  return removed
}
