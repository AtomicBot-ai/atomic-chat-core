import { describe, expect, it } from 'vitest'
import { PRISM_MODEL_RULES_BASELINE } from './rules-baseline.js'
import { findPrismModelRule } from './rules.js'

describe('PRISM_MODEL_RULES_BASELINE', () => {
  it('carries the five Bonsai families and the header tables', () => {
    expect(PRISM_MODEL_RULES_BASELINE.families.map((f) => f.id)).toEqual([
      'ternary-bonsai-2-27b',
      'ternary-bonsai-27b',
      'ternary-bonsai-8b',
      'ternary-bonsai-4b',
      'ternary-bonsai-1.7b',
    ])
    expect(PRISM_MODEL_RULES_BASELINE.tensor_types).toEqual({
      '41': 'q1_0',
      '42': 'q2_0',
      '142': 'pq2_0',
      '143': 'ptq1_0',
    })
    expect(PRISM_MODEL_RULES_BASELINE.metadata_capabilities['prism.hadamard.version']).toBe('hadamard')
  })
  it('marks Bonsai 2 PQ2_0 Prism-only and first-generation Q2_0 legacy', () => {
    const b2 = findPrismModelRule(PRISM_MODEL_RULES_BASELINE, {
      repo: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
      file: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
    })
    expect(b2?.file).toMatchObject({ treatment: 'prism_required', requires: ['pq2_0', 'hadamard'] })
    const legacy = findPrismModelRule(PRISM_MODEL_RULES_BASELINE, {
      repo: 'prism-ml/Ternary-Bonsai-27B-gguf',
      file: 'Ternary-Bonsai-27B-Q2_0.gguf',
    })
    expect(legacy?.file).toMatchObject({ treatment: 'legacy', replacement: 'Ternary-Bonsai-27B-PQ2_0.gguf' })
  })
})
