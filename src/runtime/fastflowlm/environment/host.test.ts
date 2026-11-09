import { expect, it } from 'vitest'
import { nodeProbeDeps } from '../../../hardware/index.js'
import { preparationHost } from './host.js'
it.each([
  ['rw', false, true],
  ['ro', false, false],
  ['rw', true, false],
  ['', false, null],
] as const)(
  'reads the running Linux kernel and mount flags %s (ostree %s)',
  async (flags, ostree, mutable) => {
    const deps = nodeProbeDeps({ platform: 'linux', arch: 'x64' })
    const fs = {
      ...deps.fs,
      exists: async () => ostree,
      readFile: async (p: string) =>
        p.endsWith('os-release')
          ? 'ID=arch\nBUILD_ID=rolling'
          : flags
            ? '10 1 0:1 / / ' + flags + ' - ext4 /dev/root ' + flags
            : '',
    }
    expect(await preparationHost({ ...deps, fs }, '6.17-test')).toMatchObject({
      distribution: 'arch',
      kernel_release: '6.17-test',
      mutable,
    })
  }
)
it.each([
  ['1', '11'],
  ['3', null],
])('requires Windows workstation product type', async (product, version) => {
  const deps = nodeProbeDeps({
    platform: 'win32',
    arch: 'x64',
    run: async () => ({ code: 0, stdout: product!, stderr: '' }),
  })
  expect((await preparationHost(deps, '10.0.22631')).version).toBe(version)
})
