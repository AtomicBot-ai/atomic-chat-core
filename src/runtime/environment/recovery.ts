/**
 * Picking an operation back up after the core that was running it went away.
 *
 * The record says what was intended, and it is behind by definition: the crash that made recovery
 * necessary is most likely to have happened between doing something and writing down that it was
 * done. So the stored phase is never treated as a result. A recovered operation goes back to
 * looking at the machine, and only what the machine can be made to prove is adopted.
 *
 * Proof means identity, never a name. A WSL distribution called `atomic-app` or a container with a
 * familiar label is not evidence that this operation created it — the user may have one of their
 * own, or a previous install may have left one behind. Something that exists but cannot be shown to
 * be ours stops the operation and is reported, because the alternatives are both bad: adopting it
 * would hand a stranger's distribution to the runtime, and removing it would delete their data.
 */

import type { ErrorBody, Sha256Digest } from '../../contracts/index.js'
import { reduceOperation, type EffectIntent, type OperationMachine } from './state.js'
import type { PersistedOperation } from './store.js'

/** What the machine shows for the work that was in flight when the core disappeared. */
export type EffectFinding =
  /** It finished. These are the exact resources it can be shown to have created. */
  | { kind: 'completed'; owned_resource_ids: string[] }
  /** Nothing of it is there, so running it again is safe. */
  | { kind: 'absent' }
  /** Something is in its place that this operation cannot claim. */
  | { kind: 'foreign'; detail: string }

/**
 * The questions recovery asks about the real machine. Every answer is verified against identity the
 * operation recorded or can derive; none of them is a name match.
 */
export interface EffectInventory {
  inspect(effect: EffectIntent, record: PersistedOperation): Promise<EffectFinding>
  /** Linux: the `docker` group is granted but not yet effective for this session. */
  needsRelogin(record: PersistedOperation): Promise<boolean>
  needsReboot(record: PersistedOperation): Promise<boolean>
  /** Which recorded host steps are still evidently applied. */
  verifyCompletedSteps(record: PersistedOperation): Promise<string[]>
  /** What the plan hashes to now, or null when it cannot be computed yet. */
  currentPlanDigest(record: PersistedOperation): Promise<Sha256Digest | null>
}

export interface RecoveryDeps {
  /** The core doing the recovering. The operation keeps its own id; only the owner changes. */
  instanceId: string
  newEffectId: () => string
  inventory: EffectInventory
}

export type RecoveryOutcome =
  /** Finished before the crash, or finished since. Nothing to do. */
  | { kind: 'unchanged'; record: PersistedOperation }
  | { kind: 'reconciled'; record: PersistedOperation; effects: EffectIntent[] }
  /** Stopped on purpose: something is there that this operation may neither use nor remove. */
  | { kind: 'blocked'; record: PersistedOperation; error: ErrorBody }

const TERMINAL = ['ready', 'removed', 'cancelled', 'failed'] as const

const unique = (values: string[]): string[] => [...new Set(values)]

/**
 * The state a restarted core starts from: the same operation, owned by this core, with nothing in
 * flight and a single question outstanding — what is actually on this machine? Any single-use
 * authorization the old core was holding is dropped here, so nothing can re-elevate on its own.
 */
const restarted = (
  machine: OperationMachine,
  deps: RecoveryDeps
): { machine: OperationMachine; intent: EffectIntent } => {
  const revision = machine.operation.revision + 1
  const intent: EffectIntent = {
    effect_id: deps.newEffectId(),
    operation_id: machine.operation.operation_id,
    expected_revision: revision,
    kind: 'reconcile',
    plan_digest: machine.operation.plan_digest,
  }
  return {
    machine: {
      operation: {
        ...machine.operation,
        instance_id: deps.instanceId,
        revision,
        phase: 'checking',
        pending_host_step: null,
        progress: null,
        error: null,
      },
      pending_effect: intent,
      indivisible_host_step_running: false,
    },
    intent,
  }
}

/**
 * Reconcile one operation against the machine and hand back the state a running core can continue
 * from. The decision about what to do next stays in the reducer; this only supplies the facts.
 */
export async function recoverOperation(
  record: PersistedOperation,
  deps: RecoveryDeps
): Promise<RecoveryOutcome> {
  const { machine } = record
  if ((TERMINAL as readonly string[]).includes(machine.operation.phase)) {
    return { kind: 'unchanged', record }
  }

  let adopted = record.owned_resource_ids
  const pending = machine.pending_effect
  if (pending !== null) {
    const finding = await deps.inventory.inspect(pending, record)
    if (finding.kind === 'foreign') {
      const error: ErrorBody = {
        code: 'MANAGED_IDENTITY_MISMATCH',
        message: 'Something this setup would have created is already there and is not ours.',
        details: finding.detail,
      }
      const stopped = restarted(machine, deps)
      return {
        kind: 'blocked',
        record: {
          ...record,
          machine: {
            operation: { ...stopped.machine.operation, phase: 'failed', error },
            pending_effect: null,
            indivisible_host_step_running: false,
          },
        },
        error,
      }
    }
    if (finding.kind === 'completed') {
      // Adopt exactly what was verified, and only once: a second recovery of the same completed
      // effect must not make it look like two distributions were imported.
      adopted = unique([...adopted, ...finding.owned_resource_ids])
    }
  }

  const [steps, planDigest, needsRelogin, needsReboot] = await Promise.all([
    deps.inventory.verifyCompletedSteps(record),
    deps.inventory.currentPlanDigest(record),
    deps.inventory.needsRelogin(record),
    deps.inventory.needsReboot(record),
  ])

  const start = restarted(machine, deps)
  const applied = reduceOperation(
    start.machine,
    {
      type: 'reconciled',
      effect_id: start.intent.effect_id,
      expected_revision: start.machine.operation.revision,
      instance_id: deps.instanceId,
      verified_completed_step_ids: steps,
      current_plan_digest: planDigest,
      needs_relogin: needsRelogin,
      needs_reboot: needsReboot,
    },
    { next_effect_id: deps.newEffectId() }
  )
  if (!applied.ok) {
    return {
      kind: 'blocked',
      record: { ...record, owned_resource_ids: adopted },
      error: applied.error,
    }
  }

  return {
    kind: 'reconciled',
    record: { ...record, machine: applied.value.state, owned_resource_ids: adopted },
    effects: applied.value.effects,
  }
}
