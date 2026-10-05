import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { getPrismSupportedFeatures, PRISM_MANIFEST_BASELINE } from '../../backend/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  CompatibilityVerdict,
  ModelSetup,
  ModelSetupPlan,
  ModelSetupPlanRequest,
} from '../../contracts/index.js'
import type { DownloadItem } from '../../downloads/index.js'
import { findPrismModelRule, PRISM_MODEL_RULES_BASELINE } from '../../models/index.js'
import type { ModelYmlInput } from '../../models/index.js'
import { planModelSetup } from './plan.js'
import { blockedPlanError, engineTaskId, ModelSetupService, setupErrorBody, setupTaskId } from './service.js'
import type { ModelSetupServiceDeps } from './service.js'
import { ModelSetupStore } from './store.js'

const TAG = PRISM_MANIFEST_BASELINE.releases[0]!.tag
const REPO = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
const FILE = 'Ternary-Bonsai-2-27B-PQ2_0.gguf'
const REQUEST: ModelSetupPlanRequest = { repo: REPO, file: FILE }

function bonsaiPlan(over: { freeBytes?: number; installed?: boolean } = {}): ModelSetupPlan {
  const rule = findPrismModelRule(PRISM_MODEL_RULES_BASELINE, { repo: REPO, file: FILE })!
  return planModelSetup({
    request: REQUEST,
    verdict: {
      outcome: 'engine_required',
      provider: 'atomic-prism',
      requires: ['pq2_0'],
      evidence: 'rules',
      rules_version: 1,
      min_prism_build: 10754,
      family: rule.family.id,
      reason: 'needs PrismML',
    },
    rule,
    manifest: PRISM_MANIFEST_BASELINE,
    offer: { coreVersion: '0.10.0', allowCandidates: true },
    host: {
      osType: 'macos',
      arch: 'aarch64',
      features: getPrismSupportedFeatures('macos', [], [], undefined),
      gpus: [],
    },
    installedPacks: over.installed ? [{ version: TAG, backend: 'macos-arm64' }] : [],
    currentPack: null,
    freeBytes: over.freeBytes ?? 100e9,
  })
}

const deferred = <T = void>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Harness {
  service: ModelSetupService
  store: ModelSetupStore
  calls: string[]
  events: ModelSetup[]
  registered: Array<{ modelId: string; yml: ModelYmlInput }>
  deps: ModelSetupServiceDeps
}

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-setup-')
})
afterEach(() => data.cleanup())

function harness(
  over: Partial<ModelSetupServiceDeps> = {},
  plan: () => ModelSetupPlan = () => bonsaiPlan()
): Harness {
  const calls: string[] = []
  const events: ModelSetup[] = []
  const registered: Harness['registered'] = []
  const store = new ModelSetupStore(data.layout.core.prismSetupsDir)
  let ids = 0
  const deps: ModelSetupServiceDeps = {
    layout: data.layout,
    store,
    plan: async () => plan(),
    installEngine: async (engine, taskId) => {
      calls.push(`install ${engine.version}/${engine.backend} ${taskId}`)
    },
    selectEngine: async (engine) => {
      calls.push(`select ${engine.version}/${engine.backend}`)
    },
    download: async (taskId, items: DownloadItem[]) => {
      calls.push(`download ${taskId}`)
      for (const item of items) {
        const path = join(data.root, item.save_path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, Buffer.alloc(16, 1))
      }
    },
    cancelDownload: (taskId) => {
      calls.push(`cancel ${taskId}`)
    },
    verify: async (): Promise<CompatibilityVerdict> => ({
      outcome: 'compatible',
      provider: 'atomic-prism',
      requires: ['pq2_0'],
      evidence: 'header',
      rules_version: 1,
      reason: 'ok',
    }),
    register: async (modelId, yml) => {
      registered.push({ modelId, yml })
    },
    emit: (record) => events.push(record),
    imported: (event) => calls.push(`imported ${event.provider} ${event.modelId}`),
    newId: () => `s${++ids}`,
    now: () => 1_000,
    ...over,
  }
  return { service: new ModelSetupService(deps), store, calls, events, registered, deps }
}

const start = (h: Harness, requestId = 'r1', plan = bonsaiPlan()) =>
  h.service.start({ ...REQUEST, request_id: requestId, plan_digest: plan.digest })

describe('task ids and error bodies', () => {
  it.each([
    ['model-setup-s1-model', 'model-setup-s1-model'],
    ['a b+c', 'a_b_c'],
  ])('setupTaskId(%s) → %s', (raw, id) => expect(setupTaskId(raw)).toBe(id))

  it('engineTaskId is one per pack', () => {
    expect(engineTaskId({ version: TAG, backend: 'macos-arm64' })).toBe(
      `atomic-prism-backend-${TAG}/macos-arm64`
    )
  })

  it('setupErrorBody keeps a core error and wraps anything else as IO', () => {
    expect(setupErrorBody(new AtomicCoreError('MODEL_FORMAT_LEGACY', 'old'))).toMatchObject({
      code: 'MODEL_FORMAT_LEGACY',
    })
    expect(setupErrorBody(new Error('[disk_full] no room'))).toEqual({
      code: 'IO_ERROR',
      message: '[disk_full] no room',
    })
  })

  it.each([
    ['legacy_artifact', 'MODEL_FORMAT_LEGACY'],
    ['insufficient_disk_space', 'DISK_FULL'],
    ['no_engine_build', 'MODEL_ENGINE_INCOMPATIBLE'],
    ['unsupported', 'MODEL_ENGINE_INCOMPATIBLE'],
  ] as const)('blockedPlanError(%s) → %s', (blocker, code) => {
    const plan = { ...bonsaiPlan(), blockers: [{ code: blocker, message: 'm' }] }
    expect(blockedPlanError(plan)?.code).toBe(code)
  })

  it('blockedPlanError is null for a clear plan', () => expect(blockedPlanError(bonsaiPlan())).toBeNull())
})

describe('ModelSetupService', () => {
  it('runs a Bonsai setup to ready: engine, model, projector, check, model.yml', async () => {
    const h = harness()
    const started = await start(h)
    expect(started).toMatchObject({
      setup_id: 's1',
      stage: 'queued',
      task_ids: { engine: expect.any(String) },
    })
    await h.service.settled('s1')
    expect((await h.service.get('s1')).stage).toBe('ready')
    expect(h.events.map((e) => e.stage)).toEqual([
      'queued',
      'installing_engine',
      'downloading_model',
      'downloading_projector',
      'verifying',
      'registering',
      'ready',
    ])
    expect(h.calls).toEqual([
      `install ${TAG}/macos-arm64 atomic-prism-backend-${TAG}/macos-arm64`,
      `select ${TAG}/macos-arm64`,
      'download model-setup-s1-model',
      'download model-setup-s1-projector',
      'imported atomic-prism prism-ml/Ternary-Bonsai-2-27B-PQ2_0',
    ])
    const [{ modelId, yml }] = h.registered as [Harness['registered'][number]]
    expect(modelId).toBe('prism-ml/Ternary-Bonsai-2-27B-PQ2_0')
    expect(yml).toMatchObject({
      model_path: `llamacpp/models/prism-ml/Ternary-Bonsai-2-27B-PQ2_0/${FILE}`,
      mmproj_path:
        'llamacpp/models/prism-ml/Ternary-Bonsai-2-27B-PQ2_0/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
      size_bytes: 32,
      model_size_bytes: 16,
      mmproj_size_bytes: 16,
      projector_vision: true,
      embedding: false,
      atomic_runtime: { provider: 'atomic-prism', requires: ['pq2_0'], min_build: 10754 },
    })
    expect(yml['model_sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(h.service.snapshot().map((r) => r.stage)).toEqual(['ready'])
  })

  it('skips the install for a pack on disk but still selects it', async () => {
    const plan = bonsaiPlan({ installed: true })
    const h = harness({}, () => plan)
    await start(h, 'r1', plan)
    await h.service.settled('s1')
    expect(h.calls[0]).toBe(`select ${TAG}/macos-arm64`)
    expect((await h.service.get('s1')).task_ids.engine).toBeUndefined()
  })

  it('a retry with the same request id returns the same setup; another body under it is refused', async () => {
    const h = harness()
    const first = await start(h)
    expect((await start(h)).setup_id).toBe(first.setup_id)
    await expect(
      h.service.start({ ...REQUEST, file: 'other.gguf', request_id: 'r1', plan_digest: bonsaiPlan().digest })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await h.service.settled(first.setup_id)
  })

  it('refuses a stale digest with the new plan, and a blocked plan with its code', async () => {
    const h = harness()
    await expect(h.service.start({ ...REQUEST, request_id: 'r1', plan_digest: 'old' })).rejects.toMatchObject(
      {
        code: 'MODEL_SETUP_PLAN_STALE',
        details: expect.stringContaining('"digest"'),
      }
    )
    const blocked = bonsaiPlan({ freeBytes: 10 })
    const b = harness({}, () => blocked)
    await expect(start(b, 'r2', blocked)).rejects.toMatchObject({ code: 'DISK_FULL' })
    await expect(h.service.start({ ...REQUEST, request_id: '', plan_digest: 'x' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('returns the running setup for a model already being set up', async () => {
    const install = deferred()
    const h = harness({ installEngine: () => install.promise })
    const first = await start(h, 'r1')
    expect((await start(h, 'r2')).setup_id).toBe(first.setup_id)
    install.resolve()
    await h.service.settled(first.setup_id)
  })

  it('shares one engine install; cancelling one setup leaves the install to the other', async () => {
    const install = deferred()
    let installs = 0
    const other = { ...bonsaiPlan(), model_id: 'me/other' }
    let next = bonsaiPlan()
    const h = harness(
      {
        installEngine: () => {
          installs++
          return install.promise
        },
      },
      () => next
    )
    await start(h, 'r1')
    next = other
    await h.service.start({ ...REQUEST, model_id: 'me/other', request_id: 'r2', plan_digest: other.digest })
    await new Promise((r) => setTimeout(r, 10))
    expect(installs).toBe(1)
    const cancelled = await h.service.cancel('s1')
    expect(cancelled).toMatchObject({ stage: 'cancelled', stopped_at: 'installing_engine' })
    install.resolve()
    await h.service.settled('s2')
    expect((await h.service.get('s2')).stage).toBe('ready')
  })

  it('cancel during a download stops that task and keeps the setup resumable', async () => {
    const download = deferred()
    const h = harness({
      download: async (taskId) => {
        h.calls.push(`download ${taskId}`)
        return download.promise
      },
    })
    await start(h)
    while (!h.calls.includes('download model-setup-s1-model')) await new Promise((r) => setTimeout(r, 2))
    const cancelled = await h.service.cancel('s1')
    expect(cancelled).toMatchObject({ stage: 'cancelled', stopped_at: 'downloading_model' })
    expect(h.calls).toContain('cancel model-setup-s1-model')
    expect(h.calls).toContain('cancel model-setup-s1-projector')
    expect(await h.service.cancel('s1')).toMatchObject({ stage: 'cancelled' })
  })

  it('a downloader that answers "Download cancelled" ends as cancelled, not failed', async () => {
    const h = harness({
      download: async () => {
        throw new Error('Download cancelled')
      },
    })
    await start(h)
    await h.service.settled('s1')
    expect(await h.service.get('s1')).toMatchObject({ stage: 'cancelled', stopped_at: 'downloading_model' })
  })

  it.each([
    ['needs another engine', { outcome: 'compatible', provider: 'llamacpp' }, 'MODEL_SETUP_PLAN_STALE'],
    ['is legacy', { outcome: 'legacy_artifact', provider: 'atomic-prism' }, 'MODEL_FORMAT_LEGACY'],
    ['is unsupported', { outcome: 'unsupported', provider: null }, 'MODEL_ENGINE_INCOMPATIBLE'],
  ] as const)('fails at verifying when the downloaded file %s', async (_name, verdict, code) => {
    const h = harness({
      verify: async () => ({ requires: [], evidence: 'header', rules_version: 1, reason: 'r', ...verdict }),
    })
    await start(h)
    await h.service.settled('s1')
    expect(await h.service.get('s1')).toMatchObject({
      stage: 'failed',
      stopped_at: 'verifying',
      error: { code },
    })
    expect(h.registered).toEqual([])
  })

  it('recover marks a run a stopped core left as interrupted; resume plans again and finishes', async () => {
    const first = harness({ installEngine: () => new Promise(() => {}) })
    await start(first)
    await new Promise((r) => setTimeout(r, 10))

    const h = harness()
    await h.service.recover()
    expect(await h.service.get('s1')).toMatchObject({ stage: 'interrupted', stopped_at: 'installing_engine' })
    const resumed = await h.service.resume('s1')
    expect(resumed).toMatchObject({ stage: 'queued' })
    expect(resumed.stopped_at).toBeUndefined()
    await h.service.settled('s1')
    expect((await h.service.get('s1')).stage).toBe('ready')
    expect(await h.service.resume('s1')).toMatchObject({ stage: 'ready' })
  })

  it('resume of a plan that is now blocked fails with the blocker', async () => {
    const h = harness({
      download: async () => {
        throw new Error('[disk_full] write failed')
      },
    })
    await start(h)
    await h.service.settled('s1')
    expect(await h.service.get('s1')).toMatchObject({ stage: 'failed', error: { code: 'IO_ERROR' } })
    const blocked = harness({}, () => bonsaiPlan({ freeBytes: 10 }))
    await blocked.service.recover()
    expect(await blocked.service.resume('s1')).toMatchObject({
      stage: 'failed',
      error: { code: 'DISK_FULL' },
    })
  })

  it('an unknown setup is MODEL_SETUP_NOT_FOUND', async () => {
    const h = harness()
    await expect(h.service.get('nope')).rejects.toMatchObject({ code: 'MODEL_SETUP_NOT_FOUND' })
    await expect(h.service.cancel('nope')).rejects.toMatchObject({ code: 'MODEL_SETUP_NOT_FOUND' })
  })

  it('cancel of a queued setup with no run records the stop', async () => {
    const h = harness()
    await h.store.create({
      setup_id: 'q1',
      request_id: 'rq',
      revision: 0,
      stage: 'interrupted',
      request: REQUEST,
      plan: bonsaiPlan(),
      task_ids: { model: 'm' },
      created_at: 1,
      updated_at: 1,
    })
    expect(await h.service.cancel('q1')).toMatchObject({ stage: 'cancelled', stopped_at: 'interrupted' })
  })

  it('plan and list pass through', async () => {
    const h = harness()
    expect((await h.service.plan(REQUEST)).digest).toBe(bonsaiPlan().digest)
    expect(await h.service.list()).toEqual([])
  })
})
