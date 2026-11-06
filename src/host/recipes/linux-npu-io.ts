import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nodeProbeDeps } from '../../hardware/index.js'
import { preparationHost, matchesNpuFirmware } from '../../runtime/fastflowlm/environment/index.js'
import type { HostStepExecutorDeps } from './executor.js'
import { firmwareDirectory, type LinuxNpuTarget } from './linux-amd-npu.js'
import { installNpuArchives, npuCommandEnv } from './linux-npu-dpkg.js'
import { stageNpuPackages, type NpuRun } from './linux-npu-packages.js'

const runCommand: NpuRun = async (exe, args) => {
  const { stdout } = await promisify(execFile)(exe, args, {
    cwd: '/',
    env: npuCommandEnv,
    timeout: 10 * 60_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trimEnd()
}
const native = {
  host: () => preparationHost(nodeProbeDeps(), release()),
  run: runCommand,
  stage: async () => {
    const path = await mkdtemp('/run/atomic-flm-npu-')
    await chmod(path, 0o711)
    return path
  },
  remove: (path: string) => rm(path, { recursive: true, force: true }),
  packages: stageNpuPackages,
  apply: installNpuArchives,
}
type Deps = Pick<HostStepExecutorDeps, 'invokingUid' | 'writeFile' | 'readFile' | 'fetch'>

export async function installLinuxNpu(t: LinuxNpuTarget, deps: Deps, io = native) {
  const host = await io.host(),
    kernel = host.kernel_release
  if (
    host.os !== 'linux' ||
    host.arch !== 'x64' ||
    host.distribution !== 'ubuntu' ||
    host.mutable !== true ||
    !kernel ||
    !t.recipe.platforms.some((p) => p.version === host.version && p.kernel_release === kernel)
  )
    throw Error('Unsupported Ubuntu release, running kernel or immutable host.')
  const run = io.run
  const pci = '/sys/bus/pci/devices/' + t.device
  const read = async (path: string) =>
    Buffer.from((await deps.readFile(path)) ?? [])
      .toString()
      .trim()
  const revision = (await read(pci + '/revision')).replace(/^0x/, '')
  if (
    (await read(pci + '/vendor')) !== '0x1022' ||
    (await read(pci + '/device')) !== '0x17f0' ||
    !['10', '11', '20'].includes(revision)
  )
    throw Error('Selected XDNA2 PCI device is absent or changed.')
  const user = (await run('/usr/bin/getent', ['passwd', t.account])).split(':')
  const uid = user[2],
    home = user[5]
  if (
    user[0] !== t.account ||
    !uid ||
    !/^[1-9]\d*$/.test(uid) ||
    !home?.startsWith('/') ||
    (t.mode !== 'system-service' && deps.invokingUid !== null && uid !== deps.invokingUid)
  )
    throw Error('Runtime account does not match the operator.')
  const unit = t.unit ?? ''
  if (
    t.mode === 'system-service' &&
    (await run('/usr/bin/systemctl', ['show', unit, '--property=User', '--value'])) !== t.account
  )
    throw Error('System unit is not owned by the runtime account.')
  const asUser = (cmd: string, ...args: string[]) =>
    run('/usr/sbin/runuser', [
      '-u',
      t.account,
      '--',
      '/usr/bin/env',
      '-i',
      'HOME=' + home,
      'PATH=/usr/bin:/bin',
      'XDG_RUNTIME_DIR=/run/user/' + uid,
      cmd,
      ...args,
    ])
  let limitFile = '',
    limitText = ''
  if (t.memlock) {
    if (t.mode === 'user-service') {
      if (
        (await asUser('/usr/bin/systemctl', '--user', 'show', unit, '--property=LoadState', '--value')) !==
        'loaded'
      )
        throw Error('User service is unavailable.')
      const pid = await run('/usr/bin/systemctl', [
        'show',
        'user@' + uid + '.service',
        '--property=MainPID',
        '--value',
      ])
      if (!/^[1-9]\d*$/.test(pid)) throw Error('User manager is unavailable.')
      const hard = /^Max locked memory\s+\S+\s+(unlimited|\d+)\s+bytes[ \t]*$/m.exec(
        await read('/proc/' + pid + '/limits')
      )?.[1]
      if (!hard || (hard !== 'unlimited' && BigInt(hard) < BigInt(t.recipe.memlock_bytes)))
        throw Error(
          'User manager hard memlock is too low. Raise its limit before applying this service drop-in.'
        )
    }
    if (t.mode.endsWith('-service')) {
      const base = t.mode === 'user-service' ? join(home, '.config/systemd/user') : '/etc/systemd/system'
      limitFile = join(base, unit + '.d', '60-atomic-npu.conf')
      limitText = '[Service]\nLimitMEMLOCK=' + t.recipe.memlock_bytes + '\n'
    } else {
      limitFile = '/etc/security/limits.d/90-atomic-npu-' + uid + '.conf'
      limitText = t.account + ' - memlock ' + String(t.recipe.memlock_bytes / 1024) + '\n'
    }
  }
  // No elevated read or write under a user-controlled home directory.
  let sameLimit = false
  if (limitFile) {
    if (t.mode === 'user-service') {
      const existing = await asUser('/usr/bin/cat', limitFile).catch(() => null)
      sameLimit = existing === limitText.trimEnd()
    } else sameLimit = (await read(limitFile)) === limitText.trim()
  }
  const ensure = async (path: string, body: string) => {
    if ((await read(path)) === body.trim()) return false
    await deps.writeFile(path, Buffer.from(body), 0o644)
    return true
  }
  const driver = t.packages.some((p) => p.name === 'amdxdna-dkms')
  if (driver) {
    if (!matchesNpuFirmware(revision, t.recipe.firmware_version))
      throw Error('Firmware version does not match the target PCI revision.')
    if (
      !/^\/sys\/kernel\/iommu_groups\/\d+$/.test(
        await run('/usr/bin/readlink', ['-e', pci + '/iommu_group']).catch(() => '')
      )
    )
      throw Error('The selected NPU has no active IOMMU group. Check the firmware settings.')
    const status = await run('/usr/bin/mokutil', ['--sb-state'])
    if (!/^(SecureBoot disabled|EFI variables are not supported on this system)$/m.test(status))
      throw Error('DKMS requires a verified Secure Boot signing/enrollment procedure for this kernel.')
    const builtFor = await read('/lib/modules/' + kernel + '/build/include/config/kernel.release')
    if (!builtFor && !t.packages.some((p) => p.name === 'linux-headers-' + kernel))
      throw Error('Running-kernel headers are missing from the approved transaction.')
    if (builtFor && builtFor !== kernel) throw Error('Installed headers target a different kernel.')
  }
  const installedState = (name: string) =>
    run('/usr/bin/dpkg-query', ['-W', '-f=${Status}\t${Version}\t${Architecture}', name]).catch(
      (e: unknown) => {
        if ((e as { code?: number }).code === 1) return ''
        throw e
      }
    )
  const missing = []
  for (const p of t.packages) {
    const state = await installedState(p.name)
    if (state !== ['install ok installed', p.version, p.architecture].join('\t')) {
      if (state.startsWith('install ok installed\t')) {
        const version = state.split('\t')[1]!
        await run('/usr/bin/dpkg', ['--compare-versions', version, 'le', p.version]).catch(() => {
          throw Error('Refusing a package downgrade: ' + p.name)
        })
      }
      missing.push(p)
    }
  }
  const rulePath = '/etc/udev/rules.d/70-atomic-npu-' + t.device.replace(/[:.]/g, '-') + '-' + uid + '.rules'
  const rule = `SUBSYSTEM=="accel", KERNEL=="accel[0-9]*", KERNELS=="${t.device}", ATTRS{vendor}=="0x1022", ATTRS{device}=="0x17f0", RUN+="/usr/bin/setfacl -m u:${uid}:rw $devnode"\n`
  if (t.access) await run('/usr/bin/setfacl', ['--version'])
  const stage = await io.stage()
  try {
    const files = missing.length ? await io.packages(t, missing, stage, revision, run, deps.fetch) : []
    if (files.length) {
      await io.apply(files)
      for (const p of missing) {
        if ((await installedState(p.name)) !== ['install ok installed', p.version, p.architecture].join('\t'))
          throw Error('The approved package version is not configured: ' + p.name)
      }
    }
    if (driver) {
      if ((await read('/lib/modules/' + kernel + '/build/include/config/kernel.release')) !== kernel)
        throw Error('Running kernel headers unavailable after package installation.')
      const module = await run('/usr/sbin/modinfo', ['-k', kernel, '-F', 'vermagic', 'amdxdna'])
      if (module.split(' ')[0] !== kernel)
        throw Error('Built amdxdna module does not match the running kernel.')
      const modulePath = await run('/usr/sbin/modinfo', ['-k', kernel, '-F', 'filename', 'amdxdna'])
      const relative = modulePath
        .replace(/^\/usr\/lib\//, '/lib/')
        .split('/lib/modules/' + kernel + '/updates/dkms/')
      if (
        relative.length !== 2 ||
        relative[0] !== '' ||
        !/^amdxdna\.ko(?:\.(?:gz|xz|zst))?$/.test(relative[1]!)
      )
        throw Error('Kernel selected a module outside the approved DKMS installation.')
      const fw = '/lib/firmware/updates/amdnpu/17f0_' + firmwareDirectory(revision) + '/npu_7.sbin'
      if (!(await run('/usr/bin/readlink', ['-e', fw])).endsWith('/npu.sbin.' + t.recipe.firmware_version))
        throw Error('Installed firmware differs from the pinned version.')
    }
    if (t.access) {
      await ensure(rulePath, rule)
      await run('/usr/bin/udevadm', ['control', '--reload-rules'])
      await run('/usr/bin/udevadm', [
        'trigger',
        '--action=change',
        '--subsystem-match=accel',
        '--parent-match=' + pci,
      ])
      await run('/usr/bin/udevadm', ['settle', '--timeout=30'])
    }
    if (limitFile) {
      if (!sameLimit && t.mode === 'user-service') {
        const config = join(stage, 'user-limit.conf')
        await writeFile(config, limitText, { mode: 0o644, flag: 'wx' })
        await chmod(config, 0o644)
        await asUser('/usr/bin/install', '-D', '-m', '0644', config, limitFile)
      } else if (!sameLimit) await ensure(limitFile, limitText)
      if (t.mode === 'user-service') await asUser('/usr/bin/systemctl', '--user', 'daemon-reload')
      if (t.mode === 'system-service') await run('/usr/bin/systemctl', ['daemon-reload'])
    }
    if (driver && (files.length || (await read(pci + '/fw_version')) !== t.recipe.firmware_version))
      return 'reboot-required' as const
    if (t.memlock && t.unit) return 'service-restart-required' as const
    if (t.memlock) return 'relogin-required' as const
    return 'completed' as const
  } finally {
    await io
      .remove(stage)
      .catch((error: Error) => process.emitWarning('Could not remove protected NPU stage: ' + error.message))
  }
}
