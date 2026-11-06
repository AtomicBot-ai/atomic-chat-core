import { randomUUID } from 'node:crypto'
import {
  AtomicCoreError,
  type FastFlowLmAccelerators,
  type FastFlowLmConsent,
  type FastFlowLmHostReceipt,
  type FastFlowLmHostStep,
  type FastFlowLmOperation,
  type FastFlowLmProbePlan,
  type Sha256Digest,
} from '../../../contracts/index.js'
import { AsyncMutex } from '../../../diffusion/index.js'
import { canonicalDigest } from '../../environment/index.js'
import type { FlmManifest } from './manifest.js'
import { RUNTIME_MEMLOCK, RUNTIME_MEMLOCK_DIGEST } from './memlock.js'
import { PreparationJournal, type PreparationRecord } from './operation-journal.js'

interface Options {
  dir: string
  dataRoot?: string
  inspect: (
    pinned?: FlmManifest,
    build?: string | null
  ) => Promise<{ facts: FastFlowLmAccelerators; plan: FastFlowLmProbePlan }>
  facts: () => Promise<FastFlowLmAccelerators>
  pinned: (digest: Sha256Digest) => Promise<FlmManifest | null>
  boot: () => Promise<string | null>
  emit: (operation: FastFlowLmOperation) => void
}
type State = FastFlowLmOperation['state']
const terminal = (state: State) => ['ready', 'failed', 'cancelled'].includes(state)
const invalid = (message: string): never => {
  throw new AtomicCoreError('INVALID_ARGUMENT', message)
}
const identifier = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s)
const digest = (s: unknown) => typeof s === 'string' && /^sha256:[a-f0-9]{64}$/.test(s)
const revision = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const conflict = (why: string): never => {
  throw new AtomicCoreError('MANAGED_OPERATION_CONFLICT', why)
}
function keys(v: unknown, allowed: string[]) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !allowed.includes(k)))
    invalid('Unexpected preparation request fields.')
}
function checkRevision(op: FastFlowLmOperation, n: number) {
  if (!revision(n)) invalid('Expected a non-negative operation revision.')
  if (op.revision !== n)
    throw new AtomicCoreError(
      'MANAGED_REVISION_CONFLICT',
      'Read the latest preparation operation before acting.'
    )
}
function view(plan: FastFlowLmProbePlan): FastFlowLmOperation['plan'] {
  const {
    plan_digest,
    manifest_digest,
    recipe_digest,
    runtime_account,
    runtime_mode,
    runtime_service,
    packages,
    changes,
    blockers,
  } = plan
  return {
    plan_digest,
    manifest_digest,
    recipe_digest,
    runtime_account,
    runtime_mode,
    runtime_service,
    packages,
    changes,
    blockers,
  }
}
function makeStep(
  plan: FastFlowLmProbePlan,
  manifest: FlmManifest | null,
  device: string,
  next: number
): FastFlowLmHostStep {
  if (
    plan.recipe_id === RUNTIME_MEMLOCK.recipe_id &&
    plan.recipe_digest === RUNTIME_MEMLOCK_DIGEST &&
    plan.runtime_process &&
    plan.runtime_account &&
    plan.runtime_mode
  ) {
    const parameters = {
      runtime_account: plan.runtime_account,
      runtime_mode: plan.runtime_mode,
      runtime_service: plan.runtime_service,
      runtime_process: plan.runtime_process,
    }
    return {
      step_id: randomUUID(),
      nonce: randomUUID(),
      expected_operation_revision: next,
      recipe_id: RUNTIME_MEMLOCK.recipe_id,
      recipe_digest: RUNTIME_MEMLOCK_DIGEST,
      action: 'linux.configure-runtime-memlock',
      parameters,
      parameters_digest: canonicalDigest(parameters),
    }
  }
  const recipe = manifest?.recipes.find(
    (r) => r.recipe_id === plan.recipe_id && r.revision === plan.recipe_revision
  )
  if (
    !manifest ||
    !recipe ||
    !plan.runtime_account ||
    !plan.runtime_mode ||
    canonicalDigest(manifest) !== plan.manifest_digest ||
    canonicalDigest(recipe) !== plan.recipe_digest
  )
    throw new AtomicCoreError('MANAGED_PLAN_CHANGED', 'The approved recipe is unavailable.')
  const base = {
    step_id: randomUUID(),
    nonce: randomUUID(),
    expected_operation_revision: next,
    recipe_id: recipe.recipe_id,
    recipe_digest: plan.recipe_digest,
  }
  const common = {
    manifest_id: manifest.manifest_id,
    manifest_digest: plan.manifest_digest,
    recipe_revision: recipe.revision,
    runtime_account: plan.runtime_account,
    runtime_service: plan.runtime_service,
    runtime_mode: plan.runtime_mode,
    environment_manifest: manifest,
    device_instance_id: device,
  }
  if (recipe.action === 'windows.install-amd-npu')
    return { ...base, action: recipe.action, parameters: common, parameters_digest: canonicalDigest(common) }
  const parameters = {
    ...common,
    ...(plan.runtime_process ? { runtime_process: plan.runtime_process } : {}),
    package_names: plan.packages.map((p) => p.name),
    device_access: plan.changes.some((c) => c.code === 'device-access'),
    memlock: plan.changes.some((c) =>
      ['account-memlock', 'service-memlock', 'user-service-memlock'].includes(c.code)
    ),
  }
  return { ...base, action: recipe.action, parameters, parameters_digest: canonicalDigest(parameters) }
}

/** One writer per locked data folder. No privileged process belongs to the coordinator. */
export class PreparationCoordinator {
  private readonly owner = randomUUID()
  private readonly mutex = new AsyncMutex()
  private readonly journal: PreparationJournal
  private closed = false
  constructor(private readonly options: Options) {
    this.journal = new PreparationJournal(options.dir, options.dataRoot)
  }
  private exclusive<T>(work: () => Promise<T>) {
    return this.mutex.run(() => {
      if (this.closed) throw new AtomicCoreError('CORE_NOT_RUNNING', 'The preparation owner has stopped.')
      return work()
    })
  }
  async close() {
    this.closed = true
    await this.mutex.run(async () => {})
  }
  private async save(
    r: PreparationRecord,
    state: State,
    reason: string | null = null,
    step: FastFlowLmHostStep | null = null
  ) {
    if (state !== 'preparing-host') delete r.unclaimedStep
    r.operation = {
      ...r.operation,
      state,
      reason,
      pending_host_step: step,
      revision: r.operation.revision + 1,
    }
    await this.journal.write(r)
    this.options.emit(structuredClone(r.operation))
    return r.operation
  }
  private async admit(id?: string) {
    if (
      (await this.journal.all()).some((r) => r.operation.operation_id !== id && !terminal(r.operation.state))
    )
      conflict('Another FastFlowLM preparation is active.')
  }
  get(id: string) {
    return this.exclusive(async () => (await this.journal.read(id)).operation)
  }
  list() {
    return this.exclusive(async () => (await this.journal.all()).map((r) => r.operation))
  }
  begin(input: { request_id: string }) {
    return this.exclusive(async () => {
      keys(input, ['request_id'])
      if (!identifier(input.request_id)) invalid('Invalid preparation request_id.')
      const prior = (await this.journal.all()).find((r) => r.operation.request_id === input.request_id)
      if (prior) return prior.operation.state === 'checking' ? this.check(prior) : prior.operation
      await this.admit()
      const plan = {
        plan_digest: canonicalDigest(null),
        manifest_digest: null,
        recipe_digest: null,
        runtime_account: null,
        runtime_mode: null,
        runtime_service: null,
        packages: [],
        changes: [],
        blockers: [],
      }
      const r: PreparationRecord = {
        operation: {
          request_id: input.request_id,
          operation_id: randomUUID(),
          revision: 0,
          state: 'checking',
          reason: null,
          plan,
          pending_host_step: null,
        },
        device: null,
        build: null,
        approvedManifest: null,
        boot: null,
        lastReceipt: null,
      }
      await this.save(r, 'checking')
      return this.check(r)
    })
  }
  private async check(r: PreparationRecord) {
    let observation
    try {
      observation = await this.options.inspect(
        r.approvedManifest ?? undefined,
        r.approvedManifest ? r.build : undefined
      )
    } catch (e) {
      return this.save(r, 'failed', String(e))
    }
    return this.offer(r, observation)
  }
  private async offer(r: PreparationRecord, { facts, plan }: Awaited<ReturnType<Options['inspect']>>) {
    r.operation.plan = view(plan)
    r.device = facts.devices.find((d) => d.generation === 'xdna2')?.id ?? null
    r.build = plan.engine_version
    if (plan.status === 'ready') return this.verified(r, facts)
    if (plan.status === 'action-required') return this.save(r, 'awaiting-consent')
    return this.save(r, 'failed', plan.blockers.join(', ') || 'preparation-blocked')
  }
  consent(id: string, input: FastFlowLmConsent) {
    return this.exclusive(async () => {
      keys(input, ['expected_revision', 'approved_plan_digest'])
      if (!digest(input.approved_plan_digest)) invalid('Invalid approved plan digest.')
      const r = await this.journal.read(id),
        op = r.operation
      checkRevision(op, input.expected_revision)
      if (op.state !== 'awaiting-consent') return conflict('The operation is not awaiting consent.')
      const observation = await this.options.inspect(
          r.approvedManifest ?? undefined,
          r.approvedManifest ? r.build : undefined
        ),
        { plan, facts } = observation
      if (
        plan.status !== 'action-required' ||
        plan.plan_digest !== op.plan.plan_digest ||
        plan.plan_digest !== input.approved_plan_digest
      ) {
        if (plan.plan_digest !== op.plan.plan_digest || plan.status !== 'action-required')
          await this.offer(r, observation)
        throw new AtomicCoreError('MANAGED_PLAN_CHANGED', 'The preparation plan must be approved again.')
      }
      const manifest =
        r.approvedManifest ?? (plan.manifest_digest && (await this.options.pinned(plan.manifest_digest)))
      const target = facts.devices.filter((d) => d.generation === 'xdna2')
      if (
        (!manifest && plan.recipe_id !== RUNTIME_MEMLOCK.recipe_id) ||
        target.length !== 1 ||
        target[0]!.id !== r.device
      )
        throw new AtomicCoreError(
          'MANAGED_PLAN_CHANGED',
          'The selected device or pinned manifest has changed.'
        )
      const step = makeStep(plan, manifest, target[0]!.id, op.revision + 2)
      r.approvedManifest = manifest
      r.boot = await this.options.boot()
      r.owner = this.owner
      r.unclaimedStep = step
      return this.save(r, 'preparing-host')
    })
  }
  claim(id: string, input: { expected_revision: number }) {
    return this.exclusive(async () => {
      keys(input, ['expected_revision'])
      const r = await this.journal.read(id)
      checkRevision(r.operation, input.expected_revision)
      const step = r.unclaimedStep
      if (r.operation.state !== 'preparing-host' || !step || r.operation.pending_host_step)
        return conflict('The FastFlowLM host step cannot be claimed.')
      delete r.unclaimedStep
      return this.save(r, 'preparing-host', null, step)
    })
  }
  cancel(id: string) {
    return this.exclusive(async () => {
      const r = await this.journal.read(id),
        op = r.operation
      if (terminal(op.state) || op.reason === 'cancellation-requested') return op
      if (op.pending_host_step)
        return this.save(r, 'preparing-host', 'cancellation-requested', op.pending_host_step)
      return this.save(r, 'cancelled')
    })
  }
  receipt(id: string, input: FastFlowLmHostReceipt) {
    return this.exclusive(async () => {
      keys(input, [
        'receipt_id',
        'nonce',
        'step_id',
        'expected_operation_revision',
        'recipe_digest',
        'parameters_digest',
        'outcome',
        'log_tail',
      ])
      if (
        !identifier(input.receipt_id) ||
        !identifier(input.nonce) ||
        !identifier(input.step_id) ||
        !digest(input.recipe_digest) ||
        !digest(input.parameters_digest) ||
        !revision(input.expected_operation_revision) ||
        ![
          'completed',
          'declined',
          'failed',
          'reboot-required',
          'relogin-required',
          'service-restart-required',
        ].includes(input.outcome) ||
        (input.log_tail !== undefined && typeof input.log_tail !== 'string')
      )
        invalid('Invalid preparation receipt.')
      const r = await this.journal.read(id),
        op = r.operation,
        s = op.pending_host_step
      if (
        op.state !== 'preparing-host' ||
        !s ||
        s.nonce !== input.nonce ||
        s.step_id !== input.step_id ||
        s.expected_operation_revision !== input.expected_operation_revision
      )
        throw new AtomicCoreError(
          'MANAGED_RECEIPT_CONFLICT',
          'The receipt is stale, already consumed or belongs to another step.'
        )
      if (
        s.recipe_digest !== input.recipe_digest ||
        s.parameters_digest !== input.parameters_digest ||
        canonicalDigest(s.parameters) !== s.parameters_digest
      )
        throw new AtomicCoreError(
          'MANAGED_HOST_STEP_INVALID',
          'The receipt digests do not match the authorization.'
        )
      const outcome = input.outcome
      if (
        outcome === 'service-restart-required' &&
        (!s.parameters.runtime_service || s.action !== 'linux.install-amd-npu')
      )
        invalid('This authorization cannot require a service restart.')
      if (outcome === 'relogin-required' && s.action !== 'linux.install-amd-npu')
        invalid('This authorization cannot require a new login.')
      r.lastReceipt = {
        ...input,
        ...(input.log_tail === undefined ? {} : { log_tail: input.log_tail.slice(-16384) }),
      }
      if (op.reason === 'cancellation-requested') return this.save(r, 'cancelled')
      if (outcome === 'failed' || outcome === 'declined')
        return this.save(r, 'failed', r.lastReceipt.log_tail || outcome)
      if (outcome === 'reboot-required' || outcome === 'relogin-required')
        return this.save(r, outcome, outcome)
      if (outcome === 'service-restart-required')
        return this.save(r, 'relogin-required', 'restart-service: ' + s.parameters.runtime_service)
      await this.save(r, 'verifying')
      return this.verify(r)
    })
  }
  private async verify(r: PreparationRecord) {
    let facts: FastFlowLmAccelerators
    try {
      facts = await this.options.facts()
    } catch (e) {
      return this.save(r, 'failed', String(e))
    }
    return this.verified(r, facts)
  }
  private async verified(r: PreparationRecord, facts: FastFlowLmAccelerators) {
    const op = r.operation
    if (
      !facts.runtime_account ||
      !facts.runtime_mode ||
      facts.runtime_account !== op.plan.runtime_account ||
      facts.runtime_mode !== op.plan.runtime_mode ||
      facts.runtime_service !== op.plan.runtime_service
    )
      return this.save(r, 'failed', 'runtime-identity-changed')
    const target = facts.devices.filter((d) => d.generation === 'xdna2')
    if (target.length !== 1 || target[0]!.id !== r.device) return this.save(r, 'failed', 'npu-target-changed')
    if (facts.engine_version && r.build !== facts.engine_version)
      return this.save(r, 'failed', 'engine-build-changed')
    if (
      facts.ready &&
      facts.blockers.length === 0 &&
      target[0]!.ready &&
      target[0]!.xrt_visible === true &&
      facts.engine_version
    )
      return this.save(r, 'ready')
    if (op.state === 'relogin-required' || op.state === 'reboot-required') return op
    return this.save(r, 'failed', facts.reason ?? facts.blockers[0] ?? 'npu-not-ready')
  }
  private async reconcile(r: PreparationRecord) {
    const op = r.operation
    if (op.state === 'preparing-host' || op.state === 'reboot-required' || op.state === 'relogin-required') {
      const current = await this.options.boot()
      if (
        (!current || !r.boot || current === r.boot) &&
        !(op.state === 'relogin-required' && r.owner && r.owner !== this.owner)
      )
        return op.state === 'preparing-host' ? op : this.verify(r)
      if (op.reason === 'cancellation-requested') return this.save(r, 'cancelled')
      await this.save(r, 'verifying')
    }
    if (r.operation.state === 'checking') return this.check(r)
    if (['verifying', 'reboot-required', 'relogin-required'].includes(r.operation.state))
      return this.verify(r)
    return r.operation
  }
  resume(id: string, expected: number) {
    return this.exclusive(async () => {
      const r = await this.journal.read(id)
      checkRevision(r.operation, expected)
      if (r.operation.state === 'failed') {
        await this.admit(id)
        await this.save(r, 'checking')
        return this.check(r)
      }
      return this.reconcile(r)
    })
  }
  recover() {
    return this.exclusive(async () => {
      for (const r of await this.journal.all()) if (!terminal(r.operation.state)) await this.reconcile(r)
    })
  }
}
