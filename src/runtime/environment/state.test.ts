import { describe, expect, it } from 'vitest'
import type {
  ManagedHostStep,
  ManagedOperationKind,
  ManagedOperationTarget,
  RequirementPlan,
  Sha256Digest,
} from '../../contracts/index.js'
import { reduceOperation, startOperation, type OperationEvent, type OperationMachine } from './state.js'

const RUNTIME: ManagedOperationTarget = {
  kind: 'runtime',
  installation_id: 'inst-1',
  engine_id: 'tensorrt-llm',
}
const ENVIRONMENT: ManagedOperationTarget = { kind: 'environment' }

const HOST_STEP: ManagedHostStep = {
  step_id: 'step-1',
  action: 'linux.install-container-runtime',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: 'sha256:re',
  parameters_digest: 'sha256:pa',
  nonce: 'once-1',
  expected_operation_revision: 1,
}

const plan = (digest: Sha256Digest, over: Partial<RequirementPlan> = {}): RequirementPlan => ({
  plan_digest: digest,
  environment_id: 'env-1',
  target: RUNTIME,
  availability: 'setup-required',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: 'sha256:re',
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

/** Drives the machine, allocating a fresh effect id per transition like the service does. */
class Driver {
  machine: OperationMachine
  effects: { kind: string; effect_id: string }[] = []
  private serial = 0

  constructor(kind: ManagedOperationKind = 'setup', target = RUNTIME, approved?: Sha256Digest) {
    const started = startOperation(
      {
        operation_id: 'op-1',
        request_id: 'req-1',
        environment_id: 'env-1',
        instance_id: 'core-1',
        target,
        kind,
        ...(approved === undefined ? {} : { approved_plan_digest: approved }),
      },
      { next_effect_id: this.next() }
    )
    this.machine = started.state
    this.record(started.effects)
  }

  private next(): string {
    this.serial += 1
    return `effect-${this.serial}`
  }

  private record(effects: { kind: string; effect_id: string }[]): void {
    for (const effect of effects) this.effects.push({ kind: effect.kind, effect_id: effect.effect_id })
  }

  /** Fills in the identity of whatever effect is pending, which is what a real runner reports. */
  reply(event: Record<string, unknown>): OperationEvent {
    const pending = this.machine.pending_effect
    if (pending === null) throw new Error('no effect is pending')
    return {
      ...event,
      effect_id: pending.effect_id,
      expected_revision: this.machine.operation.revision,
    } as OperationEvent
  }

  apply(event: OperationEvent): OperationMachine {
    const result = reduceOperation(this.machine, event, { next_effect_id: this.next() })
    if (!result.ok) throw new Error(`refused: ${result.error.code} (${result.error.details ?? ''})`)
    this.machine = result.value.state
    this.record(result.value.effects)
    return this.machine
  }

  refuse(event: OperationEvent): string {
    const before = this.machine
    const result = reduceOperation(this.machine, event, { next_effect_id: this.next() })
    if (result.ok) throw new Error('expected the event to be refused')
    // A refusal never moves the machine.
    expect(this.machine).toBe(before)
    return result.error.code
  }

  get phase(): string {
    return this.machine.operation.phase
  }
  get pending(): string | null {
    return this.machine.pending_effect?.kind ?? null
  }
  kinds(kind: string): number {
    return this.effects.filter((effect) => effect.kind === kind).length
  }
}

describe('startOperation', () => {
  it('begins by looking, before anything on the machine has been touched', () => {
    const driver = new Driver()
    expect(driver.phase).toBe('checking')
    expect(driver.pending).toBe('probe')
    expect(driver.machine.operation.revision).toBe(0)
    expect(driver.machine.operation.completed_step_ids).toEqual([])
    expect(driver.effects).toHaveLength(1)
  })
})

describe('consent (OP02)', () => {
  it('asks for approval, refuses one made for a plan the host has since changed, then proceeds', () => {
    const driver = new Driver()
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    expect(driver.phase).toBe('awaiting-consent')
    expect(driver.machine.operation.plan_digest).toBe('sha256:A')
    expect(driver.pending).toBeNull()

    // The user approves A; the machine looks again and the host now yields plan B.
    driver.apply({
      type: 'approve',
      input: { expected_revision: driver.machine.operation.revision, approved_plan_digest: 'sha256:A' },
    })
    expect(driver.phase).toBe('checking')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:B'), host_step: HOST_STEP }))

    // Back to asking, with the new plan, and the privileged step was never issued.
    expect(driver.phase).toBe('awaiting-consent')
    expect(driver.machine.operation.plan_digest).toBe('sha256:B')
    expect(driver.machine.operation.error?.code).toBe('MANAGED_PLAN_CHANGED')
    expect(driver.kinds('host-step')).toBe(0)

    // Approving B at the revision it is really at issues exactly one host step.
    driver.apply({
      type: 'approve',
      input: { expected_revision: driver.machine.operation.revision, approved_plan_digest: 'sha256:B' },
    })
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:B'), host_step: HOST_STEP }))
    expect(driver.phase).toBe('preparing-host')
    expect(driver.kinds('host-step')).toBe(1)
    expect(driver.machine.operation.pending_host_step).toEqual(HOST_STEP)
    expect(driver.machine.operation.error).toBeNull()
  })

  it('refuses an approval prepared against a revision the operation has left', () => {
    const driver = new Driver()
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    expect(
      driver.refuse({ type: 'approve', input: { expected_revision: 0, approved_plan_digest: 'sha256:A' } })
    ).toBe('MANAGED_REVISION_CONFLICT')
  })

  it('refuses an approval that carries no plan at all', () => {
    const driver = new Driver()
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    expect(
      driver.refuse({
        type: 'approve',
        input: { expected_revision: driver.machine.operation.revision },
      })
    ).toBe('MANAGED_CONSENT_REQUIRED')
  })

  it('goes straight on when the approval already in hand still matches (OP09, adopted engine)', () => {
    // A host that already runs containers with a GPU needs no privileged step at all.
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(
      driver.reply({
        type: 'requirements-ready',
        plan: plan('sha256:A', {
          adopts_existing_engine: true,
          system_changes: [],
          requires_elevation: false,
        }),
        host_step: null,
      })
    )
    expect(driver.phase).toBe('preparing-environment')
    expect(driver.kinds('host-step')).toBe(0)
  })

  it('fails with the blocker rather than asking to approve something that cannot work', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(
      driver.reply({
        type: 'requirements-ready',
        plan: plan('sha256:A', {
          blockers: [{ code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'No NVIDIA driver was found.' }],
        }),
        host_step: null,
      })
    )
    expect(driver.phase).toBe('failed')
    expect(driver.machine.operation.error?.message).toContain('NVIDIA driver')
    expect(driver.effects).toHaveLength(1)
  })
})

describe('waiting on the user (OP09)', () => {
  const toRelogin = (): Driver => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: HOST_STEP }))
    driver.apply(driver.reply({ type: 'host-step-started' }))
    driver.apply(
      driver.reply({
        type: 'host-receipt-verified',
        prerequisites_met: false,
        receipt: {
          step_id: 'step-1',
          nonce: 'once-1',
          expected_operation_revision: 1,
          recipe_digest: 'sha256:re',
          parameters_digest: 'sha256:pa',
          outcome: 'relogin-required',
          receipt_id: 'receipt-1',
        },
      })
    )
    return driver
  }

  it('holds the phase across restarts while the group is not effective, then continues once', () => {
    const driver = toRelogin()
    expect(driver.phase).toBe('relogin-required')
    expect(driver.machine.operation.completed_step_ids).toEqual(['step-1'])
    // The single-use nonce is gone, so nothing can re-elevate on its own.
    expect(driver.machine.operation.pending_host_step).toBeNull()

    for (const instance of ['core-2', 'core-3']) {
      driver.apply({ type: 'resume', input: { expected_revision: driver.machine.operation.revision } })
      expect(driver.pending).toBe('reconcile')
      driver.apply(
        driver.reply({
          type: 'reconciled',
          instance_id: instance,
          verified_completed_step_ids: ['step-1'],
          current_plan_digest: 'sha256:A',
          needs_relogin: true,
          needs_reboot: false,
        })
      )
      expect(driver.phase).toBe('relogin-required')
      expect(driver.machine.operation.instance_id).toBe(instance)
    }
    // Two restarts, and still not one step of installation.
    expect(driver.kinds('prepare-environment')).toBe(0)
    expect(driver.kinds('host-step')).toBe(1)

    // The user signs out and back in: the group counts, and the machine looks once more.
    driver.apply({ type: 'resume', input: { expected_revision: driver.machine.operation.revision } })
    driver.apply(
      driver.reply({
        type: 'reconciled',
        instance_id: 'core-4',
        verified_completed_step_ids: ['step-1'],
        current_plan_digest: 'sha256:A',
        needs_relogin: false,
        needs_reboot: false,
      })
    )
    expect(driver.phase).toBe('checking')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    expect(driver.phase).toBe('preparing-environment')
    expect(driver.kinds('prepare-environment')).toBe(1)
    expect(driver.kinds('host-step')).toBe(1)
  })

  it('waits for a reboot the same way, and keeps the step that was already applied', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: HOST_STEP }))
    driver.apply(driver.reply({ type: 'host-step-started' }))
    driver.apply(
      driver.reply({
        type: 'host-receipt-verified',
        prerequisites_met: false,
        receipt: { ...HOST_STEP, outcome: 'reboot-required', receipt_id: 'r', nonce: 'once-1' } as never,
      })
    )
    expect(driver.phase).toBe('reboot-required')
    expect(driver.machine.operation.completed_step_ids).toEqual(['step-1'])
  })
})

describe('privileged steps', () => {
  const atHostStep = (): Driver => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: HOST_STEP }))
    return driver
  }

  it('stops when the user declines the system change', () => {
    const driver = atHostStep()
    driver.apply(driver.reply({ type: 'host-step-started' }))
    driver.apply(
      driver.reply({
        type: 'host-receipt-verified',
        prerequisites_met: false,
        receipt: { ...HOST_STEP, outcome: 'declined', receipt_id: 'r' } as never,
      })
    )
    expect(driver.phase).toBe('failed')
    expect(driver.machine.operation.error?.code).toBe('MANAGED_ELEVATION_DECLINED')
    expect(driver.kinds('prepare-environment')).toBe(0)
  })

  it('believes the machine over a helper that reports success it cannot show', () => {
    const driver = atHostStep()
    driver.apply(driver.reply({ type: 'host-step-started' }))
    driver.apply(
      driver.reply({
        type: 'host-receipt-verified',
        prerequisites_met: false,
        receipt: { ...HOST_STEP, outcome: 'completed', receipt_id: 'r' } as never,
      })
    )
    expect(driver.phase).toBe('failed')
    expect(driver.machine.operation.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
  })

  it('cancels only at the safe boundary of a package transaction (OP04)', () => {
    const driver = atHostStep()
    driver.apply(driver.reply({ type: 'host-step-started' }))
    expect(driver.machine.indivisible_host_step_running).toBe(true)

    driver.apply({ type: 'cancel' })
    // The wish is recorded; the transaction is not killed, and nothing new is started.
    expect(driver.machine.operation.cancellation_requested).toBe(true)
    expect(driver.phase).toBe('preparing-host')
    expect(driver.pending).toBe('host-step')
    const afterCancel = driver.effects.length

    // A second cancel changes nothing at all.
    const revision = driver.machine.operation.revision
    driver.apply({ type: 'cancel' })
    expect(driver.machine.operation.revision).toBe(revision)
    expect(driver.effects).toHaveLength(afterCancel)

    driver.apply(
      driver.reply({
        type: 'host-receipt-verified',
        prerequisites_met: true,
        receipt: { ...HOST_STEP, outcome: 'completed', receipt_id: 'r' } as never,
      })
    )
    expect(driver.phase).toBe('cancelling')
    expect(driver.pending).toBe('cleanup')
    // The installed package stays recorded; cancelling does not un-install it.
    expect(driver.machine.operation.completed_step_ids).toEqual(['step-1'])
    // And nothing went on to pull or import anything.
    expect(driver.kinds('prepare-environment')).toBe(0)
    expect(driver.kinds('pull-image')).toBe(0)

    driver.apply(driver.reply({ type: 'cleanup-completed' }))
    expect(driver.phase).toBe('cancelled')
  })
})

describe('setup, update and removal', () => {
  it('runs a setup through to a ready installation', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    driver.apply(driver.reply({ type: 'environment-verified' }))
    expect(driver.phase).toBe('pulling-image')
    driver.apply(driver.reply({ type: 'image-pulled' }))
    expect(driver.phase).toBe('verifying')
    driver.apply(driver.reply({ type: 'verification-passed' }))
    expect(driver.phase).toBe('activating')
    expect(driver.pending).toBe('activate')
    driver.apply(driver.reply({ type: 'activation-committed' }))
    expect(driver.phase).toBe('ready')
    expect(driver.pending).toBeNull()
    // An environment-only setup never touches an image.
    expect(driver.kinds('unload-resident')).toBe(0)
  })

  it('finishes an environment-only setup at verification, with no runtime to activate', () => {
    const driver = new Driver('setup', ENVIRONMENT, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    driver.apply(driver.reply({ type: 'environment-verified' }))
    expect(driver.phase).toBe('verifying')
    driver.apply(driver.reply({ type: 'verification-passed' }))
    expect(driver.phase).toBe('ready')
    expect(driver.kinds('pull-image')).toBe(0)
    expect(driver.kinds('activate')).toBe(0)
  })

  it('takes the GPU back before proving a new image, and only then commits it', () => {
    const driver = new Driver('update', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    // An update stages over an environment that already exists.
    expect(driver.phase).toBe('pulling-image')
    expect(driver.kinds('prepare-environment')).toBe(0)
    driver.apply(driver.reply({ type: 'image-pulled' }))
    driver.apply(driver.reply({ type: 'verification-passed' }))
    expect(driver.phase).toBe('activating')
    expect(driver.pending).toBe('unload-resident')
    driver.apply(driver.reply({ type: 'resident-unloaded' }))
    expect(driver.pending).toBe('activate')
    driver.apply(driver.reply({ type: 'activation-committed' }))
    expect(driver.phase).toBe('ready')
  })

  it('leaves the running installation alone when the candidate fails its smoke test (OP06)', () => {
    const driver = new Driver('update', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    driver.apply(driver.reply({ type: 'image-pulled' }))
    driver.apply(
      driver.reply({
        type: 'failed',
        error: { code: 'MANAGED_METADATA_INVALID', message: 'The candidate did not answer.' },
      })
    )
    expect(driver.phase).toBe('failed')
    // Nothing was activated, so the digest that was running is still the active one.
    expect(driver.kinds('activate')).toBe(0)
    expect(driver.kinds('unload-resident')).toBe(0)
  })

  it('removes without preparing anything first', () => {
    const driver = new Driver('remove', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    expect(driver.phase).toBe('removing')
    driver.apply(driver.reply({ type: 'removal-completed' }))
    expect(driver.phase).toBe('removed')
    expect(driver.kinds('prepare-environment')).toBe(0)
    expect(driver.kinds('pull-image')).toBe(0)
  })
})

describe('cancellation and refusals', () => {
  it('never erases an installation that did commit', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    driver.apply(driver.reply({ type: 'environment-verified' }))
    driver.apply(driver.reply({ type: 'image-pulled' }))
    driver.apply(driver.reply({ type: 'verification-passed' }))

    driver.apply({ type: 'cancel' })
    expect(driver.phase).toBe('activating')
    driver.apply(driver.reply({ type: 'activation-committed' }))
    // The commit won the race; reporting it as cancelled would misdescribe what is running.
    expect(driver.phase).toBe('ready')
    expect(driver.machine.operation.cancellation_requested).toBe(false)
  })

  it('is a no-op once the operation has finished', () => {
    const driver = new Driver('remove', RUNTIME, 'sha256:A')
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    driver.apply(driver.reply({ type: 'removal-completed' }))
    const before = driver.machine
    driver.apply({ type: 'cancel' })
    driver.apply({ type: 'cancel' })
    expect(driver.machine).toBe(before)
    expect(driver.machine.operation.revision).toBe(before.operation.revision)
  })

  it('cancels a failure that never started anything without asking for cleanup', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(
      driver.reply({
        type: 'requirements-ready',
        plan: plan('sha256:A', {
          blockers: [{ code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'No driver.' }],
        }),
        host_step: null,
      })
    )
    driver.apply({ type: 'cancel' })
    expect(driver.phase).toBe('cancelled')
    expect(driver.kinds('cleanup')).toBe(0)
  })

  it('refuses a result from an effect that is no longer the one in flight', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    const stale = driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null })
    driver.apply(stale)
    // The same answer arriving twice belongs to an attempt that is over.
    expect(driver.refuse(stale)).toBe('MANAGED_OPERATION_CONFLICT')
    expect(
      driver.refuse({
        type: 'requirements-ready',
        plan: plan('sha256:A'),
        host_step: null,
        effect_id: 'someone-elses',
        expected_revision: driver.machine.operation.revision,
      })
    ).toBe('MANAGED_OPERATION_CONFLICT')
  })

  it('refuses an answer that does not belong to the effect that is pending', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    // A probe cannot answer with a pulled image.
    expect(driver.refuse(driver.reply({ type: 'image-pulled' }))).toBe('MANAGED_OPERATION_CONFLICT')
    expect(driver.phase).toBe('checking')
  })

  it('moves the revision on exactly once per accepted event, and not at all per refused one', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    expect(driver.machine.operation.revision).toBe(0)
    driver.apply(driver.reply({ type: 'requirements-ready', plan: plan('sha256:A'), host_step: null }))
    expect(driver.machine.operation.revision).toBe(1)
    driver.apply(driver.reply({ type: 'environment-verified' }))
    expect(driver.machine.operation.revision).toBe(2)
    driver.refuse(driver.reply({ type: 'environment-verified' }))
    expect(driver.machine.operation.revision).toBe(2)
  })

  it('refuses a resume for a phase that is already running, and one prepared at an old revision', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    expect(
      driver.refuse({ type: 'resume', input: { expected_revision: driver.machine.operation.revision } })
    ).toBe('MANAGED_OPERATION_CONFLICT')
    driver.apply(
      driver.reply({
        type: 'requirements-ready',
        plan: plan('sha256:A', { blockers: [{ code: 'IO_ERROR', message: 'disk' }] }),
        host_step: null,
      })
    )
    expect(driver.refuse({ type: 'resume', input: { expected_revision: 0 } })).toBe(
      'MANAGED_REVISION_CONFLICT'
    )
  })

  it('looks at the machine again on resume instead of trusting the phase it stored', () => {
    const driver = new Driver('setup', RUNTIME, 'sha256:A')
    driver.apply(
      driver.reply({
        type: 'requirements-ready',
        plan: plan('sha256:A', { blockers: [{ code: 'IO_ERROR', message: 'disk' }] }),
        host_step: null,
      })
    )
    expect(driver.phase).toBe('failed')
    driver.apply({ type: 'resume', input: { expected_revision: driver.machine.operation.revision } })
    expect(driver.phase).toBe('checking')
    expect(driver.pending).toBe('reconcile')
    expect(driver.machine.operation.error).toBeNull()
  })
})
