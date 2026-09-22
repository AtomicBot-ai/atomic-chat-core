/**
 * Who still needs a set of model bytes, and what it takes to delete them.
 *
 * The same checkpoint can be wanted by more than one thing at once: an installed runtime that lists
 * it, a session that has it loaded right now, and a user who asked to keep their models when they
 * removed an engine. Those are different reasons with different lifetimes, so they are recorded
 * separately rather than counted.
 *
 * Deletion is the part that has to be exact. Between "nothing references this" and "the bytes are
 * gone" a model can be loaded, and if those two steps are separate the delete wins a race it should
 * lose and a running session loses its weights mid-answer. So a delete states the revision it was
 * decided on, and is refused if anything has touched the references since. The caller then looks
 * again rather than deleting on a stale answer.
 */

import { AtomicCoreError } from '../contracts/index.js'

/** Why a set of bytes is being kept. */
export type ArtifactReference =
  /** An installed runtime lists this checkpoint. */
  | { kind: 'installation'; installation_id: string }
  /** A session has it loaded now. The strongest claim: these bytes are open. */
  | { kind: 'live'; execution_id: string }
  /** The user chose to keep their models when they removed the engine that used them. */
  | { kind: 'retained'; reason: string }

export interface ArtifactReferences {
  schema_version: 1
  artifact_id: string
  /** Bumped by every change, so a delete decided on an older view is refused. */
  revision: number
  references: ArtifactReference[]
}

/** The slice of `node:fs/promises` this needs; tests pass an in-memory fake. */
export interface ArtifactFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: 'utf8'; mode?: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  stat(path: string): Promise<unknown>
}

export const REFERENCES_FILE = 'references.json'

const key = (reference: ArtifactReference): string => {
  switch (reference.kind) {
    case 'installation':
      return `installation:${reference.installation_id}`
    case 'live':
      return `live:${reference.execution_id}`
    case 'retained':
      return `retained:${reference.reason}`
  }
}

const empty = (artifactId: string): ArtifactReferences => ({
  schema_version: 1,
  artifact_id: artifactId,
  revision: 0,
  references: [],
})

const parse = (text: string, artifactId: string): ArtifactReferences | null => {
  try {
    const raw = JSON.parse(text) as ArtifactReferences
    if (raw?.artifact_id !== artifactId) return null
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) return null
    if (!Array.isArray(raw.references)) return null
    return raw
  } catch {
    return null
  }
}

export interface ArtifactReferenceStoreOptions {
  /** `<data>/atomic-core/managed-runtimes/artifacts`, from `managedScopePaths`. */
  artifactsDir: string
  /** Where one artifact's bytes live, so a delete removes the right directory. */
  artifactDir: (artifactId: string) => string
  fs: ArtifactFs
}

export class ArtifactReferenceStore {
  constructor(private readonly options: ArtifactReferenceStoreOptions) {}

  /** Who needs these bytes. An artifact nobody has claimed yet reads as empty, not as missing. */
  async read(artifactId: string): Promise<ArtifactReferences> {
    const path = this.path(artifactId)
    let text: string
    try {
      text = await this.options.fs.readFile(path, 'utf8')
    } catch {
      return empty(artifactId)
    }
    const parsed = parse(text, artifactId)
    if (parsed !== null) return parsed
    // A record that cannot be read is not permission to delete the bytes it describes.
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      'The record of what needs this checkpoint cannot be read.',
      artifactId
    )
  }

  /** Claim the bytes. Claiming twice for the same reason is the same claim, not a second one. */
  async add(artifactId: string, reference: ArtifactReference): Promise<ArtifactReferences> {
    const current = await this.read(artifactId)
    if (current.references.some((existing) => key(existing) === key(reference))) return current
    return this.write({
      ...current,
      revision: current.revision + 1,
      references: [...current.references, reference],
    })
  }

  /** Let go of one claim. The bytes stay until nothing claims them and somebody asks. */
  async remove(artifactId: string, reference: ArtifactReference): Promise<ArtifactReferences> {
    const current = await this.read(artifactId)
    const remaining = current.references.filter((existing) => key(existing) !== key(reference))
    if (remaining.length === current.references.length) return current
    return this.write({ ...current, revision: current.revision + 1, references: remaining })
  }

  /**
   * Delete the bytes, but only if nothing claims them and nothing has claimed them since the caller
   * looked. Answers what happened rather than throwing: "somebody took it while you were deciding"
   * is an ordinary outcome, and the caller's move is to look again.
   */
  async deleteIfUnreferenced(
    artifactId: string,
    expectedRevision: number
  ): Promise<'deleted' | 'still-referenced' | 'changed'> {
    const current = await this.read(artifactId)
    if (current.revision !== expectedRevision) return 'changed'
    if (current.references.length > 0) return 'still-referenced'
    // Nothing can slip in between this check and the removal, because anything that wanted to would
    // have moved the revision the check just matched.
    await this.options.fs.rm(this.options.artifactDir(artifactId), { recursive: true, force: true })
    return 'deleted'
  }

  private path(artifactId: string): string {
    return `${this.options.artifactDir(artifactId)}/${REFERENCES_FILE}`
  }

  private async write(next: ArtifactReferences): Promise<ArtifactReferences> {
    const dir = this.options.artifactDir(next.artifact_id)
    await this.options.fs.mkdir(dir, { recursive: true })
    const path = this.path(next.artifact_id)
    const tmp = `${path}.tmp`
    await this.options.fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await this.options.fs.rename(tmp, path)
    return next
  }
}

/**
 * What a private cache belongs to. Caches are never shared: a kernel or engine cache built by one
 * release of one engine says nothing about another, and reusing it across them is how a
 * mysteriously broken model happens. The directory itself comes from `managedScopePaths().cacheDir`.
 */
export interface CacheKey {
  engine_id: string
  descriptor_id: string
  artifact_id: string
}

export function cacheKeyFor(engineId: string, descriptorId: string, artifactId: string): CacheKey {
  return { engine_id: engineId, descriptor_id: descriptorId, artifact_id: artifactId }
}
