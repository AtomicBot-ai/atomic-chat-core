/**
 * Types for the deployment seam preserved by ADR `docs/decisions/2026-09-23-preserve-deployment-
 * seams.md` (task T01e, openspec change `add-tensorrt-llm-linux`): what a containerized text
 * engine needs to run, and how a deployment turns that into a published, reachable target.
 *
 * Keeping these separate from the desktop `LaunchSpec`/`AdapterContext` that task 2.8 builds on
 * means a desktop-only choice — binding loopback, picking a random host port, bind-mounting a
 * heartbeat file — never becomes an engine requirement a future non-desktop deployment would have
 * to fake just to satisfy this module's shape.
 */

/**
 * What a containerized engine needs to run, in engine terms only. No host publication and no
 * heartbeat: those are desktop choices a `ManagedDeployment` adds on top, not something the engine
 * or its adapter decides. Task 2.8 gives adapters the rest of the Docker argv this eventually feeds
 * (image, mounts, entrypoint); this task only fixes the boundary that return type lives inside.
 */
export interface EngineLaunchSpec {
  /** The engine's own listening port inside its container's network namespace. */
  container_port: number
}

/**
 * Where a started engine is actually reachable, for one recorded execution. An HTTP(S) server-root
 * URL: no credentials, query, fragment or `/v1` prefix. Internal only — never handed to a browser,
 * and never accepted verbatim from a descriptor, the UI or chat input.
 */
export interface BackendTarget {
  base_url: string
}

/**
 * Resolves a core-visible filesystem path (this process's own view) into what the Docker daemon
 * should mount as its source. Identity for a core running directly on the host; WSL's guest-path
 * resolver (task 2.8) is a distinct implementation, because a core-visible path and the daemon's
 * mount source can name different filesystems entirely.
 */
export type MountSourceResolver = (corePath: string) => string

/** A host path mounted into the container so the watchdog can read the engine's heartbeat file. */
export interface HeartbeatBind {
  /** Path as this core process sees it. */
  core_path: string
  /** What the `MountSourceResolver` said to bind that path as, in the Docker daemon's namespace. */
  mount_source: string
}

/** The desktop host-publication bindings a `ManagedDeployment` adds on top of an `EngineLaunchSpec`. */
export interface HostPublication {
  host: string
  host_port: number
  container_port: number
}

/** What `ManagedDeployment.prepareLaunch` returns: the publication, its reachable target, and the heartbeat bind. */
export interface PreparedLaunch {
  publication: HostPublication
  target: BackendTarget
  heartbeat: HeartbeatBind
}

/**
 * Turns engine requirements into a running, reachable deployment. The desktop implementation
 * (`createDesktopManagedDeployment`) publishes on loopback with a random host port; a future
 * non-desktop deployment could resolve a sibling container by private DNS instead — the shared
 * lifecycle never allocates ports, selects a socket/distro or branches on OS itself, it only calls
 * this seam.
 */
export interface ManagedDeployment {
  prepareLaunch(spec: EngineLaunchSpec, heartbeatCorePath: string): Promise<PreparedLaunch>
}
