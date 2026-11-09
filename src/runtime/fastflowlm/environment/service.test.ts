import { expect, it, vi } from 'vitest'
import { flmBuild, flmFacts, kernel, linuxManifest } from '../../../../test/helpers/flm-environment.js'
import { parseEnvironment } from './manifest.js'
import { probePreparation } from './service.js'
const ubuntu = {
  os: 'linux',
  arch: 'x64',
  distribution: 'ubuntu',
  version: '24.04',
  kernel_release: kernel,
  mutable: true,
}
function sources() {
  return {
    host: vi.fn(async () => ubuntu),
    manifest: vi.fn(async () => parseEnvironment(linuxManifest(), 'linux')),
    selectedBuild: vi.fn(async () => flmBuild),
  }
}
it('skips network and host qualification when already ready and skips the manifest on Arch', async () => {
  const s = sources()
  expect((await probePreparation(flmFacts([]), 'linux', 'x64', s)).status).toBe('ready')
  expect(s.host).not.toHaveBeenCalled()
  s.host.mockResolvedValue({ ...ubuntu, distribution: 'arch' })
  expect((await probePreparation(flmFacts(), 'linux', 'x64', s)).blockers).toContain('driver-missing')
  expect(s.manifest).not.toHaveBeenCalled()
})
it('preserves inspection of a pinned legacy operation against its selected release', async () => {
  const s = { ...sources(), pinned: true }
  const facts = { ...flmFacts(['driver-missing', 'engine-not-installed']), engine_version: null }
  expect((await probePreparation(facts, 'linux', 'x64', s)).status).toBe('action-required')
  s.selectedBuild.mockResolvedValue('flm-1.0.11-r9')
  expect((await probePreparation(facts, 'linux', 'x64', s)).status).toBe('blocked')
})

it('directs new driver preparation to the vendor even when a recipe exists', async () => {
  const s = sources()
  s.host.mockResolvedValue({ ...ubuntu, os: 'windows', version: '11' })
  const plan = await probePreparation(flmFacts(), 'win32', 'x64', s)
  expect(plan).toMatchObject({
    status: 'blocked',
    packages: [],
    changes: [],
    driver_setup: {
      links: [expect.objectContaining({ url: 'https://www.amd.com/en/support/download/drivers.html' })],
      commands: [],
    },
  })
  expect(s.manifest).not.toHaveBeenCalled()
  expect(s.selectedBuild).not.toHaveBeenCalled()
})
it('provides Ubuntu commands without mistaking manual installation for an approved host step', async () => {
  const s = sources()
  const plan = await probePreparation(flmFacts(), 'linux', 'x64', s)
  expect(plan).toMatchObject({ status: 'blocked', recipe_id: null, packages: [], changes: [] })
  expect(plan).toHaveProperty(
    'driver_setup.commands',
    expect.arrayContaining(['sudo apt install amdxdna-dkms'])
  )
  expect(s.manifest).not.toHaveBeenCalled()
})
