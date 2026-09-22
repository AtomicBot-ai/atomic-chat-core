/**
 * What a Windows machine can already do, read without changing any of it.
 *
 * Windows never adopts the user's own container setup. The runtime runs inside a distribution
 * Atomic Chat imports and owns, so what this probe answers is narrower: can the host support one,
 * what has to be turned on first, and is ours already there.
 *
 * Two traps are handled here rather than anywhere downstream. `wsl.exe` writes UTF-16, so a caller
 * that decoded it as UTF-8 hands us a string with a NUL between every character; parsing that
 * naively finds no distributions on a machine that has several. And the account matters: when the
 * app is running elevated, the administrator is not the person whose distribution this is. The
 * invoking account is supplied by the app and is the only identity the import may use — deriving it
 * from the current process would register the guest to the wrong profile, where the user cannot
 * reach their own models.
 */

import type { ErrorBody, GpuFacts, ManagedAvailability } from '../../contracts/index.js'
import { parseNvidiaSmi, type CommandOutput } from './linux-probe.js'

export interface WindowsAccount {
  name: string
  sid: string
}

export interface WslDistribution {
  name: string
  state: string
  /** WSL 1 and WSL 2 are different machines; only 2 can carry this runtime. */
  version: number | null
  is_default: boolean
  /** True only when this is the exact distribution this installation recorded as its own. */
  owned: boolean
}

export interface WindowsFeatures {
  wsl: boolean | null
  virtual_machine_platform: boolean | null
  virtualization_firmware: boolean | null
}

export interface WindowsFacts {
  features: WindowsFeatures
  wsl_default_version: number | null
  wsl_kernel: string | null
  distributions: WslDistribution[]
  owned_distribution: WslDistribution | null
  driver_version: string | null
  gpus: GpuFacts[]
  /** The account that launched the app. Never the administrator an elevation switched to. */
  original_user: WindowsAccount
  /** Set only when the process is running as somebody else, so the difference is visible. */
  elevated_user: WindowsAccount | null
  free_disk_bytes: number | null
  unknown: string[]
}

export type WindowsPrerequisite =
  'virtualization' | 'wsl-feature' | 'virtual-machine-platform' | 'nvidia-driver' | 'owned-distribution'

export interface WindowsAssessment {
  availability: ManagedAvailability
  /** Our distribution is already registered, so nothing has to be enabled or imported. */
  adopts_existing_engine: boolean
  needs_reboot: boolean
  missing: WindowsPrerequisite[]
  blockers: ErrorBody[]
  /** The account the distribution must be imported under. */
  import_as: WindowsAccount
}

export interface WindowsProbeDeps {
  exec: (command: string, args: string[]) => Promise<CommandOutput>
  /** Supplied by the app from the session that launched it, not read from this process. */
  originalUser: WindowsAccount
  elevatedUser?: WindowsAccount
  /** The distribution name this installation recorded, if it has one yet. */
  ownedDistribution: string | null
  freeDiskBytes: () => Promise<number | null>
}

const NUL = String.fromCharCode(0)
const BOM = String.fromCharCode(0xfeff)

/** `wsl.exe` speaks UTF-16; a caller that read it as UTF-8 leaves a NUL between every character. */
export function decodeWslOutput(text: string): string {
  return text.split(NUL).join('').split(BOM).join('')
}

/** `wsl --status`: the default version and the kernel, in whatever language Windows is set to. */
export function parseWslStatus(output: CommandOutput | null): {
  default_version: number | null
  kernel: string | null
} {
  if (output === null || output.code !== 0) return { default_version: null, kernel: null }
  const text = decodeWslOutput(output.stdout)
  const version = /:\s*([12])\s*$/m.exec(text)
  const kernel = /(\d+\.\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/.exec(text)
  return {
    default_version: version === null ? null : Number(version[1]),
    kernel: kernel === null ? null : (kernel[1] as string),
  }
}

/**
 * `wsl --list --verbose`: a header, then one line per distribution, the default marked with `*`.
 * The header's own words change with the display language, so a row is recognised by shape instead:
 * a real one ends in a version number.
 */
export function parseWslDistributions(output: CommandOutput | null, owned: string | null): WslDistribution[] {
  if (output === null || output.code !== 0) return []
  const rows: WslDistribution[] = []
  for (const raw of decodeWslOutput(output.stdout).split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    const isDefault = line.startsWith('*')
    const cells = line
      .replace(/^\*/, '')
      .trim()
      .split(/\s{2,}|\t+/)
      .filter(Boolean)
    if (cells.length < 3) continue
    const version = Number(cells[cells.length - 1])
    if (!Number.isInteger(version)) continue
    const name = cells[0] as string
    rows.push({
      name,
      state: cells[1] as string,
      version,
      is_default: isDefault,
      // Ownership is the exact name this installation recorded, never a family resemblance.
      owned: owned !== null && name === owned,
    })
  }
  return rows
}

/** `Get-WindowsOptionalFeature ... | ConvertTo-Json`: an object for one feature, an array for several. */
export function parseOptionalFeatures(output: CommandOutput | null): Map<string, boolean> {
  const states = new Map<string, boolean>()
  if (output === null || output.code !== 0) return states
  try {
    const parsed = JSON.parse(output.stdout) as unknown
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    for (const entry of entries) {
      const feature = entry as { FeatureName?: unknown; State?: unknown }
      if (typeof feature.FeatureName !== 'string') continue
      // `State` is an enum: 2 over the wire, "Enabled" once formatted.
      states.set(feature.FeatureName, feature.State === 2 || feature.State === 'Enabled')
    }
  } catch {
    return states
  }
  return states
}

/** `Get-ComputerInfo -Property HyperVRequirementVirtualizationFirmwareEnabled | ConvertTo-Json`. */
export function parseVirtualization(output: CommandOutput | null): boolean | null {
  if (output === null || output.code !== 0) return null
  try {
    const parsed = JSON.parse(output.stdout) as Record<string, unknown>
    const value =
      parsed['HyperVRequirementVirtualizationFirmwareEnabled'] ?? parsed['VirtualizationFirmwareEnabled']
    return typeof value === 'boolean' ? value : null
  } catch {
    return null
  }
}

const FEATURE_WSL = 'Microsoft-Windows-Subsystem-Linux'
const FEATURE_VMP = 'VirtualMachinePlatform'

/** Read the machine. Nothing here enables a feature, imports a distribution or starts one. */
export async function probeWindows(deps: WindowsProbeDeps): Promise<WindowsFacts> {
  const unknown: string[] = []
  const [status, list, features, virtualization, smi, disk] = await Promise.all([
    deps.exec('wsl.exe', ['--status']),
    deps.exec('wsl.exe', ['--list', '--verbose']),
    deps.exec('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-WindowsOptionalFeature -Online -FeatureName ${FEATURE_WSL},${FEATURE_VMP} | ConvertTo-Json`,
    ]),
    deps.exec('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-ComputerInfo -Property HyperVRequirementVirtualizationFirmwareEnabled | ConvertTo-Json',
    ]),
    deps.exec('nvidia-smi', [
      '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
      '--format=csv,noheader,nounits',
    ]),
    deps.freeDiskBytes().catch(() => null),
  ])

  const featureStates = parseOptionalFeatures(features)
  if (featureStates.size === 0) unknown.push('windows-features')
  const virtualizationEnabled = parseVirtualization(virtualization)
  if (virtualizationEnabled === null) unknown.push('virtualization')
  if (smi.code === null) unknown.push('nvidia-driver')
  if (disk === null) unknown.push('free-disk')

  const distributions = parseWslDistributions(list, deps.ownedDistribution)
  const nvidia = parseNvidiaSmi(smi)
  const { default_version, kernel } = parseWslStatus(status)

  return {
    features: {
      wsl: featureStates.get(FEATURE_WSL) ?? null,
      virtual_machine_platform: featureStates.get(FEATURE_VMP) ?? null,
      virtualization_firmware: virtualizationEnabled,
    },
    wsl_default_version: default_version,
    wsl_kernel: kernel,
    distributions,
    owned_distribution: distributions.find((entry) => entry.owned) ?? null,
    driver_version: nvidia.driver_version,
    gpus: nvidia.gpus,
    original_user: deps.originalUser,
    elevated_user: deps.elevatedUser ?? null,
    free_disk_bytes: disk,
    unknown,
  }
}

const blocker = (message: string, details?: string): ErrorBody => ({
  code: 'MANAGED_PREREQUISITE_BLOCKED',
  message,
  ...(details === undefined ? {} : { details }),
})

export interface WindowsAssessmentOptions {
  requiredDiskBytes: number | null
}

export function assessWindows(facts: WindowsFacts, options: WindowsAssessmentOptions): WindowsAssessment {
  const blockers: ErrorBody[] = []
  const missing: WindowsPrerequisite[] = []

  for (const name of facts.unknown) {
    blockers.push(blocker(`Could not determine ${name} on this system.`, name))
  }

  if (facts.features.virtualization_firmware === false) {
    missing.push('virtualization')
    // Enabling this is a firmware setting; no installer can do it for the user.
    blockers.push(
      blocker('Virtualization is turned off in this computer’s firmware. Turn it on, then try again.')
    )
  }
  if (facts.driver_version === null && !facts.unknown.includes('nvidia-driver')) {
    missing.push('nvidia-driver')
    blockers.push(blocker('No NVIDIA driver was found. Install the driver for your card, then try again.'))
  } else if (facts.driver_version !== null && facts.gpus.length === 0) {
    blockers.push(blocker('The NVIDIA driver is installed but reports no usable GPU.'))
  }

  if (facts.features.wsl !== true) missing.push('wsl-feature')
  if (facts.features.virtual_machine_platform !== true) missing.push('virtual-machine-platform')
  if (facts.owned_distribution === null) missing.push('owned-distribution')

  if (
    options.requiredDiskBytes !== null &&
    facts.free_disk_bytes !== null &&
    facts.free_disk_bytes < options.requiredDiskBytes
  ) {
    blockers.push(
      blocker(
        'There is not enough free disk space for the runtime image.',
        `free=${facts.free_disk_bytes} required=${options.requiredDiskBytes}`
      )
    )
  }

  // A distribution registered as WSL 1 cannot run this runtime, and converting it is the user's call.
  if (facts.owned_distribution !== null && facts.owned_distribution.version !== 2) {
    blockers.push(
      blocker(
        'The Atomic Chat distribution is registered as WSL 1, which cannot run the runtime.',
        facts.owned_distribution.name
      )
    )
  }

  const enablingFeatures = missing.includes('wsl-feature') || missing.includes('virtual-machine-platform')
  const adopts = blockers.length === 0 && missing.length === 0
  const availability: ManagedAvailability =
    blockers.length > 0 ? 'prerequisite-blocked' : adopts ? 'supported' : 'setup-required'

  return {
    availability,
    adopts_existing_engine: adopts,
    // Turning a Windows feature on takes a restart before anything can use it.
    needs_reboot: enablingFeatures && blockers.length === 0,
    missing,
    blockers,
    // The elevation may be running as an administrator; the distribution is still the user's.
    import_as: facts.original_user,
  }
}
