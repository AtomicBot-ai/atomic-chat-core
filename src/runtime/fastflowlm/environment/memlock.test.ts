import { expect, it } from 'vitest'
import { flmFacts } from '../../../../test/helpers/flm-environment.js'
import { preparationPlan } from './plan.js'

const process = { pid: 4207, start_ticks: '123456', boot_id: '11111111-1111-1111-1111-111111111111' }
const host = {
  os: 'linux',
  arch: 'x64',
  distribution: 'arch',
  version: null,
  kernel_release: '7.2.8-9-omarchy',
  mutable: true,
  process,
}
function facts() {
  const f = flmFacts([
    'memlock-too-low',
    'native-memlock-unconfirmed',
    'native-validation-failed',
    'xrt-device-unavailable',
  ])
  f.memlock_bytes = '8388608'
  Object.assign(f.devices[0]!, { accessible: true, xrt_visible: false })
  return f
}
it('offers memory preparation offline on a working Arch NPU without a driver recipe', () => {
  expect(preparationPlan(facts(), host, null)).toMatchObject({
    status: 'action-required',
    manifest_digest: null,
    packages: [],
    recipe_id: 'linux.runtime-memlock',
    changes: [{ code: 'service-memlock', params: { bytes: '2147483648' } }],
  })
})
it('binds the memory approval to this owner process, independently of driver manifests', () => {
  const first = preparationPlan(facts(), host, null)
  const next = preparationPlan(facts(), { ...host, process: { ...process, start_ticks: '999' } }, null)
  expect(next.plan_digest).not.toBe(first.plan_digest)
  expect(first.status).toBe('action-required')
})
it.each(['driver-missing', 'device-access-denied', 'firmware-unconfirmed', 'probe-inconclusive'])(
  'does not turn %s into a memory repair',
  (blocker) => {
    const f = facts()
    f.blockers.push(blocker)
    expect(preparationPlan(f, host, null).status).toBe('blocked')
  }
)
it('does not authorize an unknown owner or a limit outside the fixed policy', () => {
  const { process: _owner, ...unknown } = host
  expect(preparationPlan(facts(), unknown, null).status).toBe('blocked')
  const f = facts()
  f.required.memlock_bytes = '999999999999'
  expect(preparationPlan(f, host, null).status).toBe('blocked')
})
