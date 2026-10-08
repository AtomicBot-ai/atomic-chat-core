/**
 * The part that actually runs a setup: it holds the record, decides nothing itself, and turns each
 * decision the reducer makes into one piece of external work.
 *
 * The split matters because the two halves fail differently. The reducer is a table and is proved
 * by reading it. Everything the machine does — probing a host, pulling sixteen gigabytes, asking
 * for a password, importing a distribution — fails in ways nobody enumerates in advance, so it all
 * arrives here through injected seams that a test can make fail at any point.
 *
 * Two things are deliberate. Work is committed with the revision it was computed from, so a result
 * from an attempt that has been superseded is dropped instead of applied. And the privileged step
 * is not work this service performs: it hands the step out, and waits for the app to come back with
 * a receipt, which is then verified against the machine rather than believed.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type {
  BeginOperation,
  EnvironmentDiagnostics,
  EnvironmentOperation,
  EnvironmentResetResult,
  EnvironmentSnapshot,
  ErrorBody,
  ManagedHostReceipt,
  ManagedHostStep,
  ManagedPhase,
  ManagedProgress,
  ProbeEnvironmentInput,
  RequirementPlan,
  ResumeOperation,
  RuntimeDescriptorSummary,
} from '../../contracts/index.js'
import { identityPermitsTakeover, verifyProcessIdentity } from '../../lock/index.js'
import type { IdentityDeps } from '../../lock/index.js'
import { beginFingerprint } from './canonical-json.js'
import { summarizeRuntimeDescriptor } from './descriptor.js'
import type { RuntimeDescriptorProvider } from './descriptor-provider.js'
import { recoverOperation, type EffectInventory } from './recovery.js'
import { reduceOperation, type EffectIntent, type OperationEvent } from './state.js'
import { classifyReceipt, withReceipt, type OperationStore, type PersistedOperation } from './store.js'
import { poolsExhaustedIn } from './host-step-failure.js'

/** What the probe that follows a host-step receipt shows. The receipt itself is never believed. */
export interface HostStepVerdict {
  /** Nothing is left to install or authorize: the setup may go on. */
  prerequisites_met: boolean
  /** The `docker` group is granted, the daemon runs, and only a sign-in is missing. */
  needs_relogin: boolean
  /** What is still missing, as the operation's failure when neither of the above holds. */
  error: ErrorBody | null
  /**
   * A failed step whose log shows Docker found no free address pool: whether `daemon.json` sets
   * `bip` or `default-address-pools` (task 2.23, review round 1). Absent otherwise.
   */
  address_pools_configured?: boolean | 'unknown'
}

/** A probe's answer: the plan, the privileged step it needs if any, and whether the image is there. */
export interface ProvisionerProbe {
  plan: RequirementPlan
  host_step: ManagedHostStep | null
  /** The runtime image this operation installs is already present by digest (restart mid-pull). */
  image_present?: boolean
}

/** What a host recipe can do. One implementation per platform; none of it is decided here. */
export interface EnvironmentProvisioner {
  /** Read the machine and say what setting this up would involve. Never changes anything. */
  probe(record: PersistedOperation, signal: AbortSignal): Promise<ProvisionerProbe>
  /** Re-probe after a host-step receipt that claims the step ran (task 2.6). Changes nothing. */
  verifyHostStep(record: PersistedOperation, signal: AbortSignal): Promise<HostStepVerdict>
  /**
   * Whether `/etc/docker/daemon.json` sets `bip` or `default-address-pools` — read-only, asked only
   * to explain a failed step whose log shows Docker found no free address pool (task 2.23). Absent
   * where the host has no such file (off Linux).
   */
  addressPoolsConfigured?(): Promise<boolean | 'unknown'>
  /**
   * `own` records, durably and at once, resources the step is about to create, before it creates
   * them (`OperationStore.recordOwned`): what the operation later removes is only what it made.
   */
  prepare(
    record: PersistedOperation,
    signal: AbortSignal,
    own: (resourceIds: string[]) => Promise<void>
  ): Promise<void>
  pull(
    record: PersistedOperation,
    onProgress: (progress: ManagedProgress) => void,
    signal: AbortSignal
  ): Promise<void>
  verify(record: PersistedOperation, signal: AbortSignal): Promise<void>
  /** Take the GPU back from whatever is running on the digest being replaced. */
  unloadResident(record: PersistedOperation, signal: AbortSignal): Promise<void>
  activate(record: PersistedOperation, signal: AbortSignal): Promise<void>
  remove(record: PersistedOperation, signal: AbortSignal): Promise<void>
  /** Undo only what this operation tentatively created. Never touches what it did not make. */
  cleanup(record: PersistedOperation, signal: AbortSignal): Promise<void>
  inventory: EffectInventory
}

export interface EnvironmentServiceOptions {
  store: OperationStore
  environmentId: string
  instanceId: string
  newEffectId: () => string
  /**
   * Null when this host has no qualified recipe. The probe then answers with a blocker rather than
   * failing: an unsupported machine is a fact to report, not a transport error.
   */
  provisioner: EnvironmentProvisioner | null
  readSnapshot: () => Promise<EnvironmentSnapshot[]>
  emit?: (event: 'environment:operation', payload: EnvironmentOperation) => void
  /**
   * How to tell whether the process that last wrote a record (`PersistedOperation.owner_pid`) is
   * still running — real process checks by default (`src/lock/process-identity.ts`, the same
   * primitive `InstanceLock` uses for its own takeover decision); tests inject a fake so recovery
   * is deterministic instead of depending on what is actually alive on the machine running them.
   */
  identityDeps?: IdentityDeps
  /** The clock progress ticks are throttled by; `Date.now` by default. */
  now?: () => number
  /**
   * The descriptor cache `descriptor()` answers from (task 2.22). Only `forInstallation`, the
   * cache-only read: this service is never handed a way to fetch a descriptor for that call.
   */
  descriptors?: Pick<RuntimeDescriptorProvider, 'forInstallation'>
  /**
   * Called after `reset()` archived finished operations, with their ids: the snapshot's own view of
   * operations forgets them and is published again. Absent in tests that do not look.
   */
  onReset?: (archivedIds: string[]) => void
  /** Builds `diagnostics()`'s report; absent where nothing assembles one (tests). */
  diagnostics?: () => Promise<EnvironmentDiagnostics>
  /** The archive folder's name for a reset: a sortable UTC time by default. */
  resetStamp?: () => string
  /**
   * A reinstall (`beginReinstall`) began, or its chain ended: the setup it began finished one way or
   * another, or the removal ended without `removed`. Called with the engine id.
   */
  onReinstall?: (engineId: string, moment: 'started' | 'finished') => void
}

/** What `beginReinstall` takes: the client's idempotency key, the installation, the release to set up. */
export interface BeginReinstall {
  request_id: string
  target: Extract<BeginOperation['target'], { kind: 'runtime' }>
  descriptor_id: string
}

const unsupported = (input: {
  environment_id: string
  target: BeginOperation['target']
}): RequirementPlan => ({
  plan_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  environment_id: input.environment_id,
  target: input.target,
  availability: 'unsupported',
  recipe_id: 'none',
  recipe_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  descriptor_id: null,
  environment_manifest_id: null,
  image_digest: null,
  adopts_existing_engine: false,
  system_changes: [],
  download_bytes: null,
  required_disk_bytes: null,
  docker_root_dir: null,
  free_disk_bytes: null,
  requires_elevation: false,
  may_require_relogin: false,
  may_require_reboot: false,
  blockers: [
    {
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message: 'Managed runtimes are not available on this system yet.',
    },
  ],
  warnings: [],
})

const notFound = (operationId: string): AtomicCoreError =>
  new AtomicCoreError('MANAGED_OPERATION_NOT_FOUND', 'No such operation.', operationId)

const TERMINAL: readonly ManagedPhase[] = ['ready', 'removed', 'cancelled', 'failed']

/** Phases in which an operation waits on the user, with no core working on it. */
const WAITING: readonly ManagedPhase[] = ['awaiting-consent', 'relogin-required', 'reboot-required']

/** How often byte progress of a pull is announced, at most. The first tick always goes out. */
export const PROGRESS_EMIT_INTERVAL_MS = 250

/** How many times a receipt is re-read and re-applied after losing a compare-and-swap. */
const RECEIPT_ATTEMPTS = 3

const receiptConflict = (why: string, details?: string): AtomicCoreError =>
  new AtomicCoreError('MANAGED_RECEIPT_CONFLICT', why, details)

/** Resolves once `signal` fires; never, if there is no signal to wait on. */
const whenAborted = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

export class EnvironmentService {
  private readonly options: EnvironmentServiceOptions
  private readonly aborts = new Map<string, AbortController>()
  /**
   * Byte progress of a pull in flight, by operation. Kept in memory and announced on
   * `environment:operation` without a new revision: the pull effect was issued at the current
   * revision and has to answer at it, so a revision per tick would make its own result stale.
   */
  private readonly progress = new Map<string, ManagedProgress>()
  /** The last state of each operation this service announced: what a progress tick is checked against. */
  private readonly latest = new Map<string, EnvironmentOperation>()
  private running = new Set<Promise<void>>()
  private stopped = false

  constructor(options: EnvironmentServiceOptions) {
    this.options = options
  }

  async list(): Promise<EnvironmentSnapshot[]> {
    return this.options.readSnapshot()
  }

  /** What setting this up would involve, without touching the machine. */
  async probe(input: ProbeEnvironmentInput): Promise<RequirementPlan> {
    const environmentId = input.environment_id ?? this.options.environmentId
    if (this.options.provisioner === null) {
      return unsupported({ environment_id: environmentId, target: input.target })
    }
    const record = this.speculative(environmentId, input)
    const controller = new AbortController()
    const { plan } = await this.options.provisioner.probe(record, controller.signal)
    return plan
  }

  /**
   * One cached runtime descriptor, as a client shows it (task 2.22): read from the cache by id, never
   * fetched, so asking cannot change which descriptor an installation or a plan names.
   * `MANAGED_ADAPTER_UNAVAILABLE` where no host recipe applies (off Linux), like a probe answering
   * `unsupported` there; `MANAGED_METADATA_INVALID` for an id this core has not cached.
   */
  async descriptor(descriptorId: string): Promise<RuntimeDescriptorSummary> {
    if (this.options.provisioner === null || this.options.descriptors === undefined) {
      throw new AtomicCoreError(
        'MANAGED_ADAPTER_UNAVAILABLE',
        'Managed runtimes are not available on this system.'
      )
    }
    const cached = await this.options.descriptors.forInstallation(descriptorId)
    if (cached.kind !== 'available') {
      throw new AtomicCoreError(
        'MANAGED_METADATA_INVALID',
        'This core has no cached runtime descriptor with that id.',
        descriptorId
      )
    }
    return summarizeRuntimeDescriptor(cached.descriptor)
  }

  /**
   * Put the environment's bookkeeping back to "nothing was ever attempted" without uninstalling
   * anything: every finished operation is archived, so no failed setup is shown or resumed any more
   * and the next setup starts from a fresh probe — with whatever descriptor conf serves now, not the
   * one an old consent pinned. Refused with `MANAGED_OPERATION_CONFLICT` while an operation is still
   * running. The distribution, the images, the models, the installation records and the cached conf
   * documents stay exactly as they are; removing those is `remove`'s job.
   */
  async reset(environmentId: string): Promise<EnvironmentResetResult> {
    if (environmentId !== this.options.environmentId) {
      throw new AtomicCoreError('MANAGED_OPERATION_NOT_FOUND', 'No such environment.', environmentId)
    }
    const stamp = this.options.resetStamp?.() ?? new Date().toISOString().replace(/[:.]/g, '-')
    const archived = await this.options.store.archiveFinished(stamp)
    for (const id of archived.ids) this.latest.delete(id)
    this.options.onReset?.(archived.ids)
    return {
      environment_id: environmentId,
      archived_operation_ids: archived.ids,
      archive_path: archived.path,
    }
  }

  /** A read-only report on the environment for a support message (`EnvironmentDiagnostics`). */
  async diagnostics(environmentId: string): Promise<EnvironmentDiagnostics> {
    if (environmentId !== this.options.environmentId) {
      throw new AtomicCoreError('MANAGED_OPERATION_NOT_FOUND', 'No such environment.', environmentId)
    }
    if (this.options.diagnostics === undefined) {
      throw new AtomicCoreError(
        'MANAGED_ADAPTER_UNAVAILABLE',
        'Managed runtimes are not available on this system.'
      )
    }
    return this.options.diagnostics()
  }

  /**
   * Start, or hand back the operation this request already started.
   *
   * Recovery only runs when a core starts, so an operation whose core died while another core kept
   * running would refuse every later `begin` on its environment until that other core restarted.
   * When the operation in the way belongs to a process that can be shown to be gone, it is ended
   * here instead (task 2.6), and the new request goes ahead.
   */
  async begin(environmentId: string, input: BeginOperation): Promise<EnvironmentOperation> {
    return (await this.beginWith(environmentId, input)).record.machine.operation
  }

  private async beginWith(
    environmentId: string,
    input: BeginOperation,
    chain: Pick<PersistedOperation, 'follow_up' | 'reinstall_of'> = {}
  ): Promise<{ record: PersistedOperation; created: boolean }> {
    const fingerprint = beginFingerprint(input)
    let result: { record: PersistedOperation; created: boolean }
    try {
      result = await this.options.store.createOrGet(environmentId, input, fingerprint, chain)
    } catch (error) {
      if (!(await this.endAbandonedBlocker(error))) throw error
      result = await this.options.store.createOrGet(environmentId, input, fingerprint, chain)
    }
    if (result.created) {
      // Announced from its first state, so the snapshot and the event stream both show it at once.
      this.announce(result.record.machine.operation)
      this.dispatch(result.record)
    }
    return result
  }

  /**
   * The plan a removal of `target` would show, computed as the removal's own probe computes it: what
   * a caller consenting on the user's behalf approves (a reinstall, `DELETE /engines/…`). Changes
   * nothing.
   */
  async planRemoval(
    environmentId: string,
    target: BeginOperation['target'],
    retainModels: boolean
  ): Promise<RequirementPlan> {
    if (this.options.provisioner === null) return unsupported({ environment_id: environmentId, target })
    const record = this.speculative(
      environmentId,
      { target },
      { kind: 'remove', retain_models: retainModels }
    )
    const controller = new AbortController()
    return (await this.options.provisioner.probe(record, controller.signal)).plan
  }

  /**
   * Reinstall an engine from a newer release (change `unify-engine-lifecycle`, design D6): a removal
   * that keeps the models, approved here — the client's call to update is the consent to remove — and
   * on disk the setup that follows it. The setup is begun by this core once the removal ends
   * `removed` (or by the next core, if this one stops first), and it asks for consent like any
   * setup: the new image is tens of gigabytes. A retried request answers the same removal.
   */
  async beginReinstall(environmentId: string, input: BeginReinstall): Promise<EnvironmentOperation> {
    const plan = await this.planRemoval(environmentId, input.target, true)
    const { record, created } = await this.beginWith(
      environmentId,
      {
        request_id: input.request_id,
        target: input.target,
        kind: 'remove',
        retain_models: true,
        approved_plan_digest: plan.plan_digest,
      },
      {
        follow_up: {
          kind: 'setup',
          descriptor_id: input.descriptor_id,
          request_id: `${input.request_id}:setup`,
        },
      }
    )
    if (created) this.options.onReinstall?.(input.target.engine_id, 'started')
    return record.machine.operation
  }

  /** The setup a `removed` reinstall names; idempotent by its request id, across cores and restarts. */
  private async beginFollowUp(record: PersistedOperation): Promise<void> {
    const follow = record.follow_up
    if (follow === undefined || this.stopped) return
    await this.beginWith(
      record.machine.operation.environment_id,
      {
        request_id: follow.request_id,
        target: record.request.target,
        kind: 'setup',
        descriptor_id: follow.descriptor_id,
      },
      { reinstall_of: record.machine.operation.operation_id }
    )
  }

  /** A finished operation that is part of a reinstall moves the chain on, or ends it. */
  private async afterFinished(operation: EnvironmentOperation): Promise<void> {
    const record = await this.options.store.read(operation.operation_id).catch(() => null)
    if (record === null) return
    const engine = operation.target.kind === 'runtime' ? operation.target.engine_id : null
    if (record.follow_up !== undefined) {
      if (operation.phase === 'removed') await this.beginFollowUp(record)
      else if (engine !== null) this.options.onReinstall?.(engine, 'finished')
    }
    if (record.reinstall_of !== undefined && engine !== null) this.options.onReinstall?.(engine, 'finished')
  }

  async get(operationId: string): Promise<EnvironmentOperation> {
    const record = await this.options.store.read(operationId)
    if (record === null) throw notFound(operationId)
    return this.withProgress(record.machine.operation)
  }

  async cancel(operationId: string): Promise<EnvironmentOperation> {
    const { record: next, owned } = await this.apply(operationId, { type: 'cancel' })
    // Stop the work in flight; whether that ends the operation now or at a safe boundary is the
    // reducer's call, and it has already been made.
    this.aborts.get(operationId)?.abort()
    // Cancelling usually issues cleanup of its own, and nobody else will run it — but only when
    // this call is the one that actually committed the transition: dispatching the fresh state a
    // lost race handed back would run whatever the *winner* already dispatched a second time.
    if (owned) this.dispatch(next)
    return next.machine.operation
  }

  /** Approve a plan, or continue after a sign-out, a reboot, a failure or a cancellation. */
  async resume(operationId: string, input: ResumeOperation): Promise<EnvironmentOperation> {
    const current = await this.options.store.read(operationId)
    if (current === null) throw notFound(operationId)
    const event: OperationEvent =
      current.machine.operation.phase === 'awaiting-consent'
        ? { type: 'approve', input }
        : { type: 'resume', input }
    const { record: next, owned } = await this.apply(operationId, event)
    // Approving or resuming always starts by looking at the machine again; run that look — unless
    // this call lost the race to commit it, in which case whoever won already will.
    if (owned) this.dispatch(next)
    return next.machine.operation
  }

  /**
   * Take the app's word for what the OS prompt did, then check it. A receipt is an assertion: the
   * machine is re-probed before the step counts as done, and a helper that claims success it cannot
   * show is refused by the reducer.
   *
   * A receipt is bound to the pending step by all of its identity: step id, single-use nonce, the
   * revision the step was issued at, and the recipe and parameter digests. A nonce already used —
   * the identical receipt again included — a nonce this operation is not waiting for, or another
   * revision is `MANAGED_RECEIPT_CONFLICT` (spec "Повтор квитанции"); a client that lost the answer
   * reads the operation instead. Recording the nonce and applying the transition are one
   * compare-and-swap, so a receipt that races itself is applied once: the loser re-reads, finds its
   * nonce spent, and is refused.
   */
  async acceptHostReceipt(operationId: string, receipt: ManagedHostReceipt): Promise<EnvironmentOperation> {
    for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
      const current = await this.options.store.read(operationId)
      if (current === null) throw notFound(operationId)
      if (classifyReceipt(current, receipt) === 'duplicate') {
        // The same authorization arriving twice authorizes nothing a second time.
        throw receiptConflict(
          'This authorization was already used; nothing was applied again.',
          receipt.nonce
        )
      }
      const pending = current.machine.operation.pending_host_step
      if (pending === null || pending.nonce !== receipt.nonce || pending.step_id !== receipt.step_id) {
        throw receiptConflict(
          'That result does not match the authorization this operation is waiting for.',
          receipt.step_id
        )
      }
      if (pending.expected_operation_revision !== receipt.expected_operation_revision) {
        throw receiptConflict(
          'That result is for another revision of this operation.',
          `step issued at ${pending.expected_operation_revision}, receipt names ${receipt.expected_operation_revision}`
        )
      }
      if (
        pending.recipe_digest !== receipt.recipe_digest ||
        pending.parameters_digest !== receipt.parameters_digest
      ) {
        throw new AtomicCoreError(
          'MANAGED_HOST_STEP_INVALID',
          'That result is for other recipe bytes or parameters than the step that was authorized.',
          receipt.step_id
        )
      }

      const verdict = await this.verdictFor(current, receipt)
      const result = reduceOperation(
        current.machine,
        {
          type: 'host-receipt-verified',
          effect_id: current.machine.pending_effect?.effect_id ?? '',
          expected_revision: current.machine.operation.revision,
          receipt,
          prerequisites_met: verdict.prerequisites_met,
          needs_relogin: verdict.needs_relogin,
          ...(verdict.error === null ? {} : { probe_error: verdict.error }),
          ...(verdict.address_pools_configured === undefined
            ? {}
            : { address_pools_configured: verdict.address_pools_configured }),
        },
        { next_effect_id: this.options.newEffectId() }
      )
      if (!result.ok) {
        throw new AtomicCoreError(result.error.code, result.error.message, result.error.details)
      }
      const next: PersistedOperation = { ...withReceipt(current, receipt), machine: result.value.state }
      const swapped = await this.options.store.compareAndSwap(
        operationId,
        current.machine.operation.revision,
        next
      )
      if (!swapped) continue // someone moved it meanwhile; look again, and maybe it was us
      this.announce(next.machine.operation)
      this.dispatch(next)
      return next.machine.operation
    }
    throw new AtomicCoreError(
      'MANAGED_OPERATION_CONFLICT',
      'The operation kept changing while this result was being recorded; send it again.',
      operationId
    )
  }

  /**
   * Pick up whatever the previous core left behind, against what this machine actually shows.
   *
   * A non-terminal operation is not automatically abandoned: app and CLI cores share this store,
   * so the core that wrote it may simply still be running it right now. Only when the recorded
   * owner (`PersistedOperation.owner_pid`) can be shown to be gone does this core touch the
   * record — otherwise two cores would drive the same operation at once, each believing the other
   * is not there.
   */
  async recover(instanceId: string): Promise<void> {
    const pending = await this.options.store.listRecoverable()
    for (const record of pending) {
      // One record's recovery failing outright (a store error, a reducer refusal this loop did
      // not anticipate) must not stop the rest of the list from being looked at — the next core
      // start, or a client's own `resume`, gets another chance at whichever record it was.
      try {
        if (await this.ownerAlive(record)) continue

        if (this.options.provisioner === null) {
          // No recipe exists to reconcile against, so this operation can never move on its own —
          // and with nothing to skip it for (its owner is gone), leaving it non-terminal would
          // block every later `begin` on this environment with MANAGED_OPERATION_CONFLICT forever.
          await this.failAbandoned(record)
          continue
        }

        const outcome = await recoverOperation(record, {
          instanceId,
          newEffectId: this.options.newEffectId,
          inventory: this.options.provisioner.inventory,
        })
        if (outcome.kind === 'unchanged') continue
        const swapped = await this.options.store.compareAndSwap(
          record.machine.operation.operation_id,
          record.machine.operation.revision,
          outcome.record
        )
        if (!swapped) continue
        this.announce(outcome.record.machine.operation)
        if (outcome.kind === 'reconciled') this.dispatch(outcome.record)
      } catch {
        continue
      }
    }
    // A reinstall whose removal ended `removed` while no core was there to begin its setup. Begun by
    // its derived request id, so one that exists already (this core's, or the other scope's) is
    // answered instead of started again.
    for (const record of await this.options.store.listAll().catch(() => [] as PersistedOperation[])) {
      if (record.follow_up === undefined || record.machine.operation.phase !== 'removed') continue
      await this.beginFollowUp(record).catch(() => undefined)
    }
  }

  /** Stop what is in flight. The intent stays on disk, so the next core resumes from it. */
  async shutdown(signal: AbortSignal): Promise<void> {
    this.stopped = true
    for (const controller of this.aborts.values()) controller.abort()
    await this.idle(signal)
  }

  /**
   * Resolves when nothing is running, or when `signal` fires — whichever comes first. Used by
   * shutdown, and by tests that drive a whole flow to completion.
   *
   * Racing the signal against the wait itself, not just checking it between iterations, is what
   * actually enforces a caller's deadline: a single effect that ignores its own abort (a
   * provisioner step that does not return promptly, or a test double that never resolves) would
   * otherwise leave nothing to check between — `Promise.allSettled` on one such promise simply
   * never settles, and the loop never reaches its next look at `signal.aborted`.
   */
  async idle(signal?: AbortSignal): Promise<void> {
    while (this.running.size > 0) {
      if (signal?.aborted === true) return
      await Promise.race([Promise.allSettled([...this.running]), whenAborted(signal)])
    }
  }

  /** A record shaped like the one a real operation would have, for a probe that starts nothing. */
  private speculative(
    environmentId: string,
    input: Pick<ProbeEnvironmentInput, 'target'> & { descriptor_id?: string },
    as: Pick<BeginOperation, 'kind' | 'retain_models'> = { kind: 'setup' }
  ): PersistedOperation {
    const request: BeginOperation = {
      request_id: 'probe',
      target: input.target,
      kind: as.kind,
      ...(input.descriptor_id !== undefined ? { descriptor_id: input.descriptor_id } : {}),
      ...(as.retain_models !== undefined ? { retain_models: as.retain_models } : {}),
    }
    return {
      machine: {
        operation: {
          schema_version: 1,
          operation_id: 'probe',
          request_id: 'probe',
          environment_id: environmentId,
          target: input.target,
          kind: as.kind,
          instance_id: this.options.instanceId,
          revision: 0,
          phase: 'checking',
          plan_digest: null,
          approved_plan_digest: null,
          carried_plan_digest: null,
          progress: null,
          pending_host_step: null,
          completed_step_ids: [],
          cancellation_requested: false,
          error: null,
        },
        pending_effect: null,
        indivisible_host_step_running: false,
      },
      request_digest: beginFingerprint(request),
      request,
      requirement_plan: null,
      accepted_receipt_digests: {},
      completed_effect_ids: [],
      owned_resource_ids: [],
      // A probe never reaches the store: there is no owner to record.
      owner_pid: null,
      owner_process_start_id: null,
    }
  }

  /**
   * What the machine shows after a receipt. A refusal or a failure changed nothing, so there is
   * nothing to look at; a receipt claiming the step ran is checked by a fresh probe.
   */
  private async verdictFor(
    record: PersistedOperation,
    receipt: ManagedHostReceipt
  ): Promise<HostStepVerdict> {
    const provisioner = this.options.provisioner
    if (
      receipt.outcome === 'failed' &&
      poolsExhaustedIn(receipt.log_tail) &&
      provisioner?.addressPoolsConfigured
    ) {
      // Which of Docker's two pool failures it was is in daemon.json, read now (task 2.23).
      const configured = await provisioner.addressPoolsConfigured().catch(() => 'unknown' as const)
      return {
        prerequisites_met: false,
        needs_relogin: false,
        error: null,
        address_pools_configured: configured,
      }
    }
    if (receipt.outcome === 'declined' || receipt.outcome === 'failed' || provisioner === null) {
      return { prerequisites_met: false, needs_relogin: false, error: null }
    }
    return provisioner.verifyHostStep(record, new AbortController().signal)
  }

  /**
   * Announce a committed state, and remember it as the operation's current one while it runs. A
   * finished operation is forgotten, so this map stays as small as what is in flight.
   */
  private announce(operation: EnvironmentOperation): void {
    const finished = TERMINAL.includes(operation.phase)
    if (finished) this.latest.delete(operation.operation_id)
    else this.latest.set(operation.operation_id, operation)
    this.options.emit?.('environment:operation', operation)
    if (finished) this.track(this.afterFinished(operation))
  }

  /** Work that `idle()` and `shutdown()` wait for, like a dispatched effect. */
  private track(work: Promise<void>): void {
    const task = work.catch(() => undefined)
    this.running.add(task)
    void task.finally(() => this.running.delete(task))
  }

  /** `current` is the pull `pulling` started at, still: same phase, same revision. Unknown counts as still. */
  private stillPulling(current: EnvironmentOperation | undefined, pulling: EnvironmentOperation): boolean {
    return (
      current === undefined || (current.phase === 'pulling-image' && current.revision === pulling.revision)
    )
  }

  /** The operation with the byte progress of a pull still in flight, when there is one. */
  private withProgress(operation: EnvironmentOperation): EnvironmentOperation {
    const live = this.progress.get(operation.operation_id)
    return live !== undefined && operation.phase === 'pulling-image'
      ? { ...operation, progress: live }
      : operation
  }

  /**
   * `begin` was refused because another operation is running on this environment. If that
   * operation's owner is provably gone, end it and say so; the caller then tries again once.
   */
  private async endAbandonedBlocker(error: unknown): Promise<boolean> {
    if (!(error instanceof AtomicCoreError) || error.code !== 'MANAGED_OPERATION_CONFLICT') return false
    if (error.details === undefined) return false
    const running = await this.options.store.read(error.details).catch(() => null)
    if (running === null || TERMINAL.includes(running.machine.operation.phase)) return false
    // Waiting on the user is not abandonment: a consent not yet given, or a sign-in or reboot the
    // operation continues after at the next core start, stays theirs (review r1, item 6).
    if (WAITING.includes(running.machine.operation.phase)) return false
    if (await this.ownerAlive(running)) return false
    await this.failAbandoned(running, {
      code: 'MANAGED_OPERATION_CONFLICT',
      message: 'The core that was running this operation is gone; a new operation replaced it.',
    })
    return true
  }

  /**
   * Apply one event and commit it against the revision it was computed from.
   *
   * `owned: false` means somebody else — another call in this core, or the other core over the
   * same shared store — committed a change to this operation between this call's read and its
   * compare-and-swap. Its own transition never happened; `record` is simply the current state,
   * handed back so the caller has something to return. The caller must not dispatch on it: the
   * write that *did* land already came from a call whose own `apply` returned `owned: true`, and
   * that call already dispatched whatever comes next. Dispatching again here would run the same
   * external step (a pull, an activation, a removal) a second time for no reason a retry would.
   */
  private async apply(
    operationId: string,
    event: OperationEvent,
    patch: Pick<Partial<PersistedOperation>, 'requirement_plan'> = {}
  ): Promise<{ record: PersistedOperation; owned: boolean }> {
    const current = await this.options.store.read(operationId)
    if (current === null) throw notFound(operationId)
    const result = reduceOperation(current.machine, event, {
      next_effect_id: this.options.newEffectId(),
    })
    if (!result.ok) {
      throw new AtomicCoreError(result.error.code, result.error.message, result.error.details)
    }
    const next: PersistedOperation = { ...current, ...patch, machine: result.value.state }
    const swapped = await this.options.store.compareAndSwap(
      operationId,
      current.machine.operation.revision,
      next
    )
    if (!swapped) {
      // Somebody else moved the operation while this event was being computed.
      const fresh = await this.options.store.read(operationId)
      if (fresh === null) throw notFound(operationId)
      return { record: fresh, owned: false }
    }
    this.announce(next.machine.operation)
    return { record: next, owned: true }
  }

  /**
   * Whether the process that last wrote `record` (`owner_pid`) can still be shown to be running.
   * `unknown` counts as alive, the same as `InstanceLock`'s own takeover decision: an unproven
   * claim that a core is gone must not let a second core start driving the same operation.
   */
  private async ownerAlive(record: PersistedOperation): Promise<boolean> {
    const pid = record.owner_pid
    if (pid === null) return false // nothing was ever recorded; there is no owner to protect
    const verdict = await verifyProcessIdentity(pid, record.owner_process_start_id, this.options.identityDeps)
    return !identityPermitsTakeover(verdict)
  }

  /**
   * Give up on an operation whose owner is gone and that no provisioner exists to reconcile: with
   * no recipe to check the host against, this operation can never reach a terminal phase on its
   * own, and leaving it non-terminal would refuse every later `begin` on its environment forever
   * (`MANAGED_OPERATION_CONFLICT`, `OperationStore.createOrGet`'s busy check).
   */
  private async failAbandoned(
    record: PersistedOperation,
    error: ErrorBody = {
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message:
        'The core that started this operation is gone, and managed runtimes are not available on this system yet.',
    }
  ): Promise<void> {
    const operationId = record.machine.operation.operation_id
    const pending = record.machine.pending_effect
    if (pending !== null) {
      await this.apply(operationId, {
        type: 'failed',
        effect_id: pending.effect_id,
        expected_revision: record.machine.operation.revision,
        error,
      }).catch(() => undefined)
      return
    }
    // Nothing is pending — awaiting consent, or waiting on a sign-out or reboot that will never
    // come from a core that is gone. `cancel` is the one event the reducer accepts without a
    // pending effect; it issues a `cleanup` effect, which the no-provisioner branch of `perform`
    // (below) turns into the same failure `execute` would have reported for real work. `recover`'s
    // own per-record `try`/`catch` is the backstop; this one keeps a refusal here from reading as
    // an operation this call still owes a result to.
    const applied = await this.apply(operationId, { type: 'cancel' }).catch(() => null)
    if (applied?.owned === true) this.dispatch(applied.record)
  }

  /** Run whatever the machine is now waiting on, without making the caller wait for it. */
  private dispatch(record: PersistedOperation): void {
    const effect = record.machine.pending_effect
    if (effect === null || this.stopped) return
    const task = this.perform(record, effect).catch(() => undefined)
    this.running.add(task)
    void task.finally(() => this.running.delete(task))
  }

  private async perform(record: PersistedOperation, effect: EffectIntent): Promise<void> {
    const provisioner = this.options.provisioner
    const operationId = record.machine.operation.operation_id
    const controller = new AbortController()
    this.aborts.set(operationId, controller)
    const identity = { effect_id: effect.effect_id, expected_revision: effect.expected_revision }

    try {
      if (effect.kind === 'probe') {
        const answer =
          provisioner === null
            ? { plan: unsupported(record.machine.operation), host_step: null }
            : await provisioner.probe(record, controller.signal)
        // The plan is kept with the record: it names the descriptor this operation installs, so a
        // later probe, the pull and the activation all resolve the same one (design D7).
        const { record: next, owned } = await this.apply(
          operationId,
          {
            type: 'requirements-ready',
            ...identity,
            plan: answer.plan,
            host_step: answer.host_step,
            ...('image_present' in answer && answer.image_present !== undefined
              ? { image_present: answer.image_present }
              : {}),
          },
          { requirement_plan: answer.plan }
        )
        if (owned) this.dispatch(next)
        return
      }

      if (effect.kind === 'reconcile' && provisioner !== null) {
        // An explicit resume: the same questions recovery asks at startup, then the reducer decides
        // whether to keep waiting or to look at requirements again.
        const inventory = provisioner.inventory
        const [steps, planDigest, needsRelogin, needsReboot] = await Promise.all([
          inventory.verifyCompletedSteps(record),
          inventory.currentPlanDigest(record),
          inventory.needsRelogin(record),
          inventory.needsReboot(record),
        ])
        const { record: next, owned } = await this.apply(operationId, {
          type: 'reconciled',
          ...identity,
          instance_id: this.options.instanceId,
          verified_completed_step_ids: steps,
          current_plan_digest: planDigest,
          needs_relogin: needsRelogin,
          needs_reboot: needsReboot,
        })
        if (owned) this.dispatch(next)
        return
      }

      if (effect.kind === 'host-step') {
        // The privileged work belongs to the app. Say it has begun — from here until the receipt
        // arrives, a cancellation is recorded rather than acted on — and wait.
        await this.apply(operationId, { type: 'host-step-started', ...identity })
        return
      }

      if (provisioner === null) {
        await this.apply(operationId, {
          type: 'failed',
          ...identity,
          error: {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            message: 'Managed runtimes are not available on this system yet.',
          },
        })
        return
      }

      const done = await this.execute(provisioner, effect, record, controller.signal)
      const { record: next, owned } = await this.apply(operationId, {
        ...done,
        ...identity,
      } as OperationEvent)
      if (owned) this.dispatch(next)
    } catch (error) {
      const failure =
        error instanceof AtomicCoreError
          ? {
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            }
          : { code: 'IO_ERROR' as const, message: (error as Error).message }
      // A refusal from the reducer means this result no longer applies; there is nothing to record.
      if (error instanceof AtomicCoreError && error.code === 'MANAGED_OPERATION_CONFLICT') return
      await this.apply(operationId, { type: 'failed', ...identity, error: failure }).catch(() => undefined)
    } finally {
      if (this.aborts.get(operationId) === controller) this.aborts.delete(operationId)
    }
  }

  private async execute(
    provisioner: EnvironmentProvisioner,
    effect: EffectIntent,
    record: PersistedOperation,
    signal: AbortSignal
  ): Promise<{ type: OperationEvent['type'] }> {
    switch (effect.kind) {
      case 'prepare-environment':
        await provisioner.prepare(record, signal, (ids) =>
          this.options.store.recordOwned(record.machine.operation.operation_id, ids)
        )
        return { type: 'environment-verified' }
      case 'pull-image': {
        const operation = record.machine.operation
        const now = this.options.now ?? Date.now
        let last: number | null = null
        try {
          await provisioner.pull(
            record,
            (progress) => {
              // Only for the operation as it stands now: a tick still streaming after a cancel (or
              // any other transition) committed must not announce the pull as current again.
              if (!this.stillPulling(this.latest.get(operation.operation_id), operation)) return
              this.progress.set(operation.operation_id, progress)
              const at = now()
              const final = progress.total !== null && progress.completed === progress.total
              if (last !== null && !final && at - last < PROGRESS_EMIT_INTERVAL_MS) return
              last = at
              // The shared record decides, not only what this core announced: the other scope's
              // core may have cancelled it (review r2, item E). Checked again once it answers.
              void this.options.store
                .read(operation.operation_id)
                .then((stored) => {
                  const latest = this.latest.get(operation.operation_id)
                  if (!this.stillPulling(stored?.machine.operation, operation)) return
                  if (!this.stillPulling(latest, operation)) return
                  this.options.emit?.('environment:operation', { ...operation, progress })
                })
                .catch(() => undefined)
            },
            signal
          )
        } finally {
          this.progress.delete(operation.operation_id)
        }
        return { type: 'image-pulled' }
      }
      case 'verify':
        await provisioner.verify(record, signal)
        return { type: 'verification-passed' }
      case 'unload-resident':
        await provisioner.unloadResident(record, signal)
        return { type: 'resident-unloaded' }
      case 'activate':
        await provisioner.activate(record, signal)
        return { type: 'activation-committed' }
      case 'remove':
        await provisioner.remove(record, signal)
        return { type: 'removal-completed' }
      case 'cleanup':
        await provisioner.cleanup(record, signal)
        return { type: 'cleanup-completed' }
      default:
        throw new AtomicCoreError('MANAGED_OPERATION_CONFLICT', `Nothing runs a ${effect.kind} here.`)
    }
  }
}
