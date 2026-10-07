import { describe, expect, it } from 'vitest'
import { findPrismModelRule, findPrismProjector, parsePrismModelRules } from './rules.js'

const SHA = (c: string) => c.repeat(64)
const REV = 'a'.repeat(40)
const doc = {
  schema_version: 1,
  updated_at: '2026-10-05T00:00:00Z',
  rules_version: 3,
  tensor_types: { '41': 'q1_0', '42': 'q2_0', '142': 'pq2_0', '999': 'telepathy', 'x': 'q1_0' },
  metadata_capabilities: { 'prism.hadamard.version': 'hadamard', 'bad.key': 'nope' },
  upstream_capabilities: ['q1_0', 'q2_0_g64', 'nope'],
  families: [
    {
      id: 'bonsai',
      title: 'Bonsai',
      repo: 'prism-ml/Bonsai-gguf',
      revision: REV,
      featured: true,
      sampling: { temperature: 1, top_k: 20, junk: 'x' },
      default_ctx: 16384,
      files: [
        {
          file: 'Bonsai-PQ2_0.gguf',
          size: 10,
          sha256: SHA('1'),
          treatment: 'prism_required',
          requires: ['pq2_0', 'bogus'],
          min_prism_build: 10754,
          default: true,
        },
        {
          file: 'Bonsai-Q2_0.gguf',
          size: 10,
          sha256: SHA('2'),
          treatment: 'legacy',
          replacement: 'Bonsai-PQ2_0.gguf',
        },
        { file: 'broken.gguf', size: 0, sha256: SHA('3'), treatment: 'any' },
        { file: 'weird.gguf', size: 1, sha256: SHA('4'), treatment: 'maybe' },
      ],
      projectors: [{ file: 'Bonsai-mmproj.gguf', size: 5, sha256: SHA('9'), default: true }, { file: 'x' }],
    },
    { id: 'empty', title: 'E', repo: 'a/b', revision: REV, files: [] },
    {
      id: 'badrev',
      title: 'E',
      repo: 'a/b',
      revision: 'main',
      files: [{ file: 'a.gguf', size: 1, sha256: SHA('5'), treatment: 'any' }],
    },
  ],
}

describe('parsePrismModelRules', () => {
  it('keeps valid entries and drops malformed ones', () => {
    const rules = parsePrismModelRules(doc)
    expect(rules?.rules_version).toBe(3)
    expect(rules?.tensor_types).toEqual({ '41': 'q1_0', '42': 'q2_0', '142': 'pq2_0' })
    expect(rules?.metadata_capabilities).toEqual({ 'prism.hadamard.version': 'hadamard' })
    expect(rules?.upstream_capabilities).toEqual(['q1_0', 'q2_0_g64'])
    expect(rules?.families.map((f) => f.id)).toEqual(['bonsai'])
    const family = rules?.families[0]
    expect(family?.files.map((f) => f.file)).toEqual(['Bonsai-PQ2_0.gguf', 'Bonsai-Q2_0.gguf'])
    expect(family?.files[0]?.requires).toEqual(['pq2_0'])
    expect(family?.sampling).toEqual({ temperature: 1, top_k: 20 })
    expect(family?.projectors).toHaveLength(1)
  })
  it.each([
    ['not an object', null],
    ['a newer schema', { ...doc, schema_version: 2 }],
    ['no rules_version', { ...doc, rules_version: undefined }],
  ])('refuses %s', (_label, raw) => {
    expect(parsePrismModelRules(raw)).toBeNull()
  })
})

describe('findPrismModelRule / findPrismProjector', () => {
  const rules = parsePrismModelRules(doc)!
  it.each([
    ['by sha256', { sha256: SHA('2') }, 'Bonsai-Q2_0.gguf'],
    [
      'by repo and name, repo case-insensitive',
      { repo: 'Prism-ML/bonsai-GGUF', file: 'Bonsai-PQ2_0.gguf' },
      'Bonsai-PQ2_0.gguf',
    ],
    [
      'by repo and a path-like name',
      { repo: 'prism-ml/Bonsai-gguf', file: 'sub/Bonsai-PQ2_0.gguf' },
      'Bonsai-PQ2_0.gguf',
    ],
    ['nothing for an unknown file', { repo: 'prism-ml/Bonsai-gguf', file: 'other.gguf' }, undefined],
    ['nothing for an unknown repo', { repo: 'x/y', file: 'Bonsai-PQ2_0.gguf' }, undefined],
  ])('%s', (_label, query, expected) => {
    expect(findPrismModelRule(rules, query)?.file.file).toBe(expected)
  })
  it('finds a projector by hash or name', () => {
    expect(findPrismProjector(rules, { sha256: SHA('9') })?.family.id).toBe('bonsai')
    expect(
      findPrismProjector(rules, { repo: 'prism-ml/bonsai-gguf', file: 'Bonsai-mmproj.gguf' })?.projector
        .default
    ).toBe(true)
    expect(findPrismProjector(rules, { sha256: SHA('0') })).toBeUndefined()
  })
})
