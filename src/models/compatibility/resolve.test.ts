import { describe, expect, it } from 'vitest'
import { BPW, bonsaiLikeGguf } from '../../../test/helpers/gguf-builder.js'
import { readGgufTensorSummary } from '../gguf/index.js'
import type { CompatibilityVerdict } from '../../contracts/index.js'
import {
  capabilitiesFromEvidence,
  evidenceFromSummary,
  gateDecision,
  resolveCompatibility,
} from './resolve.js'
import type { GgufEvidence } from './resolve.js'
import { PRISM_MODEL_RULES_BASELINE as RULES } from './rules-baseline.js'
import { findPrismModelRule } from './rules.js'

const header = (weightType: number, bpw: number, metadata: Record<string, number> = {}): GgufEvidence => {
  const file = bonsaiLikeGguf({ weightType, bitsPerWeight: bpw, metadata })
  return evidenceFromSummary(readGgufTensorSummary(file, { fileSize: file.length }))
}
const HADAMARD = { 'prism.hadamard.version': 1 }
const NO_PRISM = { build: null }
const PRISM = {
  build: 10754,
  capabilities: ['q1_0', 'q2_0_g64', 'pq2_0', 'ptq1_0', 'hadamard', 'vision'] as const,
}

describe('evidenceFromSummary / capabilitiesFromEvidence', () => {
  it.each([
    ['Bonsai 2 PQ2_0', header(142, BPW.pq2_0, HADAMARD), ['hadamard', 'pq2_0'], false],
    ['first-generation PQ2_0', header(142, BPW.pq2_0), ['pq2_0'], false],
    ['PTQ1_0', header(143, BPW.ptq1_0, HADAMARD), ['hadamard', 'ptq1_0'], false],
    ['Q2_0 group-64', header(42, BPW.q2_g64), ['q2_0_g64'], false],
    ['Q2_0 group-128 (legacy)', header(42, BPW.q2_g128), [], true],
    ['Q1_0', header(41, BPW.q1_0), ['q1_0'], false],
    ['a stock F16 file', header(1, BPW.f16), [], false],
  ])('%s', (_label, evidence, caps, legacy) => {
    const found = capabilitiesFromEvidence(RULES, evidence)
    expect(found.capabilities).toEqual(caps)
    expect(found.legacy).toBe(legacy)
    expect(found.unknownTypes).toEqual([])
  })
  it('reports an unmeasured Q2_0 and unknown non-stock types', () => {
    expect(
      capabilitiesFromEvidence(RULES, { tensorTypes: [{ type: 42, bitsPerWeight: null }], metadataKeys: [] })
        .undetermined
    ).toBe(true)
    expect(
      capabilitiesFromEvidence(RULES, {
        tensorTypes: [
          { type: 150, bitsPerWeight: 3 },
          { type: 39, bitsPerWeight: 4 },
        ],
        metadataKeys: [],
      }).unknownTypes
    ).toEqual([150])
  })
  it('treats any prism.hadamard.* key as the transform', () => {
    expect(
      capabilitiesFromEvidence(RULES, { tensorTypes: [], metadataKeys: ['prism.hadamard.block_size'] })
        .capabilities
    ).toEqual(['hadamard'])
  })
})

describe('resolveCompatibility', () => {
  const rule = (repo: string, file: string) => findPrismModelRule(RULES, { repo, file })
  const B2 = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
  const B1 = 'prism-ml/Ternary-Bonsai-27B-gguf'

  it.each<[string, Parameters<typeof resolveCompatibility>[0], Partial<CompatibilityVerdict>]>([
    [
      'A01 Bonsai 2 rule, no Prism installed',
      { rules: RULES, rule: rule(B2, 'Ternary-Bonsai-2-27B-PQ2_0.gguf')!, prism: NO_PRISM },
      {
        outcome: 'engine_required',
        provider: 'atomic-prism',
        requires: ['hadamard', 'pq2_0'],
        evidence: 'rules',
        min_prism_build: 10754,
        family: 'ternary-bonsai-2-27b',
      },
    ],
    [
      'A02 Bonsai 2 rule, Prism installed',
      { rules: RULES, rule: rule(B2, 'Ternary-Bonsai-2-27B-PQ2_0.gguf')!, prism: PRISM },
      { outcome: 'compatible', provider: 'atomic-prism' },
    ],
    [
      'A03 Bonsai 2 rule, Prism too old',
      { rules: RULES, rule: rule(B2, 'Ternary-Bonsai-2-27B-PQ2_0.gguf')!, prism: { build: 10700 } },
      { outcome: 'engine_update_required', provider: 'atomic-prism' },
    ],
    [
      'A04 installed release lacks a capability',
      {
        rules: RULES,
        rule: rule(B2, 'Ternary-Bonsai-2-27B-PTQ1_0.gguf')!,
        prism: { build: 10754, capabilities: ['pq2_0', 'hadamard'] },
      },
      { outcome: 'engine_update_required' },
    ],
    [
      'A05 legacy Q2_0 rule',
      { rules: RULES, rule: rule(B1, 'Ternary-Bonsai-27B-Q2_0.gguf')!, prism: PRISM },
      { outcome: 'legacy_artifact', replacement: 'Ternary-Bonsai-27B-PQ2_0.gguf', provider: null },
    ],
    [
      'A06 F16 master rule',
      { rules: RULES, rule: rule(B2, 'Ternary-Bonsai-2-27B-F16.gguf')!, prism: PRISM },
      { outcome: 'unsupported', provider: null },
    ],
    [
      'A07 Q2_g64 rule runs anywhere',
      { rules: RULES, rule: rule(B1, 'Ternary-Bonsai-27B-Q2_g64.gguf')!, prism: NO_PRISM },
      { outcome: 'compatible', provider: null },
    ],
    [
      'A08 header PQ2_0 + hadamard',
      { rules: RULES, evidence: header(142, BPW.pq2_0, HADAMARD), prism: NO_PRISM },
      { outcome: 'engine_required', evidence: 'header', requires: ['hadamard', 'pq2_0'] },
    ],
    [
      'A09 header legacy Q2_0',
      { rules: RULES, evidence: header(42, BPW.q2_g128), prism: PRISM },
      { outcome: 'legacy_artifact', evidence: 'header' },
    ],
    [
      'A10 header stock file',
      { rules: RULES, evidence: header(1, BPW.f16), prism: NO_PRISM },
      { outcome: 'compatible', provider: null, evidence: 'header' },
    ],
    [
      'A11 header Q2_0 g64',
      { rules: RULES, evidence: header(42, BPW.q2_g64), prism: NO_PRISM },
      { outcome: 'compatible', provider: null },
    ],
    [
      'A12 nothing known',
      { rules: RULES, prism: NO_PRISM },
      { outcome: 'inspection_required', evidence: 'none' },
    ],
    [
      'A13 unknown tensor type',
      {
        rules: RULES,
        evidence: { tensorTypes: [{ type: 200, bitsPerWeight: 2 }], metadataKeys: [] },
        prism: PRISM,
      },
      { outcome: 'unsupported' },
    ],
    [
      'A14 unmeasured Q2_0',
      {
        rules: RULES,
        evidence: { tensorTypes: [{ type: 42, bitsPerWeight: null }], metadataKeys: [] },
        prism: PRISM,
      },
      { outcome: 'inspection_required', evidence: 'header' },
    ],
  ])('%s', (_label, input, expected) => {
    const verdict = resolveCompatibility(input)
    expect(verdict).toMatchObject({ rules_version: RULES.rules_version, ...expected })
    expect(verdict.reason.length).toBeGreaterThan(0)
  })
})

describe('gateDecision', () => {
  const verdict = (over: Partial<CompatibilityVerdict>): CompatibilityVerdict => ({
    outcome: 'compatible',
    provider: null,
    requires: [],
    evidence: 'header',
    rules_version: 1,
    reason: 'r',
    ...over,
  })
  it.each([
    ['a stock file anywhere', verdict({}), 'llamacpp-upstream', null],
    [
      'a Prism file on Prism',
      verdict({ provider: 'atomic-prism', requires: ['pq2_0'] }),
      'atomic-prism',
      null,
    ],
    [
      'a Prism file on upstream',
      verdict({ provider: 'atomic-prism', requires: ['pq2_0'] }),
      'llamacpp-upstream',
      'MODEL_ENGINE_INCOMPATIBLE',
    ],
    [
      'a Prism file on TurboQuant',
      verdict({ outcome: 'engine_required', provider: 'atomic-prism' }),
      'llamacpp',
      'MODEL_ENGINE_INCOMPATIBLE',
    ],
    [
      'a Prism file on a Prism build too old',
      verdict({ outcome: 'engine_update_required', provider: 'atomic-prism' }),
      'atomic-prism',
      'MODEL_ENGINE_INCOMPATIBLE',
    ],
    [
      'a legacy file',
      verdict({ outcome: 'legacy_artifact', replacement: 'X.gguf' }),
      'atomic-prism',
      'MODEL_FORMAT_LEGACY',
    ],
    [
      'an unsupported file',
      verdict({ outcome: 'unsupported' }),
      'llamacpp-upstream',
      'MODEL_ENGINE_INCOMPATIBLE',
    ],
    ['nothing known', verdict({ outcome: 'inspection_required' }), 'llamacpp-upstream', null],
  ] as const)('%s', (_label, v, provider, code) => {
    expect(gateDecision(v, provider)?.code ?? null).toBe(code)
  })
  it('names the replacement of a legacy file', () => {
    expect(
      gateDecision(verdict({ outcome: 'legacy_artifact', replacement: 'X.gguf' }), 'llamacpp')?.message
    ).toMatch(/X\.gguf/)
  })
})
