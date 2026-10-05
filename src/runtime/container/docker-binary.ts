/**
 * Where the `docker` CLI lives, resolved once at core startup (task 2.12; task 2.8 review carry-
 * forward). Every model-container command runs this absolute path rather than `docker` looked up on
 * `PATH`: core's `PATH` is whatever the app or shell that started it had, and a directory earlier on
 * it (a user's `~/bin`, a project's `node_modules/.bin`) could put a different program under that
 * name, and core would hand it the model container's whole configuration. The distributions the
 * install recipe supports all ship the CLI in one of the fixed system directories below.
 */
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'

/** System locations of the docker CLI, in the order they are tried. Never a relative path. */
export const DOCKER_BINARY_CANDIDATES: readonly string[] = [
  '/usr/bin/docker',
  '/usr/local/bin/docker',
  '/bin/docker',
]

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** The first candidate that is an executable file, or null when this host has none of them. */
export async function resolveDockerBinary(
  candidates: readonly string[] = DOCKER_BINARY_CANDIDATES
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}
