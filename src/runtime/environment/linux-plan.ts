/**
 * Turning `LinuxFacts` into a verdict: adopt the machine as it stands, install what is missing, or
 * explain why neither is possible before anything asks for a password (design D2).
 *
 * Six kinds of answer, and only two of them ever propose a system change:
 *
 * - **Adopt.** The daemon answers the current user over the system socket and already exposes a
 *   GPU runtime. Nothing is missing, so nothing is proposed — on any distribution, including ones
 *   nobody has qualified an install recipe for (spec: "Дистрибутив вне рецепта, но Docker с GPU
 *   готов"). Per controller ruling (item 11), `availability` still reads `setup-required` here —
 *   2.6 is the one that upgrades it to `supported` once the installation itself is `ready`.
 * - **Relogin required.** This account is already a confirmed member of the `docker` group, but this
 *   login session predates that — the daemon is unreachable for no other reason than a stale
 *   session. A blocker, not an install plan, on every distribution (design D4, round 3 ruling 4):
 *   there is nothing to elevate, nothing to change, and no recipe-tagged plan to hand back — just a
 *   wait for the next sign-in. If the account is a member *and* this session already shows it, yet
 *   the daemon still refuses the connection, that is not a relogin problem at all —
 *   `docker-access-unexplained` below (round 2, item 2).
 * - **Group only.** Everything else is ready (Docker, the toolkit, the GPU runtime, the service),
 *   but the account is not (confirmedly) a member of the `docker` group yet. On a distribution that
 *   would otherwise qualify for an automatic install, this is a minimal plan: just the group add.
 *   Everywhere else (Arch, an immutable base, or a distribution nobody has qualified), automatic
 *   elevation is not offered even for one command — the answer is a blocker with the exact commands
 *   instead (round 2, item 5; round 3, ruling 6 for rpm-ostree's extra step).
 * - **Install plan.** Docker or the toolkit is missing, but this machine's distribution, version
 *   and architecture are on the descriptor's `linux.install-container-runtime` recipe. The plan
 *   lists only the packages this machine is actually missing, never a whole-system upgrade.
 * - **Blocked.** Either a fact no install can fix (no driver, a driver or card too old, the wrong
 *   architecture), or a Docker install this integration will not touch (snap, rootless, Docker
 *   Desktop without a system Engine, the `podman-docker` shim, or one the package database and
 *   `docker info` simply do not recognise), or an immutable base (rpm-ostree) without a working
 *   Docker already, or a `daemon.json` this probe cannot read or parse, or — Arch and its
 *   derivatives only — exact manual commands, because Arch has no qualified recipe and installing a
 *   single package without a full `pacman -Syu` can leave the system inconsistent (design D2).
 *
 * Blockers that no install fixes are checked first and unconditionally: a host that happens to
 * already expose a GPU runtime is still refused if the driver is below `minimum_driver_version` or
 * every card is below `minimum_compute_capability` — the spec requires that check to run "до
 * всякого согласия" (before any consent), not only on a host that still needs setup.
 */

import type { ManagedAvailability, RecipeDistribution } from '../../contracts/index.js'
import {
  archCommands,
  blocker,
  effectiveGpuRuntime,
  groupOnlyCommands,
  installMethodBlocker,
  type LinuxBlocker,
} from './linux-blockers.js'
import type { LinuxDistribution, LinuxFacts } from './linux-probe.js'

export type { LinuxBlocker, LinuxBlockerReason } from './linux-blockers.js'

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
  /** The account the plan would add to the `docker` group. Never `root` (design D4, item 9): root
   *  needs no group membership, so this account should never be `root` in practice, but this module
   *  still never proposes `usermod` for it even if it is. */
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

/**
 * Whether this probe recognises *something* about how Docker got here. Arch's own `docker` package
 * is not one `dpkg-query`/`rpm -q` ever see (round 3, item 1/ruling 1) — there is exactly one common
 * source there, nothing to disambiguate against the way Debian/Fedora need — so `docker.cli`
 * answering at all on a `pacman`-family host stands in for a real `install_method` match.
 */
function dockerInstallRecognised(facts: LinuxFacts, distribution: LinuxDistribution): boolean {
  return facts.docker.install_method !== null || (distribution.family === 'pacman' && facts.docker.cli)
}

/** Would automatic package installation even be offered on this host, distribution questions aside? */
function distroBlocksAutoInstall(
  facts: LinuxFacts,
  distribution: LinuxDistribution,
  options: LinuxAssessmentOptions
): boolean {
  if (facts.immutable_os) return true
  if (distribution.family === 'pacman') return true
  const qualified = options.recipeDistributions.some(
    (entry) =>
      entry.id === distribution.id &&
      entry.version_id === distribution.version_id &&
      entry.arch === facts.architecture
  )
  return !qualified
}

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

  // Group effectiveness is a session-level fact, checked before anything distro-specific and on
  // every distribution (round 3, ruling 4) — it overrides Arch/immutable-base/unqualified gating
  // the same way it would on Ubuntu, because logging back in is either the whole fix or provably not
  // the fix, regardless of what else this host is or is not qualified for.
  if (!facts.docker.daemon_reachable) {
    if (facts.docker_group.configured === true && !facts.docker_group.effective) {
      // The account is a confirmed member; this session just predates it. Never an install plan —
      // there is nothing to elevate or change, only a wait for the next sign-in.
      return blocked([
        blocker(
          'relogin-required',
          'This account is already a member of the docker group, but this login session started ' +
            'before that took effect. Log out and back in (or restart this session) to pick it up.',
          undefined,
          []
        ),
      ])
    }
    if (facts.docker_group.configured === true && facts.docker_group.effective) {
      // Membership is confirmed *and* this session already has it, yet the daemon still refused —
      // relogin will not fix that, and this probe has no further diagnosis to offer (round 2, item 2).
      return blocked([
        blocker(
          'docker-access-unexplained',
          'The docker group already includes this account and this login session already has it, and ' +
            'the daemon still did not answer over the system socket. Something other than group ' +
            "membership is blocking access — check the socket's permissions or an AppArmor/SELinux " +
            'policy — this integration cannot fix it automatically.'
        ),
      ])
    }
  }

  // `distribution` is guaranteed non-null here: a null distribution already added 'distribution'
  // to `facts.unknown`, which returned above.
  const distribution = facts.distribution as LinuxDistribution

  // Nothing but group membership is missing: Docker, the toolkit, the GPU runtime and the service
  // are all there by every signal this probe has (round 2, items 2/3/5 — the previous round's
  // access-only branch trusted `!daemon_reachable && service_active` alone, which hid a missing
  // toolkit behind an apparently harmless "just relogin" plan). Group *effectiveness* is handled
  // above already, unconditionally — everything reaching this point has `configured` `false` or
  // `'unknown'`.
  const readyExceptAccess =
    facts.docker.cli &&
    facts.toolkit_installed &&
    dockerInstallRecognised(facts, distribution) &&
    effectiveGpuRuntime(facts) &&
    facts.docker.service_active === true &&
    !facts.docker.daemon_reachable

  if (readyExceptAccess) {
    // Root never benefits from `docker` group membership at all, so a root session landing here has
    // the same unexplained problem as the confirmed-member case above, not a group to add (design
    // D4, round 2 item 9).
    if (options.currentUser === 'root') {
      return blocked([
        blocker(
          'docker-access-unexplained',
          'Running as root, and docker.service is active, but the daemon still did not answer over the ' +
            'system socket. This is not a group-membership problem — root needs none — and this ' +
            'integration has no further diagnosis to offer automatically.'
        ),
      ])
    }
    if (distroBlocksAutoInstall(facts, distribution, options)) {
      const commands = groupOnlyCommands(facts.immutable_os, options.currentUser)
      return blocked([
        blocker(
          'docker-group-manual',
          'Everything else is ready — Docker, the toolkit and the NVIDIA runtime are all configured. ' +
            `This account just needs to join the docker group, which is not something this distribution's ` +
            `automatic install can add for you: run ${commands.map((c) => `\`${c}\``).join(', then ')}, then ` +
            'log out and back in.',
          { user: options.currentUser },
          commands
        ),
      ])
    }
    return {
      availability: 'setup-required',
      adopts_existing_engine: false,
      install_plan: {
        recipe_id: options.recipeId,
        requires_elevation: true,
        may_require_relogin: true,
        system_changes: [
          {
            code: 'add-user-to-docker-group',
            text: `Add ${options.currentUser} to the docker group. This grants access equivalent to root on this machine.`,
            params: { user: options.currentUser },
          },
        ],
      },
      blockers: [],
    }
  }

  // Something real is missing beyond access — the toolkit, the runtime configuration, Docker
  // itself, or the service is not even running. Every path from here goes through the same
  // distribution gating a full install would.
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

  if (distribution.family === 'pacman') {
    const commands = archCommands(options.currentUser)
    return blocked([
      blocker(
        'arch-manual-install',
        "Arch and its derivatives don't support a partial package install: adding just these two " +
          'packages without a full system sync can leave the system inconsistent, so the commands ' +
          'below run a full `pacman -Syu` instead — which may itself update your kernel and NVIDIA ' +
          'driver. Reboot afterward if it does' +
          (options.currentUser === 'root'
            ? '.'
            : ', then log out and back in so the new docker group membership takes effect.') +
          ' Automatic install is not offered here.',
        { family: 'pacman' },
        commands
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

  // A daemon.json this probe cannot read or parse is not a safe target for `nvidia-ctk runtime
  // configure` (round 2, item 6; round 3, item 2 broadens this past `!daemon_reachable` — a
  // reachable daemon that already says the runtime is unconfigured is just as unsafe to reconfigure
  // blind when the file behind that configuration cannot even be read back).
  if (!effectiveGpuRuntime(facts) && facts.docker.daemon_json_unreadable) {
    return blocked([
      blocker(
        'daemon-json-unreadable',
        '/etc/docker/daemon.json exists but could not be read or parsed, so this integration cannot tell ' +
          "whether the NVIDIA runtime is already configured there. Fix the file's permissions or contents " +
          'by hand, then try again — nothing here will overwrite a file it cannot read back.'
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

const FAMILY_LABEL: Record<'apt' | 'dnf', string> = { apt: 'apt', dnf: 'dnf' }

function buildInstallPlan(
  facts: LinuxFacts,
  distribution: LinuxDistribution,
  options: LinuxAssessmentOptions
): LinuxInstallPlan {
  // `docker info` is authoritative when it answered; otherwise the only evidence available is the
  // read-only daemon.json/CDI check (item 3) — never guessed from silence.
  const liveEvidence = facts.docker.daemon_reachable
  const runtimeConfigured = effectiveGpuRuntime(facts)

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
  if (!runtimeConfigured) {
    systemChanges.push({
      code: 'configure-nvidia-runtime',
      text: 'Configure the NVIDIA runtime for Docker (nvidia-ctk runtime configure --runtime=docker).',
    })
  }

  // Access steps are each emitted only when this specific thing is actually missing — never paired
  // blindly (item 2). When `liveEvidence` is true, access is already proven, so neither applies.
  // Root is never offered a group add (design D4, round 2 item 9): it needs no membership, and if
  // access is still missing for root that is not what fixes it.
  if (!liveEvidence) {
    if (facts.docker.service_active !== true) {
      systemChanges.push({ code: 'enable-docker-service', text: 'Enable and start docker.service.' })
    }
    if (facts.docker_group.configured !== true && options.currentUser !== 'root') {
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
  if (liveEvidence && !runtimeConfigured) {
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
