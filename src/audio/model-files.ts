/**
 * The models the client downloads into `<data>/audio/models` (the core never downloads one: ADR
 * 2026-10-15-core-does-not-download-models): listed recursively without in-flight downloads, and
 * deleted one file at a time by their path relative to that folder. The listing is image generation's.
 */

import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { AudioModelFile } from '../contracts/index.js'
import { listModelFiles, locate } from '../diffusion/index.js'
import { audioError, audioIoError } from './errors.js'

/** Regular files under the models root, recursively, with `/`-separated relative paths. */
export function listAudioModelFiles(modelsRoot: string): Promise<AudioModelFile[]> {
  return listModelFiles(modelsRoot)
}

/** The absolute path of a file named relative to the models root; anything that leaves it is refused. */
export async function audioModelFilePath(
  modelsRoot: string,
  relativePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const segments = relativePath.split(/[\\/]/).filter(Boolean)
  if (relativePath.trim() === '' || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath))
    throw audioError(
      'INVALID_REQUEST',
      'Name the model file relative to the audio models folder.',
      relativePath
    )
  const path = join(modelsRoot, ...segments)
  if ((await locate(path, modelsRoot, platform)) !== 'inside')
    throw audioError('INVALID_REQUEST', 'That file is not in the audio models folder.', relativePath)
  return path
}

const isEmptyDir = (dir: string): Promise<boolean> =>
  readdir(dir).then(
    (names) => names.length === 0,
    () => false
  )

/** Delete one file under the models root, and the folders it leaves empty. A file already gone is not an error. */
export async function deleteAudioModelFile(
  modelsRoot: string,
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const meta = await stat(path).catch(() => undefined)
  if (!meta) return
  if (meta.isDirectory())
    throw audioError('INVALID_REQUEST', 'That path is a folder, not a model file.', path)
  await rm(path).catch((error: unknown) => {
    throw audioIoError('Could not delete the model file.', error)
  })
  // Prune empty folders on the way up, never the root itself.
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if ((await locate(dir, modelsRoot, platform)) !== 'inside' || !(await isEmptyDir(dir))) break
    await rmdir(dir).catch(() => {})
  }
}
