import { describe, expect, it } from 'vitest'
import { getPrismSupportedFeatures, PRISM_MANIFEST_BASELINE } from '../../backend/index.js'
import type { ModelCompatibilityResponse } from '../../contracts/index.js'
import { findPrismModelRule, PRISM_MODEL_RULES_BASELINE } from '../../models/index.js'
import { choosePrismPack, defaultModelId, planDigest, planModelSetup, STOCK_SETUP_PROVIDER } from './plan.js'
import type { ModelSetupPlanInput, PrismHost } from './plan.js'

const TAG = PRISM_MANIFEST_BASELINE.releases[0]!.tag
const REPO = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
const FILE = 'Ternary-Bonsai-2-27B-PQ2_0.gguf'
const MAC: PrismHost = {
  osType: 'macos',
  arch: 'aarch64',
  features: getPrismSupportedFeatures('macos', [], [], undefined),
  gpus: [],
}
const OFFER = { coreVersion: '0.10.0', allowCandidates: true }
/** The bundled manifest with every asset still a candidate: what the release watch publishes. */
const CANDIDATES_ONLY = {
  ...PRISM_MANIFEST_BASELINE,
  releases: PRISM_MANIFEST_BASELINE.releases.map((release) => ({
    ...release,
    assets: release.assets.map((asset) => ({ ...asset, validation: 'candidate' as const })),
  })),
}

const verdict = (over: Partial<ModelCompatibilityResponse> = {}): ModelCompatibilityResponse => ({
  outcome: 'engine_required',
  provider: 'atomic-prism',
  requires: ['pq2_0'],
  evidence: 'rules',
  rules_version: 1,
  installed_prism_build: null,
  reason: 'needs PrismML',
  ...over,
})

const input = (over: Partial<ModelSetupPlanInput> = {}): ModelSetupPlanInput => {
  const rule = findPrismModelRule(PRISM_MODEL_RULES_BASELINE, { repo: REPO, file: FILE })
  return {
    request: { repo: REPO, file: FILE },
    verdict: verdict(),
    ...(rule ? { rule } : {}),
    manifest: PRISM_MANIFEST_BASELINE,
    offer: OFFER,
    host: MAC,
    installedPacks: [],
    currentPack: null,
    freeBytes: 100e9,
    ...over,
  }
}

describe('defaultModelId', () => {
  it.each([
    ['prism-ml/Ternary-Bonsai-8B-gguf', 'Ternary-Bonsai-8B-PQ2_0.gguf', 'prism-ml/Ternary-Bonsai-8B-PQ2_0'],
    ['unsloth/Qwen3-GGUF', 'sub/Qwen3-Q4_K_M.GGUF', 'unsloth/Qwen3-Q4_K_M'],
  ])('%s + %s → %s', (repo, file, id) => {
    expect(defaultModelId(repo, file)).toBe(id)
  })
})

describe('choosePrismPack', () => {
  it('offers an approved pack without the unverified-builds setting', () => {
    expect(
      choosePrismPack({
        manifest: PRISM_MANIFEST_BASELINE,
        offer: { ...OFFER, allowCandidates: false },
        host: MAC,
        requires: ['pq2_0'],
      })
    ).toMatchObject({ version: TAG, backend: 'macos-arm64' })
  })

  it('picks the Metal pack on Apple Silicon, sized with nothing extra', () => {
    const pack = choosePrismPack({
      manifest: PRISM_MANIFEST_BASELINE,
      offer: OFFER,
      host: MAC,
      requires: ['pq2_0'],
    })
    expect(pack).toMatchObject({ version: TAG, backend: 'macos-arm64' })
    expect(pack!.download_size).toBeGreaterThan(0)
  })

  it.each([
    [
      'candidate builds are not offered',
      CANDIDATES_ONLY,
      { ...OFFER, allowCandidates: false },
      ['pq2_0'] as const,
      undefined,
    ],
    [
      'the release lacks a capability',
      PRISM_MANIFEST_BASELINE,
      OFFER,
      ['pq2_0', 'not_a_capability'] as never,
      undefined,
    ],
    [
      'the release is older than the minimum build',
      PRISM_MANIFEST_BASELINE,
      OFFER,
      ['pq2_0'] as const,
      99_999,
    ],
  ])('is null when %s', (_name, manifest, offer, requires, minBuild) => {
    expect(
      choosePrismPack({
        manifest,
        offer,
        host: MAC,
        requires: [...requires],
        ...(minBuild !== undefined ? { minBuild } : {}),
      })
    ).toBeNull()
  })
})

describe('planModelSetup', () => {
  it('Bonsai 2 on a Mac with no engine: the pack, the pinned file and the default projector', () => {
    const plan = planModelSetup(input())
    expect(plan.blockers).toEqual([])
    expect(plan.provider).toBe('atomic-prism')
    expect(plan.engine).toMatchObject({
      provider: 'atomic-prism',
      version: TAG,
      backend: 'macos-arm64',
      installed: false,
    })
    expect(plan.model).toMatchObject({
      repo: REPO,
      file: FILE,
      revision: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    expect(plan.model.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.projector?.file).toBe('Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf')
    expect(plan.total_download_bytes).toBe(
      plan.engine!.download_size + plan.model.size + plan.projector!.size
    )
    expect(plan.model_id).toBe('prism-ml/Ternary-Bonsai-2-27B-PQ2_0')
  })

  it('leaves the projector out when asked, and keeps a caller model id', () => {
    const plan = planModelSetup(
      input({ request: { repo: REPO, file: FILE, include_projector: false, model_id: 'me/bonsai' } })
    )
    expect(plan.projector).toBeNull()
    expect(plan.model_id).toBe('me/bonsai')
  })

  it('downloads nothing for the engine when the chosen pack is already on disk', () => {
    const plan = planModelSetup(input({ installedPacks: [{ version: TAG, backend: 'macos-arm64' }] }))
    expect(plan.engine).toMatchObject({ installed: true, download_size: 0 })
  })

  it('a compatible Prism file runs on the current pack', () => {
    const current = { version: TAG, backend: 'macos-arm64' }
    const plan = planModelSetup(input({ verdict: verdict({ outcome: 'compatible' }), currentPack: current }))
    expect(plan.engine).toEqual({ provider: 'atomic-prism', ...current, installed: true, download_size: 0 })
  })

  it('a stock file is planned for the default llama.cpp, with the Hub facts and `main`', () => {
    const plan = planModelSetup(
      input({
        request: { repo: 'unsloth/Qwen3-GGUF', file: 'Qwen3-Q4_K_M.gguf' },
        verdict: verdict({ outcome: 'compatible', provider: null, requires: [], evidence: 'header' }),
        hubFile: { size: 5_000, sha256: 'a'.repeat(64) },
        rule: undefined as never,
      })
    )
    expect(plan.provider).toBe(STOCK_SETUP_PROVIDER)
    expect(plan.engine).toBeNull()
    expect(plan.model).toEqual({
      repo: 'unsloth/Qwen3-GGUF',
      file: 'Qwen3-Q4_K_M.gguf',
      revision: 'main',
      sha256: 'a'.repeat(64),
      size: 5_000,
    })
    expect(plan.total_download_bytes).toBe(5_000)
  })

  it.each([
    ['unsupported', { verdict: verdict({ outcome: 'unsupported', provider: null }) }, 'unsupported'],
    [
      'legacy',
      { verdict: verdict({ outcome: 'legacy_artifact', replacement: 'X-Q2_0_g64.gguf' }) },
      'legacy_artifact',
    ],
    [
      'no build',
      { manifest: CANDIDATES_ONLY, offer: { ...OFFER, allowCandidates: false } },
      'no_engine_build',
    ],
    ['no room', { freeBytes: 1_000 }, 'insufficient_disk_space'],
  ] as const)('blocks a %s setup', (_name, over, code) => {
    const plan = planModelSetup(input(over as Partial<ModelSetupPlanInput>))
    expect(plan.blockers.map((b) => b.code)).toContain(code)
  })

  it('carries the legacy replacement', () => {
    const plan = planModelSetup(
      input({ verdict: verdict({ outcome: 'legacy_artifact', replacement: 'X-Q2_0_g64.gguf' }) })
    )
    expect(plan.blockers[0]).toMatchObject({ code: 'legacy_artifact', replacement: 'X-Q2_0_g64.gguf' })
  })

  it('unknown free space blocks nothing', () => {
    expect(planModelSetup(input({ freeBytes: null })).blockers).toEqual([])
  })
})

describe('planDigest', () => {
  it('ignores what drifts on its own and follows what decides the work', () => {
    const a = planModelSetup(input({ freeBytes: 100e9 }))
    const b = planModelSetup(input({ freeBytes: 200e9 }))
    expect(a.digest).toBe(b.digest)
    const c = planModelSetup(input({ installedPacks: [{ version: TAG, backend: 'macos-arm64' }] }))
    expect(c.digest).not.toBe(a.digest)
    const { digest, ...body } = a
    expect(planDigest(body)).toBe(digest)
  })
})
