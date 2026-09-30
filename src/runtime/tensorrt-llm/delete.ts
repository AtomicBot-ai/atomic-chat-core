/**
 * The files of a deleted `tensorrt-llm` model (task 2.24, design D12a, spec `tensorrt-llm-models`
 * "Модель удаляется через core"): every engine cache of the model, from any descriptor it was ever
 * loaded with, then its own folder. Caches go first: a failure there leaves the model listed, so the
 * deletion can simply be retried, instead of leaving gigabytes of cache no model points at.
 *
 * The caller (`tensorrtLlmModelDeleter` in `src/core/tensorrt-llm.ts`) has already stopped the model
 * with Docker's confirmation and holds its loads off; nothing here asks Docker anything.
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedScopePaths } from '../../config/index.js'
import { engineCacheDirsOf, removeEngineCaches } from '../managed-text/index.js'

export interface DeletedTensorrtLlmModelFiles {
  freedBytes: number
  engineCachesRemoved: number
}

/**
 * Bytes of the regular files under `path`, symlinks not followed, a hard-linked file counted once
 * across one deletion (`seen`). A missing path is 0.
 */
async function bytesUnder(path: string, seen: Set<string>): Promise<number> {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined) return 0
  if (info.isFile()) {
    const inode = `${info.dev}:${info.ino}`
    if (seen.has(inode)) return 0
    seen.add(inode)
    return info.size
  }
  if (!info.isDirectory()) return 0
  const children = await readdir(path).catch(() => [])
  let total = 0
  for (const child of children) total += await bytesUnder(join(path, child), seen)
  return total
}

export async function deleteTensorrtLlmModelFiles(
  paths: ManagedScopePaths,
  model: { id: string; dir: string }
): Promise<DeletedTensorrtLlmModelFiles> {
  const seen = new Set<string>()
  const caches = await engineCacheDirsOf(paths, model.id)
  const sizes = new Map<string, number>()
  for (const dir of caches) sizes.set(dir, await bytesUnder(dir, seen))
  const modelBytes = await bytesUnder(model.dir, seen)

  const removed = await removeEngineCaches(paths, { modelId: model.id })
  await rm(model.dir, { recursive: true, force: true })
  const cacheBytes = removed.reduce((sum, dir) => sum + (sizes.get(dir) ?? 0), 0)
  return { freedBytes: cacheBytes + modelBytes, engineCachesRemoved: removed.length }
}
