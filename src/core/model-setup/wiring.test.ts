import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { PRISM_MANIFEST_BASELINE } from '../../backend/index.js'
import type { ModelCompatibilityResponse } from '../../contracts/index.js'
import { findPrismModelRule, PRISM_MODEL_RULES_BASELINE } from '../../models/index.js'
import { compatibilityFor, planFor, wireModelSetups } from './wiring.js'
import type { ModelSetupWiringDeps } from './wiring.js'

const TAG = PRISM_MANIFEST_BASELINE.releases[0]!.tag
const REPO = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
const FILE = 'Ternary-Bonsai-2-27B-PQ2_0.gguf'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-setup-wiring-')
})
afterEach(() => data.cleanup())

const prismVerdict: ModelCompatibilityResponse = {
  outcome: 'engine_required',
  provider: 'atomic-prism',
  requires: ['pq2_0'],
  evidence: 'rules',
  rules_version: 1,
  reason: 'needs PrismML',
}
const stockVerdict: ModelCompatibilityResponse = {
  outcome: 'compatible',
  provider: null,
  requires: [],
  evidence: 'header',
  rules_version: 1,
  reason: 'stock',
}

function deps(over: Partial<ModelSetupWiringDeps> = {}): ModelSetupWiringDeps {
  return {
    layout: data.layout,
    compatibility: {
      check: vi.fn(async (query) => (query.repo === REPO || query.modelPath ? prismVerdict : stockVerdict)),
      ruleFor: vi.fn(async (query) => findPrismModelRule(PRISM_MODEL_RULES_BASELINE, query)),
    },
    prismCatalog: {
      catalog: vi.fn(async () => ({
        manifest: PRISM_MANIFEST_BASELINE,
        source: 'bundled-baseline' as const,
      })),
    },
    hardware: async () =>
      ({ osType: 'macos', arch: 'aarch64', cpuExtensions: [], gpus: [], source: 'probe' }) as never,
    offer: () => ({ coreVersion: '0.10.0', allowCandidates: true }),
    currentPack: async () => null,
    installEngine: vi.fn(async () => ({})),
    selectEngine: vi.fn(async () => ({})),
    downloader: { download: vi.fn(async () => ({})), cancel: vi.fn() },
    register: vi.fn(async () => {}),
    modelFile: vi.fn(async () => ({ modelPath: '/m/model.gguf', sha256: 'b'.repeat(64) })),
    emit: vi.fn(),
    freeBytes: async () => 100e9,
    fetchFor: vi.fn(
      () =>
        (async () =>
          Response.json({
            siblings: [
              { rfilename: 'Qwen3-Q4_K_M.gguf', size: 7_000, lfs: { sha256: 'c'.repeat(64), size: 7_000 } },
            ],
          })) as unknown as typeof fetch
    ),
    newId: () => 'id1',
    env: {},
    installedPacks: async () => [],
    ...over,
  }
}

describe('planFor', () => {
  it('plans Bonsai from the rule, the manifest and the host, asking for the remote header', async () => {
    const d = deps()
    const plan = await planFor(d, { repo: REPO, file: FILE })
    expect(plan.engine).toMatchObject({ version: TAG, backend: 'macos-arm64' })
    expect(d.compatibility.check).toHaveBeenCalledWith({ repo: REPO, file: FILE, inspectRemote: true })
    expect(d.fetchFor).not.toHaveBeenCalled()
  })

  it('reads the Hub facts for a file no rule pins', async () => {
    const d = deps()
    const proxy = { url: 'http://proxy.test:3128' } as never
    const plan = await planFor(d, { repo: 'unsloth/Qwen3-GGUF', file: 'Qwen3-Q4_K_M.gguf', proxy })
    expect(d.fetchFor).toHaveBeenCalledWith(proxy)
    expect(plan.model).toMatchObject({ size: 7_000, sha256: 'c'.repeat(64), revision: 'main' })
    expect(plan.provider).toBe('llamacpp-upstream')
    await expect(planFor(d, { repo: 'unsloth/Qwen3-GGUF', file: 'Missing.gguf' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('treats unreadable free space as unknown', async () => {
    const plan = await planFor(deps({ freeBytes: async () => Promise.reject(new Error('statfs')) }), {
      repo: REPO,
      file: FILE,
    })
    expect(plan.free_bytes).toBeNull()
  })

  it.each([
    ['no repo', { repo: '', file: FILE }],
    ['not a gguf', { repo: REPO, file: 'model.bin' }],
    ['an empty revision', { repo: REPO, file: FILE, revision: ' ' }],
  ])('refuses %s', async (_name, request) => {
    await expect(planFor(deps(), request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('compatibilityFor', () => {
  it('checks a registered model by its file and sha256', async () => {
    const d = deps()
    await compatibilityFor(d, { model_id: 'o/m', provider: 'atomic-prism' })
    expect(d.modelFile).toHaveBeenCalledWith('atomic-prism', 'o/m')
    expect(d.compatibility.check).toHaveBeenCalledWith({ modelPath: '/m/model.gguf', sha256: 'b'.repeat(64) })
  })

  it('checks a Hub file, reading the remote header only when asked', async () => {
    const d = deps()
    await compatibilityFor(d, { repo: REPO, file: FILE, revision: 'abc', sha256: 'd'.repeat(64) })
    expect(d.compatibility.check).toHaveBeenCalledWith({
      repo: REPO,
      file: FILE,
      revision: 'abc',
      sha256: 'd'.repeat(64),
      inspectRemote: false,
    })
  })

  it('needs a model id or a repo and file', async () => {
    await expect(compatibilityFor(deps(), { repo: REPO })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('wireModelSetups', () => {
  it('downloads with resume and the Hub token in headers only, and registers Prism files under atomic-prism', async () => {
    const d = deps({ env: { HF_TOKEN: 'hf_secret' } })
    const service = wireModelSetups(d)
    const plan = await service.plan({ repo: REPO, file: FILE })
    await service.start({ repo: REPO, file: FILE, request_id: 'r1', plan_digest: plan.digest })
    await service.settled('id1')
    expect(d.installEngine).toHaveBeenCalledWith(TAG, 'macos-arm64', expect.objectContaining({ proxy: null }))
    expect(d.selectEngine).toHaveBeenCalledWith(`${TAG}/macos-arm64`)
    expect(d.downloader.download).toHaveBeenCalledWith('model-setup-id1-model', expect.any(Array), {
      resume: true,
      headers: { authorization: 'Bearer hf_secret' },
    })
    expect(d.emit).toHaveBeenCalledWith('model-setup:changed', expect.objectContaining({ setup_id: 'id1' }))
    const record = await service.get('id1')
    expect(JSON.stringify(record)).not.toContain('hf_secret')
  })

  it("carries the request's proxy into the engine install and every download, and the test endpoint into the URLs", async () => {
    const proxy = { url: 'http://proxy.test:3128', ignore_ssl: false }
    const d = deps({ hfEndpoint: 'http://127.0.0.1:9/hf' })
    const service = wireModelSetups(d)
    const plan = await service.plan({ repo: REPO, file: FILE })
    await service.start({
      repo: REPO,
      file: FILE,
      request_id: 'r1',
      plan_digest: plan.digest,
      proxy: proxy as never,
    })
    await service.settled('id1')
    expect(d.installEngine).toHaveBeenCalledWith(TAG, 'macos-arm64', expect.objectContaining({ proxy }))
    const [, items] = (d.downloader.download as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Array<{ url: string; proxy?: unknown }>,
    ]
    expect(items[0]).toMatchObject({
      proxy,
      url: expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:9/hf/${REPO}/resolve/`)),
    })
  })
})
