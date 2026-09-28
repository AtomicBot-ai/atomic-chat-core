import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  BeginOperation,
  EnvironmentOperation,
  ManagedHostReceipt,
  ManagedHostStep,
  RequirementPlan,
  Sha256Digest,
} from '../../contracts/index.js'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import { EnvironmentService, type EnvironmentProvisioner } from './service.js'
import { OperationStore } from './store.js'

const PLAN_A = `sha256:${'a'.repeat(64)}` as Sha256Digest
const PLAN_B = `sha256:${'b'.repeat(64)}` as Sha256Digest

const plan = (digest: Sha256Digest, over: Partial<RequirementPlan> = {}): RequirementPlan => ({
  plan_digest: digest,
  environment_id: 'env-1',
  target: { kind: 'environment' },
  availability: 'setup-required',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: PLAN_A,
  adopts_existing_engine: false,
  system_changes: ['Install docker-ce'],
  download_bytes: null,
  required_disk_bytes: null,
  requires_elevation: true,
  may_require_relogin: true,
  may_require_reboot: false,
  blockers: [],
  ...over,
})

const HOST_STEP: ManagedHostStep = {
  step_id: 'step-1',
  action: 'linux.install-container-runtime',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: PLAN_A,
  parameters_digest: PLAN_A,
  nonce: 'once-1',
  expected_operation_revision: 1,
}

const receipt = (over: Partial<ManagedHostReceipt> = {}): ManagedHostReceipt => ({
  step_id: 'step-1',
  nonce: 'once-1',
  expected_operation_revision: 1,
  recipe_digest: PLAN_A,
  parameters_digest: PLAN_A,
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

/** A provisioner whose every step is observable and can be made to fail or wait. */
class FakeProvisioner implements EnvironmentProvisioner {
  calls: string[] = []
  plans: { plan: RequirementPlan; host_step: ManagedHostStep | null }[] = []
  failures = new Map<string, Error>()
  relogin = false
  reboot = false

  constructor(...answers: { plan: RequirementPlan; host_step: ManagedHostStep | null }[]) {
    this.plans = answers
  }

  private step(name: string): void {
    this.calls.push(name)
    const failure = this.failures.get(name)
    if (failure !== undefined) throw failure
  }

  async probe(): Promise<{ plan: RequirementPlan; host_step: ManagedHostStep | null }> {
    this.step('probe')
    return this.plans.length > 1 ? (this.plans.shift() as never) : (this.plans[0] as never)
  }
  async prepare(): Promise<void> {
    this.step('prepare')
  }
  async pull(): Promise<void> {
    this.step('pull')
  }
  async verify(): Promise<void> {
    this.step('verify')
  }
  async unloadResident(): Promise<void> {
    this.step('unload')
  }
  async activate(): Promise<void> {
    this.step('activate')
  }
  async remove(): Promise<void> {
    this.step('remove')
  }
  async cleanup(): Promise<void> {
    this.step('cleanup')
  }
  inventory = {
    inspect: async () => ({ kind: 'absent' }) as const,
    needsRelogin: async () => this.relogin,
    needsReboot: async () => this.reboot,
    verifyCompletedSteps: async () => ['step-1'],
    currentPlanDigest: async () => PLAN_A,
  }
}

const harness = (provisioner: EnvironmentProvisioner | null) => {
  const fs = new FakeManagedFs()
  let n = 0
  const events: EnvironmentOperation[] = []
  const store = new OperationStore({
    root: '/shared',
    instanceId: 'core-1',
    newOperationId: () => 'op-1',
    newEffectId: () => `effect-${(n += 1)}`,
    fs,
    now: () => fs.clock,
    sleep: async () => undefined,
  })
  const service = new EnvironmentService({
    store,
    environmentId: 'env-1',
    instanceId: 'core-1',
    newEffectId: () => `effect-${(n += 1)}`,
    provisioner,
    readSnapshot: async () => [],
    emit: (_name, payload) => events.push(payload),
  })
  return { service, store, events, fs }
}

const settle = async (service: EnvironmentService): Promise<void> => {
  await service.idle()
}

describe('consent end to end (OP02)', () => {
  it('asks, refuses an approval the host has outgrown, then issues exactly one privileged step', async () => {
    const provisioner = new FakeProvisioner(
      { plan: plan(PLAN_A), host_step: null },
      { plan: plan(PLAN_B), host_step: HOST_STEP },
      { plan: plan(PLAN_B), host_step: HOST_STEP }
    )
    const { service } = harness(provisioner)

    await service.begin('env-1', begin())
    await settle(service)
    let operation = await service.get('op-1')
    expect(operation.phase).toBe('awaiting-consent')
    expect(operation.plan_digest).toBe(PLAN_A)

    // The user approves what they were shown; by now the host yields a different plan.
    await service.resume('op-1', { expected_revision: operation.revision, approved_plan_digest: PLAN_A })
    await settle(service)
    operation = await service.get('op-1')
    expect(operation.phase).toBe('awaiting-consent')
    expect(operation.plan_digest).toBe(PLAN_B)
    expect(operation.error?.code).toBe('MANAGED_PLAN_CHANGED')
    expect(provisioner.calls.filter((call) => call === 'prepare')).toHaveLength(0)
    expect(operation.pending_host_step).toBeNull()

    // Approving what is actually on offer moves it on, once.
    await service.resume('op-1', { expected_revision: operation.revision, approved_plan_digest: PLAN_B })
    await settle(service)
    operation = await service.get('op-1')
    expect(operation.phase).toBe('preparing-host')
    expect(operation.pending_host_step).toEqual(HOST_STEP)
  })
})

describe('an authorization is used once (OP03)', () => {
  const authorized = async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: HOST_STEP })
    const h = harness(provisioner)
    await h.service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(h.service)
    return { ...h, provisioner }
  }

  it('acts on a receipt once and treats the identical one as the retry it is', async () => {
    const { service, provisioner } = await authorized()
    expect((await service.get('op-1')).phase).toBe('preparing-host')

    await service.acceptHostReceipt('op-1', receipt())
    await settle(service)
    const after = await service.get('op-1')
    expect(after.phase).toBe('ready')
    const prepares = provisioner.calls.filter((call) => call === 'prepare').length
    expect(prepares).toBe(1)

    const replay = await service.acceptHostReceipt('op-1', receipt())
    await settle(service)
    // Same operation, and the privileged step did not happen a second time.
    expect(replay.revision).toBe(after.revision)
    expect(provisioner.calls.filter((call) => call === 'prepare')).toHaveLength(prepares)
  })

  it('refuses a different result for an authorization already spent', async () => {
    const { service } = await authorized()
    await service.acceptHostReceipt('op-1', receipt())
    await settle(service)
    await expect(service.acceptHostReceipt('op-1', receipt({ outcome: 'declined' }))).rejects.toThrow(
      AtomicCoreError
    )
  })

  it('refuses a receipt for an authorization this operation is not waiting for', async () => {
    const { service } = await authorized()
    await expect(service.acceptHostReceipt('op-1', receipt({ nonce: 'other' }))).rejects.toThrow(
      /does not match/
    )
  })
})

describe('cancelling a privileged step (OP04)', () => {
  it('records the wish, lets the transaction finish, then cleans up and installs nothing', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: HOST_STEP })
    const { service } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)

    const cancelled = await service.cancel('op-1')
    // The package transaction is not killed: the phase stands and the wish is recorded.
    expect(cancelled.phase).toBe('preparing-host')
    expect(cancelled.cancellation_requested).toBe(true)

    await service.acceptHostReceipt('op-1', receipt())
    await settle(service)
    const after = await service.get('op-1')
    expect(after.phase).toBe('cancelled')
    // The installed package stays recorded, and nothing went on to prepare or pull.
    expect(after.completed_step_ids).toEqual(['step-1'])
    expect(provisioner.calls).toEqual(['probe', 'cleanup'])
  })
})

describe('waiting for a sign-out across restarts (OP09)', () => {
  it('holds the phase while the group is not effective, then continues exactly once', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: HOST_STEP })
    const { service } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)

    provisioner.relogin = true
    await service.acceptHostReceipt('op-1', receipt({ outcome: 'relogin-required' }))
    await settle(service)
    expect((await service.get('op-1')).phase).toBe('relogin-required')

    // The app opens twice more before the user signs out and back in.
    for (let restart = 0; restart < 2; restart += 1) {
      await service.recover(`core-${restart + 2}`)
      await settle(service)
      expect((await service.get('op-1')).phase).toBe('relogin-required')
    }
    expect(provisioner.calls.filter((call) => call === 'prepare')).toHaveLength(0)

    // The user signs out and back in; the group now counts, so the host asks for nothing more.
    provisioner.relogin = false
    provisioner.plans = [{ plan: plan(PLAN_A), host_step: null }]
    await service.recover('core-4')
    await settle(service)
    const after = await service.get('op-1')
    // Two restarts of waiting, then one run of the setup: not one preparation per restart.
    expect(after.phase).toBe('ready')
    expect(provisioner.calls.filter((call) => call === 'prepare')).toHaveLength(1)
    // And the single-use authorization is gone, so nothing can re-elevate on its own.
    expect(after.pending_host_step).toBeNull()
  })
})

describe('a host with no recipe', () => {
  it('reports it as a blocker on the plan rather than failing the call', async () => {
    const { service } = harness(null)
    const answer = await service.probe({ descriptor_id: 'trtllm', target: { kind: 'environment' } })
    expect(answer.availability).toBe('unsupported')
    expect(answer.blockers[0]?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
  })

  it('leaves an operation started on such a host in an explicit blocked state', async () => {
    const { service } = harness(null)
    await service.begin('env-1', begin())
    await settle(service)
    const operation = await service.get('op-1')
    expect(operation.phase).toBe('failed')
    expect(operation.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
  })
})

describe('ordinary running', () => {
  it('carries a setup through to a ready installation and says so on the way', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    const { service, events } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)

    expect((await service.get('op-1')).phase).toBe('ready')
    expect(provisioner.calls).toEqual(['probe', 'prepare', 'pull', 'verify', 'activate'])
    // Every state the operation passed through was announced, in order.
    expect(events.map((event) => event.phase)).toEqual([
      'preparing-environment',
      'pulling-image',
      'verifying',
      'activating',
      'ready',
    ])
  })

  it('turns a step that throws into a failure carrying its reason', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    provisioner.failures.set('pull', new AtomicCoreError('IO_ERROR', 'The registry refused.'))
    const { service } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)

    const operation = await service.get('op-1')
    expect(operation.phase).toBe('failed')
    expect(operation.error?.message).toContain('registry')
    expect(provisioner.calls).not.toContain('activate')
  })

  it('answers a retried begin with the operation already running, not a second one', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    const { service, store } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)
    expect(provisioner.calls.filter((call) => call === 'prepare')).toHaveLength(1)
    expect(await store.listRecoverable()).toHaveLength(0)
  })

  it('reports an operation nobody started as missing', async () => {
    const { service } = harness(new FakeProvisioner({ plan: plan(PLAN_A), host_step: null }))
    await expect(service.get('op-nobody')).rejects.toThrow(/No such operation/)
  })

  it('stops in-flight work on shutdown and leaves the record to be picked up again', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: HOST_STEP })
    const { service, store } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)

    await service.shutdown(new AbortController().signal)
    const left = await store.listRecoverable()
    // The operation is still there, mid-flight, for the next core to reconcile.
    expect(left).toHaveLength(1)
    expect(left[0]?.machine.operation.phase).toBe('preparing-host')
  })
})
