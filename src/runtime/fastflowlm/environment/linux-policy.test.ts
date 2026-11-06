import { expect, it } from 'vitest'
import { linuxManifest } from '../../../../test/helpers/flm-environment.js'
import { parseEnvironment } from './manifest.js'
import { supportedLinuxNpuRecipe, type LinuxNpuRecipe } from './linux-policy.js'
it('ties distro headers to Ubuntu, NPU packages to their signer, and XRT to the qualified build', () => {
  const r = parseEnvironment(linuxManifest(), 'linux').recipes[0] as LinuxNpuRecipe
  expect(supportedLinuxNpuRecipe(r, ['amdxdna-dkms'])).toBe(true)
  for (const name of ['linux-image-generic', 'dkms', 'bash'])
    expect(supportedLinuxNpuRecipe(r, [name])).toBe(false)
  r.platforms[0]!.kernel_release = '7.0.0-generic'
  expect(supportedLinuxNpuRecipe(r, ['amdxdna-dkms'])).toBe(false)
  expect(supportedLinuxNpuRecipe(r, [])).toBe(true)
  r.xrt = 'system'
  expect(supportedLinuxNpuRecipe(r, [])).toBe(false)
})
