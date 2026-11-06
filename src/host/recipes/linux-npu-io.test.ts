import { nodeHostStepDeps } from './executor-io.js'
import { expect, it, vi } from 'vitest'
import { linuxManifest, kernel } from '../../../test/helpers/flm-environment.js'
import { parseEnvironment } from '../../runtime/fastflowlm/environment/index.js'
import type { LinuxNpuTarget, LinuxNpuRecipe } from './linux-amd-npu.js'
import { installLinuxNpu } from './linux-npu-io.js'
function machine() {
  const recipe = parseEnvironment(linuxManifest(), 'linux').recipes[0] as LinuxNpuRecipe
  const target: LinuxNpuTarget = {
    recipe,
    account: 'lex',
    unit: null,
    mode: 'interactive',
    device: '0000:c4:00.1',
    packages: recipe.packages,
    access: false,
    memlock: true,
  }
  const base = '/sys/bus/pci/devices/' + target.device
  const files: Record<string, string> = {
    [base + '/vendor']: '0x1022',
    [base + '/device']: '0x17f0',
    [base + '/revision']: '0x20',
    [base + '/fw_version']: recipe.firmware_version,
    ['/lib/modules/' + kernel + '/build/include/config/kernel.release']: kernel,
  }
  let installed = false
  const run = vi.fn(async (cmd: string, args: string[]) => {
    switch (cmd) {
      case '/usr/bin/getent':
        return 'lex:x:1000:1000::/home/lex:/bin/sh'
      case '/usr/bin/mokutil':
        return 'SecureBoot disabled'
      case '/usr/bin/dpkg-query':
        return installed ? 'install ok installed\t' + recipe.packages[0]!.version + '\tamd64' : ''
      case '/usr/bin/dpkg':
        installed = true
        return ''
      case '/usr/sbin/modinfo':
        if (args.includes('filename')) return '/lib/modules/' + kernel + '/updates/dkms/amdxdna.ko.zst'
        return kernel + ' SMP'
      case '/usr/bin/readlink':
        if (args.at(-1)?.endsWith('/iommu_group')) return '/sys/kernel/iommu_groups/12'
        return '/lib/firmware/updates/amdnpu/17f0_10/npu.sbin.' + recipe.firmware_version
      case '/usr/bin/systemctl':
        return 'lex'
      case '/usr/bin/setfacl':
      case '/usr/bin/udevadm':
        return ''
      default:
        throw Error('Unexpected command: ' + [cmd, ...args].join(' '))
    }
  })
  const deps = {
    readFile: async (p: string) => (p in files ? Buffer.from(files[p]!) : null),
    writeFile: vi.fn(async (p: string, d: Uint8Array) => {
      files[p] = Buffer.from(d).toString()
    }),
    invokingUid: '1000',
    fetch: vi.fn(),
  }
  const io = {
    host: async () => ({
      os: 'linux',
      arch: 'x64',
      distribution: 'ubuntu',
      version: '24.04',
      mutable: true,
      kernel_release: kernel,
    }),
    run,
    stage: async () => '/fixture',
    remove: async () => {},
    apply: vi.fn(async () => {
      installed = true
    }),
    packages: vi.fn(async () => ['/fixture/amdxdna-dkms.deb']),
  }
  return { io, deps, target, files }
}
it('installs only the staged archive and account limit; retry skips both writes', async () => {
  const { io, deps, target } = machine()
  expect(await installLinuxNpu(target, deps, io)).toBe('reboot-required')
  expect(await installLinuxNpu(target, deps, io)).toBe('relogin-required')
  expect(io.packages).toHaveBeenCalledTimes(1)
  expect(io.apply).toHaveBeenCalledTimes(1)
  expect(io.apply).toHaveBeenCalledWith(['/fixture/amdxdna-dkms.deb'])
  expect(deps.writeFile).toHaveBeenCalledTimes(1)
  expect(deps.writeFile).toHaveBeenCalledWith(
    '/etc/security/limits.d/90-atomic-npu-1000.conf',
    Buffer.from('lex - memlock 2097152\n'),
    0o644
  )
})
it('stops on Arch, a different kernel, Secure Boot or missing headers before staging', async () => {
  for (const fault of ['arch', 'kernel', 'secure', 'headers']) {
    const { io, deps, target, files } = machine(),
      host = await io.host()
    if (fault === 'arch') host.distribution = 'omarchy'
    if (fault === 'kernel') host.kernel_release = 'other'
    if (fault === 'secure') {
      const normal = io.run.getMockImplementation()!
      io.run.mockImplementation((c, a) =>
        c.endsWith('/mokutil') ? Promise.resolve('SecureBoot enabled') : normal(c, a)
      )
    }
    if (fault === 'headers') delete files['/lib/modules/' + kernel + '/build/include/config/kernel.release']
    io.host = async () => host
    await expect(installLinuxNpu(target, deps, io)).rejects.toThrow()
    expect(io.packages).not.toHaveBeenCalled()
    expect(deps.writeFile).not.toHaveBeenCalled()
  }
})
it('limits the access rule to this PCI device and UID, and the system drop-in to its service', async () => {
  const { io, deps, target, files } = machine()
  Object.assign(target, { packages: [], mode: 'system-service', unit: 'atc.service', access: true })
  expect(await installLinuxNpu(target, deps, io)).toBe('service-restart-required')
  expect(files['/etc/systemd/system/atc.service.d/60-atomic-npu.conf']).toBe(
    '[Service]\nLimitMEMLOCK=2147483648\n'
  )
  const rules = Object.entries(files).filter(([k]) => k.endsWith('.rules'))
  expect(rules).toHaveLength(1)
  expect(rules[0]![1]).toContain('KERNELS=="0000:c4:00.1"')
  expect(rules[0]![1]).toContain('u:1000:rw')
  expect(io.packages).not.toHaveBeenCalled()
})
it('blocks a user service whose manager hard limit cannot grant its requested memlock', async () => {
  const { io, deps, target, files } = machine()
  Object.assign(target, { packages: [], mode: 'user-service', unit: 'atc.service' })
  const normal = io.run.getMockImplementation()!
  io.run.mockImplementation((c, a) =>
    c.endsWith('/runuser')
      ? Promise.resolve('loaded')
      : c.endsWith('/systemctl')
        ? Promise.resolve('123')
        : normal(c, a)
  )
  files['/proc/123/limits'] = 'Max locked memory         8388608              8388608              bytes\n'
  await expect(installLinuxNpu(target, deps, io)).rejects.toThrow('hard memlock')
  expect(deps.writeFile).not.toHaveBeenCalled()
})

it('the real host-step factory refuses an unqualified running kernel before any machine mutation', async () => {
  const { target } = machine()
  target.recipe.platforms[0]!.kernel_release = '0.0.0-atomic-fixture-never-running'
  await expect(nodeHostStepDeps({}).installLinuxNpu!(target)).rejects.toThrow('Unsupported Ubuntu release')
})
