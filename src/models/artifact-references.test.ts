import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  ArtifactReferenceStore,
  cacheKeyFor,
  REFERENCES_FILE,
  type ArtifactFs,
} from './artifact-references.js'

const ARTIFACT = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

/** An in-memory disk, with every directory removal recorded so a delete can be seen or not seen. */
class FakeFs implements ArtifactFs {
  files = new Map<string, string>()
  removed: string[] = []

  async readFile(path: string): Promise<string> {
    const text = this.files.get(path)
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return text
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data)
  }
  async rename(from: string, to: string): Promise<void> {
    const text = this.files.get(from)
    if (text === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.set(to, text)
    this.files.delete(from)
  }
  async mkdir(): Promise<string | undefined> {
    return undefined
  }
  async rm(path: string): Promise<void> {
    this.removed.push(path)
    for (const name of [...this.files.keys()]) {
      if (name.startsWith(`${path}/`)) this.files.delete(name)
    }
  }
  async stat(): Promise<unknown> {
    return {}
  }
}

const store = (fs: FakeFs) =>
  new ArtifactReferenceStore({
    artifactsDir: '/data/artifacts',
    artifactDir: (id) => `/data/artifacts/${id}`,
    fs,
  })

describe('who needs a checkpoint', () => {
  it('starts with nobody, which is not the same as not knowing', async () => {
    const fs = new FakeFs()
    const references = await store(fs).read(ARTIFACT)
    expect(references.references).toEqual([])
    expect(references.revision).toBe(0)
  })

  it('keeps the reasons apart rather than counting them', async () => {
    const fs = new FakeFs()
    const s = store(fs)
    await s.add(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    await s.add(ARTIFACT, { kind: 'live', execution_id: 'exec-1' })
    const after = await s.add(ARTIFACT, { kind: 'retained', reason: 'user kept models' })

    expect(after.references.map((reference) => reference.kind)).toEqual(['installation', 'live', 'retained'])
    // Letting go of one claim leaves the others exactly where they were.
    const left = await s.remove(ARTIFACT, { kind: 'live', execution_id: 'exec-1' })
    expect(left.references.map((reference) => reference.kind)).toEqual(['installation', 'retained'])
  })

  it('treats the same claim twice as the same claim', async () => {
    const fs = new FakeFs()
    const s = store(fs)
    const first = await s.add(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    const again = await s.add(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    expect(again.references).toHaveLength(1)
    // Nothing changed, so nothing moved: a delete decided a moment ago is still valid.
    expect(again.revision).toBe(first.revision)
  })

  it('tells two installations apart even when they want the same bytes', async () => {
    const fs = new FakeFs()
    const s = store(fs)
    await s.add(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    const both = await s.add(ARTIFACT, { kind: 'installation', installation_id: 'inst-2' })
    expect(both.references).toHaveLength(2)
  })

  it('keeps the record of one checkpoint out of another\u2019s', async () => {
    const fs = new FakeFs()
    const s = store(fs)
    await s.add(ARTIFACT, { kind: 'live', execution_id: 'exec-1' })
    expect((await s.read(OTHER)).references).toEqual([])
    expect(fs.files.has(`/data/artifacts/${ARTIFACT}/${REFERENCES_FILE}`)).toBe(true)
  })

  it('refuses to guess when the record cannot be read', async () => {
    const fs = new FakeFs()
    fs.files.set(`/data/artifacts/${ARTIFACT}/${REFERENCES_FILE}`, 'not json')
    // An unreadable record is not permission to delete the bytes it describes.
    await expect(store(fs).read(ARTIFACT)).rejects.toThrow(AtomicCoreError)
  })

  it('refuses a record filed under another artifact', async () => {
    const fs = new FakeFs()
    fs.files.set(
      `/data/artifacts/${ARTIFACT}/${REFERENCES_FILE}`,
      JSON.stringify({ schema_version: 1, artifact_id: OTHER, revision: 1, references: [] })
    )
    await expect(store(fs).read(ARTIFACT)).rejects.toThrow(AtomicCoreError)
  })
})

describe('deleting the bytes', () => {
  it('removes them once nothing claims them', async () => {
    const fs = new FakeFs()
    const s = store(fs)
    await s.add(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    const free = await s.remove(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })

    expect(await s.deleteIfUnreferenced(ARTIFACT, free.revision)).toBe('deleted')
    expect(fs.removed).toEqual([`/data/artifacts/${ARTIFACT}`])
  })

  it('refuses while anything still claims them', async () => {
    const fs = new FakeFs()
    const s = store(fs)
    const held = await s.add(ARTIFACT, { kind: 'retained', reason: 'user kept models' })
    expect(await s.deleteIfUnreferenced(ARTIFACT, held.revision)).toBe('still-referenced')
    expect(fs.removed).toEqual([])
  })

  it('cannot delete a checkpoint that was loaded while the caller was deciding', async () => {
    const fs = new FakeFs()
    const s = store(fs)
    await s.add(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    const free = await s.remove(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    expect(free.references).toEqual([])

    // Between deciding and deleting, a session loads the model. The delete was decided on a view
    // that no longer holds, and losing this race would take the weights out from under it.
    await s.add(ARTIFACT, { kind: 'live', execution_id: 'exec-9' })

    expect(await s.deleteIfUnreferenced(ARTIFACT, free.revision)).toBe('changed')
    expect(fs.removed).toEqual([])
    expect((await s.read(ARTIFACT)).references).toHaveLength(1)
  })

  it('refuses a delete decided before a claim was let go, too', async () => {
    const fs = new FakeFs()
    const s = store(fs)
    const claimed = await s.add(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    await s.remove(ARTIFACT, { kind: 'installation', installation_id: 'inst-1' })
    // Stale in the other direction: the answer is still "look again", never "delete anyway".
    expect(await s.deleteIfUnreferenced(ARTIFACT, claimed.revision)).toBe('changed')
    expect(fs.removed).toEqual([])
  })

  it('deletes nothing when the record cannot be read at all', async () => {
    const fs = new FakeFs()
    fs.files.set(`/data/artifacts/${ARTIFACT}/${REFERENCES_FILE}`, '{')
    await expect(store(fs).deleteIfUnreferenced(ARTIFACT, 0)).rejects.toThrow(AtomicCoreError)
    expect(fs.removed).toEqual([])
  })
})

describe('private caches', () => {
  it('belongs to one engine, one release and one checkpoint at a time', () => {
    const key = cacheKeyFor('tensorrt-llm', 'trtllm-1.3.0rc27', ARTIFACT)
    expect(key).toEqual({
      engine_id: 'tensorrt-llm',
      descriptor_id: 'trtllm-1.3.0rc27',
      artifact_id: ARTIFACT,
    })
    // A cache built by another engine, or another release of the same one, is a different cache.
    expect(cacheKeyFor('vllm', 'trtllm-1.3.0rc27', ARTIFACT)).not.toEqual(key)
    expect(cacheKeyFor('tensorrt-llm', 'trtllm-1.4.0', ARTIFACT)).not.toEqual(key)
  })
})
