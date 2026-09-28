/**
 * The desktop `ManagedDeployment` (`types.ts`): publishes an engine's `container_port` on loopback
 * with a random host port, and resolves the heartbeat file's mount source through the given
 * `MountSourceResolver` (identity by default; WSL's guest-path resolver replaces it, task 2.8,
 * without touching this shape). The shared lifecycle depends only on `ManagedDeployment` — it never
 * allocates a port, picks a socket/distro or branches on OS itself, per ADR T01e.
 */
import { randomFreePort } from '../shared/index.js'
import { identityMountSourceResolver } from './mount-source.js'
import type { EngineLaunchSpec, ManagedDeployment, MountSourceResolver, PreparedLaunch } from './types.js'

const DESKTOP_HOST = '127.0.0.1'

export interface DesktopManagedDeploymentDeps {
  /** Host ports already claimed by other sessions, so the new publication does not collide. */
  usedHostPorts?: () => Iterable<number>
  /** Injected for tests; the production default binds `randomFreePort` (`runtime/shared`) to loopback. */
  allocateHostPort?: (usedHostPorts: Iterable<number>) => Promise<number>
  mountSource?: MountSourceResolver
}

/**
 * Desktop bindings for a container started on this machine: loopback publication at a random free
 * host port, and an identity-mounted heartbeat path by default (a core running on the host and the
 * Docker daemon it talks to share one filesystem).
 */
export function createDesktopManagedDeployment(deps: DesktopManagedDeploymentDeps = {}): ManagedDeployment {
  const usedHostPorts = deps.usedHostPorts ?? ((): Iterable<number> => [])
  const allocateHostPort = deps.allocateHostPort ?? ((used: Iterable<number>) => randomFreePort(used))
  const mountSource = deps.mountSource ?? identityMountSourceResolver

  return {
    async prepareLaunch(spec: EngineLaunchSpec, heartbeatCorePath: string): Promise<PreparedLaunch> {
      const host_port = await allocateHostPort(usedHostPorts())
      return {
        publication: { host: DESKTOP_HOST, host_port, container_port: spec.container_port },
        target: { base_url: `http://${DESKTOP_HOST}:${host_port}` },
        heartbeat: { core_path: heartbeatCorePath, mount_source: mountSource(heartbeatCorePath) },
      }
    },
  }
}
