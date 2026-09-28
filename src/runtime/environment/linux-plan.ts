/**
 * Turning `LinuxFacts` into a verdict: adopt the machine as it stands, install what is missing, or
 * explain why neither is possible before anything asks for a password (design D2).
 *
 * Three kinds of answer, and only one of them installs anything:
 *
 * - **Adopt.** The daemon answers the current user over the system socket and already exposes a
 *   GPU runtime. Nothing is missing, so nothing is proposed — on any distribution, including ones
 *   nobody has qualified an install recipe for (spec: "Дистрибутив вне рецепта, но Docker с GPU
 *   готов").
 * - **Install plan.** Docker or the toolkit is missing, but this machine's distribution, version
 *   and architecture are on the descriptor's `linux.install-container-runtime` recipe. The plan
 *   lists only the packages this machine is actually missing, never a whole-system upgrade.
 * - **Blocked.** Either a fact no install can fix (no driver, a driver or card too old, the wrong
 *   architecture), or a Docker install this integration will not touch (snap, rootless, Docker
 *   Desktop without a system Engine, the `podman-docker` shim) or immutable base (rpm-ostree)
 *   without a working Docker already, or — Arch and its derivatives only — exact manual commands,
 *   because Arch has no qualified recipe and a partial `pacman -S` next to a GPU driver risks
 *   leaving the kernel and driver modules out of sync (design D2).
 *
 * Blockers that no install fixes are checked first and unconditionally: a host that happens to
 * already expose a GPU runtime is still refused if the driver is below `minimum_driver_version` or
 * every card is below `minimum_compute_capability` — the spec requires that check to run "до
 * всякого согласия" (before any consent), not only on a host that still needs setup.
 */

import type { ErrorBody, ManagedAvailability, RecipeDistribution } from '../../contracts/index.js'
import type { LinuxDistribution, LinuxFacts } from './linux-probe.js'
import { prerequisiteBlocker } from './linux-probe.js'

export type LinuxSystemChangeCode =
  | 'add-repository'
  | 'install-packages'
  | 'configure-nvidia-runtime'
  | 'enable-docker-service'
  | 'add-user-to-docker-group'
  | 'restart-docker'

/**
 * One line of an install plan, structured rather than pre-rendered: `code` and `params` let a
 * client (or the plan digest, task 2.6) key off the change itself, `text` is what a person reads
 * before the OS authorization prompt.
 */
export interface LinuxSystemChange {
  code: LinuxSystemChangeCode
  text: string
  params?: Record<string, string>
}

export interface LinuxInstallPlan {
  recipe_id: string
  requires_elevation: boolean
  /** True exactly when the plan adds the user to the `docker` group (design D4). */
  may_require_relogin: boolean
  system_changes: LinuxSystemChange[]
}

export interface LinuxAssessment {
  availability: ManagedAvailability
  /** The machine is usable as it stands: nothing to install, nothing to authorize. */
  adopts_existing_engine: boolean
  install_plan: LinuxInstallPlan | null
  blockers: ErrorBody[]
}

export interface LinuxAssessmentOptions {
  /** `linux.install-container-runtime`, from the descriptor's own recipe id — not hardcoded here. */
  recipeId: string
  /** This recipe's qualified distributions, from the descriptor. Arch never checks this list. */
  recipeDistributions: RecipeDistribution[]
  minimumDriverVersion: string
  minimumComputeCapability: string
  requiredDiskBytes: number | null
  /** The account the plan would add to the `docker` group. */
  currentUser: string
}

const SUPPORTED_ARCHITECTURES = new Set(['x86_64', 'aarch64'])

/**
 * Compares two dotted version strings (`"580.65.06"`, `"8.9"`) segment by segment, numerically.
 * A missing trailing segment counts as `0`, so `"8"` and `"8.0"` compare equal.
 */
export function compareDottedVersions(a: string, b: string): number {
  const left = a.split('.').map((segment) => Number(segment) || 0)
  const right = b.split('.').map((segment) => Number(segment) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1
  }
  return 0
}

const ARCH_COMMANDS = [
  'sudo pacman -S --needed docker nvidia-container-toolkit',
  'sudo nvidia-ctk runtime configure --runtime=docker',
  'sudo systemctl enable --now docker',
  'sudo usermod -aG docker $USER',
  '# then log out and back in',
].join('\n')

/** Turn the facts into a verdict: usable now, installable, or not on this machine. */
export function assessLinux(facts: LinuxFacts, options: LinuxAssessmentOptions): LinuxAssessment {
  const blocked = (blockers: ErrorBody[]): LinuxAssessment => ({
    availability: 'prerequisite-blocked',
    adopts_existing_engine: false,
    install_plan: null,
    blockers,
  })

  const universal: ErrorBody[] = []
  for (const name of facts.unknown) {
    universal.push(prerequisiteBlocker(`Could not determine ${name} on this system.`, name))
  }

  if (facts.architecture !== null && !SUPPORTED_ARCHITECTURES.has(facts.architecture)) {
    universal.push(
      prerequisiteBlocker(
        `This machine's architecture (${facts.architecture}) is not supported; only x86_64 and aarch64 can run this runtime.`,
        facts.architecture
      )
    )
  }

  if (facts.driver_version === null) {
    if (!facts.unknown.includes('nvidia-driver')) {
      universal.push(
        prerequisiteBlocker('No NVIDIA driver was found. Install the driver for your card, then try again.')
      )
    }
  } else {
    if (compareDottedVersions(facts.driver_version, options.minimumDriverVersion) < 0) {
      universal.push(
        prerequisiteBlocker(
          `The NVIDIA driver is too old: this engine needs ${options.minimumDriverVersion} or newer, this machine has ${facts.driver_version}.`,
          `required=${options.minimumDriverVersion} actual=${facts.driver_version}`
        )
      )
    }
    if (facts.gpus.length === 0) {
      universal.push(prerequisiteBlocker('The NVIDIA driver is installed but reports no usable GPU.'))
    } else {
      const best = facts.gpus.reduce((champion, gpu) =>
        compareDottedVersions(gpu.compute_capability, champion.compute_capability) > 0 ? gpu : champion
      )
      if (compareDottedVersions(best.compute_capability, options.minimumComputeCapability) < 0) {
        universal.push(
          prerequisiteBlocker(
            `Needs a GPU with compute capability ${options.minimumComputeCapability} or newer (Ampere+); the best card here has ${best.compute_capability}.`,
            `required=${options.minimumComputeCapability} actual=${best.compute_capability}`
          )
        )
      }
    }
  }

  // A Docker install this integration will never adopt or install over, regardless of whether it
  // happens to expose a GPU runtime — there is no safe way to lay `docker-ce` next to or over it.
  const methodBlocker = installMethodBlocker(facts.docker.install_method)
  if (methodBlocker !== null) universal.push(methodBlocker)

  // Insufficient room for the engine image blocks an adopted host exactly as much as one that
  // still needs Docker installed, so this is checked unconditionally rather than only on the
  // install-plan path.
  if (
    options.requiredDiskBytes !== null &&
    facts.free_disk_bytes !== null &&
    facts.free_disk_bytes < options.requiredDiskBytes
  ) {
    universal.push(
      prerequisiteBlocker(
        'There is not enough free disk space for the runtime image.',
        `free=${facts.free_disk_bytes} required=${options.requiredDiskBytes}`
      )
    )
  }

  if (universal.length > 0) return blocked(universal)

  const dockerReady = facts.docker.daemon_reachable && facts.docker.gpu_runtime
  if (dockerReady) {
    return { availability: 'supported', adopts_existing_engine: true, install_plan: null, blockers: [] }
  }

  if (facts.immutable_os) {
    return blocked([
      prerequisiteBlocker(
        'This system uses an immutable base (rpm-ostree — Silverblue, Kinoite, Bazzite, or similar). ' +
          'Installing Docker here means layering a package and rebooting, which this integration does ' +
          'not do automatically. Install docker-ce and the NVIDIA Container Toolkit yourself, then try again.'
      ),
    ])
  }

  // `distribution` is guaranteed non-null here: a null distribution already added 'distribution'
  // to `facts.unknown`, which returned above.
  const distribution = facts.distribution as LinuxDistribution

  if (distribution.family === 'pacman') {
    return blocked([
      prerequisiteBlocker(
        'Automatic install is not offered on Arch and its derivatives: a partial package install next ' +
          'to the NVIDIA driver risks leaving the kernel module out of sync until a full system upgrade ' +
          'and reboot. Install manually from the official repositories instead:\n' +
          ARCH_COMMANDS,
        'arch'
      ),
    ])
  }

  const qualified = options.recipeDistributions.some(
    (entry) =>
      entry.id === distribution.id &&
      entry.version_id === distribution.version_id &&
      entry.arch === facts.architecture
  )
  if (!qualified) {
    return blocked([
      prerequisiteBlocker(
        'Setting the runtime up automatically is only qualified on some distributions so far.',
        `${distribution.id} ${distribution.version_id} ${facts.architecture ?? 'unknown'}`
      ),
    ])
  }

  return {
    availability: 'setup-required',
    adopts_existing_engine: false,
    install_plan: buildInstallPlan(facts, distribution, options),
    blockers: [],
  }
}

function installMethodBlocker(method: LinuxFacts['docker']['install_method']): ErrorBody | null {
  switch (method) {
    case 'snap':
      return prerequisiteBlocker(
        'Docker was installed from the snap store, which does not support the NVIDIA Container ' +
          'Toolkit. Switch to the docker-ce package instead; nothing here removes the snap install.',
        'snap'
      )
    case 'rootless':
      return prerequisiteBlocker(
        'Rootless Docker is not supported for this runtime. Switch to a standard (rootful) docker-ce ' +
          'installation; nothing here removes the rootless install.',
        'rootless'
      )
    case 'docker-desktop':
      return prerequisiteBlocker(
        'Docker Desktop without a separate system Docker Engine cannot be configured for this runtime. ' +
          'Install docker-ce as the system engine; nothing here changes the Docker Desktop install.',
        'docker-desktop'
      )
    case 'podman-docker':
      return prerequisiteBlocker(
        "The docker command here is Podman's compatibility shim, not Docker Engine; Podman is not " +
          'supported by this runtime. Install Docker Engine (docker-ce) to use it; nothing here removes ' +
          'Podman or installs docker-ce over it.',
        'podman-docker'
      )
    default:
      return null
  }
}

const FAMILY_LABEL: Record<'apt' | 'dnf', string> = { apt: 'apt', dnf: 'dnf' }

function buildInstallPlan(
  facts: LinuxFacts,
  distribution: LinuxDistribution,
  options: LinuxAssessmentOptions
): LinuxInstallPlan {
  // Never lay docker-ce over a working moby-engine/docker.io install (they conflict at the package
  // level, design D2) or over anything else this probe already recognised; only a genuinely absent
  // Docker gets the full package set.
  const dockerPackages =
    facts.docker.install_method === null ? ['docker-ce', 'docker-ce-cli', 'containerd.io'] : []
  const toolkitPackages = facts.toolkit_installed ? [] : ['nvidia-container-toolkit']
  const missingPackages = [...dockerPackages, ...toolkitPackages]
  const family = distribution.family === 'apt' || distribution.family === 'dnf' ? distribution.family : null
  const familyLabel = family === null ? 'package' : FAMILY_LABEL[family]

  const systemChanges: LinuxSystemChange[] = []

  if (dockerPackages.length > 0) {
    systemChanges.push({
      code: 'add-repository',
      text: `Add Docker's official ${familyLabel} repository and signing key (download.docker.com).`,
      params: { vendor: 'docker', family: distribution.family },
    })
  }
  if (toolkitPackages.length > 0) {
    systemChanges.push({
      code: 'add-repository',
      text: `Add the NVIDIA Container Toolkit ${familyLabel} repository and signing key (nvidia.github.io/libnvidia-container).`,
      params: { vendor: 'nvidia', family: distribution.family },
    })
  }
  if (missingPackages.length > 0) {
    systemChanges.push({
      code: 'install-packages',
      text: `Install the missing packages: ${missingPackages.join(', ')}.`,
      params: { packages: missingPackages.join(',') },
    })
  }
  if (!facts.docker.gpu_runtime) {
    systemChanges.push({
      code: 'configure-nvidia-runtime',
      text: 'Configure the NVIDIA runtime for Docker (nvidia-ctk runtime configure --runtime=docker).',
    })
  }

  // Whatever the exact reason the current user cannot reach the daemon — Docker not installed,
  // not running, or not accessible to this account — enabling the service and adding the user to
  // the group are both idempotent, so the recipe always does both rather than trying to diagnose
  // which one is missing.
  const needsAccess = !facts.docker.daemon_reachable
  if (needsAccess) {
    systemChanges.push({ code: 'enable-docker-service', text: 'Enable and start docker.service.' })
    systemChanges.push({
      code: 'add-user-to-docker-group',
      text: `Add ${options.currentUser} to the docker group. This grants access equivalent to root on this machine.`,
      params: { user: options.currentUser },
    })
  }

  // Reconfiguring the runtime on a Docker that is already running requires restarting it, which
  // stops whatever containers are up (design D5) — only relevant when Docker is not already being
  // freshly enabled above.
  if (facts.docker.daemon_reachable && !facts.docker.gpu_runtime) {
    const count = facts.docker.containers_running
    systemChanges.push({
      code: 'restart-docker',
      text:
        count > 0
          ? `Restart Docker to load the new runtime configuration; ${count} running container(s) will stop.`
          : 'Restart Docker to load the new runtime configuration.',
      params: { running_containers: String(count) },
    })
  }

  return {
    recipe_id: options.recipeId,
    requires_elevation: true,
    may_require_relogin: needsAccess,
    system_changes: systemChanges,
  }
}
