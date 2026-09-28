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
  EnvironmentOperation,
  EnvironmentSnapshot,
  ManagedHostReceipt,
  ManagedHostStep,
  ManagedProgress,
  ProbeEnvironmentInput,
  RequirementPlan,
  ResumeOperation,
} from '../../contracts/index.js'
import { identityPermitsTakeover, verifyProcessIdentity } from '../../lock/index.js'
import type { IdentityDeps } from '../../lock/index.js'
import { beginFingerprint } from './canonical-json.js'
import { recoverOperation, type EffectInventory } from './recovery.js'
import { reduceOperation, type EffectIntent, type OperationEvent } from './state.js'
import { classifyReceipt, withReceipt, type OperationStore, type PersistedOperation } from './store.js'

/** What a host recipe can do. One implementation per platform; none of it is decided here. */
export interface EnvironmentProvisioner {
  /** Read the machine and say what setting this up would involve. Never changes anything. */
  probe(
    record: PersistedOperation,
    signal: AbortSignal
  ): Promise<{ plan: RequirementPlan; host_step: ManagedHostStep | null }>
  prepare(record: PersistedOperation, signal: AbortSignal): Promise<void>
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
  adopts_existing_engine: false,
  system_changes: [],
  download_bytes: null,
  required_disk_bytes: null,
  requires_elevation: false,
  may_require_relogin: false,
  may_require_reboot: false,
  blockers: [
    {
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message: 'Managed runtimes are not available on this system yet.',
    },
  ],
})

const notFound = (operationId: string): AtomicCoreError =>
  new AtomicCoreError('MANAGED_OPERATION_NOT_FOUND', 'No such operation.', operationId)

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

  /** Start, or hand back the operation this request already started. */
  async begin(environmentId: string, input: BeginOperation): Promise<EnvironmentOperation> {
    const { record, created } = await this.options.store.createOrGet(
      environmentId,
      input,
      beginFingerprint(input)
    )
    if (created) this.dispatch(record)
    return record.machine.operation
  }

  async get(operationId: string): Promise<EnvironmentOperation> {
    const record = await this.options.store.read(operationId)
    if (record === null) throw notFound(operationId)
    return record.machine.operation
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
   */
  async acceptHostReceipt(operationId: string, receipt: ManagedHostReceipt): Promise<EnvironmentOperation> {
    const current = await this.options.store.read(operationId)
    if (current === null) throw notFound(operationId)
    if (classifyReceipt(current, receipt) === 'duplicate') {
      // The same authorization arriving twice is a retry, not a second authorization.
      return current.machine.operation
    }
    const pending = current.machine.operation.pending_host_step
    if (pending === null || pending.nonce !== receipt.nonce || pending.step_id !== receipt.step_id) {
      throw new AtomicCoreError(
        'MANAGED_HOST_STEP_INVALID',
        'That result does not match the authorization this operation is waiting for.',
        receipt.step_id
      )
    }
    const met =
      receipt.outcome === 'completed' &&
      this.options.provisioner !== null &&
      (await this.prerequisitesMet(current))

    const recorded = withReceipt(current, receipt)
    await this.options.store.compareAndSwap(operationId, recorded.machine.operation.revision, recorded)
    const { record: next, owned } = await this.apply(operationId, {
      type: 'host-receipt-verified',
      effect_id: current.machine.pending_effect?.effect_id ?? '',
      expected_revision: current.machine.operation.revision,
      receipt,
      prerequisites_met: met,
    })
    if (owned) this.dispatch(next)
    return next.machine.operation
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
        this.options.emit?.('environment:operation', outcome.record.machine.operation)
        if (outcome.kind === 'reconciled') this.dispatch(outcome.record)
      } catch {
        continue
      }
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
  private speculative(environmentId: string, input: ProbeEnvironmentInput): PersistedOperation {
    const request: BeginOperation = {
      request_id: 'probe',
      target: input.target,
      kind: 'setup',
      descriptor_id: input.descriptor_id,
    }
    return {
      machine: {
        operation: {
          schema_version: 1,
          operation_id: 'probe',
          request_id: 'probe',
          environment_id: environmentId,
          target: input.target,
          kind: 'setup',
          instance_id: this.options.instanceId,
          revision: 0,
          phase: 'checking',
          plan_digest: null,
          approved_plan_digest: null,
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

  private async prerequisitesMet(record: PersistedOperation): Promise<boolean> {
    const provisioner = this.options.provisioner
    if (provisioner === null) return false
    const [relogin, reboot] = await Promise.all([
      provisioner.inventory.needsRelogin(record),
      provisioner.inventory.needsReboot(record),
    ])
    return !relogin && !reboot
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
    event: OperationEvent
  ): Promise<{ record: PersistedOperation; owned: boolean }> {
    const current = await this.options.store.read(operationId)
    if (current === null) throw notFound(operationId)
    const result = reduceOperation(current.machine, event, {
      next_effect_id: this.options.newEffectId(),
    })
    if (!result.ok) {
      throw new AtomicCoreError(result.error.code, result.error.message, result.error.details)
    }
    const next: PersistedOperation = { ...current, machine: result.value.state }
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
    this.options.emit?.('environment:operation', next.machine.operation)
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
  private async failAbandoned(record: PersistedOperation): Promise<void> {
    const operationId = record.machine.operation.operation_id
    const pending = record.machine.pending_effect
    const error = {
      code: 'MANAGED_PREREQUISITE_BLOCKED' as const,
      message:
        'The core that started this operation is gone, and managed runtimes are not available on this system yet.',
    }
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
        const { record: next, owned } = await this.apply(operationId, {
          type: 'requirements-ready',
          ...identity,
          plan: answer.plan,
          host_step: answer.host_step,
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
        await provisioner.prepare(record, signal)
        return { type: 'environment-verified' }
      case 'pull-image':
        // Byte progress is dropped for now: recording it is a state change like any other, so it
        // needs a throttle before a sixteen-gigabyte pull writes a revision per chunk. The route
        // and event that carry it land with the real executor (T05c/T06c).
        await provisioner.pull(record, () => undefined, signal)
        return { type: 'image-pulled' }
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
