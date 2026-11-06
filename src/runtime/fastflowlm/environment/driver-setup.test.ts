import { expect, it } from 'vitest'
import { flmFacts } from '../../../../test/helpers/flm-environment.js'
import { driverSetup } from './driver-setup.js'
import type { PreparationHost } from './plan.js'
const host: PreparationHost = {
  os: 'linux',
  arch: 'x64',
  distribution: 'ubuntu',
  version: '24.04',
  kernel_release: '6.17.0-generic',
  mutable: true,
}
it.each([
  [{}, 'sudo apt install amdxdna-dkms'],
  [{ version: '25.10' }, 'sudo apt install amdxdna-dkms'],
  [{ version: '26.04' }, 'sudo apt install linux-firmware'],
  [{ distribution: 'arch', version: null }, 'sudo pacman -Syu linux-firmware'],
  [{ distribution: 'debian', version: '13' }, 'modinfo amdxdna'],
  [{ distribution: null, version: null }, 'modinfo amdxdna'],
  [{ mutable: false }, 'modinfo amdxdna'],
  [{ mutable: null }, 'modinfo amdxdna'],
] as const)('selects documented server commands for %j', (overrides, command) => {
  const setup = driverSetup(flmFacts(), { ...host, ...overrides })!
  expect(setup.commands).toContain(command)
  expect(setup.links[0]!.url).toBe('https://lemonade-server.ai/flm_npu_linux.html')
  expect(setup.commands.join(' ')).not.toMatch(/memlock|prlimit|libxrt|fastflowlm/)
})
it('sends Windows to AMD without installer commands', () => {
  expect(driverSetup(flmFacts(), { ...host, os: 'windows', version: '11' })).toMatchObject({
    commands: [],
    links: [{ label: 'AMD driver downloads', url: 'https://www.amd.com/en/support/download/drivers.html' }],
  })
})
it.each(['device-access-denied', 'xrt-device-unavailable'])(
  'does not suggest reinstalling drivers just for %s',
  (blocker) => {
    const setup = driverSetup(flmFacts([blocker]), host)!
    expect(setup.commands.join(' ')).not.toContain('sudo')
    if (blocker === 'device-access-denied') expect(setup.commands).toContain('ls -l /dev/accel/')
  }
)
it.each(['device-busy', 'probe-inconclusive', 'ambiguous-npu'])(
  'withholds guidance on unreliable %s facts',
  (blocker) => {
    expect(driverSetup(flmFacts(['driver-missing', blocker]), host)).toBeUndefined()
  }
)
it('does not label a ready, unsupported or memory-only host as needing drivers', () => {
  expect(driverSetup(flmFacts([]), host)).toBeUndefined()
  expect(driverSetup(flmFacts(['memlock-too-low']), host)).toBeUndefined()
  expect(driverSetup(flmFacts(['engine-not-installed']), host)).toBeUndefined()
  expect(driverSetup({ ...flmFacts(), devices: [] }, host)).toBeUndefined()
  for (const overrides of [{ arch: 'arm64' }, { os: 'darwin' }, { os: 'windows', version: null }])
    expect(driverSetup(flmFacts(), { ...host, ...overrides })).toBeUndefined()
})

it.each(['driver-problem', 'driver-unknown', 'device-access-unknown'])(
  'offers diagnostics and AMD support for %s without assuming reinstall',
  (blocker) => {
    const setup = driverSetup(flmFacts([blocker]), { ...host, os: 'windows', version: '11' })
    expect(setup?.steps.join(' ')).toContain('Device Manager')
    expect(setup?.links[0]?.url).toBe('https://www.amd.com/en/support/download/drivers.html')
    expect(setup?.commands).toEqual([])
  }
)
