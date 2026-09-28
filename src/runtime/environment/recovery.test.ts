import { describe, expect, it } from 'vitest'
import type { Sha256Digest } from '../../contracts/index.js'
import { recoverOperation, type EffectFinding, type EffectInventory } from './recovery.js'
import { startOperation, type EffectIntent, type OperationMachine } from './state.js'
import type { PersistedOperation } from './store.js'

const PLAN_A = `sha256:${'a'.repeat(64)}` as Sha256Digest

/** An operation that has already reached the step which imports the WSL distribution. */
const importing = (): OperationMachine => {
  const started = startOperation(
    {
      operation_id: 'op-1',
      request_id: 'req-1',
      environment_id: 'env-1',
      instance_id: 'core-dead',
      target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
      kind: 'setup',
      approved_plan_digest: PLAN_A,
    },
    { next_effect_id: 'effect-1' }
  )
  const intent: EffectIntent = {
    effect_id: 'effect-2',
    operation_id: 'op-1',
    expected_revision: 1,
    kind: 'prepare-environment',
    plan_digest: PLAN_A,
  }
  return {
    operation: {
      ...started.state.operation,
      revision: 1,
      phase: 'preparing-environment',
      plan_digest: PLAN_A,
      completed_step_ids: ['step-1'],
      pending_host_step: {
        step_id: 'step-1',
        action: 'linux.install-container-runtime',
        recipe_id: 'ubuntu-24.04-docker-ce',
        recipe_digest: PLAN_A,
        parameters_digest: PLAN_A,
        nonce: 'once-1',
        expected_operation_revision: 1,
      },
    },
    pending_effect: intent,
    indivisible_host_step_running: false,
  }
}

const record = (machine = importing(), owned: string[] = []): PersistedOperation => ({
  machine,
  request_digest: PLAN_A,
  request: {
    request_id: 'req-1',
    target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
    kind: 'setup',
  },
  requirement_plan: null,
  accepted_receipt_digests: {},
  completed_effect_ids: [],
  owned_resource_ids: owned,
})

const inventory = (
  finding: EffectFinding,
  over: Partial<{ relogin: boolean; reboot: boolean; steps: string[]; plan: Sha256Digest | null }> = {}
): EffectInventory => ({
  inspect: async () => finding,
  needsRelogin: async () => over.relogin ?? false,
  needsReboot: async () => over.reboot ?? false,
  verifyCompletedSteps: async () => over.steps ?? ['step-1'],
  currentPlanDigest: async () => (over.plan === undefined ? PLAN_A : over.plan),
})

const deps = (inv: EffectInventory, instanceId = 'core-new') => {
  let n = 0
  return { instanceId, newEffectId: () => `recovered-${(n += 1)}`, inventory: inv }
}

describe('adopting only what can be proved (OP05)', () => {
  it('takes over a distribution that was imported before the crash, and imports nothing again', async () => {
    const before = record()
    const outcome = await recoverOperation(
      before,
      deps(inventory({ kind: 'completed', owned_resource_ids: ['wsl:atomic-app-7f3c'] }))
    )
    expect(outcome.kind).toBe('reconciled')
    if (outcome.kind !== 'reconciled') return

    // Exactly the identity that was verified, and nothing that merely looked like it.
    expect(outcome.record.owned_resource_ids).toEqual(['wsl:atomic-app-7f3c'])
    // The stored phase is not treated as a result: the operation goes back to looking.
    expect(outcome.record.machine.operation.phase).toBe('checking')
    expect(outcome.effects.map((effect) => effect.kind)).toEqual(['probe'])
    expect(outcome.effects.some((effect) => effect.kind === 'prepare-environment')).toBe(false)
  })

  it('does not record the same resource twice when recovery itself is interrupted and repeated', async () => {
    const inv = inventory({ kind: 'completed', owned_resource_ids: ['wsl:atomic-app-7f3c'] })
    const first = await recoverOperation(record(), deps(inv))
    expect(first.kind).toBe('reconciled')
    if (first.kind !== 'reconciled') return

    // The core dies again before it gets any further; the machine still shows the same distro.
    const second = await recoverOperation(record(importing(), first.record.owned_resource_ids), deps(inv))
    expect(second.kind).toBe('reconciled')
    if (second.kind !== 'reconciled') return
    expect(second.record.owned_resource_ids).toEqual(['wsl:atomic-app-7f3c'])
  })

  it('stops on something it cannot claim, and neither adopts nor removes it', async () => {
    const before = record(importing(), ['wsl:ours'])
    const outcome = await recoverOperation(
      before,
      deps(inventory({ kind: 'foreign', detail: 'wsl distribution "Ubuntu" was not created by Atomic Chat' }))
    )
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') return

    expect(outcome.error.code).toBe('MANAGED_IDENTITY_MISMATCH')
    expect(outcome.error.details).toContain('Ubuntu')
    expect(outcome.record.machine.operation.phase).toBe('failed')
    // The user's own distribution is untouched, and nothing new was claimed.
    expect(outcome.record.owned_resource_ids).toEqual(['wsl:ours'])
    expect(outcome.record.machine.pending_effect).toBeNull()
  })

  it('simply runs the step again when nothing of it is on the machine', async () => {
    const outcome = await recoverOperation(record(), deps(inventory({ kind: 'absent' })))
    expect(outcome.kind).toBe('reconciled')
    if (outcome.kind !== 'reconciled') return
    expect(outcome.record.owned_resource_ids).toEqual([])
    expect(outcome.record.machine.operation.phase).toBe('checking')
  })
})

describe('what a restart keeps and what it drops', () => {
  it('keeps the operation and its request, and moves ownership to the core that is running now', async () => {
    const outcome = await recoverOperation(record(), deps(inventory({ kind: 'absent' }), 'core-new'))
    expect(outcome.kind).toBe('reconciled')
    if (outcome.kind !== 'reconciled') return

    const operation = outcome.record.machine.operation
    expect(operation.operation_id).toBe('op-1')
    expect(operation.request_id).toBe('req-1')
    expect(operation.instance_id).toBe('core-new')
    expect(operation.revision).toBeGreaterThan(1)
    // The approval survives; whether it still covers the plan is decided by the next probe.
    expect(operation.approved_plan_digest).toBe(PLAN_A)
  })

  it('drops the single-use authorization the dead core was holding', async () => {
    const before = record()
    expect(before.machine.operation.pending_host_step).not.toBeNull()
    const outcome = await recoverOperation(before, deps(inventory({ kind: 'absent' })))
    expect(outcome.kind).toBe('reconciled')
    if (outcome.kind !== 'reconciled') return
    // Nothing can raise a system prompt again on the strength of a nonce from a previous run.
    expect(outcome.record.machine.operation.pending_host_step).toBeNull()
  })

  it('waits again when the machine says the sign-out or the restart has not happened', async () => {
    const relogin = await recoverOperation(record(), deps(inventory({ kind: 'absent' }, { relogin: true })))
    expect(relogin.kind === 'reconciled' && relogin.record.machine.operation.phase).toBe('relogin-required')
    expect(relogin.kind === 'reconciled' && relogin.effects).toEqual([])

    const reboot = await recoverOperation(record(), deps(inventory({ kind: 'absent' }, { reboot: true })))
    expect(reboot.kind === 'reconciled' && reboot.record.machine.operation.phase).toBe('reboot-required')
  })

  it('records only the host steps the machine still shows', async () => {
    const outcome = await recoverOperation(record(), deps(inventory({ kind: 'absent' }, { steps: [] })))
    expect(outcome.kind).toBe('reconciled')
    if (outcome.kind !== 'reconciled') return
    // A step the machine cannot confirm is not carried forward as done.
    expect(outcome.record.machine.operation.completed_step_ids).toEqual([])
  })

  it('takes the plan the host yields now, so an approval can be rechecked against it', async () => {
    const other = `sha256:${'b'.repeat(64)}` as Sha256Digest
    const outcome = await recoverOperation(record(), deps(inventory({ kind: 'absent' }, { plan: other })))
    expect(outcome.kind).toBe('reconciled')
    if (outcome.kind !== 'reconciled') return
    expect(outcome.record.machine.operation.plan_digest).toBe(other)
    expect(outcome.record.machine.operation.approved_plan_digest).toBe(PLAN_A)
  })

  it('leaves an operation that had already finished exactly as it was', async () => {
    const finished = importing()
    const done = record({
      ...finished,
      operation: { ...finished.operation, phase: 'ready' },
      pending_effect: null,
    })
    const outcome = await recoverOperation(done, deps(inventory({ kind: 'absent' })))
    expect(outcome.kind).toBe('unchanged')
    expect(outcome.record).toBe(done)
  })

  it('reconciles an operation that was waiting on nobody, with no effect in flight', async () => {
    const waiting = importing()
    const idle = record({
      ...waiting,
      operation: { ...waiting.operation, phase: 'awaiting-consent' },
      pending_effect: null,
    })
    const outcome = await recoverOperation(idle, deps(inventory({ kind: 'absent' })))
    expect(outcome.kind).toBe('reconciled')
    if (outcome.kind !== 'reconciled') return
    expect(outcome.record.machine.operation.phase).toBe('checking')
    expect(outcome.effects.map((effect) => effect.kind)).toEqual(['probe'])
  })
})
