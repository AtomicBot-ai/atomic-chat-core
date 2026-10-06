import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../../contracts/index.js'
import type {
  BeginOperation,
  EnvironmentOperation,
  ManagedHostReceipt,
  RequirementPlan,
  RuntimeDescriptorSummary,
  Sha256Digest,
} from '../../../contracts/index.js'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import type { ManagedEnvironmentControl } from '../types.js'

const DIGEST = `sha256:${'a'.repeat(64)}` as Sha256Digest

const operation = (over: Partial<EnvironmentOperation> = {}): EnvironmentOperation => ({
  schema_version: 1,
  operation_id: 'op-1',
  request_id: 'req-1',
  environment_id: 'env-1',
  target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
  kind: 'setup',
  instance_id: 'core-1',
  revision: 3,
  phase: 'preparing-host',
  plan_digest: DIGEST,
  approved_plan_digest: DIGEST,
  carried_plan_digest: null,
  progress: null,
  pending_host_step: null,
  completed_step_ids: [],
  cancellation_requested: false,
  error: null,
  ...over,
})

const plan: RequirementPlan = {
  plan_digest: DIGEST,
  environment_id: 'env-1',
  target: { kind: 'environment' },
  availability: 'setup-required',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: DIGEST,
  descriptor_id: null,
  environment_manifest_id: null,
  image_digest: null,
  adopts_existing_engine: false,
  system_changes: [{ code: 'install-packages', text: 'Install docker-ce' }],
  download_bytes: null,
  required_disk_bytes: null,
  docker_root_dir: null,
  free_disk_bytes: null,
  warnings: [],
  requires_elevation: true,
  may_require_relogin: true,
  may_require_reboot: false,
  blockers: [],
}

const summary: RuntimeDescriptorSummary = {
  descriptor_id: 'tensorrt-llm-1.2.1-r1',
  engine_id: 'tensorrt-llm',
  notices: ['NVIDIA Software License Agreement applies.'],
  curated_models: [],
  supported_architectures: ['LlamaForCausalLM'],
}

const receipt = (over: Partial<ManagedHostReceipt> = {}): ManagedHostReceipt => ({
  step_id: 'step-1',
  nonce: 'once-1',
  expected_operation_revision: 3,
  recipe_digest: DIGEST,
  parameters_digest: DIGEST,
  outcome: 'completed',
  receipt_id: 'receipt-1',
  ...over,
})

const begin = (over: Partial<BeginOperation> = {}): BeginOperation => ({
  request_id: 'req-1',
  target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
  kind: 'setup',
  descriptor_id: 'trtllm-1.3.0rc27',
  ...over,
})

/** Records what actually reached the service, so a refused request can be shown to do nothing. */
class FakeEnvironments implements ManagedEnvironmentControl {
  calls: string[] = []
  failWith: AtomicCoreError | undefined
  /** Every receipt body that reached the service, as the route parsed it. */
  receipts: ManagedHostReceipt[] = []
  /** Receipts already acted on, keyed by nonce, as the real service keeps them. */
  private consumed = new Set<string>()

  private record<T>(what: string, answer: T): T {
    this.calls.push(what)
    if (this.failWith !== undefined) throw this.failWith
    return answer
  }

  async list() {
    return this.record('list', [])
  }
  async probe() {
    return this.record('probe', plan)
  }
  async descriptor(descriptorId: string) {
    return this.record(`descriptor ${descriptorId}`, summary)
  }
  async begin(environmentId: string, input: BeginOperation) {
    return this.record(`begin ${environmentId} ${input.request_id} ${input.kind}`, operation())
  }
  async get(operationId: string) {
    return this.record(`get ${operationId}`, operation())
  }
  async cancel(operationId: string) {
    return this.record(`cancel ${operationId}`, operation({ cancellation_requested: true }))
  }
  async resume(operationId: string, input: { expected_revision: number }) {
    return this.record(`resume ${operationId} @${input.expected_revision}`, operation())
  }
  async acceptHostReceipt(operationId: string, input: ManagedHostReceipt) {
    this.receipts.push(input)
    // The real service answers a replay with the state as it stands, without acting again.
    if (this.consumed.has(input.nonce)) {
      return this.record(`receipt ${operationId} replay`, operation({ phase: 'preparing-environment' }))
    }
    this.consumed.add(input.nonce)
    return this.record(
      `receipt ${operationId} ${input.outcome}`,
      operation({ phase: 'preparing-environment' })
    )
  }
  async reset(environmentId: string) {
    return this.record(`reset ${environmentId}`, {
      environment_id: environmentId,
      archived_operation_ids: ['op-1'],
      archive_path: '/managed/operations/archive/t',
    })
  }
  async diagnostics(environmentId: string) {
    return this.record(`diagnostics ${environmentId}`, {
      generated_at: '2026-10-06T00:00:00.000Z',
      core_version: '0.9.5',
      platform: 'win32',
      arch: 'arm64',
      environment: null,
      sources: [],
      operations: [],
      recent_warnings: [],
    })
  }
}

let h: ControlHarness
let environments: FakeEnvironments

beforeEach(async () => {
  environments = new FakeEnvironments()
  h = await start({ environments })
})
afterEach(() => h.server.close())

const errorOf = async (res: Response): Promise<{ code: string; message: string; details?: string }> =>
  ((await res.json()) as { error: { code: string; message: string; details?: string } }).error

const operationOf = async (res: Response): Promise<EnvironmentOperation> =>
  (await res.json()) as EnvironmentOperation

const post = (path: string, body?: unknown) =>
  h.get(`/atomic/v1${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

describe('reaching the managed runtime', () => {
  it('answers the environments, the plan, and the operation it started', async () => {
    expect(await (await h.get('/atomic/v1/environments')).json()).toEqual({ environments: [] })

    const probed = await post('/environments/probe', {
      descriptor_id: 'trtllm-1.3.0rc27',
      target: { kind: 'environment' },
    })
    expect(probed.status).toBe(200)
    expect(await probed.json()).toEqual(plan)

    const started = await post('/environments/env-1/operations', begin())
    // 202: the operation is recorded, and what it does next outlives this request.
    expect(started.status).toBe(202)
    expect((await operationOf(started)).operation_id).toBe('op-1')
    expect(environments.calls).toEqual(['list', 'probe', 'begin env-1 req-1 setup'])
  })

  it('reads, cancels and resumes one operation by its id', async () => {
    expect((await h.get('/atomic/v1/environments/operations/op-1')).status).toBe(200)
    expect((await post('/environments/operations/op-1/cancel')).status).toBe(200)
    expect((await post('/environments/operations/op-1/resume', { expected_revision: 3 })).status).toBe(200)
    expect(environments.calls).toEqual(['get op-1', 'cancel op-1', 'resume op-1 @3'])
  })

  it('tells the two operation route families apart', async () => {
    // `/environments/operations/...` must not be read as an environment called "operations".
    await h.get('/atomic/v1/environments/operations/op-1')
    await post('/environments/env-1/operations', begin())
    expect(environments.calls).toEqual(['get op-1', 'begin env-1 req-1 setup'])
  })
})

describe('resetting and diagnosing an environment', () => {
  it('resets one environment and answers what it archived', async () => {
    const res = await post('/environments/default/reset')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ environment_id: 'default', archived_operation_ids: ['op-1'] })
    expect(environments.calls).toEqual(['reset default'])
  })

  it('answers 409 while an operation still runs, and the diagnostics report read-only', async () => {
    environments.failWith = new AtomicCoreError('MANAGED_OPERATION_CONFLICT', 'still running')
    expect((await post('/environments/default/reset')).status).toBe(409)
    environments.failWith = undefined
    const report = await h.get('/atomic/v1/environments/default/diagnostics')
    expect(report.status).toBe(200)
    expect(await report.json()).toMatchObject({ core_version: '0.9.5', operations: [] })
    expect(environments.calls).toEqual(['reset default', 'diagnostics default'])
  })
})

describe('reading a cached runtime descriptor (task 2.22)', () => {
  it('answers the summary of the descriptor the service has under that id', async () => {
    const res = await h.get('/atomic/v1/environments/descriptors/tensorrt-llm-1.2.1-r1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(summary)
    expect(environments.calls).toEqual(['descriptor tensorrt-llm-1.2.1-r1'])
  })

  it('is told apart from the operation routes and from an environment id', async () => {
    await h.get('/atomic/v1/environments/descriptors/op-1')
    await h.get('/atomic/v1/environments/operations/op-1')
    await post('/environments/descriptors/operations', begin())
    // The POST is an operation begun on an environment called "descriptors", as before: the
    // descriptor route is a GET only, and the begin route's shape is unchanged.
    expect(environments.calls).toEqual(['descriptor op-1', 'get op-1', 'begin descriptors req-1 setup'])
  })

  it('answers 404 MANAGED_METADATA_INVALID for an id this core has not cached', async () => {
    environments.failWith = new AtomicCoreError('MANAGED_METADATA_INVALID', 'not cached', 'nope-1')
    const res = await h.get('/atomic/v1/environments/descriptors/nope-1')
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toMatchObject({ code: 'MANAGED_METADATA_INVALID', details: 'nope-1' })
  })

  it('answers 422 MANAGED_ADAPTER_UNAVAILABLE where no managed runtime applies (no host recipe in this build)', async () => {
    environments.failWith = new AtomicCoreError('MANAGED_ADAPTER_UNAVAILABLE', 'not on this system')
    expect((await h.get('/atomic/v1/environments/descriptors/tensorrt-llm-1.2.1-r1')).status).toBe(422)
    const bare = await start()
    try {
      const res = await bare.get('/atomic/v1/environments/descriptors/tensorrt-llm-1.2.1-r1')
      expect(res.status).toBe(422)
      expect((await errorOf(res)).code).toBe('MANAGED_ADAPTER_UNAVAILABLE')
    } finally {
      bare.server.close()
    }
  })

  it('refuses an id that is not one before the service sees it', async () => {
    for (const bad of ['x'.repeat(201), 'a%5Cb', 'a%01b']) {
      const res = await h.get(`/atomic/v1/environments/descriptors/${bad}`)
      expect(res.status).toBe(400)
      expect((await errorOf(res)).code).toBe('INVALID_ARGUMENT')
    }
    expect(environments.calls).toEqual([])
  })
})

describe('what the routes refuse', () => {
  it('takes nothing at all from an unauthenticated caller', async () => {
    const res = await h.get('/atomic/v1/environments/operations/op-1', {
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.status).toBe(401)
    const started = await h.get('/atomic/v1/environments/env-1/operations', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: JSON.stringify(begin()),
    })
    expect(started.status).toBe(401)
    // Nothing reached the service, so nothing was started, cancelled or authorized.
    expect(environments.calls).toEqual([])
  })

  it('refuses a malformed target before the service sees it', async () => {
    for (const target of [
      { kind: 'runtime' },
      { kind: 'runtime', installation_id: 'i' },
      { kind: 'nonsense' },
      { kind: 'environment', installation_id: 'i' },
      'environment',
      null,
    ]) {
      const res = await post('/environments/env-1/operations', { ...begin(), target })
      expect(res.status).toBe(400)
      expect((await errorOf(res)).code).toBe('INVALID_ARGUMENT')
    }
    expect(environments.calls).toEqual([])
  })

  it('refuses a field this build does not know, rather than ignoring it', async () => {
    // A field that means something to the caller and nothing here is worth refusing on a surface
    // where one of the calls ends in a password prompt.
    const res = await post('/environments/env-1/operations', { ...begin(), force: true })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).details).toBe('force')
    expect(environments.calls).toEqual([])
  })

  it('refuses a setup that does not say what it installs, and an id that is a path', async () => {
    const noDescriptor = await post('/environments/env-1/operations', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
    })
    expect(noDescriptor.status).toBe(400)
    expect((await errorOf(noDescriptor)).details).toBe('descriptor_id')

    const asPath = await post('/environments/env-1/operations', {
      ...begin(),
      descriptor_id: '../../etc/passwd',
    })
    expect(asPath.status).toBe(400)
    expect(environments.calls).toEqual([])
  })

  it('refuses a revision or a digest that is not one', async () => {
    for (const body of [
      { expected_revision: -1 },
      { expected_revision: 1.5 },
      { expected_revision: '3' },
      {},
      { expected_revision: 3, approved_plan_digest: 'sha256:short' },
    ]) {
      expect((await post('/environments/operations/op-1/resume', body)).status).toBe(400)
    }
    expect(environments.calls).toEqual([])
  })

  it('refuses a receipt outcome nobody defined', async () => {
    const res = await post('/environments/operations/op-1/host-step-result', {
      ...receipt(),
      outcome: 'sort-of',
    })
    expect(res.status).toBe(400)
    expect(environments.calls).toEqual([])
  })

  it('takes the step log tail a receipt may carry, keeps its last 16 KiB, and refuses one that is not text (task 2.23)', async () => {
    const long = `${'x'.repeat(20_000)}all predefined address pools have been fully subnetted`
    expect(
      (await post('/environments/operations/op-1/host-step-result', receipt({ log_tail: long }))).status
    ).toBe(200)
    const kept = environments.receipts.at(-1)?.log_tail ?? ''
    expect(kept).toHaveLength(16 * 1024)
    expect(kept.endsWith('fully subnetted')).toBe(true)

    const bad = await post('/environments/operations/op-1/host-step-result', { ...receipt(), log_tail: 42 })
    expect(bad.status).toBe(400)
  })

  it('passes an operation nobody has on as 404', async () => {
    environments.failWith = new AtomicCoreError('MANAGED_OPERATION_NOT_FOUND', 'No such operation.')
    expect((await h.get('/atomic/v1/environments/operations/op-9')).status).toBe(404)
  })

  it('passes a conflicting request or revision on as 409', async () => {
    for (const code of [
      'MANAGED_OPERATION_CONFLICT',
      'MANAGED_REVISION_CONFLICT',
      'MANAGED_CONSENT_REQUIRED',
      'MANAGED_PLAN_CHANGED',
      'MANAGED_RECEIPT_CONFLICT',
      'GPU_BUSY',
    ] as const) {
      environments.failWith = new AtomicCoreError(code, 'no')
      const res = await post('/environments/operations/op-1/resume', { expected_revision: 3 })
      expect(res.status).toBe(409)
      expect((await errorOf(res)).code).toBe(code)
    }
  })

  it('says an engine this build cannot serve is understood but unavailable', async () => {
    environments.failWith = new AtomicCoreError('MANAGED_ADAPTER_UNAVAILABLE', 'no adapter')
    expect((await h.get('/atomic/v1/environments')).status).toBe(422)
  })

  it('says so plainly when this build has no managed runtime wired at all', async () => {
    const bare = await start()
    try {
      const res = await bare.get('/atomic/v1/environments')
      expect(res.status).toBe(422)
      expect((await errorOf(res)).code).toBe('MANAGED_ADAPTER_UNAVAILABLE')
    } finally {
      bare.server.close()
    }
  })
})

describe('an authorization is used once', () => {
  it('acts on a receipt, then answers a replay with the state as it stands', async () => {
    const first = await post('/environments/operations/op-1/host-step-result', receipt())
    expect(first.status).toBe(200)
    expect((await operationOf(first)).phase).toBe('preparing-environment')

    const replay = await post('/environments/operations/op-1/host-step-result', receipt())
    expect(replay.status).toBe(200)
    expect((await operationOf(replay)).phase).toBe('preparing-environment')
    // The privileged step was acted on once; the second call only read the state back.
    expect(environments.calls).toEqual(['receipt op-1 completed', 'receipt op-1 replay'])
  })

  it('passes a different result for a spent authorization on as a conflict', async () => {
    await post('/environments/operations/op-1/host-step-result', receipt())
    environments.failWith = new AtomicCoreError('MANAGED_RECEIPT_CONFLICT', 'already recorded')
    const res = await post('/environments/operations/op-1/host-step-result', receipt({ outcome: 'declined' }))
    expect(res.status).toBe(409)
  })
})
