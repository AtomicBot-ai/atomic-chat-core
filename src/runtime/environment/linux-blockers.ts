/**
 * The structured reasons `assessLinux` (`linux-plan.ts`) refuses a host — split out of that file
 * once it grew past the ~500-line guidance for this module (task 2.4 fix round 2). Everything here
 * is pure: a reason code, the message a person reads, and the machine-checkable specifics.
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
