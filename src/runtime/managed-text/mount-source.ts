/**
 * The default `MountSourceResolver` (see `types.ts`): identity. Correct when the core process and
 * the Docker daemon it talks to share one filesystem — a native Linux host or a core running
 * directly on Windows against Docker Desktop. WSL's guest-path resolver, where a core-visible
 * Windows path and the daemon's Linux mount source name different filesystems, is a distinct
 * implementation task 2.8 adds; copying one path into the other there would not be a mapping.
 */

/** Satisfies `MountSourceResolver`: same `(corePath: string) => string` signature. */
export function identityMountSourceResolver(corePath: string): string {
  return corePath
}
