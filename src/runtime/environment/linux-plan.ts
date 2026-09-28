/**
 * Turning `LinuxFacts` into a verdict: adopt the machine as it stands, install what is missing, or
 * explain why neither is possible before anything asks for a password (design D2).
 *
 * Four kinds of answer, and only two of them ever propose a system change:
 *
 * - **Adopt.** The daemon answers the current user over the system socket and already exposes a
 *   GPU runtime. Nothing is missing, so nothing is proposed — on any distribution, including ones
 *   nobody has qualified an install recipe for (spec: "Дистрибутив вне рецепта, но Docker с GPU
 *   готов"). Per controller ruling (item 11), `availability` still reads `setup-required` here —
 *   2.6 is the one that upgrades it to `supported` once the installation itself is `ready`.
 * - **Access only.** The daemon is *active* (`systemctl is-active docker`) but this login session
 *   cannot reach it — the classic "just added to the `docker` group, haven't logged back in yet"
 *   story. Nothing about the GPU runtime is touched, because without reaching the daemon there is
 *   no live evidence of its state to act on (item 3) — the plan is exactly "add the group if it is
 *   not already configured" and nothing else, with no elevation at all when it already is.
 * - **Install plan.** Docker or the toolkit is missing, but this machine's distribution, version
 *   and architecture are on the descriptor's `linux.install-container-runtime` recipe. The plan
 *   lists only the packages this machine is actually missing, never a whole-system upgrade.
 * - **Blocked.** Either a fact no install can fix (no driver, a driver or card too old, the wrong
 *   architecture), or a Docker install this integration will not touch (snap, rootless, Docker
 *   Desktop without a system Engine, the `podman-docker` shim, or one the package database and
 *   `docker info` simply do not recognise), or an immutable base (rpm-ostree) without a working
 *   Docker already, or — Arch and its derivatives only — exact manual commands, because Arch has
 *   no qualified recipe and installing a single package without a full `pacman -Syu` can leave the
 *   system inconsistent (design D2).
 *
 * Blockers that no install fixes are checked first and unconditionally: a host that happens to
 * already expose a GPU runtime is still refused if the driver is below `minimum_driver_version` or
 * every card is below `minimum_compute_capability` — the spec requires that check to run "до
 * всякого согласия" (before any consent), not only on a host that still needs setup.
 */

import type { ManagedAvailability, RecipeDistribution } from '../../contracts/index.js'
import type { LinuxDistribution, LinuxFacts } from './linux-probe.js'

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
  /**
   * Always `true` for a plan this module returns (controller ruling, item 10 — spec text states
   * `requires_elevation: true, may_require_relogin: true` together for the install-plan
   * requirement): even a plan whose only content is package installs can leave a member of the
   * `docker` group who is not yet reading as one, and a client should always offer the "log out and
   * back in" step rather than assume that never applies.
   */
  may_require_relogin: boolean
  system_changes: LinuxSystemChange[]
}

/**
 * A stable, machine-readable reason a host is blocked — for a client to switch on, or a test to
 * assert against, instead of matching on `message` text (item 8).
 */
export type LinuxBlockerReason =
  | 'unknown-fact'
  | 'unsupported-architecture'
  | 'driver-missing'
  | 'driver-too-old'
  | 'no-gpu'
  | 'compute-capability-too-low'
  | 'docker-snap'
  | 'docker-rootless'
  | 'docker-desktop-only'
  | 'podman-docker'
  | 'docker-unrecognised'
  | 'immutable-os'
  | 'distribution-not-in-recipe'
  | 'arch-manual-install'
  | 'insufficient-disk'

/**
 * One reason a host cannot proceed. `params` carries the machine-checkable specifics (required vs.
 * actual version, the distro tuple, ...); `commands`, when present, are exact, copyable shell
 * commands (Arch's manual install); `message` is what a person reads.
 */
export interface LinuxBlocker {
  reason: LinuxBlockerReason
  message: string
  params?: Record<string, string>
  commands?: string[]
}

export interface LinuxAssessment {
  availability: ManagedAvailability
  /** The machine is usable as it stands: nothing to install, nothing to authorize. */
  adopts_existing_engine: boolean
  install_plan: LinuxInstallPlan | null
  blockers: LinuxBlocker[]
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

function blocker(
  reason: LinuxBlockerReason,
  message: string,
  params?: Record<string, string>,
  commands?: string[]
): LinuxBlocker {
  return {
    reason,
    message,
    ...(params === undefined ? {} : { params }),
    ...(commands === undefined ? {} : { commands }),
  }
}

// Arch never supports a partial `pacman -S` of just these two packages (design D2): installing a
// package without syncing the whole system can leave it inconsistent, so the commands run a full
// `-Syu` instead — which may itself bring in a newer kernel and NVIDIA driver, hence the reboot
// note. `nvidia-ctk runtime configure` changes `/etc/docker/daemon.json`, so Docker is explicitly
// restarted afterward rather than relying on `enable --now` to notice the new config on its own
// (item 12).
const ARCH_COMMANDS = [
  'sudo pacman -Syu --needed docker nvidia-container-toolkit',
  'sudo nvidia-ctk runtime configure --runtime=docker',
  'sudo systemctl restart docker',
  'sudo systemctl enable --now docker',
  'sudo usermod -aG docker $USER',
]

/** Turn the facts into a verdict: usable now, installable, waiting on a relogin, or not on this machine. */
export function assessLinux(facts: LinuxFacts, options: LinuxAssessmentOptions): LinuxAssessment {
  const blocked = (blockers: LinuxBlocker[]): LinuxAssessment => ({
    availability: 'prerequisite-blocked',
    adopts_existing_engine: false,
    install_plan: null,
    blockers,
  })

  const universal: LinuxBlocker[] = []
  for (const name of facts.unknown) {
    universal.push(blocker('unknown-fact', `Could not determine ${name} on this system.`, { fact: name }))
  }

  if (facts.architecture !== null && !SUPPORTED_ARCHITECTURES.has(facts.architecture)) {
    universal.push(
      blocker(
        'unsupported-architecture',
        `This machine's architecture (${facts.architecture}) is not supported; only x86_64 and aarch64 can run this runtime.`,
        { actual: facts.architecture }
      )
    )
  }

  if (facts.driver_version === null) {
    if (!facts.unknown.includes('nvidia-driver')) {
      universal.push(
        blocker(
          'driver-missing',
          'No NVIDIA driver was found. Install the driver for your card, then try again.'
        )
      )
    }
  } else {
    if (compareDottedVersions(facts.driver_version, options.minimumDriverVersion) < 0) {
      universal.push(
        blocker(
          'driver-too-old',
          `The NVIDIA driver is too old: this engine needs ${options.minimumDriverVersion} or newer, this machine has ${facts.driver_version}.`,
          { required: options.minimumDriverVersion, actual: facts.driver_version }
        )
      )
    }
    if (facts.gpus.length === 0) {
      universal.push(blocker('no-gpu', 'The NVIDIA driver is installed but reports no usable GPU.'))
    } else {
      const best = facts.gpus.reduce((champion, gpu) =>
        compareDottedVersions(gpu.compute_capability, champion.compute_capability) > 0 ? gpu : champion
      )
      if (compareDottedVersions(best.compute_capability, options.minimumComputeCapability) < 0) {
        universal.push(
          blocker(
            'compute-capability-too-low',
            `Needs a GPU with compute capability ${options.minimumComputeCapability} or newer (Ampere+); the best card here has ${best.compute_capability}.`,
            { required: options.minimumComputeCapability, actual: best.compute_capability }
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
      blocker('insufficient-disk', 'There is not enough free disk space for the runtime image.', {
        free: String(facts.free_disk_bytes),
        required: String(options.requiredDiskBytes),
      })
    )
  }

  if (universal.length > 0) return blocked(universal)

  const dockerReady = facts.docker.daemon_reachable && facts.docker.gpu_runtime
  if (dockerReady) {
    // Ruling (item 11): stays 'setup-required' here even though nothing is missing — 2.6 owns the
    // upgrade to 'supported' once the runtime installation itself reads ready.
    return { availability: 'setup-required', adopts_existing_engine: true, install_plan: null, blockers: [] }
  }

  // The daemon is confirmed running but this session cannot reach it: the one thing that can fix
  // that is a relogin (once the `docker` group is configured), never a package or a runtime change
  // this probe has no live evidence for (item 2/3).
  if (!facts.docker.daemon_reachable && facts.docker.service_active === true) {
    const needsGroup = !facts.docker_group.configured
    const systemChanges: LinuxSystemChange[] = needsGroup
      ? [
          {
            code: 'add-user-to-docker-group',
            text: `Add ${options.currentUser} to the docker group. This grants access equivalent to root on this machine.`,
            params: { user: options.currentUser },
          },
        ]
      : []
    return {
      availability: 'setup-required',
      adopts_existing_engine: false,
      install_plan: {
        recipe_id: options.recipeId,
        requires_elevation: needsGroup,
        may_require_relogin: true,
        system_changes: systemChanges,
      },
      blockers: [],
    }
  }

  if (facts.immutable_os) {
    return blocked([
      blocker(
        'immutable-os',
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
      blocker(
        'arch-manual-install',
        "Arch and its derivatives don't support a partial package install: adding just these two " +
          'packages without a full system sync can leave the system inconsistent, so the commands ' +
          'below run a full `pacman -Syu` instead — which may itself update your kernel and NVIDIA ' +
          'driver. Reboot afterward if it does, then log out and back in so the new docker group ' +
          'membership takes effect. Automatic install is not offered here.',
        { family: 'pacman' },
        ARCH_COMMANDS
      ),
    ])
  }

  // Something answers to `docker` here, but neither the package database nor `docker info` places
  // it as any install this probe recognises — never lay docker-ce over an unknown quantity (item 15).
  if (facts.docker.cli && facts.docker.install_method === null) {
    return blocked([
      blocker(
        'docker-unrecognised',
        "This machine's docker command does not match any Docker install this integration " +
          'recognises (not docker-ce, docker.io, moby-engine, snap, rootless, Docker Desktop, or the ' +
          'podman-docker shim). Nothing will be installed over it automatically.'
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
      blocker(
        'distribution-not-in-recipe',
        'Setting the runtime up automatically is only qualified on some distributions so far.',
        { id: distribution.id, version_id: distribution.version_id, arch: facts.architecture ?? 'unknown' }
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

function installMethodBlocker(method: LinuxFacts['docker']['install_method']): LinuxBlocker | null {
  switch (method) {
    case 'snap':
      return blocker(
        'docker-snap',
        'Docker was installed from the snap store, which does not support the NVIDIA Container ' +
          'Toolkit. Switch to the docker-ce package instead; nothing here removes the snap install.'
      )
    case 'rootless':
      return blocker(
        'docker-rootless',
        'Rootless Docker is not supported for this runtime. Switch to a standard (rootful) docker-ce ' +
          'installation; nothing here removes the rootless install.'
      )
    case 'docker-desktop':
      return blocker(
        'docker-desktop-only',
        'Docker Desktop without a separate system Docker Engine cannot be configured for this runtime. ' +
          'Install docker-ce as the system engine; nothing here changes the Docker Desktop install.'
      )
    case 'podman-docker':
      return blocker(
        'podman-docker',
        "The docker command here is Podman's compatibility shim, not Docker Engine; Podman is not " +
          'supported by this runtime. podman-docker conflicts with docker-ce at the package level, so ' +
          'it must be removed first; install Docker Engine (docker-ce) afterward. Nothing here removes ' +
          'Podman itself or installs docker-ce over it automatically.'
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
  // `docker info` is authoritative when it answered; otherwise the only evidence available is the
  // read-only daemon.json/CDI check (item 3) — never guessed from silence.
  const liveEvidence = facts.docker.daemon_reachable
  const effectiveGpuRuntime = liveEvidence ? facts.docker.gpu_runtime : facts.docker.gpu_runtime_from_config

  // Never lay docker-ce over a working moby-engine/docker.io install (they conflict at the package
  // level, design D2) or over anything else this probe already recognised; only a genuinely absent
  // Docker gets the full package set. (A `cli && install_method === null` machine never reaches
  // here — `assessLinux` blocks it first, item 15.)
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
  if (!effectiveGpuRuntime) {
    systemChanges.push({
      code: 'configure-nvidia-runtime',
      text: 'Configure the NVIDIA runtime for Docker (nvidia-ctk runtime configure --runtime=docker).',
    })
  }

  // Access steps are each emitted only when this specific thing is actually missing — never paired
  // blindly (item 2). When `liveEvidence` is true, access is already proven, so neither applies.
  if (!liveEvidence) {
    if (facts.docker.service_active !== true) {
      systemChanges.push({ code: 'enable-docker-service', text: 'Enable and start docker.service.' })
    }
    if (!facts.docker_group.configured) {
      systemChanges.push({
        code: 'add-user-to-docker-group',
        text: `Add ${options.currentUser} to the docker group. This grants access equivalent to root on this machine.`,
        params: { user: options.currentUser },
      })
    }
  }

  // Reconfiguring the runtime on a Docker that is confirmed live and running requires restarting
  // it, which stops whatever containers are up (design D5) — only planned from live evidence, so
  // the container count in the warning is never a guess.
  if (liveEvidence && !effectiveGpuRuntime) {
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
    requires_elevation: systemChanges.length > 0,
    // Ruling (item 10): always true for a plan, regardless of whether this particular one happens
    // to touch the docker group.
    may_require_relogin: true,
    system_changes: systemChanges,
  }
}
