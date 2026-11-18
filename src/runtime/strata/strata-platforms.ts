import type { StrataFamily } from '../../contracts/index.js'
import type { StrataRelease, StrataVariant } from '../../engine-builds/index.js'

export interface StrataDevice {
  id: string
  name?: string
  vendor: 'apple' | 'nvidia' | 'amd' | 'intel'
  ordinal?: number
  architecture?: string
  driverVersion?: string
  family?: string
  memoryBytes: number
  unified: boolean
}
export interface StrataHostFacts {
  os: string
  arch: string
  osVersion?: string
  distribution?: string
  glibcVersion?: string
  cpuFeatures?: string[]
  ramBytes: number
  devices: StrataDevice[]
}
function atLeast(actual: string | undefined, minimum: string) {
  if (!actual || !/^\d+(?:\.\d+)*$/.test(actual) || !/^\d+(?:\.\d+)*$/.test(minimum)) return false
  const a = actual.split('.').map(Number),
    b = minimum.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d > 0
  }
  return true
}

/** All compatibility bounds are positive evidence. Missing facts never authorize a fallback. */
export function selectStrataDevice(
  release: StrataRelease,
  facts: StrataHostFacts,
  family?: StrataFamily,
  gpuId?: string
):
  | { variant: StrataVariant; device: StrataDevice; reason: null }
  | { variant: null; device: null; reason: string } {
  const reasons = new Set<string>()
  // One installation carries every family this host can run; do not pick CUDA 12 merely by order.
  for (const v of [...release.variants].sort((a, b) => b.families.length - a.families.length)) {
    const h = v.host
    if (family && !v.families.includes(family)) continue
    if (facts.os !== h.os || facts.arch !== h.arch) continue
    if (!atLeast(facts.osVersion, h.minimum_os_version)) {
      reasons.add('OS version is unknown or below the required version.')
      continue
    }
    if (
      h.cpu_features.length &&
      (!facts.cpuFeatures || !h.cpu_features.every((f) => facts.cpuFeatures!.includes(f)))
    ) {
      reasons.add('Required CPU instruction sets are unavailable or unknown.')
      continue
    }
    if (
      (h.distribution && h.distribution !== facts.distribution) ||
      (h.minimum_glibc && !atLeast(facts.glibcVersion, h.minimum_glibc))
    ) {
      reasons.add('Distribution or glibc requirement is not confirmed.')
      continue
    }
    for (const gpu of facts.devices) {
      if (gpuId && gpuId !== gpu.id) continue
      if (gpu.vendor !== h.gpu_vendor) continue
      if (
        !gpu.architecture ||
        !h.gpu_architectures.includes(gpu.architecture) ||
        (family === 'deepseek41' &&
          v.family_gpu_architectures &&
          !v.family_gpu_architectures.deepseek41.includes(gpu.architecture))
      ) {
        reasons.add('GPU architecture is unsupported or unknown.')
        continue
      }
      if (
        (h.device_family && h.device_family !== gpu.family) ||
        (gpu.family && h.excluded_device_families?.includes(gpu.family))
      )
        continue
      if (h.minimum_driver && !atLeast(gpu.driverVersion, h.minimum_driver)) {
        reasons.add('GPU driver is unknown or below the required version.')
        continue
      }
      return { variant: v, device: gpu, reason: null }
    }
  }
  return {
    variant: null,
    device: null,
    reason:
      [...reasons].join(' ') ||
      'No published Strata variant supports this model and selected GPU on this host.',
  }
}

/** Match the build's own HIP enumeration. Identical cards cannot safely be distinguished by name. */
export function strataHipOrdinal(
  target: StrataDevice,
  host: readonly StrataDevice[],
  stdout: string
): number | undefined {
  const normalize = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!target.name || !target.architecture || target.vendor !== 'amd') return undefined
  const name = normalize(target.name)
  if (
    host.filter(
      (d) =>
        d.vendor === 'amd' && d.architecture === target.architecture && d.name && normalize(d.name) === name
    ).length !== 1
  )
    return undefined
  const matches = stdout.split(/(?=^\s*device \d+:)/m).flatMap((block) => {
    const row = /^\s*device (\d+):\s*([^\r\n]+)/.exec(block)
    if (!row || normalize(row[2]!) !== name || /cannot run:/i.test(block)) return []
    const arch = /^\s*arch (gfx[0-9a-f]+)\s*,/m.exec(block)?.[1]
    const ordinal = Number(row[1])
    return arch === target.architecture && Number.isSafeInteger(ordinal) ? [ordinal] : []
  })
  return matches.length === 1 ? matches[0] : undefined
}
