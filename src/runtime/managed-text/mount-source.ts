/**
 * The two `MountSourceResolver`s (see `types.ts`). Identity, the default: correct when the core process
 * and the Docker daemon it talks to share one filesystem — a native Linux host. And WSL's (change
 * `add-tensorrt-llm-windows`, task 2.6): core on Windows sees a mount source as
 * `\\wsl.localhost\<distro>\var\lib\atomic-chat\…`, the daemon in that distribution mounts
 * `/var/lib/atomic-chat/…`; anything outside the distribution is refused, so a container is never given
 * a Windows path over 9p.
 */
import { WSL_LOCALHOST_MOUNT, type GuestMount } from '../wsl/index.js'
import type { MountSourceResolver } from './types.js'

/** Satisfies `MountSourceResolver`: same `(corePath: string) => string` signature. */
export function identityMountSourceResolver(corePath: string): string {
  return corePath
}

/** WSL's resolver: the guest path behind a `\\wsl.localhost\<distribution>\…` path, and nothing else. */
export function wslMountSourceResolver(
  distribution: string,
  mount: GuestMount = WSL_LOCALHOST_MOUNT
): MountSourceResolver {
  return (corePath) => mount.guestPath(distribution, corePath)
}
