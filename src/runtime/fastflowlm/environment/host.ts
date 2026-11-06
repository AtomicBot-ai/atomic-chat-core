import { win32 } from 'node:path'
import type { ProbeDeps } from '../../../hardware/index.js'
import { parseOsRelease } from '../../environment/index.js'
import type { PreparationHost } from './plan.js'

/** Only the running host can supply the distribution, kernel and workstation identity. */
export async function preparationHost(deps: ProbeDeps, release: string): Promise<PreparationHost> {
  const os = deps.platform === 'win32' ? 'windows' : deps.platform
  const host: PreparationHost = {
    os,
    arch: deps.arch,
    distribution: null,
    version: null,
    kernel_release: os === 'linux' ? release : null,
    mutable: null,
  }
  if (os === 'windows' && deps.arch === 'x64' && Number(release.split('.')[2]) >= 22000) {
    const ps = win32.join(
      deps.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const r = await deps
      .run(
        ps,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).ProductType',
        ],
        10000
      )
      .catch(() => null)
    if (r?.code === 0 && r.stdout.trim() === '1') host.version = '11'
  }
  if (os === 'linux') {
    const [info, mounts, ostree] = await Promise.all([
      deps.fs.readFile('/etc/os-release').catch(() => null),
      deps.fs.readFile('/proc/self/mountinfo').catch(() => ''),
      deps.fs.exists('/run/ostree-booted'),
    ])
    const dist = parseOsRelease(info)
    host.distribution = dist?.id ?? null
    host.version = dist?.version_id ?? null
    const destinations = [
      '/etc/apt',
      '/etc/security/limits.d',
      '/etc/systemd/system',
      '/etc/udev/rules.d',
      '/var/lib/dpkg',
      '/usr',
      '/boot',
      '/lib/modules',
      '/usr/lib/modules',
      '/usr/src',
    ]
    const system = mounts
      .split('\n')
      .map((line) => line.split(' '))
      .filter((row) => {
        const mount = row[4]
        return (
          mount && (mount === '/' || destinations.some((dir) => dir === mount || dir.startsWith(mount + '/')))
        )
      })
    if (ostree) host.mutable = false
    else if (system.some((row) => row[4] === '/')) {
      host.mutable = system.every((row) => {
        const separator = row.indexOf('-')
        return (
          separator >= 6 &&
          row[5]?.split(',').includes('rw') === true &&
          row[separator + 3]?.split(',').includes('rw') === true
        )
      })
    }
  }
  return host
}
