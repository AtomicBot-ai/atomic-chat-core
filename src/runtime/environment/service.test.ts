import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  BeginOperation,
  EnvironmentOperation,
  ManagedHostReceipt,
  ManagedHostStep,
  ManagedProgress,
  RequirementPlan,
  Sha256Digest,
} from '../../contracts/index.js'
import type { IdentityDeps } from '../../lock/index.js'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseRuntimeDescriptor } from './descriptor.js'
import type { RuntimeDescriptorProvider } from './descriptor-provider.js'
import { EnvironmentService, type EnvironmentProvisioner } from './service.js'
import { OperationStore } from './store.js'

/**
 * A `/proc/<pid>/stat` line whose start-tick field is `ticks` — just enough of the real shape for
 * `processStartId`'s Linux parser to read a genuine `linux:<ticks>` value out of it, without ever
 * touching an actual process. `tail[19]` (20 whitespace-separated fields after the last `)`) is the
 * field it reads; the other 19 are unused filler.
 */
const fakeProcStat = (ticks: number): string =>
  `4242 (node) ${['S', ...Array(18).fill('0'), String(ticks)].join(' ')}`

const PLAN_A = `sha256:${'a'.repeat(64)}` as Sha256Digest
const PLAN_B = `sha256:${'b'.repeat(64)}` as Sha256Digest

const plan = (digest: Sha256Digest, over: Partial<RequirementPlan> = {}): RequirementPlan => ({
  plan_digest: digest,
  environment_id: 'env-1',
  target: { kind: 'environment' },
  availability: 'setup-required',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: PLAN_A,
  descriptor_id: null,
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
  ...over,
})

const HOST_STEP: ManagedHostStep = {
  step_id: 'step-1',
  action: 'linux.install-container-runtime',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: PLAN_A,
  parameters_digest: PLAN_A,
  parameters: {
    user: 'ada',
    arch: 'x86_64',
    family: 'apt',
    distro_id: 'ubuntu',
    version_id: '24.04',
    components: ['docker-engine'],
  },
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
  /** What the probe after a receipt reports missing, when the step did not take. */
  missing: { code: 'MANAGED_PREREQUISITE_BLOCKED'; message: string } | null = null
  imagePresent = false
  /** Byte progress `pull` reports before it returns. */
  pullProgress: { completed: number; total: number }[] = []
  /** Progress `pull` reports after its pause is released, as a pull still streaming would. */
  lateProgress: { completed: number; total: number }[] = []
  private gates = new Map<string, { promise: Promise<void>; release: () => void }>()

  constructor(...answers: { plan: RequirementPlan; host_step: ManagedHostStep | null }[]) {
    this.plans = answers
  }

  /** Hold `step` until the returned function is called, so a test can pause mid-effect. */
  pauseAt(step: string): () => void {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    this.gates.set(step, { promise, release })
    return release
  }

  private async step(name: string): Promise<void> {
    this.calls.push(name)
    await this.gates.get(name)?.promise
    const failure = this.failures.get(name)
    if (failure !== undefined) throw failure
  }

  async probe(): Promise<{
    plan: RequirementPlan
    host_step: ManagedHostStep | null
    image_present: boolean
  }> {
    await this.step('probe')
    const answer = this.plans.length > 1 ? this.plans.shift() : this.plans[0]
    return {
      ...(answer as { plan: RequirementPlan; host_step: ManagedHostStep | null }),
      image_present: this.imagePresent,
    }
  }
  async verifyHostStep() {
    await this.step('verify-host-step')
    return {
      prerequisites_met: !this.relogin && !this.reboot && this.missing === null,
      needs_relogin: this.relogin,
      error: this.missing,
    }
  }
  /** What `prepare` records as its own before its (paused) work. */
  claims: string[] = []
  async prepare(_record: unknown, _signal: unknown, own?: (ids: string[]) => Promise<void>): Promise<void> {
    if (this.claims.length > 0) await own?.(this.claims)
    await this.step('prepare')
  }
  async pull(_record: unknown, onProgress: (progress: ManagedProgress) => void): Promise<void> {
    for (const tick of this.pullProgress) {
      onProgress({ label: 'Downloading', completed: tick.completed, total: tick.total, unit: 'bytes' })
    }
    await this.step('pull')
    for (const tick of this.lateProgress) {
      onProgress({ label: 'Downloading', completed: tick.completed, total: tick.total, unit: 'bytes' })
    }
  }
  async verify(): Promise<void> {
    await this.step('verify')
  }
  async unloadResident(): Promise<void> {
    await this.step('unload')
  }
  async activate(): Promise<void> {
    await this.step('activate')
  }
  async remove(): Promise<void> {
    await this.step('remove')
  }
  async cleanup(): Promise<void> {
    await this.step('cleanup')
  }
  inventory = {
    inspect: async () => ({ kind: 'absent' }) as const,
    needsRelogin: async () => this.relogin,
    needsReboot: async () => this.reboot,
    verifyCompletedSteps: async () => ['step-1'],
    currentPlanDigest: async () => PLAN_A,
  }
}

interface HarnessIdentity {
  /**
   * Fully deterministic on every host: no `platform`/`readText`/`run` here ever reaches the real
   * OS unless a test supplies its own (as the "a live owner" tests below do, to get a genuine
   * `match` or `unknown` verdict without depending on what pid 4242 happens to be on the machine
   * running the suite).
   */
  identityDeps?: IdentityDeps
  /** What `PersistedOperation.owner_process_start_id` this harness's writes carry. */
  ownerStartId?: string | null
  /** Operation ids; every operation is `op-1` unless a test needs two of them. */
  newOperationId?: () => string
  now?: () => number
  /** The descriptor cache the descriptor read answers from (task 2.22); none when omitted. */
  descriptors?: Pick<RuntimeDescriptorProvider, 'forInstallation'>
}

const harness = (provisioner: EnvironmentProvisioner | null, identity: HarnessIdentity = {}) => {
  const fs = new FakeManagedFs()
  let n = 0
  const events: EnvironmentOperation[] = []
  const store = new OperationStore({
    root: '/shared',
    instanceId: 'core-1',
    newOperationId: identity.newOperationId ?? (() => 'op-1'),
    newEffectId: () => `effect-${(n += 1)}`,
    fs,
    now: () => fs.clock,
    sleep: async () => undefined,
    // Fast and deterministic: these tests are about operation flow, not about which real OS
    // process is still running, and the vitest worker's own pid would otherwise make every
    // record's "owner" look alive forever, since it is the one writing them.
    ownerIdentity: async () => ({ pid: 4242, startId: identity.ownerStartId ?? 'harness:owner' }),
  })
  const service = new EnvironmentService({
    store,
    environmentId: 'env-1',
    instanceId: 'core-1',
    newEffectId: () => `effect-${(n += 1)}`,
    provisioner,
    readSnapshot: async () => [],
    emit: (_name, payload) => events.push(payload),
    // Every owner is "gone" by default, so `recover` behaves exactly as it did before the owner
    // liveness check existed: most of these tests exercise repeated recovery of the harness's own
    // writes (see OP09, simulating several real app restarts in one process), never a live
    // handoff between two cores. The "a live owner" tests below pass their own `identityDeps`.
    identityDeps: identity.identityDeps ?? { alive: () => false },
    ...(identity.now === undefined ? {} : { now: identity.now }),
    ...(identity.descriptors === undefined ? {} : { descriptors: identity.descriptors }),
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
    expect(operation.pending_host_step).toEqual({
      ...HOST_STEP,
      expected_operation_revision: operation.pending_host_step?.expected_operation_revision,
    })
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

  it('acts on a receipt once, and refuses the same nonce a second time (spec "Повтор квитанции")', async () => {
    const { service, provisioner } = await authorized()
    expect((await service.get('op-1')).phase).toBe('preparing-host')

    await service.acceptHostReceipt('op-1', receipt())
    await settle(service)
    const after = await service.get('op-1')
    expect(after.phase).toBe('ready')
    const prepares = provisioner.calls.filter((call) => call === 'prepare').length
    expect(prepares).toBe(1)

    await expect(service.acceptHostReceipt('op-1', receipt())).rejects.toMatchObject({
      code: 'MANAGED_RECEIPT_CONFLICT',
    })
    await settle(service)
    // Nothing moved, and the privileged step did not count a second time.
    expect((await service.get('op-1')).revision).toBe(after.revision)
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
    await expect(service.acceptHostReceipt('op-1', receipt({ nonce: 'other' }))).rejects.toMatchObject({
      code: 'MANAGED_RECEIPT_CONFLICT',
    })
  })

  it('refuses a receipt naming another revision of the operation (task 2.6)', async () => {
    const { service } = await authorized()
    await expect(
      service.acceptHostReceipt('op-1', receipt({ expected_operation_revision: 99 }))
    ).rejects.toMatchObject({ code: 'MANAGED_RECEIPT_CONFLICT' })
    expect((await service.get('op-1')).phase).toBe('preparing-host')
  })

  it('refuses a receipt for other recipe bytes or parameters than the step it names', async () => {
    const { service } = await authorized()
    await expect(
      service.acceptHostReceipt('op-1', receipt({ parameters_digest: PLAN_B }))
    ).rejects.toMatchObject({ code: 'MANAGED_HOST_STEP_INVALID' })
  })

  it('applies a receipt that arrives twice at once exactly once (a lost compare-and-swap)', async () => {
    const { service, provisioner } = await authorized()
    const outcomes = await Promise.allSettled([
      service.acceptHostReceipt('op-1', receipt()),
      service.acceptHostReceipt('op-1', receipt()),
    ])
    await settle(service)
    // One applies; the other finds the nonce spent once it re-reads, and is refused.
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ code: 'MANAGED_RECEIPT_CONFLICT' })
    expect(provisioner.calls.filter((call) => call === 'prepare')).toHaveLength(1)
    expect((await service.get('op-1')).phase).toBe('ready')
  })

  it('fails with what the machine shows when the helper says completed but nothing is there', async () => {
    const { service, provisioner } = await authorized()
    provisioner.missing = { code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'Docker Engine is not installed.' }
    await service.acceptHostReceipt('op-1', receipt())
    await settle(service)
    const after = await service.get('op-1')
    expect(after.phase).toBe('failed')
    expect(after.error?.message).toBe('Docker Engine is not installed.')
    expect(provisioner.calls).not.toContain('prepare')
  })

  it('keeps a declined authorization resumable, and a resume issues a fresh step', async () => {
    const { service, provisioner } = await authorized()
    await service.acceptHostReceipt('op-1', receipt({ outcome: 'declined' }))
    await settle(service)
    const declined = await service.get('op-1')
    expect(declined.phase).toBe('failed')
    expect(declined.error?.code).toBe('MANAGED_ELEVATION_DECLINED')
    // Nothing on the host was even looked at for a refusal.
    expect(provisioner.calls).not.toContain('verify-host-step')

    await service.resume('op-1', { expected_revision: declined.revision })
    await settle(service)
    const again = await service.get('op-1')
    expect(again.phase).toBe('preparing-host')
    expect(again.pending_host_step?.expected_operation_revision).toBe(again.revision - 1)
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
    // The receipt was checked against the machine; nothing was prepared or pulled after it.
    expect(provisioner.calls).toEqual(['probe', 'verify-host-step', 'cleanup'])
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

describe('an explicit resume looks at the machine (task 2.6)', () => {
  it('runs the reconcile a resume asks for, and continues after the sign-in without new consent', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: HOST_STEP })
    const { service } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)
    provisioner.relogin = true
    await service.acceptHostReceipt('op-1', receipt())
    await settle(service)
    const waiting = await service.get('op-1')
    expect(waiting.phase).toBe('relogin-required')
    expect(waiting.error?.code).toBe('MANAGED_RELOGIN_REQUIRED')

    // Still not signed in: the resume looks, and waits again.
    await service.resume('op-1', { expected_revision: waiting.revision })
    await settle(service)
    const still = await service.get('op-1')
    expect(still.phase).toBe('relogin-required')

    // Signed in; the host now adopts as it stands, under a different plan digest.
    provisioner.relogin = false
    provisioner.plans = [
      { plan: plan(PLAN_B, { system_changes: [], requires_elevation: false }), host_step: null },
    ]
    await service.resume('op-1', { expected_revision: still.revision })
    await settle(service)
    expect((await service.get('op-1')).phase).toBe('ready')
    expect(provisioner.calls.filter((call) => call === 'prepare')).toHaveLength(1)
  })
})

describe('a resume never swaps the approval (review r3, N1)', () => {
  it('refuses another approval on a failed operation and leaves it as it was', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    provisioner.failures.set('pull', new AtomicCoreError('IO_ERROR', 'The registry refused.'))
    const { service } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    await settle(service)
    const failed = await service.get('op-1')
    expect(failed.phase).toBe('failed')
    await expect(
      service.resume('op-1', { expected_revision: failed.revision, approved_plan_digest: PLAN_B })
    ).rejects.toMatchObject({ code: 'MANAGED_PLAN_CHANGED' })
    expect((await service.get('op-1')).revision).toBe(failed.revision)
  })
})

describe('a begin that finds an abandoned operation (task 2.6)', () => {
  it('fails the operation a dead core left running and starts the new request', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    let serial = 0
    const { service, store } = harness(provisioner, { newOperationId: () => `op-${(serial += 1)}` })
    // What a core that died right after recording its begin leaves behind.
    await store.createOrGet('env-1', begin({ request_id: 'req-old' }), PLAN_A)

    const started = await service.begin('env-1', begin({ request_id: 'req-new' }))
    await settle(service)
    expect(started.operation_id).toBe('op-2')
    const old = await service.get('op-1')
    expect(['failed', 'cancelled']).toContain(old.phase)
    expect(old.error?.code ?? 'MANAGED_OPERATION_CONFLICT').toBe('MANAGED_OPERATION_CONFLICT')
  })

  it('leaves an operation that waits on the user alone, even with its owner gone (review r1, item 6)', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    let serial = 0
    const { service, store } = harness(provisioner, { newOperationId: () => `op-${(serial += 1)}` })
    await service.begin('env-1', begin({ request_id: 'req-old' }))
    await settle(service)
    expect((await service.get('op-1')).phase).toBe('awaiting-consent')
    // The harness reports every owner as gone; a consent the user has not given yet is still theirs.
    await expect(service.begin('env-1', begin({ request_id: 'req-new' }))).rejects.toMatchObject({
      code: 'MANAGED_OPERATION_CONFLICT',
      details: 'op-1',
    })
    expect((await service.get('op-1')).phase).toBe('awaiting-consent')
    expect(await store.listRecoverable()).toHaveLength(1)
  })

  it('still refuses while the owner of the running operation is alive', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    const { service, store } = harness(provisioner, {
      ownerStartId: null,
      identityDeps: { alive: () => true },
    })
    await store.createOrGet('env-1', begin({ request_id: 'req-old' }), PLAN_A)
    await expect(service.begin('env-1', begin({ request_id: 'req-new' }))).rejects.toMatchObject({
      code: 'MANAGED_OPERATION_CONFLICT',
    })
  })
})

describe('what a step creates is recorded before it creates it (review r2, item B)', () => {
  it('persists the claim while the step is still running, so a crash right after keeps it', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    provisioner.claims = ['image:probe@sha256:1']
    const release = provisioner.pauseAt('prepare')
    const { service, store } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    for (let i = 0; i < 200 && !provisioner.calls.includes('prepare'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const midStep = await store.read('op-1')
    expect(midStep?.machine.operation.phase).toBe('preparing-environment')
    expect(midStep?.owned_resource_ids).toEqual(['image:probe@sha256:1'])
    release()
    await settle(service)
    // Every later transition kept it.
    expect((await store.read('op-1'))?.owned_resource_ids).toEqual(['image:probe@sha256:1'])
    expect((await service.get('op-1')).phase).toBe('ready')
  })
})

describe('byte progress while pulling (task 2.6)', () => {
  it('announces progress without moving the revision, and get() shows it', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    provisioner.pullProgress = [
      { completed: 10, total: 100 },
      { completed: 50, total: 100 },
    ]
    const release = provisioner.pauseAt('pull')
    const { service, events } = harness(provisioner, { now: () => 1_000 })
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    for (let i = 0; i < 200 && !provisioner.calls.includes('pull'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const during = await service.get('op-1')
    expect(during.phase).toBe('pulling-image')
    expect(during.progress).toMatchObject({ unit: 'bytes', total: 100 })
    const ticks = events.filter((event) => event.phase === 'pulling-image' && event.progress !== null)
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.every((event) => event.revision === during.revision)).toBe(true)
    expect(ticks[0]?.progress?.completed).toBe(10)
    // One clock reading for all ticks: the throttle lets only the first out.
    expect(ticks).toHaveLength(1)
    release()
    await settle(service)
    expect((await service.get('op-1')).progress).toBeNull()
  })

  it('stops announcing ticks once the other scope’s core cancelled the operation (review r2, item E)', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    const release = provisioner.pauseAt('pull')
    let clock = 0
    const { service, store, events } = harness(provisioner, { now: () => (clock += 1_000) })
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    for (let i = 0; i < 200 && !provisioner.calls.includes('pull'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    // Another core over the same shared store: this one never hears of its cancel.
    let n = 1_000
    const other = new EnvironmentService({
      store,
      environmentId: 'env-1',
      instanceId: 'core-2',
      newEffectId: () => `other-${(n += 1)}`,
      provisioner: new FakeProvisioner({ plan: plan(PLAN_A), host_step: null }),
      readSnapshot: async () => [],
      identityDeps: { alive: () => true },
    })
    await other.cancel('op-1')
    await other.idle()
    const before = events.length
    provisioner.lateProgress = [{ completed: 60, total: 100 }]
    release()
    await settle(service)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.slice(before).some((event) => event.phase === 'pulling-image')).toBe(false)
  })

  it('never announces a tick for an operation that has since moved on (review r1, item 8)', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    const release = provisioner.pauseAt('pull')
    let clock = 0
    const { service, events } = harness(provisioner, { now: () => (clock += 1_000) })
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))
    for (let i = 0; i < 200 && !provisioner.calls.includes('pull'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await service.cancel('op-1')
    const cancelling = events.length
    // The stream still delivers a tick after the cancel committed.
    provisioner.lateProgress = [{ completed: 50, total: 100 }]
    release()
    await settle(service)
    expect(events.slice(cancelling).some((event) => event.phase === 'pulling-image')).toBe(false)
  })
})

describe('a live owner is left alone (finding 1)', () => {
  it('does not reconcile a non-terminal operation whose recorded owner is still running (match)', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: HOST_STEP })
    // A genuine `match` verdict, the same way `InstanceLock` gets one: `alive` says yes, and the
    // recorded start id is exactly what this fake `/proc/4242/stat` line parses to. Deterministic
    // on every host — not "pid 4242 happens not to be running here" (`processStartId` would
    // otherwise make a real syscall/exec against the real pid 4242, whatever that is today).
    const ticks = 99_999
    const { service } = harness(provisioner, {
      ownerStartId: `linux:${ticks}`,
      identityDeps: { alive: () => true, platform: 'linux', readText: async () => fakeProcStat(ticks) },
    })
    await service.begin('env-1', begin())
    await settle(service)
    const before = await service.get('op-1')
    expect(before.phase).toBe('awaiting-consent')

    await service.recover('core-2')
    await settle(service)

    // Not re-dispatched, not reconciled, not even touched: the record is exactly what its live
    // owner left it as.
    const after = await service.get('op-1')
    expect(after.revision).toBe(before.revision)
    expect(after.phase).toBe('awaiting-consent')
    expect(provisioner.calls).toEqual(['probe'])
  })

  it('treats an unprovable identity as alive too, the same as InstanceLock does for its own lock (unknown)', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: HOST_STEP })
    // A genuine `unknown` verdict: `alive` says yes, but no start id was ever recorded to compare
    // against, so `verifyProcessIdentity` returns `unknown` without probing anything — no real pid
    // or platform I/O involved, deterministic on every host.
    const { service } = harness(provisioner, { ownerStartId: null, identityDeps: { alive: () => true } })
    await service.begin('env-1', begin())
    await settle(service)
    const before = await service.get('op-1')

    await service.recover('core-2')
    await settle(service)

    expect((await service.get('op-1')).revision).toBe(before.revision)
  })
})

describe('an abandoned operation with nobody to help it (finding 2)', () => {
  it('fails a checking operation left by a dead core instead of blocking every later begin', async () => {
    // `harness(null)` is exactly what every environment answers with today (no host recipe is
    // qualified on any platform yet, `wiring.ts`'s `provisionerFor`) — the realistic case this
    // fix is for, not a hypothetical. The record is written directly through the store, the way
    // `service.begin` itself does, but without going through `service.begin` (which would
    // dispatch its probe effect on this very process, racing the recovery this test means to
    // exercise): this is exactly what a core that wrote the record and died before running its
    // own probe effect leaves behind.
    const { service, store } = harness(null)
    await store.createOrGet('env-1', begin(), PLAN_A)
    expect((await service.get('op-1')).phase).toBe('checking')

    await service.recover('core-2')
    await settle(service)

    const after = await service.get('op-1')
    expect(after.phase).toBe('failed')
    expect(after.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    // And the environment is free again: a later `begin` is not refused as still running.
    expect(await store.listRecoverable()).toHaveLength(0)
  })

  it('leaves a live owner alone even with no provisioner to reconcile through', async () => {
    // `unknown` (no recorded start id): deterministic on every host, the same as the "a live
    // owner is left alone" tests above.
    const { service, store } = harness(null, { ownerStartId: null, identityDeps: { alive: () => true } })
    await store.createOrGet('env-1', begin(), PLAN_A)
    const before = await service.get('op-1')
    expect(before.phase).toBe('checking')

    await service.recover('core-2')

    // No provisioner and a live owner both apply; the live-owner check wins; the operation is
    // untouched by this call.
    const after = await service.get('op-1')
    expect(after.revision).toBe(before.revision)
    expect(after.phase).toBe('checking')
  })
})

describe('recovering the rest of the list when one record misbehaves (finding 6)', () => {
  it('keeps recovering later records after an earlier one throws instead of aborting the whole pass', async () => {
    // A bespoke store/service pair, not the shared `harness()`: that helper pins `newOperationId`
    // to a single `'op-1'` (every other test in this file only ever recovers one record at a
    // time), which would make two `createOrGet` calls collide on the same file. Two distinct,
    // independently recoverable records are the whole point here.
    const fs = new FakeManagedFs()
    let opSerial = 0
    let effectSerial = 0
    let aliveCalls = 0
    const store = new OperationStore({
      root: '/shared',
      instanceId: 'core-1',
      newOperationId: () => `op-${(opSerial += 1)}`,
      newEffectId: () => `effect-${(effectSerial += 1)}`,
      fs,
      now: () => fs.clock,
      sleep: async () => undefined,
      ownerIdentity: async () => ({ pid: 4242, startId: 'harness:owner' }),
    })
    const service = new EnvironmentService({
      store,
      environmentId: 'env-1',
      instanceId: 'core-1',
      newEffectId: () => `effect-${(effectSerial += 1)}`,
      provisioner: null,
      readSnapshot: async () => [],
      // The first record's liveness probe blows up outright — not a normal dead/unknown verdict,
      // a genuinely unexpected failure, the same shape a store error or a reducer refusal this
      // loop did not anticipate would take. The second record's probe must still be reached.
      identityDeps: {
        alive: () => {
          aliveCalls += 1
          if (aliveCalls === 1) throw new Error('probe exploded')
          return false
        },
      },
    })

    await store.createOrGet('env-a', begin({ request_id: 'req-a' }), PLAN_A)
    await store.createOrGet('env-b', begin({ request_id: 'req-b' }), PLAN_A)
    expect(await store.listRecoverable()).toHaveLength(2)

    await service.recover('core-2')

    // The record whose liveness check threw is exactly where it started: `recover`'s per-record
    // `try`/`catch` is its backstop, not a second chance to finish the work that failed. But the
    // throw did not stop the loop — the second record was still reached, found its owner gone,
    // and (with no provisioner to reconcile it) was abandoned, same as the single-record case in
    // "an abandoned operation with nobody to help it" above.
    expect(aliveCalls).toBe(2)
    const opA = await service.get('op-1')
    expect(opA.phase).toBe('checking')
    const opB = await service.get('op-2')
    expect(opB.phase).toBe('failed')
    expect(opB.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
  })
})

describe('never re-running an external step for a lost race (finding 1)', () => {
  it('does not run cleanup twice when two cancels race the same compare-and-swap', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    const release = provisioner.pauseAt('pull')
    const { service } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))

    // Let it reach `pulling-image` and stall there, mid-effect — `pull` is paused, so `idle` would
    // never return; poll instead.
    let phase = ''
    for (let i = 0; i < 200 && phase !== 'pulling-image'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      phase = (await service.get('op-1')).phase
    }
    expect(phase).toBe('pulling-image')

    // Two callers cancel "at once": both compute their transition from the same unlocked read,
    // and the store's compare-and-swap lets only one of them actually commit it.
    await Promise.all([service.cancel('op-1'), service.cancel('op-1')])
    release()
    await settle(service)

    expect((await service.get('op-1')).phase).toBe('cancelled')
    // If the loser had also dispatched the state it was handed back, `cleanup` would have run for
    // both of them.
    expect(provisioner.calls.filter((call) => call === 'cleanup')).toHaveLength(1)
  })
})

describe('shutdown enforces its own deadline (finding 5)', () => {
  it('returns once the signal fires, even while an effect is still ignoring its own abort', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    // A fake that never returns even after `perform`'s own AbortController fires — the case a
    // provisioner step that does not respect its signal looks like from `idle`'s side.
    provisioner.pauseAt('prepare')
    const { service } = harness(provisioner)
    await service.begin('env-1', begin({ approved_plan_digest: PLAN_A }))

    // Wait until the paused step is actually in flight — `perform` dispatches `prepare` from
    // inside the `probe` effect's own handler, which `begin` does not wait for, so it is not yet
    // running the instant `begin` resolves. Aborting before `idle` is actually waiting on it would
    // let even the old, unraced `idle` return quickly by coincidence (nothing to hang on yet),
    // rather than by actually enforcing the deadline.
    for (let i = 0; i < 200 && !provisioner.calls.includes('prepare'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(provisioner.calls).toContain('prepare')

    const controller = new AbortController()
    const started = Date.now()
    const shutdown = service.shutdown(controller.signal)
    controller.abort()
    await shutdown

    // The cap is enforced by the signal firing, not by the effect ever finishing — this resolves
    // in well under the seconds a hung effect would otherwise cost.
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('installation-scoped operations (finding 11 coverage)', () => {
  it('updates an installation by unloading its resident model before activating the new image', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    const { service } = harness(provisioner)
    await service.begin('env-1', {
      request_id: 'req-1',
      target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
      kind: 'update',
      descriptor_id: 'trtllm-1.4.0',
      approved_plan_digest: PLAN_A,
    })
    await settle(service)

    expect((await service.get('op-1')).phase).toBe('ready')
    // An update stages the new image directly (no `prepare-environment`: the environment already
    // exists) and takes the GPU back from the old image before the new one's smoke test can prove
    // itself.
    expect(provisioner.calls).toEqual(['probe', 'pull', 'verify', 'unload', 'activate'])
  })

  it('removes an installation without pulling or verifying anything', async () => {
    const provisioner = new FakeProvisioner({ plan: plan(PLAN_A), host_step: null })
    const { service } = harness(provisioner)
    await service.begin('env-1', {
      request_id: 'req-1',
      target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
      kind: 'remove',
      approved_plan_digest: PLAN_A,
    })
    await settle(service)

    expect((await service.get('op-1')).phase).toBe('removed')
    expect(provisioner.calls).toEqual(['probe', 'remove'])
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
      'checking',
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

describe('reading a cached runtime descriptor (task 2.22)', () => {
  const DESCRIPTOR = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))
  const cache = () => ({
    forInstallation: vi.fn(async (id: string) =>
      id === DESCRIPTOR.descriptor_id
        ? { kind: 'available' as const, descriptor: DESCRIPTOR }
        : {
            kind: 'unsupported' as const,
            error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'not cached', id),
          }
    ),
  })

  it('answers what the cache holds under that id: notices, curated models, architectures', async () => {
    const descriptors = cache()
    const { service } = harness(new FakeProvisioner({ plan: plan(PLAN_A), host_step: null }), { descriptors })
    expect(await service.descriptor(DESCRIPTOR.descriptor_id)).toEqual({
      descriptor_id: DESCRIPTOR.descriptor_id,
      engine_id: DESCRIPTOR.engine_id,
      notices: DESCRIPTOR.notices,
      curated_models: DESCRIPTOR.curated_models,
      supported_architectures: DESCRIPTOR.supported_architectures,
    })
    expect(descriptors.forInstallation).toHaveBeenCalledWith(DESCRIPTOR.descriptor_id)
  })

  it('says MANAGED_METADATA_INVALID, naming the id, for one the cache does not hold', async () => {
    const { service } = harness(new FakeProvisioner({ plan: plan(PLAN_A), host_step: null }), {
      descriptors: cache(),
    })
    await expect(service.descriptor('tensorrt-llm-9.9.9-r1')).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
      details: 'tensorrt-llm-9.9.9-r1',
    })
  })

  it('says MANAGED_ADAPTER_UNAVAILABLE where no host recipe applies, without reading the cache', async () => {
    const descriptors = cache()
    const { service } = harness(null, { descriptors })
    await expect(service.descriptor(DESCRIPTOR.descriptor_id)).rejects.toMatchObject({
      code: 'MANAGED_ADAPTER_UNAVAILABLE',
    })
    expect(descriptors.forInstallation).not.toHaveBeenCalled()
    // A recipe with no descriptor cache wired is no better.
    const bare = harness(new FakeProvisioner({ plan: plan(PLAN_A), host_step: null }))
    await expect(bare.service.descriptor(DESCRIPTOR.descriptor_id)).rejects.toMatchObject({
      code: 'MANAGED_ADAPTER_UNAVAILABLE',
    })
  })
})
