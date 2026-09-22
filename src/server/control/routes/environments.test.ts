import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../../contracts/index.js'
import type {
  BeginOperation,
  EnvironmentOperation,
  ManagedHostReceipt,
  RequirementPlan,
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
  adopts_existing_engine: false,
  system_changes: ['Install docker-ce'],
  download_bytes: null,
  required_disk_bytes: null,
  requires_elevation: true,
  may_require_relogin: true,
  may_require_reboot: false,
  blockers: [],
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
