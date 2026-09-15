/**
 * The filesystem half of `backend/`: what is actually installed under
 * `<data>/<provider>/backends/<version>/<backend>/`.
 *
 * `discoverBackendBinary` reproduces `discover_llamacpp_binary_in` (cli/mod.rs:198) exactly, because
 * `serve` without `--bin` must pick the same executable the Rust CLI picks: version directories are
 * ordered by parsed build number (so `b10018-1.3.0` outranks `b9000`, which plain string sort gets
 * wrong), ties broken by name descending, backends inside a version by name ascending, and each pack
 * is probed at `build/bin/<exe>` before the flat `<exe>`.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { LocalProviderId } from '../contracts/index.js'
import { backendExeCandidates, llamaServerExeName } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import { installedBackendsFromEntries } from './installed.js'
import type { InstalledBackendEntry } from './installed.js'
import type { BackendVersion } from './types.js'
// Two build-number parsers exist on purpose: `version.ts` has the app's strict `^b(\d+)$` one, and
// this is the Rust `ArgumentBuilder::parse_build_number`, which also reads the unified fork tag
// `b10018-1.3.0`. Discovery must use the lenient one, or the fork's builds sort last.
import { parseBuildNumber as parseLenientBuildNumber } from '../runtime/llamacpp/args.js'
import { stripBom } from './version.js'

export interface DiscoveredBackendBinary {
  path: string
  /** `<version>/<backend>`, the form the argument builder parses for feature gates. */
  version_backend: string
  version: string
  backend: string
}

const dirNames = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

const exists = (path: string): Promise<boolean> =>
  stat(path)
    .then(() => true)
    .catch(() => false)

/** Version directories newest first: build number descending, then raw name descending. */
export function orderVersionDirs(names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const ba = parseLenientBuildNumber(a)
    const bb = parseLenientBuildNumber(b)
    if (ba !== bb) return (bb ?? -1) - (ba ?? -1)
    return a < b ? 1 : a > b ? -1 : 0
  })
}

/**
 * Every installed pack, in directory order with `order` = install mtime, exactly as Rust
 * `get_local_installed_backends` reports it. Callers that need a ranking sort it themselves.
 */
export async function scanInstalledBackends(
  layout: DataLayout,
  provider: LocalProviderId,
  platform: NodeJS.Platform = process.platform
): Promise<BackendVersion[]> {
  const paths = layout.provider(provider)
  const exe = llamaServerExeName(platform)
  const entries: InstalledBackendEntry[] = []
  for (const version of await dirNames(paths.backendsDir)) {
    for (const backend of await dirNames(join(paths.backendsDir, version))) {
      const candidates = backendExeCandidates(paths, version, backend, exe)
      let hasExe = false
      let mtimeSeconds = 0
      for (const candidate of candidates) {
        const s = await stat(candidate).catch(() => undefined)
        if (s) {
          hasExe = true
          mtimeSeconds = Math.floor(s.mtimeMs / 1000)
          break
        }
      }
      entries.push({ version: stripBom(version), backend: stripBom(backend), hasExe, mtimeSeconds })
    }
  }
  return installedBackendsFromEntries(entries)
}

/** The newest usable `llama-server` in the data folder, or `undefined` when none is installed. */
export async function discoverBackendBinary(
  layout: DataLayout,
  provider: LocalProviderId = 'llamacpp-upstream',
  platform: NodeJS.Platform = process.platform
): Promise<DiscoveredBackendBinary | undefined> {
  const paths = layout.provider(provider)
  const exe = llamaServerExeName(platform)
  for (const version of orderVersionDirs(await dirNames(paths.backendsDir))) {
    for (const backend of (await dirNames(join(paths.backendsDir, version))).sort()) {
      for (const candidate of backendExeCandidates(paths, version, backend, exe)) {
        if (await exists(candidate))
          return { path: candidate, version_backend: `${version}/${backend}`, version, backend }
      }
    }
  }
  return undefined
}

/**
 * Recover `<version>/<backend>` from a hand-supplied `--bin` path that still sits in the standard
 * layout (`version_backend_from_bin_path`, cli/mod.rs). A binary from anywhere else has no tag, and
 * the caller must fall back to a neutral placeholder rather than guess a feature set.
 */
export function versionBackendFromBinPath(binPath: string): string | undefined {
  const parts = binPath.split(/[\\/]/).filter(Boolean)
  const backendsAt = parts.lastIndexOf('backends')
  if (backendsAt < 0 || parts.length < backendsAt + 3) return undefined
  const version = parts[backendsAt + 1]
  const backend = parts[backendsAt + 2]
  if (!version || !backend) return undefined
  return `${version}/${backend}`
}

/** Path of a specific pack's executable, or `undefined` when that pack is not installed. */
export async function resolveBackendExe(
  layout: DataLayout,
  provider: LocalProviderId,
  version: string,
  backend: string,
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
  const candidates = backendExeCandidates(
    layout.provider(provider),
    stripBom(version),
    stripBom(backend),
    llamaServerExeName(platform)
  )
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  return undefined
}

/** Directory a pack lives in, for deletion and disk accounting. */
export function backendPackDir(
  layout: DataLayout,
  provider: LocalProviderId,
  version: string,
  backend: string
): string {
  return [layout.provider(provider).backendsDir, stripBom(version), stripBom(backend)].join(sep)
}
