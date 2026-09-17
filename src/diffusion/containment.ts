/**
 * "Is this path really inside that folder?" for everything the diffusion surface deletes or writes
 * on a caller's word: engine trees, model files, gallery images. `is_within` and the
 * `canonicalize_existing_prefix` callers of `install.rs` (app commit `767ff6350`).
 *
 * Both sides are resolved through symlinks as far as they exist first (on Fedora Silverblue `/home`
 * is a link to `/var/home`), then compared component-wise, ignoring case on Windows.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalizeExistingPrefix } from '../downloads/index.js'

const fold = (path: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? path.toLowerCase() : path

/** Lexical containment of two absolute, already-resolved paths. A path is within itself. */
export function isWithin(path: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const rel = relative(fold(resolve(root), platform), fold(resolve(path), platform))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export type Containment = 'inside' | 'root' | 'outside'

/** Where `path` lies relative to `root`, once the existing part of both is resolved through symlinks. */
export async function locate(
  path: string,
  root: string,
  platform: NodeJS.Platform = process.platform
): Promise<Containment> {
  const [resolvedPath, resolvedRoot] = await Promise.all([
    canonicalizeExistingPrefix(path),
    canonicalizeExistingPrefix(root),
  ])
  if (fold(resolvedPath, platform) === fold(resolvedRoot, platform)) return 'root'
  return isWithin(resolvedPath, resolvedRoot, platform) ? 'inside' : 'outside'
}

/** Whether two spellings name the same directory or file. */
export async function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const [left, right] = await Promise.all([canonicalizeExistingPrefix(a), canonicalizeExistingPrefix(b)])
  return fold(left, platform) === fold(right, platform)
}
