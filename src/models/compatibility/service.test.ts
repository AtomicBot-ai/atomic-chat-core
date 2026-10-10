import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { GgufEvidence, InstalledPrism } from './resolve.js'
import { PRISM_MODEL_RULES_BASELINE as RULES } from './rules-baseline.js'
import { ModelCompatibilityService } from './service.js'

const B2 = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
const PQ2: GgufEvidence = {
  tensorTypes: [{ type: 142, bitsPerWeight: 2.125 }],
  metadataKeys: ['prism.hadamard.version'],
}
const STOCK: GgufEvidence = { tensorTypes: [{ type: 1, bitsPerWeight: 16 }], metadataKeys: [] }
const LEGACY: GgufEvidence = { tensorTypes: [{ type: 42, bitsPerWeight: 2.125 }], metadataKeys: [] }

const make = (options: { evidence?: GgufEvidence | Error; prism?: InstalledPrism } = {}) => {
  const inspectLocal = vi.fn(async () => {
    if (options.evidence instanceof Error) throw options.evidence
    return options.evidence ?? STOCK
  })
  const inspectRemote = vi.fn(async () => PQ2)
  const rules = { rules: vi.fn(async () => RULES), cachedRules: vi.fn(async () => RULES) }
  const svc = new ModelCompatibilityService({
    rules,
    installedPrism: async () => options.prism ?? { build: null },
    fetch: (async () => new Response()) as typeof fetch,
    hfToken: () => 'tok',
    inspectLocal,
    inspectRemote,
  })
  return { svc, inspectLocal, inspectRemote, rules }
}

describe('ModelCompatibilityService.check', () => {
  it('answers from a conf rule with the family defaults, without reading anything', async () => {
    const { svc, inspectLocal, inspectRemote } = make()
    const verdict = await svc.check({ repo: B2, file: 'Ternary-Bonsai-2-27B-PQ2_0.gguf' })
    expect(verdict).toMatchObject({
      outcome: 'engine_required',
      provider: 'atomic-prism',
      family: 'ternary-bonsai-2-27b',
      defaults: { sampling: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0.05 }, ctx_len: 16384 },
    })
    expect(inspectLocal).not.toHaveBeenCalled()
    expect(inspectRemote).not.toHaveBeenCalled()
  })
  it('reads the remote header on request when no rule matches', async () => {
    const { svc, inspectRemote } = make()
    expect((await svc.check({ repo: 'someone/fork', file: 'x.gguf', inspectRemote: true })).outcome).toBe(
      'engine_required'
    )
    expect(inspectRemote).toHaveBeenCalledWith(
      'https://huggingface.co/someone/fork/resolve/main/x.gguf',
      expect.objectContaining({ token: 'tok' })
    )
  })
  it('bounds the remote read only when the core was given a timeout', async () => {
    const bounded = vi.fn(async () => PQ2)
    const svc = new ModelCompatibilityService({
      rules: { rules: vi.fn(async () => RULES), cachedRules: vi.fn(async () => RULES) },
      installedPrism: async () => ({ build: null }),
      fetch: (async () => new Response()) as typeof fetch,
      inspectRemote: bounded,
      remoteTimeoutMs: 20_000,
    })
    await svc.check({ repo: 'someone/fork', file: 'x.gguf', inspectRemote: true })
    expect(bounded).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeoutMs: 20_000 }))
    const unbounded = make()
    await unbounded.svc.check({ repo: 'someone/fork', file: 'x.gguf', inspectRemote: true })
    expect((unbounded.inspectRemote.mock.calls[0] as unknown[])[1]).not.toHaveProperty('timeoutMs')
  })
  it('is inspection_required without a rule and without a header to read', async () => {
    const { svc } = make()
    expect((await svc.check({ repo: 'someone/fork', file: 'x.gguf' })).outcome).toBe('inspection_required')
  })
  it('reads a local file', async () => {
    const { svc } = make({ evidence: LEGACY })
    expect((await svc.check({ modelPath: '/m.gguf' })).outcome).toBe('legacy_artifact')
  })
})

describe('ModelCompatibilityService.families', () => {
  it('lists every family with only the files the Hub may offer', async () => {
    const { svc } = make()
    const { rules_version, families } = await svc.families()

    expect(rules_version).toBe(RULES.rules_version)
    const b2 = families.find((f) => f.repo === B2)!
    expect(b2.files.map((f) => f.file)).toEqual([
      'Ternary-Bonsai-2-27B-PQ2_0.gguf',
      'Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    ])
    expect(b2.files[0]).toMatchObject({ treatment: 'prism_required', default: true })
    expect(b2.projectors.length).toBeGreaterThan(0)
    // An F16 master and a legacy layout are never offered.
    for (const family of families)
      for (const file of family.files) expect(['prism_required', 'any']).toContain(file.treatment)
  })

  it('leaves out a family with nothing to offer', async () => {
    const only = RULES.families[0]!
    const rules = {
      ...RULES,
      families: [{ ...only, files: only.files.map((f) => ({ ...f, treatment: 'excluded' as const })) }],
    }
    const svc = new ModelCompatibilityService({
      rules: { rules: async () => rules, cachedRules: async () => rules },
      installedPrism: async () => ({ build: null }),
      fetch: (async () => new Response()) as typeof fetch,
    })

    expect((await svc.families()).families).toEqual([])
  })
})

describe('ModelCompatibilityService.ruleFor', () => {
  it('matches a file the way check does', async () => {
    const { svc } = make()
    expect((await svc.ruleFor({ repo: B2, file: 'Ternary-Bonsai-2-27B-PQ2_0.gguf' }))?.family.id).toBe(
      'ternary-bonsai-2-27b'
    )
    expect(await svc.ruleFor({ repo: 'x/y', file: 'z.gguf' })).toBeUndefined()
  })
})

describe('ModelCompatibilityService.gate', () => {
  const codeOf = async (p: Promise<void>) =>
    p.then(
      () => null,
      (e: AtomicCoreError) => e.code
    )
  it.each([
    ['a Prism file on upstream', PQ2, 'llamacpp-upstream', 'MODEL_ENGINE_INCOMPATIBLE'],
    ['a Prism file on TurboQuant', PQ2, 'llamacpp', 'MODEL_ENGINE_INCOMPATIBLE'],
    ['a legacy file on Prism', LEGACY, 'atomic-prism', 'MODEL_FORMAT_LEGACY'],
    ['a stock file on upstream', STOCK, 'llamacpp-upstream', null],
    ['a stock file on Prism', STOCK, 'atomic-prism', null],
  ] as const)('%s', async (_label, evidence, provider, code) => {
    const { svc } = make({ evidence, prism: { build: 10754 } })
    expect(await codeOf(svc.gate(provider, { modelPath: '/m.gguf', modelId: 'm' }))).toBe(code)
  })
  it('carries the verdict in details and never uses the network', async () => {
    const { svc, rules } = make({ evidence: PQ2 })
    const error = await svc
      .gate('llamacpp-upstream', { modelPath: '/m.gguf', modelId: 'm' })
      .catch((e: AtomicCoreError) => e)
    expect(error).toBeInstanceOf(AtomicCoreError)
    expect(JSON.parse((error as AtomicCoreError).details ?? '{}')).toMatchObject({
      model_id: 'm',
      verdict: { provider: 'atomic-prism' },
    })
    expect(rules.rules).not.toHaveBeenCalled()
  })
  it('does not gate MLX or an unreadable header', async () => {
    const { svc, inspectLocal } = make({ evidence: new Error('EACCES') })
    await expect(svc.gate('mlx', { modelPath: '/m' })).resolves.toBeUndefined()
    expect(inspectLocal).not.toHaveBeenCalled()
    await expect(svc.gate('llamacpp-upstream', { modelPath: '/m' })).resolves.toBeUndefined()
  })
  it('uses a rule matched by the recorded sha256', async () => {
    const legacy = RULES.families[1]?.files.find((f) => f.treatment === 'legacy')
    const { svc, inspectLocal } = make()
    expect(
      await codeOf(svc.gate('atomic-prism', { modelPath: '/m', sha256: legacy?.sha256 as string }))
    ).toBe('MODEL_FORMAT_LEGACY')
    expect(inspectLocal).not.toHaveBeenCalled()
  })
})
