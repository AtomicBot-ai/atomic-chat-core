/**
 * Where a Windows scope's managed files live, and how each side names them (change
 * `add-tensorrt-llm-windows`, task 2.6, design D5). Everything a model container sees — the model,
 * its engine cache, the heartbeat, the watchdog script — is in the guest's ext4, under one root per
 * scope: `/var/lib/atomic-chat/scopes/<scope_key>/`. Loading weights over the VM boundary (9p) is
 * several times slower, so nothing the engine reads is left on NTFS.
 *
 * Core (on Windows) reaches the same files as `\\wsl.localhost\<distro>\var\lib\atomic-chat\…`;
 * Docker (in the guest) mounts them as `/var/lib/atomic-chat/…`. `uncPathFor` and `guestPathFor` are
 * the one translation between the two, and `guestPathFor` refuses anything that is not inside the
 * named distribution — a Windows path, another distribution, a `..` climbing out — so a guest mount can
 * never be pointed at the Windows disk or at someone else's files. The execution journal and the
 * docker config stay on Windows: they are core's own state, not the container's.
 */
import { win32 } from 'node:path'
import type { ManagedScopePaths } from '../../config/index.js'
import { AtomicCoreError } from '../../contracts/index.js'

/** Every scope's guest root lives under this. */
export const GUEST_SCOPES_ROOT = '/var/lib/atomic-chat/scopes'

const SCOPE_KEY = /^[A-Za-z0-9-]{1,64}$/
const UNC_PREFIX = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i

const outside = (path: string): AtomicCoreError =>
  new AtomicCoreError('INVALID_ARGUMENT', 'The path is not inside the Atomic Chat distribution.', path)

/** `/var/lib/atomic-chat/scopes/<key>`; the key is core's own random id, never a path segment it was given. */
export function guestScopeRoot(scopeKey: string): string {
  if (!SCOPE_KEY.test(scopeKey)) throw new AtomicCoreError('INVALID_ARGUMENT', 'Not a scope key.', scopeKey)
  return `${GUEST_SCOPES_ROOT}/${scopeKey}`
}

/** A guest path as Windows opens it: `\\wsl.localhost\<distro>\…`. */
export function uncPathFor(distribution: string, guestPath: string): string {
  const relative = guestPath.replace(/^\/+/, '').split('/').filter(Boolean).join('\\')
  return `\\\\wsl.localhost\\${distribution}${relative === '' ? '' : `\\${relative}`}`
}

/**
 * The guest path behind a `\\wsl.localhost\<distro>\…` (or `\\wsl$\…`) path of this distribution.
 * Throws `INVALID_ARGUMENT` for anything else, a `..` segment included.
 */
export function guestPathFor(distribution: string, uncPath: string): string {
  const match = UNC_PREFIX.exec(uncPath)
  if (match === null || (match[2] as string).toLowerCase() !== distribution.toLowerCase())
    throw outside(uncPath)
  const segments = (match[3] ?? '').split(/[\\/]+/).filter(Boolean)
  if (segments.some((segment) => segment === '..' || segment === '.')) throw outside(uncPath)
  return `/${segments.join('/')}`
}

/**
 * This scope's managed paths on Windows: heartbeats, engine caches and the watchdog script in the
 * guest (as core reaches them, through `\\wsl.localhost`), the journal and docker config where they
 * were. Same layout below the root as Linux's (`config/paths.ts`), so nothing above it changes.
 */
export function guestScopePaths(
  windows: ManagedScopePaths,
  distribution: string,
  scopeKey: string
): ManagedScopePaths {
  const root = uncPathFor(distribution, guestScopeRoot(scopeKey))
  const relativeTo = (path: string): string => win32.relative(windows.root, path)
  const inGuest = (path: string): string => win32.join(root, relativeTo(path))
  return {
    ...windows,
    root,
    heartbeatsDir: inGuest(windows.heartbeatsDir),
    heartbeatDir: (generation) => inGuest(windows.heartbeatDir(generation)),
    cachesDir: inGuest(windows.cachesDir),
    descriptorCachesDir: (descriptorId) => inGuest(windows.descriptorCachesDir(descriptorId)),
    engineCacheDir: (descriptorId, modelId) => inGuest(windows.engineCacheDir(descriptorId, modelId)),
    watchdogScript: inGuest(windows.watchdogScript),
  }
}
