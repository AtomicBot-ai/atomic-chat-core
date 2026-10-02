/**
 * What a Windows machine needs before TensorRT-LLM can run on it (change `add-tensorrt-llm-windows`,
 * task 2.3; spec `wsl-runtime-environment`): the facts `probeWindowsHost` read, the guest's own facts
 * when Atomic Chat's distribution exists, and the manifest, turned into a verdict — the blockers, and
 * the changes a setup would make. Pure: no I/O, so every scenario is a table row.
 *
 * The order of the gates is the order a person can act on them. First what makes the provider
 * pointless to show at all (`unsupported`): a machine that is not x64, no manifest and nothing
 * imported yet, a Windows build below the manifest's minimum. Then what blocks a plan
 * (`prerequisite-blocked`): this core running elevated (its `wsl.exe` would see another user's
 * registrations, design D2), a distribution with Atomic Chat's name it never imported, the NVIDIA
 * driver and card, virtualization off in the firmware, a WSL older than the manifest asks, our own
 * distribution registered as WSL 1, whatever the guest itself blocks on, and the disk. Everything
 * else is the plan: enable WSL (the one elevated step, which may need a restart), import the
 * distribution, provision the guest with the Linux recipe.
 *
 * The guest is judged by `assessLinux`, exactly as a Linux host (design D1), with one substitution:
 * the driver version it compares is the NVIDIA library version WSL hands the guest, not the number
 * the guest's `nvidia-smi` prints (that is the Windows driver's; design D10).
 */

import type {
  GpuFacts,
  ManagedAvailability,
  ManagedSystemChange,
  WindowsEnvironmentManifest,
} from '../../contracts/index.js'
import type { GuestExtras } from './guest-host.js'
import { assessLinux, compareDottedVersions, type LinuxBlocker, type LinuxInstallPlan } from './linux-plan.js'
import type { LinuxFacts } from './linux-probe.js'
import type { WindowsHostFacts, WslDistribution } from './windows-probe.js'

/** Room a fresh guest takes before any image: Ubuntu's base system, Docker Engine and the toolkit. */
export const GUEST_BASE_BYTES = 4 * 1024 ** 3

export type WindowsBlockerReason =
  | LinuxBlocker['reason']
  | 'windows-build-too-old'
  | 'elevated-process'
  | 'foreign-distribution'
  | 'virtualization-disabled'
  | 'wsl-version'
  | 'wsl1-distribution'
  | 'windows-restart-pending'

export interface WindowsBlocker {
  reason: WindowsBlockerReason
  message: string
  params?: Record<string, string>
  commands?: string[]
}

export interface WindowsAssessmentInput {
  facts: WindowsHostFacts
  /** The manifest this probe judges by: the pinned one for an existing environment, else the latest. */
  manifest: WindowsEnvironmentManifest | null
  /** Atomic Chat's own distribution: the recorded one, as `wsl --list` shows it. Null when not registered. */
  owned: WslDistribution | null
  /** A distribution with Atomic Chat's name exists that no record says is ours. */
  foreign: boolean
  /** Where ours is or would be. */
  distribution: { name: string; path: string }
  /** Free bytes on that directory's volume. */
  volumeFreeBytes: number | null
  /** The guest's facts, when ours exists and could be entered. */
  guest: { facts: LinuxFacts; extras: GuestExtras } | null
  guestRecipeId: string
  minimumDriverVersion: string
  minimumComputeCapability: string
  /** What the engine image still needs on disk; null when nothing is left to pull (or no image at all). */
  requiredDiskBytes: number | null
}

export interface WindowsAssessment {
  availability: ManagedAvailability
  /** Ours exists and its guest already runs containers on the GPU: nothing to change. */
  adopts_existing_engine: boolean
  blockers: WindowsBlocker[]
  /** The one elevated step: `wsl --install`. */
  enable_wsl: boolean
  import_distribution: boolean
  /** The guest recipe's own plan, when ours exists and still needs it. */
  guest_plan: LinuxInstallPlan | null
  provision_guest: boolean
  system_changes: ManagedSystemChange[]
  /** The smaller of the volume's and the guest's free space; null when neither could be read. */
  free_disk_bytes: number | null
  /** Whether that covers what is still needed; null when it could not be told. */
  disk_sufficient: boolean | null
}

const blocker = (
  reason: WindowsBlockerReason,
  message: string,
  params?: Record<string, string>,
  commands?: string[]
): WindowsBlocker => ({
  reason,
  message,
  ...(params === undefined ? {} : { params }),
  ...(commands === undefined ? {} : { commands }),
})

const verdict = (
  availability: ManagedAvailability,
  blockers: WindowsBlocker[],
  free: number | null = null
): WindowsAssessment => ({
  availability,
  adopts_existing_engine: false,
  blockers,
  enable_wsl: false,
  import_distribution: false,
  guest_plan: null,
  provision_guest: false,
  system_changes: [],
  free_disk_bytes: free,
  disk_sufficient: null,
})

/** The driver and card, read on Windows: what has to be there before WSL is worth enabling. */
function nvidiaBlockers(facts: WindowsHostFacts, minimumComputeCapability: string): WindowsBlocker[] {
  if (facts.unknown.includes('nvidia-driver')) return []
  if (facts.driver_installed === false) {
    return [
      blocker(
        'driver-missing',
        'No NVIDIA driver was found. Install the NVIDIA driver for your card from nvidia.com, then check again.'
      ),
    ]
  }
  if (facts.gpus.length === 0) {
    return [blocker('no-gpu', 'The NVIDIA driver is installed but reports no NVIDIA graphics card.')]
  }
  const eligible = facts.gpus.some(
    (gpu: GpuFacts) => compareDottedVersions(gpu.compute_capability, minimumComputeCapability) >= 0
  )
  if (eligible) return []
  const best = facts.gpus
    .map((gpu) => gpu.compute_capability)
    .sort((a, b) => compareDottedVersions(b, a))[0] as string
  return [
    blocker(
      'compute-capability-too-low',
      `TensorRT-LLM needs an NVIDIA card of the Ampere generation (RTX 30xx) or newer; this card has compute capability ${best}.`,
      { required: minimumComputeCapability, actual: best }
    ),
  ]
}

/** The guest judged as a Linux host, with the library version standing in for the driver's (D10). */
function guestVerdict(
  input: WindowsAssessmentInput,
  guest: { facts: LinuxFacts; extras: GuestExtras }
): { blockers: WindowsBlocker[]; plan: LinuxInstallPlan | null; adopts: boolean } {
  const library = guest.extras.nvidia_library_version
  if (library === null) {
    return {
      blockers: [
        blocker(
          'unknown-fact',
          'Could not read the version of the NVIDIA libraries Windows provides to the distribution.',
          { fact: 'nvidia-libraries' }
        ),
      ],
      plan: null,
      adopts: false,
    }
  }
  const facts: LinuxFacts = {
    ...guest.facts,
    driver_version: library,
    gpus: guest.facts.gpus.map((gpu) => ({ ...gpu, driver_version: library })),
  }
  const linux = assessLinux(facts, {
    recipeId: input.guestRecipeId,
    recipeDistributions: input.manifest === null ? null : [input.manifest.rootfs.distribution],
    minimumDriverVersion: input.minimumDriverVersion,
    minimumComputeCapability: input.minimumComputeCapability,
    // The disk is judged once, for the guest and its volume together (below).
    requiredDiskBytes: null,
    currentUser: 'root',
  })
  const windowsDriver = input.facts.driver_version ?? guest.facts.driver_version ?? 'unknown'
  const blockers = linux.blockers
    // The card was already judged on Windows; the guest sees the same one.
    .filter((entry) => !['no-gpu', 'compute-capability-too-low', 'driver-missing'].includes(entry.reason))
    .map((entry): WindowsBlocker =>
      entry.reason === 'driver-too-old'
        ? blocker(
            'driver-too-old',
            `The NVIDIA libraries Windows provides to WSL are version ${library}, older than the ${input.minimumDriverVersion} TensorRT-LLM needs. Update the NVIDIA driver for Windows (now ${windowsDriver}), restart, and check again.`,
            { required: input.minimumDriverVersion, actual: library, windows_driver: windowsDriver }
          )
        : { ...entry }
    )
  return { blockers, plan: linux.install_plan, adopts: linux.adopts_existing_engine }
}

export function assessWindowsHost(input: WindowsAssessmentInput): WindowsAssessment {
  const { facts, manifest } = input

  // What makes the provider pointless to show here at all.
  if (facts.architecture !== 'x86_64') {
    return verdict('unsupported', [
      blocker(
        'unsupported-architecture',
        'TensorRT-LLM on Windows needs a 64-bit x86 (x64) PC; Windows on ARM is not supported.',
        { actual: facts.architecture ?? 'unknown' }
      ),
    ])
  }
  if (manifest === null && input.owned === null) {
    return verdict('unsupported', [
      blocker(
        'environment-manifest-unavailable',
        'TensorRT-LLM is not available for Windows yet: the description of the Windows environment could not be loaded.'
      ),
    ])
  }
  if (manifest !== null && input.owned === null && facts.windows_build !== null) {
    if (facts.windows_build < manifest.minimum_windows_build) {
      return verdict('unsupported', [
        blocker('windows-build-too-old', 'TensorRT-LLM on Windows needs Windows 11.', {
          required: String(manifest.minimum_windows_build),
          actual: String(facts.windows_build),
        }),
      ])
    }
  }

  const blockers: WindowsBlocker[] = []
  for (const name of facts.unknown) {
    blockers.push(blocker('unknown-fact', `Could not determine ${name} on this system.`, { fact: name }))
  }
  if (facts.elevated === true) {
    blockers.push(
      blocker(
        'elevated-process',
        'Atomic Chat is running as administrator. Close it and start it normally: the WSL distribution has to belong to your own account.'
      )
    )
  }
  if (input.foreign) {
    blockers.push(
      blocker(
        'foreign-distribution',
        `A WSL distribution named "${input.distribution.name}" already exists, and Atomic Chat did not create it. It will not be used or changed. Rename or remove it, then check again.`,
        { name: input.distribution.name }
      )
    )
  }
  blockers.push(...nvidiaBlockers(facts, input.minimumComputeCapability))

  const wslReady = facts.wsl.installed === true && facts.wsl.ready === true
  // WSL is in and the VM platform is on, but Windows has not restarted yet: no second elevation.
  const restartPending = facts.wsl.installed === true && facts.wsl.reboot_pending === true && !wslReady
  if (restartPending) {
    blockers.push(
      blocker(
        'windows-restart-pending',
        'Windows needs a restart to finish turning on the Windows Subsystem for Linux. Restart the computer, open Atomic Chat again and check again.'
      )
    )
  }
  const enableWsl = facts.wsl.installed !== null && !wslReady && !restartPending
  if (enableWsl && facts.virtualization === false) {
    blockers.push(
      blocker(
        'virtualization-disabled',
        'Virtualization is turned off in this computer’s firmware (BIOS/UEFI). Turn on Intel VT-x or AMD-V (SVM) there, restart, and check again; no installer can do this for you.'
      )
    )
  }
  if (manifest !== null && facts.wsl.installed === true && facts.wsl.version !== null) {
    if (compareDottedVersions(facts.wsl.version, manifest.minimum_wsl_version) < 0) {
      blockers.push(
        blocker(
          'wsl-version',
          `WSL ${facts.wsl.version} is installed; TensorRT-LLM needs ${manifest.minimum_wsl_version} or newer. Update it with the command below, then check again.`,
          { required: manifest.minimum_wsl_version, actual: facts.wsl.version },
          ['wsl --update']
        )
      )
    }
  }
  if (input.owned !== null && input.owned.version !== 2) {
    blockers.push(
      blocker(
        'wsl1-distribution',
        `The Atomic Chat distribution "${input.owned.name}" is registered as WSL 1, which cannot run TensorRT-LLM. Atomic Chat does not convert it; remove the environment and set it up again.`,
        { name: input.owned.name }
      )
    )
  }

  const importDistribution = input.owned === null && !input.foreign
  let guestPlan: LinuxInstallPlan | null = null
  let guestAdopts = false
  if (input.guest !== null) {
    const guest = guestVerdict(input, input.guest)
    blockers.push(...guest.blockers)
    guestPlan = guest.plan
    guestAdopts = guest.adopts
  }
  const provisionGuest = importDistribution || guestPlan !== null

  // The disk: what is still needed against the smaller of the volume and the guest.
  const needed =
    input.requiredDiskBytes === null && !importDistribution
      ? null
      : (input.requiredDiskBytes ?? 0) + (importDistribution ? GUEST_BASE_BYTES : 0)
  const guestFree = input.guest?.facts.free_disk_bytes ?? null
  const frees = [input.volumeFreeBytes, guestFree].filter((value): value is number => value !== null)
  const free = frees.length === 0 ? null : Math.min(...frees)
  const sufficient = needed === null ? true : free === null ? null : free >= needed
  if (sufficient === false) {
    blockers.push(
      blocker(
        'insufficient-disk',
        `There is not enough free space for TensorRT-LLM in ${input.distribution.path}: it needs ${needed} bytes and ${free} are free.`,
        { required: String(needed), free: String(free), path: input.distribution.path }
      )
    )
  }

  const changes: ManagedSystemChange[] = []
  if (enableWsl && facts.virtualization !== false) {
    changes.push({
      code: 'enable-wsl',
      text: 'Turn on the Windows Subsystem for Linux (wsl --install). Windows asks for administrator approval and a restart is needed. Windows also installs its default Ubuntu distribution, which may open its own setup window after the restart; Atomic Chat does not use it, and you can close that window.',
    })
  }
  if (importDistribution && manifest !== null) {
    const { id, version_id } = manifest.rootfs.distribution
    changes.push({
      code: 'import-distribution',
      text: `Download ${id} ${version_id} and import it as Atomic Chat’s own WSL distribution "${input.distribution.name}" in ${input.distribution.path}. Your other distributions and your default one are not touched.`,
      params: { name: input.distribution.name, path: input.distribution.path, rootfs: manifest.rootfs.url },
    })
  }
  if (provisionGuest) {
    const inside = guestPlan?.system_changes ?? []
    changes.push({
      code: 'provision-distribution',
      text:
        inside.length === 0
          ? 'Inside it, install Docker Engine and the NVIDIA Container Toolkit and generate the NVIDIA CDI specification.'
          : `Inside it: ${inside.map((change) => change.text).join(' ')}`,
      params: { components: inside.map((change) => change.code).join(',') },
    })
  }

  const adopts = blockers.length === 0 && wslReady && input.owned !== null && guestAdopts && !provisionGuest
  return {
    availability: blockers.length > 0 ? 'prerequisite-blocked' : 'setup-required',
    adopts_existing_engine: adopts,
    blockers,
    enable_wsl: enableWsl && facts.virtualization !== false,
    import_distribution: importDistribution,
    guest_plan: guestPlan,
    provision_guest: provisionGuest,
    system_changes: blockers.length > 0 ? [] : changes,
    free_disk_bytes: free,
    disk_sufficient: sufficient,
  }
}
