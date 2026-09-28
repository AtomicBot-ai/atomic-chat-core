import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { inventoryDigest, type InventoryFile } from './inventory.js'

// `atomic-chat-conf`'s `.github/scripts/inventory-digest.mjs` is a port of this algorithm and
// re-publishes the same test vectors (`inventory-digest.test.mjs`) against its own copy, so the two
// must never drift: a curated `RuntimeDescriptor.curated_models[].inventory_digest` conf publishes
// is only useful if core recomputes the identical value from the same file listing. `coreTestFiles`
// below is conf's own synthetic vector — a small, hand-picked file listing conf made up to exercise
// the algorithm, not the real Hugging Face listing behind any specific `curated_models[]` entry in
// `test/fixtures/runtimes/tensorrt-llm.json` (no per-file listing is checked into either repo; the
// fixture only carries the finished digests). Reusing it here, rather than a listing derived from
// the fixture, is what proves the two implementations agree byte-for-byte on the same input.
const coreTestFiles: InventoryFile[] = [
  { path: 'config.json', bytes: 1_024 },
  { path: 'model-00001-of-00002.safetensors', bytes: 4_250_000_000, sha256: 'aa' },
  { path: 'model-00002-of-00002.safetensors', bytes: 4_250_000_000, sha256: 'bb' },
  { path: 'tokenizer.json', bytes: 17_000 },
]

describe('inventoryDigest', () => {
  it("matches conf's inventory-digest.mjs for its own test inventory", () => {
    expect(inventoryDigest(coreTestFiles)).toBe(
      'sha256:8e362dc849296c338a83624998d58303ad62cf2ed7f47216b9a1746daf59824c'
    )
  })

  it('ignores listing order: a registry may list the same files in any order', () => {
    expect(inventoryDigest([...coreTestFiles].reverse())).toBe(inventoryDigest(coreTestFiles))
  })

  it('length-prefixes paths so a+bc and ab+c cannot collide', () => {
    expect(
      inventoryDigest([
        { path: 'a', bytes: 1 },
        { path: 'bc', bytes: 1 },
      ])
    ).toBe('sha256:0f8574ffdacd2579a64fb1fa155e46de6ae3055e2abaa6be3c17696949d4df67')
    expect(
      inventoryDigest([
        { path: 'ab', bytes: 1 },
        { path: 'c', bytes: 1 },
      ])
    ).toBe('sha256:cd97260fab6815624d1f488cbebb2ef690e38df6ae25a6f73412417660982e57')
  })

  it('sorts by UTF-16 code unit, the same order conf sorts by', () => {
    expect(
      inventoryDigest([
        { path: 'b/é.txt', bytes: 3 },
        { path: 'B.txt', bytes: 0, sha256: '' },
        { path: 'a', bytes: 0 },
      ])
    ).toBe('sha256:1cf7709515b01e406d41ea1a338462764da44bbdde916f5d58e911b7b7edf2ab')
  })

  it('rejects an empty inventory, an empty or repeated path, a NUL byte and a non-integer size', () => {
    expect(() => inventoryDigest([])).toThrow(AtomicCoreError)
    expect(() => inventoryDigest([{ path: '', bytes: 1 }])).toThrow(AtomicCoreError)
    expect(() => inventoryDigest([{ path: 'a', bytes: -1 }])).toThrow(AtomicCoreError)
    expect(() => inventoryDigest([{ path: 'a', bytes: 1.5 }])).toThrow(AtomicCoreError)
    expect(() =>
      inventoryDigest([
        { path: 'a', bytes: 1 },
        { path: 'a', bytes: 1 },
      ])
    ).toThrow(AtomicCoreError)
    expect(() => inventoryDigest([{ path: 'a\u0000b', bytes: 1 }])).toThrow(AtomicCoreError)
  })

  it('folds in the published hash only when the repository publishes one', () => {
    const withHash = inventoryDigest([{ path: 'a', bytes: 1, sha256: 'aa' }])
    const withoutHash = inventoryDigest([{ path: 'a', bytes: 1 }])
    const emptyHash = inventoryDigest([{ path: 'a', bytes: 1, sha256: '' }])
    expect(withHash).not.toBe(withoutHash)
    // An absent published hash and an explicit empty string fold in the same bytes.
    expect(withoutHash).toBe(emptyHash)
  })
})
