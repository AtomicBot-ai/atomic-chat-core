/**
 * The structured reasons `assessLinux` (`linux-plan.ts`) refuses a host — split out of that file
 * once it grew past the ~500-line guidance for this module (task 2.4 fix round 2). Everything here
 * is pure: a reason code, the message a person reads, and the machine-checkable specifics. A few
 * small, self-contained decision helpers moved in alongside them in round 3, for the same reason
 * (`linux-plan.ts` growing past the guidance again): `effectiveGpuRuntime` and the two exact-command
 * builders (`archCommands`, `groupOnlyCommands`) that blockers built here actually use.
 */

import type { LinuxFacts } from './linux-probe.js'

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
  | 'daemon-json-unreadable'
  /** Group membership confirmed and effective, service active, daemon still unreachable (round 2, item 2). */
  | 'docker-access-unexplained'
  /** Everything but group membership is ready, and automatic elevation is not offered here (round 2, item 5). */
  | 'docker-group-manual'
  /** Group membership confirmed but this session predates it — a relogin, never an install plan, on any distro (round 3, ruling 4). */
  | 'relogin-required'

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

/** `docker info` when reachable, the read-only daemon.json/CDI evidence when it is not (item 3). */
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
  return [`grep -E '^docker:' /usr/lib/group | sudo tee -a /etc/group`, usermod]
}

/**
 * Arch never supports a partial `pacman -S` of just these two packages (design D2): installing a
 * package without syncing the whole system can leave it inconsistent, so the commands run a full
 * `-Syu` instead — which may itself bring in a newer kernel and NVIDIA driver, hence the reboot
 * note. `nvidia-ctk runtime configure` changes `/etc/docker/daemon.json`, so Docker is explicitly
 * restarted afterward rather than relying on `enable --now` to notice the new config on its own
 * (item 12). The `usermod` line uses the actual probed account, never the literal `$USER`, and is
 * omitted entirely for root, which needs no group membership at all (round 3, ruling 8).
 */
export function archCommands(user: string): string[] {
  const commands = [
    'sudo pacman -Syu --needed docker nvidia-container-toolkit',
    'sudo nvidia-ctk runtime configure --runtime=docker',
    'sudo systemctl restart docker',
    'sudo systemctl enable --now docker',
  ]
  if (user !== 'root') commands.push(`sudo usermod -aG docker ${user}`)
  return commands
}
