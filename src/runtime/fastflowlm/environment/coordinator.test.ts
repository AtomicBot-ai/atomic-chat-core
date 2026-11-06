import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { flmFacts, kernel, linuxManifest } from '../../../../test/helpers/flm-environment.js'
import { canonicalDigest } from '../../environment/index.js'
import { parseEnvironment } from './manifest.js'
import { preparationPlan } from './plan.js'
import { PreparationCoordinator } from './coordinator.js'
import type { FastFlowLmHostStep, FastFlowLmOperation } from '../../../contracts/index.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flm-preparation-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
function lab() {
  const state = { facts: flmFacts(), manifest: parseEnvironment(linuxManifest(), 'linux'), boot: 'first' }
  const events: FastFlowLmOperation[] = []
  const coordinator = () =>
    new PreparationCoordinator({
      dir,
      inspect: async (pinned) => ({
        facts: state.facts,
        plan: preparationPlan(
          state.facts,
          {
            os: 'linux',
            arch: 'x64',
            version: '24.04',
            kernel_release: kernel,
            distribution: 'ubuntu',
            mutable: true,
          },
          pinned ?? state.manifest
        ),
      }),
      pinned: async (digest) => (canonicalDigest(state.manifest) === digest ? state.manifest : null),
      facts: async () => state.facts,
      boot: async () => state.boot,
      emit: (op) => events.push(op),
    })
  const core = coordinator()
  async function approved() {
    const op = await core.begin({ request_id: 'one' })
    const consented = await core.consent(op.operation_id, {
      expected_revision: op.revision,
      approved_plan_digest: op.plan.plan_digest,
    })
    return core.claim(op.operation_id, { expected_revision: consented.revision })
  }
  return { core, state, coordinator, approved, events }
}
function receipt(step: FastFlowLmHostStep) {
  return {
    step_id: step.step_id,
    nonce: step.nonce,
    expected_operation_revision: step.expected_operation_revision,
    recipe_digest: step.recipe_digest,
    parameters_digest: step.parameters_digest,
    receipt_id: 'receipt',
    outcome: 'completed' as const,
  }
}
it('serializes begin and returns the same request after detach and restart', async () => {
  const { core, coordinator } = lab()
  const [a, b] = await Promise.all([core.begin({ request_id: 'one' }), core.begin({ request_id: 'one' })])
  expect(a).toEqual(b)
  expect(await coordinator().list()).toEqual([a])
  await expect(core.begin({ request_id: 'two' })).rejects.toMatchObject({
    code: 'MANAGED_OPERATION_CONFLICT',
  })
})
it('refreshes a changed plan before consent and issues no stale authorization', async () => {
  const { core, state } = lab()
  const op = await core.begin({ request_id: 'one' })
  state.facts.runtime_account = 'different'
  await expect(
    core.consent(op.operation_id, {
      expected_revision: op.revision,
      approved_plan_digest: op.plan.plan_digest,
    })
  ).rejects.toMatchObject({ code: 'MANAGED_PLAN_CHANGED' })
  expect(await core.get(op.operation_id)).toMatchObject({
    state: 'awaiting-consent',
    pending_host_step: null,
    plan: { runtime_account: 'different' },
  })
})
it('binds every receipt field, persists the spent nonce and verifies as the original owner', async () => {
  const { core, state, approved, coordinator } = lab(),
    op = await approved(),
    s = op.pending_host_step!,
    r = receipt(s)
  expect(s.parameters_digest).toBe(canonicalDigest(s.parameters))
  for (const changed of [
    { nonce: 'other' },
    { expected_operation_revision: 0 },
    { step_id: 'other' },
    { parameters_digest: canonicalDigest({}) },
    { recipe_digest: canonicalDigest([]) },
  ]) {
    await expect(core.receipt(op.operation_id, { ...r, ...changed })).rejects.toThrow()
  }
  state.facts = { ...flmFacts([]), runtime_mode: 'interactive', runtime_service: null }
  expect(await core.receipt(op.operation_id, r)).toMatchObject({
    state: 'failed',
    reason: 'runtime-identity-changed',
  })
  await expect(coordinator().receipt(op.operation_id, r)).rejects.toMatchObject({
    code: 'MANAGED_RECEIPT_CONFLICT',
  })
})
it('waits for the privileged process boundary after cancellation, even across owner restart', async () => {
  const { core, approved, coordinator } = lab(),
    op = await approved(),
    id = op.operation_id
  expect(await core.cancel(id)).toMatchObject({ state: 'preparing-host', reason: 'cancellation-requested' })
  const reopened = coordinator()
  await reopened.recover()
  expect((await reopened.get(id)).pending_host_step).toEqual(op.pending_host_step)
  expect(await reopened.receipt(id, receipt(op.pending_host_step!))).toMatchObject({
    state: 'cancelled',
    pending_host_step: null,
  })
})
it('recovers activation by a fresh owner probe; config updates cannot replace the approved plan', async () => {
  const { core, state, approved, coordinator } = lab(),
    op = await approved()
  expect(
    await core.receipt(op.operation_id, { ...receipt(op.pending_host_step!), outcome: 'reboot-required' })
  ).toMatchObject({ state: 'reboot-required' })
  state.manifest.recipes = []
  state.facts = flmFacts([])
  state.boot = 'second'
  const reopened = coordinator()
  await reopened.recover()
  expect(await reopened.get(op.operation_id)).toMatchObject({ state: 'ready', plan: op.plan })
})
it('recovers an interrupted installer after an observed reboot without issuing a second host step', async () => {
  const { state, approved, coordinator } = lab(),
    op = await approved()
  state.boot = 'second'
  const reopened = coordinator()
  await reopened.recover()
  expect(await reopened.get(op.operation_id)).toMatchObject({
    state: 'failed',
    pending_host_step: null,
    reason: 'driver-missing',
  })
})

it('cancels before dispatch and lets only one launcher claim a later authorization', async () => {
  const { core } = lab()
  const a = await core.begin({ request_id: 'a' })
  const consent = (op: FastFlowLmOperation) =>
    core.consent(op.operation_id, {
      approved_plan_digest: op.plan.plan_digest,
      expected_revision: op.revision,
    })
  const offered = await consent(a)
  expect(offered.pending_host_step).toBeNull()
  expect((await core.cancel(a.operation_id)).state).toBe('cancelled')
  const next = await consent(await core.begin({ request_id: 'b' }))
  const claim = () => core.claim(next.operation_id, { expected_revision: next.revision })
  const results = await Promise.allSettled([claim(), claim()])
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
})
