import { canonicalDigest } from '../../runtime/environment/index.js'
import {
  parseEnvironment,
  supportedLinuxNpuRecipe,
  type LinuxNpuRecipe,
} from '../../runtime/fastflowlm/environment/index.js'
import type { LinuxRuntimeProcess, LinuxMemlockStepParameters } from '../../contracts/index.js'
import { CORE_VERSION } from '../../version.js'
import type { HostStepRequest } from './request-file.js'

export type { LinuxNpuRecipe }
export type NpuPackage = LinuxNpuRecipe['packages'][number]
export function linuxNpuTarget(request: HostStepRequest) {
  try {
    const p = request.parameters,
      account = p.runtime_account,
      mode = p.runtime_mode,
      device = p.device_instance_id
    if (
      Object.keys(p)
        .filter((k) => k !== 'runtime_process')
        .sort()
        .join(',') !==
      'device_access,device_instance_id,environment_manifest,manifest_digest,manifest_id,memlock,package_names,recipe_revision,runtime_account,runtime_mode,runtime_service'
    )
      return null
    if (
      typeof account !== 'string' ||
      !/^[a-z_][a-z0-9_-]{0,31}$/.test(account) ||
      account === 'root' ||
      (mode !== 'interactive' &&
        mode !== 'desktop' &&
        mode !== 'system-service' &&
        mode !== 'user-service') ||
      (mode.endsWith('-service')
        ? typeof p.runtime_service !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.service$/.test(p.runtime_service)
        : p.runtime_service !== null) ||
      typeof device !== 'string' ||
      !/^[a-f0-9]{4}:[a-f0-9]{2}:[01][a-f0-9]\.[0-7]$/.test(device) ||
      typeof p.memlock !== 'boolean' ||
      typeof p.device_access !== 'boolean' ||
      !Array.isArray(p.package_names)
    )
      return null
    const owner = p.runtime_process as LinuxRuntimeProcess | undefined
    if (
      owner &&
      (Object.keys(owner).sort().join(',') !== 'boot_id,pid,start_ticks' ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 1 ||
        typeof owner.start_ticks !== 'string' ||
        !/^\d+$/.test(owner.start_ticks) ||
        typeof owner.boot_id !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner.boot_id))
    )
      return null
    const manifest = parseEnvironment(p.environment_manifest, 'linux')
    const r = manifest.recipes.find(
      (row) => row.recipe_id === request.recipe_id && row.revision === p.recipe_revision
    )
    if (
      r?.action !== 'linux.install-amd-npu' ||
      canonicalDigest(r) !== request.recipe_digest ||
      canonicalDigest(p) !== request.parameters_digest ||
      manifest.manifest_id !== p.manifest_id ||
      canonicalDigest(manifest) !== p.manifest_digest ||
      !r.hardware.pci_device_ids.includes('1022:17f0')
    )
      return null
    const min = r.min_core_version.split('.').map(BigInt),
      current = CORE_VERSION.split('.').map(BigInt)
    const difference = min.findIndex((v, i) => v !== current[i])
    if (difference >= 0 && min[difference]! > current[difference]!) return null
    const names = new Set<unknown>(p.package_names),
      packages = r.packages.filter((dep) => names.has(dep.name))
    if (packages.length !== p.package_names.length || (!packages.length && !p.memlock && !p.device_access))
      return null
    if (
      !supportedLinuxNpuRecipe(
        r,
        packages.map((p) => p.name)
      )
    )
      return null
    return {
      ...(owner ? { runtimeProcess: owner } : {}),
      recipe: r,
      account,
      mode: mode as LinuxMemlockStepParameters['runtime_mode'],
      unit: p.runtime_service as string | null,
      device,
      packages,
      memlock: p.memlock,
      access: p.device_access,
    }
  } catch {
    return null
  }
}
export type LinuxNpuTarget = NonNullable<ReturnType<typeof linuxNpuTarget>>

/** apt-cache must know this exact archive from the selected signed index. */
export function verifyAptRecord(
  text: string,
  p: Pick<NpuPackage, 'name' | 'version' | 'architecture' | 'path' | 'size' | 'sha256'>
) {
  const expected = {
    Package: p.name,
    Version: p.version,
    Architecture: p.architecture,
    Filename: p.path,
    Size: String(p.size),
    SHA256: p.sha256,
  }
  if (
    !text
      .trim()
      .split(/\n\s*\n/)
      .some((record) => Object.entries(expected).every(([k, v]) => record.split('\n').includes(k + ': ' + v)))
  )
    throw Error('Pinned version or SHA-256 missing from the signed index: ' + p.name)
}

export function checkAptSimulation(text: string, packages: Pick<NpuPackage, 'name' | 'version'>[]) {
  for (const line of text.split('\n')) {
    if (!/^(Inst|Conf|Remv|Purg) /.test(line)) continue
    const m = /^(?:Inst|Conf) ([a-z0-9.+-]+)(?::amd64)? (?:\[[^\]]+\] )?\(([^ )]+)/.exec(line)
    if (!m || !packages.some((p) => p.name === m[1] && p.version === m[2]))
      throw Error('APT would change an unapproved package: ' + line)
  }
}
// The pinned DKMS npu6_regs.c uses the NPU4 firmware directory for PCI revision 20.
export function firmwareDirectory(revision: string) {
  return revision === '20' ? '10' : revision
}
export function firmwareLink(list: string, revision: string, version: string) {
  const prefix = './lib/firmware/updates/amdnpu/17f0_' + firmwareDirectory(revision) + '/'
  return (
    list
      .split('\n')
      .some((l) => l.startsWith('l') && l.endsWith(' ' + prefix + 'npu_7.sbin -> npu.sbin.' + version)) &&
    list.split('\n').some((l) => l.startsWith('-') && l.endsWith(' ' + prefix + 'npu.sbin.' + version))
  )
}
