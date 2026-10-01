/**
 * The structured reasons `assessLinux` (`linux-plan.ts`) refuses a host — split out of that file
 * once it grew past the ~500-line guidance for this module (task 2.4 fix round 2). Everything here
 * is pure: a reason code, the message a person reads, and the machine-checkable specifics. A few
 * small, self-contained decision helpers moved in alongside them in round 3, for the same reason
 * (`linux-plan.ts` growing past the guidance again): `effectiveGpuRuntime` and the two exact-command
 * builders (`archCommands`, `groupOnlyCommands`) that blockers built here actually use. Round 4 moved
 * the install-gate blockers here too (`gateBlocker`), and added the relogin path's per-component
 * blockers (`missingComponentBlockers`).
 */

import type { LinuxDistribution, LinuxFacts } from './linux-probe.js'

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
  /** The environment manifest — the recipe's distribution list — could not be had (change `extract-environment-manifest`, D5). */
  | 'environment-manifest-unavailable'
  | 'arch-manual-install'
  | 'insufficient-disk'
  | 'daemon-json-unreadable'
  /** Group membership confirmed and effective, service active, daemon still unreachable (round 2, item 2). */
  | 'docker-access-unexplained'
  /** Everything but group membership is ready, and automatic elevation is not offered here (round 2, item 5). */
  | 'docker-group-manual'
  /** Group membership confirmed but this session predates it — a relogin, never an install plan, on any distro (round 3, ruling 4). */
  | 'relogin-required'
  /** Emitted next to `relogin-required` for each other component offline evidence shows missing (round 4, item 1). */
  | 'docker-cli-missing'
  | 'toolkit-missing'
  | 'gpu-runtime-not-configured'
  | 'docker-service-inactive'
  /** No systemd (`/run/systemd/system` absent): the recipe's service steps would fail after consent. */
  | 'init-not-systemd'

/**
 * One reason a host cannot proceed. `params` carries the machine-checkable specifics (required vs.
 * actual version, the distro tuple, ...); `commands`, when present, are exact, copyable shell
 * commands (Arch's manual install, or the single `usermod` a group-only host needs); `message` is
 * what a person reads.
 */
export interface LinuxBlocker {
  reason: LinuxBlockerReason
  message: string
  params?: Record<string, string>
  commands?: string[]
}

export function blocker(
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

/**
 * A Docker install this integration will never adopt or install over, regardless of whether it
 * happens to expose a GPU runtime — there is no safe way to lay `docker-ce` next to or over it.
 */
export function installMethodBlocker(method: LinuxFacts['docker']['install_method']): LinuxBlocker | null {
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

/**
 * Whether the GPU reaches a container: a listed NVIDIA CDI device (task 2.23, F-5), from `docker
 * info`'s side when the daemon answered, from `nvidia-ctk cdi list` alone when it did not (item 3).
 */
export function effectiveGpuRuntime(facts: LinuxFacts): boolean {
  return facts.docker.daemon_reachable ? facts.docker.gpu_runtime : facts.docker.gpu_runtime_from_config
}

/**
 * The commands a host missing only its `docker` group membership needs — everything else is
 * already ready. An rpm-ostree host (Silverblue/Kinoite/Bazzite) needs one step first: package
 * layering puts the `docker` group's line in `/usr/lib/group` (the vendor/OS-tree database), but
 * `/etc/group` — what `usermod`/`getent` actually consult — does not inherit it automatically, so
 * `usermod -aG docker` alone would fail with "group 'docker' does not exist" (round 3, ruling 6).
 * Never called for root (D4): root needs no group membership, and the caller never reaches here for it.
 */
export function groupOnlyCommands(immutableOs: boolean, user: string): string[] {
  const usermod = `sudo usermod -aG docker ${user}`
  if (!immutableOs) return [usermod]
  // Idempotent (round 4, item F): run twice, it must not append a second `docker:` line.
  return [
    `grep -q '^docker:' /etc/group || grep -E '^docker:' /usr/lib/group | sudo tee -a /etc/group`,
    usermod,
  ]
}

/** The CDI spec the recipe generates, as a person runs it (task 2.23, F-5; ruling R-core-8). */
const GENERATE_CDI_COMMAND = 'sudo nvidia-ctk cdi generate --output=/var/run/cdi/nvidia.yaml'

/**
 * Arch never supports a partial `pacman -S` of just these two packages (design D2): installing a
 * package without syncing the whole system can leave it inconsistent, so the commands run a full
 * `-Syu` instead — which may itself bring in a newer kernel and NVIDIA driver, hence the reboot
 * note. The CDI spec is generated too (task 2.23, F-5: Docker 28.2+ passes `--gpus` through it).
 * `nvidia-ctk runtime configure` changes `/etc/docker/daemon.json`, so Docker is explicitly
 * restarted afterward rather than relying on `enable --now` to notice the new config on its own
 * (item 12). The `usermod` line uses the actual probed account, never the literal `$USER`, and is
 * omitted entirely for root, which needs no group membership at all (round 3, ruling 8), and for an
 * account that is already a member (round 5, item 1: `groupNeeded` false).
 */
export function archCommands(user: string, groupNeeded = user !== 'root'): string[] {
  const commands = [
    'sudo pacman -Syu --needed docker nvidia-container-toolkit',
    'sudo nvidia-ctk runtime configure --runtime=docker',
    GENERATE_CDI_COMMAND,
    'sudo systemctl restart docker',
    'sudo systemctl enable --now docker',
  ]
  if (groupNeeded && user !== 'root') commands.push(`sudo usermod -aG docker ${user}`)
  return commands
}

/** Group membership confirmed, but this login session predates it (round 3, ruling 4). */
export function reloginRequiredBlocker(): LinuxBlocker {
  return blocker(
    'relogin-required',
    'This account is already a member of the docker group, but this login session started before that ' +
      'took effect. Log out and back in (or restart this session) to pick it up.',
    undefined,
    []
  )
}

/**
 * How far automatic setup can go on this host, decided in this order: an immutable base, Arch and its
 * derivatives, a `docker` command no package database recognises, no environment manifest to read the
 * recipe's distributions from (`'manifest-unavailable'`, change `extract-environment-manifest` D5 — a
 * different cause from `'unqualified'`, with a different fix), a distribution/version/architecture not
 * on the manifest's recipe — or `'recipe'` when none of those applies and a plan may be offered.
 * `assessLinux` computes it once and uses it on every path (group-only, relogin, full install), so the
 * paths cannot drift apart (round 4).
 */
export type InstallGate =
  'recipe' | 'immutable' | 'pacman' | 'unrecognised' | 'manifest-unavailable' | 'unqualified'

/**
 * Whether the gate's own blocker applies to this host — one decision, read by the relogin path and the
 * full-install path alike (round 5, item 2). Never on a recipe distribution. On an immutable base only
 * when a package (Docker or the toolkit) is missing, since layering packages is what the gate is about
 * (spec: "система неизменяемая … и Docker или toolkit нет"); a missing runtime configuration or a
 * stopped service is an ordinary step there, reported per component. Every other gate always applies.
 */
export function gateBlockerApplies(gate: InstallGate, facts: LinuxFacts): boolean {
  if (gate === 'recipe') return false
  if (gate === 'immutable') return !facts.docker.cli || !facts.toolkit_installed
  return true
}

/** `immutable-os`, naming exactly the packages that are missing — never docker-ce over an engine (round 5, item 2). */
function immutableOsBlocker(facts: LinuxFacts): LinuxBlocker {
  const missing: Array<[string, string]> = []
  if (!facts.docker.cli) missing.push(['docker', 'Docker Engine'])
  if (!facts.toolkit_installed) missing.push(['nvidia-container-toolkit', 'the NVIDIA Container Toolkit'])
  const base = 'This system uses an immutable base (rpm-ostree — Silverblue, Kinoite, Bazzite, or similar)'
  if (missing.length === 0) {
    return blocker(
      'immutable-os',
      `${base}. Automatic setup is not offered here; finish the remaining Docker setup by hand, then try again.`
    )
  }
  const names = missing.map(([, label]) => label).join(' and ')
  const plural = missing.length > 1
  return blocker(
    'immutable-os',
    `${base}, and ${names} ${plural ? 'are' : 'is'} not installed. Installing a package here means ` +
      'layering it and rebooting, which this integration does not do automatically. ' +
      `Layer ${plural ? 'them' : 'it'} yourself, then try again.`,
    { missing: missing.map(([key]) => key).join(',') }
  )
}

/**
 * The exact commands for joining the `docker` group, for a host where automatic setup is not offered.
 * `everythingElseReady` picks the wording: the only step left, or one step among others (round 5).
 */
export function dockerGroupManualBlocker(
  immutableOs: boolean,
  user: string,
  everythingElseReady: boolean
): LinuxBlocker {
  const commands = groupOnlyCommands(immutableOs, user)
  const run = `run ${commands.map((c) => `\`${c}\``).join(', then ')}, then log out and back in.`
  return blocker(
    'docker-group-manual',
    everythingElseReady
      ? 'Everything else is ready — Docker, the toolkit and the NVIDIA runtime are all configured. ' +
          "This account just needs to join the docker group, which is not something this distribution's " +
          `automatic install can add for you: ${run}`
      : `This account also needs to join the docker group: ${run}`,
    { user },
    commands
  )
}

/** Why automatic setup is not offered, for every gate but `'recipe'`. */
export function gateBlocker(
  gate: Exclude<InstallGate, 'recipe'>,
  facts: LinuxFacts,
  distribution: LinuxDistribution,
  user: string
): LinuxBlocker {
  switch (gate) {
    case 'immutable':
      return immutableOsBlocker(facts)
    case 'pacman': {
      // An account already in the group (or root) gets no usermod and no "new membership" note.
      const groupNeeded = user !== 'root' && facts.docker_group.configured !== true
      return blocker(
        'arch-manual-install',
        "Arch and its derivatives don't support a partial package install: adding just these two " +
          'packages without a full system sync can leave the system inconsistent, so the commands ' +
          'below run a full `pacman -Syu` instead — which may itself update your kernel and NVIDIA ' +
          'driver. Reboot afterward if it does' +
          (groupNeeded
            ? ', then log out and back in so the new docker group membership takes effect.'
            : '.') +
          ' Automatic install is not offered here.',
        { family: 'pacman' },
        archCommands(user, groupNeeded)
      )
    }
    case 'unrecognised':
      // Never lay docker-ce over an unknown quantity (round 1, item 15).
      return blocker(
        'docker-unrecognised',
        "This machine's docker command does not match any Docker install this integration " +
          'recognises (not docker-ce, docker.io, moby-engine, snap, rootless, Docker Desktop, or the ' +
          'podman-docker shim). Nothing will be installed over it automatically.'
      )
    case 'manifest-unavailable':
      return environmentManifestUnavailableBlocker()
    case 'unqualified':
      return blocker(
        'distribution-not-in-recipe',
        'Setting the runtime up automatically is only qualified on some distributions so far.',
        { id: distribution.id, version_id: distribution.version_id, arch: facts.architecture ?? 'unknown' }
      )
  }
}

/**
 * No environment manifest: which distributions the install recipe is qualified for is unknown, so no
 * automatic setup is offered — not because this distribution is unsupported, but because the list
 * could not be had (no network and nothing cached, or none this core accepts). Retrying with a
 * network is the fix; a ready host never sees this (it is adopted before any gate).
 */
export function environmentManifestUnavailableBlocker(): LinuxBlocker {
  return blocker(
    'environment-manifest-unavailable',
    'The list of systems where setup can install Docker and the NVIDIA Container Toolkit could not be ' +
      'loaded, and none was saved before. Check the internet connection and try again.'
  )
}

/** Refuses to write next to a daemon.json this probe could not read or parse (round 2, item 6). */
/**
 * The recipe installs and starts Docker through systemd (`systemctl enable --now docker`, a restart
 * after `nvidia-ctk runtime configure`), so on a host that does not run it — a container whose PID 1
 * is a shell, as the vast.ai GB10 instance was — every such plan would fail only at the privileged
 * step, after the user consented. Whether systemd runs could not be read is the unread fact
 * `init-system` instead (`unknown-fact`), never this.
 */
export function initNotSystemdBlocker(): LinuxBlocker {
  return blocker('init-not-systemd', 'This system does not run systemd, which the Docker install needs.')
}

export function daemonJsonUnreadableBlocker(): LinuxBlocker {
  return blocker(
    'daemon-json-unreadable',
    '/etc/docker/daemon.json exists but could not be read or parsed, so this integration cannot tell ' +
      "whether the NVIDIA runtime is already configured there. Fix the file's permissions or contents " +
      'by hand, then try again — nothing here will overwrite a file it cannot read back.'
  )
}

const CONFIGURE_RUNTIME_COMMANDS = [
  'sudo nvidia-ctk runtime configure --runtime=docker',
  GENERATE_CDI_COMMAND,
  'sudo systemctl restart docker',
]
const ENABLE_SERVICE_COMMANDS = ['sudo systemctl enable --now docker']

/**
 * One blocker per component offline evidence shows missing, for a host that also has to relogin
 * (round 4, item 1 — the refined ruling 4): the Docker CLI, the NVIDIA Container Toolkit, the GPU
 * runtime in Docker (or `daemon-json-unreadable` when that cannot be told), and `docker.service`
 * when `systemctl` says it is not active. An `'unknown'` service state is not evidence of anything and
 * is not reported. Empty when the relogin alone is the fix.
 *
 * What each one tells the person depends on the gate: on a recipe distribution setup will do it after
 * the relogin, so there is nothing to run by hand; on Arch each carries its exact commands (a full
 * `pacman -Syu` for packages, design D2); anywhere else the package steps have no command this
 * integration can vouch for (the caller adds the gate's own blocker), while the runtime and service
 * steps are the same `nvidia-ctk`/`systemctl` commands on every distribution.
 */
export function missingComponentBlockers(facts: LinuxFacts, gate: InstallGate): LinuxBlocker[] {
  const recipe = gate === 'recipe'
  const later = (what: string): string => ` After you log back in, setup will offer to ${what}.`
  const packageStep = (reason: LinuxBlockerReason, subject: string, pacmanPackage: string): LinuxBlocker =>
    blocker(
      reason,
      `${subject} is not installed.` +
        (recipe
          ? later('install it')
          : gate === 'pacman'
            ? ' Install it with a full system sync (Arch does not support partial upgrades); reboot ' +
              'afterward if the kernel or NVIDIA driver was updated.'
            : gate === 'manifest-unavailable'
              ? ' Whether setup can install it for you is not known until the list of supported ' +
                'systems loads; try again with a working internet connection.'
              : ' Automatic install is not offered on this system; install it yourself.'),
      undefined,
      gate === 'pacman' ? [`sudo pacman -Syu --needed ${pacmanPackage}`] : []
    )

  const blockers: LinuxBlocker[] = []
  if (!facts.docker.cli) blockers.push(packageStep('docker-cli-missing', 'Docker Engine', 'docker'))
  if (!facts.toolkit_installed) {
    blockers.push(packageStep('toolkit-missing', 'The NVIDIA Container Toolkit', 'nvidia-container-toolkit'))
  }
  if (!effectiveGpuRuntime(facts)) {
    // A registered `nvidia` runtime without a CDI spec needs only the spec, and no restart (F-5).
    const specOnly = facts.docker.nvidia_runtime
    blockers.push(
      facts.docker.daemon_json_unreadable && !specOnly
        ? daemonJsonUnreadableBlocker()
        : blocker(
            'gpu-runtime-not-configured',
            (specOnly
              ? 'Docker has no NVIDIA CDI specification, so it cannot pass the GPU into a container.'
              : 'Docker is not configured with the NVIDIA runtime and has no NVIDIA CDI specification. ' +
                'Configuring it restarts Docker, which stops any running containers.') +
              (recipe ? later('configure it') : ' Configure it yourself with the commands below.'),
            undefined,
            recipe ? [] : specOnly ? [GENERATE_CDI_COMMAND] : CONFIGURE_RUNTIME_COMMANDS
          )
    )
  }
  if (facts.docker.service_active === false) {
    blockers.push(
      blocker(
        'docker-service-inactive',
        'docker.service is not running.' +
          (recipe ? later('enable and start it') : ' Enable and start it with the command below.'),
        undefined,
        recipe ? [] : ENABLE_SERVICE_COMMANDS
      )
    )
  }
  return blockers
}
