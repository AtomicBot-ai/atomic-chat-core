import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  artifactId,
  inventoryDigest,
  planSnapshot,
  sameArtifact,
  type ArtifactIdentity,
  type SnapshotFile,
  type StorageDomain,
} from './snapshot-plan.js'

const NATIVE: StorageDomain = { kind: 'native', id: 'app' }
const GUEST: StorageDomain = { kind: 'guest', id: 'atomic-app-7f3c' }

const files: SnapshotFile[] = [
  { path: 'config.json', bytes: 1_024 },
  { path: 'model-00001-of-00002.safetensors', bytes: 4_250_000_000, sha256: 'aa' },
  { path: 'model-00002-of-00002.safetensors', bytes: 4_250_000_000, sha256: 'bb' },
  { path: 'tokenizer.json', bytes: 17_000 },
]

const identity = (over: Partial<ArtifactIdentity> = {}): ArtifactIdentity => ({
  repository: 'nvidia/Llama-3.1-8B-Instruct-FP8',
  revision: 'main',
  inventory_digest: inventoryDigest(files),
  storage_domain: NATIVE,
  ...over,
})

describe('what makes two checkpoints the same bytes', () => {
  it('does not care what order the repository listed the files in', () => {
    expect(inventoryDigest([...files].reverse())).toBe(inventoryDigest(files))
  })

  it('separates a revision whose files have changed under it', () => {
    // `main` moves. Two downloads of it a month apart are not interchangeable, and treating them as
    // one would serve a user weights they never chose.
    const later = [...files, { path: 'generation_config.json', bytes: 200 }]
    expect(inventoryDigest(later)).not.toBe(inventoryDigest(files))
    expect(artifactId(identity({ inventory_digest: inventoryDigest(later) }))).not.toBe(
      artifactId(identity())
    )
  })

  it('notices a shard that was replaced rather than added', () => {
    const swapped = files.map((file) =>
      file.path.endsWith('00002.safetensors') ? { ...file, sha256: 'cc' } : file
    )
    expect(inventoryDigest(swapped)).not.toBe(inventoryDigest(files))
  })

  it('notices a shard that changed size even where no digest is published', () => {
    const bigger = files.map((file) => (file.path === 'config.json' ? { ...file, bytes: 2_048 } : file))
    expect(inventoryDigest(bigger)).not.toBe(inventoryDigest(files))
  })

  it('cannot be fooled by a path that runs into the next one', () => {
    // Length-prefixed, so `a` + `bc` and `ab` + `c` are different inventories.
    const left = inventoryDigest([
      { path: 'a', bytes: 1 },
      { path: 'bc', bytes: 1 },
    ])
    const right = inventoryDigest([
      { path: 'ab', bytes: 1 },
      { path: 'c', bytes: 1 },
    ])
    expect(left).not.toBe(right)
  })

  it('keeps the two storage domains apart however identical the bytes are', () => {
    const onDisk = identity({ storage_domain: NATIVE })
    const inGuest = identity({ storage_domain: GUEST })
    // A file in the WSL guest and a file on the Windows disk are not the same file; sharing them
    // would hand the Linux daemon a path only Windows can open.
    expect(sameArtifact(onDisk, inGuest)).toBe(false)
    expect(artifactId(onDisk)).not.toBe(artifactId(inGuest))
    // And two guests are not each other either.
    expect(artifactId(identity({ storage_domain: { kind: 'guest', id: 'atomic-cli-0001' } }))).not.toBe(
      artifactId(inGuest)
    )
  })

  it('separates the repository and the revision, without letting them run together', () => {
    expect(artifactId(identity({ repository: 'a/b', revision: 'c' }))).not.toBe(
      artifactId(identity({ repository: 'a', revision: 'b/c' }))
    )
    expect(artifactId(identity({ revision: 'refs/pr/1' }))).not.toBe(artifactId(identity()))
  })

  it('is the same answer every time for the same identity', () => {
    expect(artifactId(identity())).toBe(artifactId(identity()))
    expect(sameArtifact(identity(), identity())).toBe(true)
  })

  it('gives a name every filesystem accepts and no repository name can lengthen', () => {
    const long = artifactId(identity({ repository: `org/${'x'.repeat(300)}` }))
    expect(long).toMatch(/^[0-9a-f]{64}$/)
    expect(long).toHaveLength(artifactId(identity()).length)
  })

  it('refuses an inventory that is empty, repeated or nonsense', () => {
    expect(() => inventoryDigest([])).toThrow(AtomicCoreError)
    expect(() =>
      inventoryDigest([
        { path: 'a', bytes: 1 },
        { path: 'a', bytes: 2 },
      ])
    ).toThrow(/twice/)
    expect(() => inventoryDigest([{ path: 'a', bytes: -1 }])).toThrow(/whole number/)
    expect(() => inventoryDigest([{ path: 'a', bytes: 1.5 }])).toThrow(AtomicCoreError)
    expect(() => inventoryDigest([{ path: '', bytes: 1 }])).toThrow(AtomicCoreError)
  })

  it('refuses an identity with a part missing', () => {
    expect(() => artifactId(identity({ repository: '' }))).toThrow(AtomicCoreError)
    expect(() => artifactId(identity({ revision: '' }))).toThrow(AtomicCoreError)
    expect(() => artifactId(identity({ storage_domain: { kind: 'native', id: '' } }))).toThrow(
      AtomicCoreError
    )
  })
})

describe('planning one download', () => {
  it('sorts the inventory, totals it, and writes down what it is for later', () => {
    const plan = planSnapshot({
      repository: 'nvidia/Llama-3.1-8B-Instruct-FP8',
      revision: 'main',
      files: [...files].reverse(),
      storage_domain: NATIVE,
    })

    expect(plan.files.map((file) => file.path)).toEqual([
      'config.json',
      'model-00001-of-00002.safetensors',
      'model-00002-of-00002.safetensors',
      'tokenizer.json',
    ])
    expect(plan.total_bytes).toBe(8_500_018_024)
    expect(plan.artifact_id).toBe(artifactId(identity()))
    // The directory is a hash; the provenance beside it is what makes that explicable.
    expect(plan.provenance.repository).toBe('nvidia/Llama-3.1-8B-Instruct-FP8')
    expect(plan.provenance.artifact_id).toBe(plan.artifact_id)
    expect(plan.provenance.files).toEqual(plan.files)
  })

  it('plans nothing at all for a listing that is not a checkpoint', () => {
    expect(() =>
      planSnapshot({ repository: 'a/b', revision: 'main', files: [], storage_domain: NATIVE })
    ).toThrow(AtomicCoreError)
  })
})
