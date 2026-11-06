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
  expect((await probePreparation(flmFacts(), 'linux', 'x64', s)).blockers).toContain('platform-not-qualified')
  expect(s.manifest).not.toHaveBeenCalled()
})
it('qualifies pre-install repair against the selected catalog release', async () => {
  const s = sources()
  const facts = { ...flmFacts(['driver-missing', 'engine-not-installed']), engine_version: null }
  expect((await probePreparation(facts, 'linux', 'x64', s)).status).toBe('action-required')
  s.selectedBuild.mockResolvedValue('flm-1.0.11-r9')
  expect((await probePreparation(facts, 'linux', 'x64', s)).status).toBe('blocked')
})
