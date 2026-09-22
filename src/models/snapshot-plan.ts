/**
 * What makes two copies of a checkpoint the same bytes, and what it would take to fetch one.
 *
 * A model artifact is identified by four things: the repository, the revision, the inventory of
 * files that revision contains, and the storage domain the bytes live in. The first two are not
 * enough on their own. A branch name moves, a revision can be re-tagged, and a repository can be
 * re-uploaded with a file added or a shard replaced — so two downloads of `main` a month apart are
 * not interchangeable, and treating them as one would serve a user weights they never chose. The
 * inventory is what pins that down.
 *
 * The storage domain is part of it because a file inside the WSL guest and a file on the Windows
 * disk are not the same file even when they hold identical bytes. Deduplicating across them would
 * mean handing the Linux daemon a path only Windows can open.
 *
 * Compatibility is deliberately not here. Whether an engine can load this checkpoint depends on the
 * engine, its release, the card and the settings, and it changes when any of those do; identity
 * does not change at all.
 */

import { createHash } from 'node:crypto'
import { AtomicCoreError } from '../contracts/index.js'
import type { Sha256Digest } from '../contracts/index.js'

/** One file of a checkpoint, as the repository lists it. */
export interface SnapshotFile {
  /** Repository-relative, forward slashes, as Hugging Face spells it. */
  path: string
  bytes: number
  /** The repository's own digest where it publishes one; absent is normal and not an error. */
  sha256?: string
}

/**
 * Where a set of bytes lives. `native` is this scope's own disk; `guest` is the filesystem inside a
 * WSL distribution the core owns. Never the same domain, whatever the paths look like.
 */
export interface StorageDomain {
  kind: 'native' | 'guest'
  /** The scope for a native domain, the distribution for a guest one. */
  id: string
}

export interface ArtifactIdentity {
  repository: string
  revision: string
  inventory_digest: Sha256Digest
  storage_domain: StorageDomain
}

const NUL = String.fromCharCode(0)

const text = (value: string, field: string): string => {
  if (value === '' || value.includes(NUL)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `An artifact's ${field} cannot be empty.`, value)
  }
  return value
}

/**
 * The digest of an inventory: every file's path, size and published digest, in path order.
 *
 * Sorted because a registry may list the same files in any order and that is not a difference.
 * Length-prefixed because `a|bc` and `ab|c` must not collide.
 */
export function inventoryDigest(files: readonly SnapshotFile[]): Sha256Digest {
  if (files.length === 0) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'A checkpoint with no files is not a checkpoint.')
  }
  const seen = new Set<string>()
  const hash = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const file of sorted) {
    text(file.path, 'file path')
    if (seen.has(file.path)) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'The inventory lists a file twice.', file.path)
    }
    seen.add(file.path)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'A file size is not a whole number.', file.path)
    }
    hash.update(`${file.path.length}:${file.path}`)
    hash.update(`|${file.bytes}|`)
    hash.update(file.sha256 ?? '')
    hash.update(NUL)
  }
  return `sha256:${hash.digest('hex')}`
}

/**
 * The directory name a set of bytes gets. Hex, fixed length and case-stable, so it is a legal name
 * on every filesystem and never grows with a repository name — a Hugging Face id plus a revision
 * plus a digest would push a Windows path towards its limit before a single shard is written.
 *
 * The readable identity is not lost: it is written beside the bytes as provenance.
 */
export function artifactId(identity: ArtifactIdentity): string {
  const hash = createHash('sha256')
  for (const part of [
    identity.storage_domain.kind,
    text(identity.storage_domain.id, 'storage domain'),
    text(identity.repository, 'repository'),
    text(identity.revision, 'revision'),
    text(identity.inventory_digest, 'inventory digest'),
  ]) {
    hash.update(part)
    hash.update(NUL)
  }
  return hash.digest('hex')
}

/** Two identities name the same bytes only when all four parts agree. */
export function sameArtifact(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  return artifactId(a) === artifactId(b)
}

/** What provenance is written beside the bytes, so a directory of hashes stays explicable. */
export interface ArtifactProvenance extends ArtifactIdentity {
  schema_version: 1
  artifact_id: string
  files: SnapshotFile[]
  total_bytes: number
}

export interface SnapshotPlan {
  identity: ArtifactIdentity
  artifact_id: string
  files: SnapshotFile[]
  total_bytes: number
  provenance: ArtifactProvenance
}

/**
 * Turn a repository listing into the artifact it would become. Pure: it computes an identity and a
 * size, and downloads nothing.
 */
export function planSnapshot(input: {
  repository: string
  revision: string
  files: readonly SnapshotFile[]
  storage_domain: StorageDomain
}): SnapshotPlan {
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const identity: ArtifactIdentity = {
    repository: text(input.repository, 'repository'),
    revision: text(input.revision, 'revision'),
    inventory_digest: inventoryDigest(files),
    storage_domain: input.storage_domain,
  }
  const id = artifactId(identity)
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  return {
    identity,
    artifact_id: id,
    files,
    total_bytes: total,
    provenance: { schema_version: 1, artifact_id: id, ...identity, files, total_bytes: total },
  }
}
