/**
 * What makes two listings of a checkpoint's files the same inventory.
 *
 * `RuntimeDescriptor.curated_models[].inventory_digest` (`src/contracts/environment.ts`) pins a
 * curated entry to an exact Hugging Face file listing, not just a repository and revision: a branch
 * name moves, a revision can be re-tagged, and a repository can be re-uploaded with a file added or
 * a shard replaced, so the digest is what a `ModelCompatibility` check (spec `tensorrt-llm-models`)
 * actually compares against a submitted file list to decide `curated: true`.
 *
 * The algorithm has to be byte-for-byte identical with `atomic-chat-conf`'s own
 * `.github/scripts/inventory-digest.mjs`, which computes it the same way to publish a descriptor's
 * `curated_models[].inventory_digest` in the first place (see that repo's README, "Runtime
 * descriptors"). Neither side may drift from the other: a mismatch would mean a curated checkpoint
 * that this core can never recognise as the one the descriptor pinned.
 *
 * Design D12 keeps this to the pure digest only. Fetching a repository's file listing, resolving
 * which storage domain a downloaded artifact lives in and naming the bytes on disk are the
 * app's/CLI's job now, not core's — core never downloads model weights, so there is nothing here
 * about a storage domain, an artifact id or a download plan, unlike the branch this was ported from
 * (`origin/feat/tenzor-rt` @ `632b934`'s `src/models/snapshot-plan.ts`, which combined the digest
 * with exactly that machinery for a design core no longer has).
 */

import { createHash } from 'node:crypto'
import { AtomicCoreError } from '../../contracts/index.js'
import type { Sha256Digest } from '../../contracts/index.js'

/**
 * One file of a checkpoint, as the repository lists it. Every file counts, not only weights: an
 * engine's own file-type selection happens later and is not part of a checkpoint's identity (conf
 * README, "Runtime descriptors").
 */
export interface InventoryFile {
  /** Repository-relative, forward slashes, as Hugging Face spells it. */
  path: string
  bytes: number
  /** The repository's own digest where it publishes one; absent is normal and not an error. */
  sha256?: string
}

const NUL = String.fromCharCode(0)

/**
 * The digest of a file listing: every file's path, size and published digest, in path order.
 *
 * Sorted because a registry may list the same files in any order and that is not a difference.
 * Length-prefixed because `a`+`bc` and `ab`+`c` must not collide.
 */
export function inventoryDigest(files: readonly InventoryFile[]): Sha256Digest {
  if (files.length === 0) {
    throw new AtomicCoreError('MANAGED_METADATA_INVALID', 'A checkpoint with no files is not a checkpoint.')
  }
  const seen = new Set<string>()
  const hash = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const file of sorted) {
    if (file.path === '' || file.path.includes(NUL)) {
      throw new AtomicCoreError(
        'MANAGED_METADATA_INVALID',
        "An artifact's file path cannot be empty.",
        file.path
      )
    }
    if (seen.has(file.path)) {
      throw new AtomicCoreError('MANAGED_METADATA_INVALID', 'The inventory lists a file twice.', file.path)
    }
    seen.add(file.path)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new AtomicCoreError('MANAGED_METADATA_INVALID', 'A file size is not a whole number.', file.path)
    }
    hash.update(`${file.path.length}:${file.path}`)
    hash.update(`|${file.bytes}|`)
    hash.update(file.sha256 ?? '')
    hash.update(NUL)
  }
  return `sha256:${hash.digest('hex')}`
}
