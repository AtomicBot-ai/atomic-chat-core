/**
 * The setup, update and removal state machine, as a pure function.
 *
 * Everything that can fail halfway lives here: a user who must sign out and back in before the
 * `docker` group counts, a machine that must reboot before WSL exists, a package transaction that
 * cannot be interrupted, a core that died between importing a distribution and recording that it
 * did. None of that is testable against a real machine often enough to trust, so the rules are a
 * table: previous state plus one event in, next state and at most one effect intent out. No clock,
 * no ids, no filesystem — the caller supplies those facts and runs the effects.
 *
 * Two invariants hold the rest together. An effect's result is accepted only for the effect that is
 * actually pending, at the revision it was issued at, so a late answer from a superseded attempt
 * cannot move the machine. And nothing privileged happens without a consent whose hash still
 * matches the plan: if the host changed under an approval, the machine goes back to asking.
 */

import type {
  EnvironmentOperation,
  ErrorBody,
  ManagedHostReceipt,
  ManagedHostStep,
  ManagedOperationKind,
  ManagedOperationTarget,
  ManagedPhase,
  RequirementPlan,
  ResumeOperation,
  Sha256Digest,
} from '../../contracts/index.js'
import { err, ok, type Result } from '../../util/index.js'

/** The external work an effect runner performs. The reducer only ever names one. */
export type EffectKind =
  | 'probe'
  | 'host-step'
  | 'prepare-environment'
  | 'pull-image'
  | 'verify'
  | 'unload-resident'
  | 'activate'
  | 'remove'
  | 'cleanup'
  | 'reconcile'

/**
 * One unit of external work. The id is an idempotency identity, not an instruction: what the runner
 * actually does comes from the persisted descriptor and requirement plan, never from a caller.
 */
export interface EffectIntent {
  effect_id: string
  operation_id: string
  expected_revision: number
  kind: EffectKind
  plan_digest: Sha256Digest | null
}

export interface OperationMachine {
  operation: EnvironmentOperation
  pending_effect: EffectIntent | null
  /**
   * A package transaction or a Windows feature enable is running. Cancelling one of those means
   * asking it to stop at its own safe boundary, never killing it: a half-applied package set is
   * worse than a completed one.
   */
  indivisible_host_step_running: boolean
}

export interface EventIdentity {
  effect_id: string
  expected_revision: number
}

export type OperationEvent =
  | ({ type: 'requirements-ready'; plan: RequirementPlan; host_step: ManagedHostStep | null } & EventIdentity)
  | { type: 'approve'; input: ResumeOperation }
  | ({ type: 'host-step-started' } & EventIdentity)
  | ({
      type: 'host-receipt-verified'
      receipt: ManagedHostReceipt
      prerequisites_met: boolean
    } & EventIdentity)
  | ({ type: 'environment-verified' } & EventIdentity)
  | ({ type: 'image-pulled' } & EventIdentity)
  | ({ type: 'verification-passed' } & EventIdentity)
  | ({ type: 'resident-unloaded' } & EventIdentity)
  | ({ type: 'activation-committed' } & EventIdentity)
  | ({ type: 'removal-completed' } & EventIdentity)
  | { type: 'cancel' }
  | ({ type: 'safe-boundary' } & EventIdentity)
  | ({ type: 'cleanup-completed' } & EventIdentity)
  | { type: 'resume'; input: ResumeOperation }
  | ({ type: 'failed'; error: ErrorBody } & EventIdentity)
  | ({
      type: 'reconciled'
      instance_id: string
      verified_completed_step_ids: string[]
      current_plan_digest: Sha256Digest | null
      needs_relogin: boolean
      needs_reboot: boolean
    } & EventIdentity)

export interface TransitionInput {
  /** Allocate at most one external effect per transition; the next transition allocates another. */
  next_effect_id: string
}

export interface StartOperation {
  operation_id: string
  request_id: string
  environment_id: string
  instance_id: string
  target: ManagedOperationTarget
  kind: ManagedOperationKind
  approved_plan_digest?: Sha256Digest
}

type Transition = { state: OperationMachine; effects: EffectIntent[] }

/** Phases from which nothing more happens on its own. */
const TERMINAL: readonly ManagedPhase[] = ['ready', 'removed', 'cancelled', 'failed']

/** Which effect each internal event is the answer to. A result for anything else is not accepted. */
const ANSWERS: Record<string, EffectKind> = {
  'requirements-ready': 'probe',
  'host-step-started': 'host-step',
  'host-receipt-verified': 'host-step',
  'environment-verified': 'prepare-environment',
  'image-pulled': 'pull-image',
  'verification-passed': 'verify',
  'resident-unloaded': 'unload-resident',
  'activation-committed': 'activate',
  'removal-completed': 'remove',
  'cleanup-completed': 'cleanup',
  'reconciled': 'reconcile',
}

const conflict = (why: string): Result<Transition> =>
  err('MANAGED_OPERATION_CONFLICT', 'This event does not apply to the operation.', why)

/**
 * What happens to the work already in flight. `KEEP` is for a transition that records something —
 * a cancellation asked for, a step reported as started — while the effect it is about is still
 * running: dropping the pending effect there would leave its eventual result with nothing to
 * attach to, and the machine would refuse the answer to its own question.
 */
const KEEP = 'keep'
type NextEffect = { kind: EffectKind; input: TransitionInput } | null | typeof KEEP

/** Build the next machine. Every accepted change moves the revision on exactly once. */
const advance = (
  state: OperationMachine,
  operation: Partial<EnvironmentOperation>,
  effect: NextEffect,
  flags: { indivisible?: boolean } = {}
): Result<Transition> => {
  const revision = state.operation.revision + 1
  const next: EnvironmentOperation = { ...state.operation, ...operation, revision }
  const issued: EffectIntent | null =
    effect === null || effect === KEEP
      ? null
      : {
          effect_id: effect.input.next_effect_id,
          operation_id: next.operation_id,
          expected_revision: revision,
          kind: effect.kind,
          plan_digest: next.plan_digest,
        }
  return ok({
    state: {
      operation: next,
      pending_effect: effect === KEEP ? state.pending_effect : issued,
      indivisible_host_step_running: flags.indivisible ?? false,
    },
    effects: issued === null ? [] : [issued],
  })
}

/** A fresh operation: nothing has been touched yet, and the first thing to do is look. */
export function startOperation(input: StartOperation, transition: TransitionInput): Transition {
  const operation: EnvironmentOperation = {
    schema_version: 1,
    operation_id: input.operation_id,
    request_id: input.request_id,
    environment_id: input.environment_id,
    target: input.target,
    kind: input.kind,
    instance_id: input.instance_id,
    revision: 0,
    phase: 'checking',
    plan_digest: null,
    approved_plan_digest: input.approved_plan_digest ?? null,
    progress: null,
    pending_host_step: null,
    completed_step_ids: [],
    cancellation_requested: false,
    error: null,
  }
  const intent: EffectIntent = {
    effect_id: transition.next_effect_id,
    operation_id: operation.operation_id,
    expected_revision: 0,
    kind: 'probe',
    plan_digest: null,
  }
  return {
    state: { operation, pending_effect: intent, indivisible_host_step_running: false },
    effects: [intent],
  }
}

/** Stop and clean up whatever this operation may have started. */
const startCancelling = (state: OperationMachine, input: TransitionInput): Result<Transition> =>
  advance(state, { phase: 'cancelling', cancellation_requested: true }, { kind: 'cleanup', input })

/**
 * Where a plan goes once it is approved and the host is ready for it. Setup builds the environment
 * first; an update only stages a new image over an environment that already exists; a removal has
 * nothing to prepare.
 */
const afterConsent = (
  state: OperationMachine,
  input: TransitionInput,
  hostStep: ManagedHostStep | null
): Result<Transition> => {
  if (hostStep !== null) {
    return advance(
      state,
      { phase: 'preparing-host', pending_host_step: hostStep, error: null },
      { kind: 'host-step', input }
    )
  }
  switch (state.operation.kind) {
    case 'setup':
      return advance(
        state,
        { phase: 'preparing-environment', error: null },
        { kind: 'prepare-environment', input }
      )
    case 'update':
      return advance(state, { phase: 'pulling-image', error: null }, { kind: 'pull-image', input })
    case 'remove':
      return advance(state, { phase: 'removing', error: null }, { kind: 'remove', input })
  }
}

/** After any step that completed, honour a cancellation that arrived while it was running. */
const continueOrCancel = (
  state: OperationMachine,
  input: TransitionInput,
  proceed: () => Result<Transition>
): Result<Transition> => (state.operation.cancellation_requested ? startCancelling(state, input) : proceed())

const failWith = (state: OperationMachine, error: ErrorBody, keepStep = false): Result<Transition> =>
  advance(
    state,
    {
      phase: 'failed',
      error,
      ...(keepStep ? {} : { pending_host_step: null }),
    },
    null
  )

/**
 * Apply one event. Returns the next machine and the effect to run, or a failure explaining why the
 * event does not apply — in which case the caller keeps the state it had.
 */
export function reduceOperation(
  state: OperationMachine,
  event: OperationEvent,
  input: TransitionInput
): Result<Transition> {
  const { operation } = state
  const phase = operation.phase

  // A caller's cancel and resume are not answers to an effect; everything else must be.
  if (event.type !== 'cancel' && event.type !== 'resume' && event.type !== 'approve') {
    const pending = state.pending_effect
    if (pending === null) return conflict(`no effect is pending in ${phase}`)
    if (pending.effect_id !== event.effect_id) return conflict('this is another effect’s result')
    if (event.expected_revision !== operation.revision) {
      return conflict(`result is for revision ${event.expected_revision}, now at ${operation.revision}`)
    }
    const answers = ANSWERS[event.type]
    if (answers !== undefined && answers !== pending.kind) {
      return conflict(`a ${pending.kind} effect cannot answer with ${event.type}`)
    }
  }

  switch (event.type) {
    case 'cancel': {
      if (phase === 'ready' || phase === 'removed' || phase === 'cancelled') return ok({ state, effects: [] })
      if (phase === 'cancelling') return ok({ state, effects: [] })
      if (phase === 'failed') {
        // Nothing was started, so there is nothing to undo.
        return operation.completed_step_ids.length === 0
          ? advance(state, { phase: 'cancelled', cancellation_requested: true }, null)
          : startCancelling(state, input)
      }
      // A package transaction or an atomic activation is running: record the wish and let it finish.
      // Killing the first leaves a half-installed system; interrupting the second would either lose
      // an installation that did commit or claim one that did not.
      if (state.indivisible_host_step_running || phase === 'activating') {
        if (operation.cancellation_requested) return ok({ state, effects: [] })
        return advance(state, { cancellation_requested: true }, KEEP, {
          indivisible: state.indivisible_host_step_running,
        })
      }
      return startCancelling(state, input)
    }

    case 'resume': {
      if (phase === 'ready' || phase === 'removed') return ok({ state, effects: [] })
      if (event.input.expected_revision !== operation.revision) {
        return err(
          'MANAGED_REVISION_CONFLICT',
          'The operation has moved on since this resume was prepared.',
          `expected ${event.input.expected_revision}, now at ${operation.revision}`
        )
      }
      if (
        phase !== 'failed' &&
        phase !== 'cancelled' &&
        phase !== 'relogin-required' &&
        phase !== 'reboot-required'
      ) {
        return conflict(`${phase} is already running`)
      }
      // Never continue from a stored phase: look at the machine first.
      return advance(
        state,
        {
          phase: 'checking',
          error: null,
          cancellation_requested: false,
          approved_plan_digest: event.input.approved_plan_digest ?? operation.approved_plan_digest,
        },
        { kind: 'reconcile', input }
      )
    }

    case 'approve': {
      if (phase !== 'awaiting-consent') return conflict(`nothing is awaiting consent in ${phase}`)
      if (event.input.expected_revision !== operation.revision) {
        return err(
          'MANAGED_REVISION_CONFLICT',
          'The operation has moved on since this approval was prepared.',
          `expected ${event.input.expected_revision}, now at ${operation.revision}`
        )
      }
      const approved = event.input.approved_plan_digest
      if (approved === undefined) {
        return err('MANAGED_CONSENT_REQUIRED', 'This operation needs the plan to be approved.')
      }
      // An approval is not a licence to act on what was true a moment ago: look again first, and
      // let the fresh plan decide whether this consent still covers it.
      return advance(
        state,
        { phase: 'checking', approved_plan_digest: approved, error: null },
        { kind: 'probe', input }
      )
    }

    case 'requirements-ready': {
      if (phase !== 'checking') return conflict(`requirements arrived in ${phase}`)
      if (operation.cancellation_requested) return startCancelling(state, input)
      const plan = event.plan
      const blocker = plan.blockers[0]
      if (blocker !== undefined) {
        return advance(state, { phase: 'failed', plan_digest: plan.plan_digest, error: blocker }, null)
      }
      if (operation.approved_plan_digest !== plan.plan_digest) {
        // Either nothing was approved yet, or the host changed under an approval. Both mean asking.
        const changed = operation.approved_plan_digest !== null
        return advance(
          state,
          {
            phase: 'awaiting-consent',
            plan_digest: plan.plan_digest,
            error: changed
              ? {
                  code: 'MANAGED_PLAN_CHANGED',
                  message: 'What this setup would do has changed; approve it again.',
                }
              : null,
          },
          null
        )
      }
      return afterConsent(
        { ...state, operation: { ...operation, plan_digest: plan.plan_digest } },
        input,
        event.host_step
      )
    }

    case 'host-step-started': {
      if (phase !== 'preparing-host') return conflict(`a host step started in ${phase}`)
      return advance(state, {}, KEEP, { indivisible: true })
    }

    case 'safe-boundary': {
      // The indivisible work reached a point where stopping is safe.
      if (operation.cancellation_requested) return startCancelling(state, input)
      return advance(state, {}, KEEP, { indivisible: false })
    }

    case 'host-receipt-verified': {
      if (phase !== 'preparing-host') return conflict(`a receipt arrived in ${phase}`)
      const { receipt } = event
      const steps = operation.completed_step_ids.includes(receipt.step_id)
        ? operation.completed_step_ids
        : [...operation.completed_step_ids, receipt.step_id]

      if (receipt.outcome === 'declined') {
        return failWith(state, {
          code: 'MANAGED_ELEVATION_DECLINED',
          message: 'The system change was not authorized.',
        })
      }
      if (receipt.outcome === 'failed') {
        return failWith(state, {
          code: 'MANAGED_PREREQUISITE_BLOCKED',
          message: 'Preparing the system did not finish.',
          details: receipt.receipt_id,
        })
      }
      // A completed host step is kept whatever happens next: it changed the machine, and a later
      // cancellation does not un-install a package.
      const kept = { completed_step_ids: steps, pending_host_step: null }
      if (receipt.outcome === 'relogin-required' || receipt.outcome === 'reboot-required') {
        const waiting: ManagedPhase =
          receipt.outcome === 'relogin-required' ? 'relogin-required' : 'reboot-required'
        return operation.cancellation_requested
          ? advance(state, { ...kept, phase: 'cancelling' }, { kind: 'cleanup', input })
          : advance(state, { ...kept, phase: waiting, error: null }, null)
      }
      if (!event.prerequisites_met) {
        // The helper reported success and the machine disagrees. Believe the machine.
        return advance(
          state,
          {
            ...kept,
            phase: 'failed',
            error: {
              code: 'MANAGED_PREREQUISITE_BLOCKED',
              message: 'The system change was reported as done, but the requirement is still missing.',
            },
          },
          null
        )
      }
      return continueOrCancel({ ...state, operation: { ...operation, ...kept } }, input, () =>
        advance(
          { ...state, operation: { ...operation, ...kept } },
          { ...kept, phase: 'preparing-environment', error: null },
          { kind: 'prepare-environment', input }
        )
      )
    }

    case 'reconciled': {
      if (phase !== 'checking') return conflict(`reconciliation answered in ${phase}`)
      const base = {
        instance_id: event.instance_id,
        completed_step_ids: event.verified_completed_step_ids,
        plan_digest: event.current_plan_digest,
        pending_host_step: null,
      }
      if (operation.cancellation_requested) {
        return advance(state, { ...base, phase: 'cancelling' }, { kind: 'cleanup', input })
      }
      // Still waiting on the user: the group is not effective yet, or the machine has not rebooted.
      // The consumed nonce is dropped either way, so nothing re-elevates on its own.
      if (event.needs_relogin) return advance(state, { ...base, phase: 'relogin-required' }, null)
      if (event.needs_reboot) return advance(state, { ...base, phase: 'reboot-required' }, null)
      // The wait is over, or this is a restart mid-operation: look at requirements again.
      return advance(state, base, { kind: 'probe', input })
    }

    case 'environment-verified': {
      if (phase !== 'preparing-environment') return conflict(`the environment was verified in ${phase}`)
      return continueOrCancel(state, input, () =>
        operation.target.kind === 'environment'
          ? advance(state, { phase: 'verifying' }, { kind: 'verify', input })
          : advance(state, { phase: 'pulling-image' }, { kind: 'pull-image', input })
      )
    }

    case 'image-pulled': {
      if (phase !== 'pulling-image') return conflict(`an image arrived in ${phase}`)
      return continueOrCancel(state, input, () =>
        advance(state, { phase: 'verifying', progress: null }, { kind: 'verify', input })
      )
    }

    case 'verification-passed': {
      if (phase !== 'verifying') return conflict(`verification passed in ${phase}`)
      return continueOrCancel(state, input, () => {
        if (operation.target.kind === 'environment') {
          return advance(state, { phase: 'ready', error: null }, null)
        }
        // An update has to take the GPU back from the model that is running on the old image
        // before its smoke test can prove the new one.
        return operation.kind === 'update'
          ? advance(state, { phase: 'activating' }, { kind: 'unload-resident', input })
          : advance(state, { phase: 'activating' }, { kind: 'activate', input })
      })
    }

    case 'resident-unloaded': {
      if (phase !== 'activating') return conflict(`a model was unloaded in ${phase}`)
      return advance(state, {}, { kind: 'activate', input })
    }

    case 'activation-committed': {
      if (phase !== 'activating') return conflict(`an activation committed in ${phase}`)
      // The installation is live. A cancellation that arrived mid-commit lost the race, and saying
      // otherwise would leave the record claiming a descriptor that is actually running.
      return advance(state, { phase: 'ready', cancellation_requested: false, error: null }, null)
    }

    case 'removal-completed': {
      if (phase !== 'removing') return conflict(`a removal completed in ${phase}`)
      return advance(state, { phase: 'removed', error: null }, null)
    }

    case 'cleanup-completed': {
      if (phase !== 'cancelling') return conflict(`cleanup completed in ${phase}`)
      return advance(state, { phase: 'cancelled' }, null)
    }

    case 'failed': {
      if (TERMINAL.includes(phase)) return conflict(`${phase} has already finished`)
      return failWith(state, event.error, true)
    }
  }
}
