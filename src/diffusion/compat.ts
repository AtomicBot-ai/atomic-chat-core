/**
 * Which installed engine build may serve a model family. `check_engine_compatibility` and
 * `select_model_install` in `session.rs` of `tauri-plugin-atomic-diffusion` (app commit
 * `ec1fd3ea7`); messages verbatim.
 */

import type { DiffusionBackendInstallRecord, DiffusionEngineId } from '../contracts/index.js'
import { diffusionError } from './errors.js'

/** The first upstream build that runs Qwen Image 2.1 and Krea 2 Turbo. */
export const MIN_MODERN_FAMILY_BUILD = 883
const MODERN_FAMILIES: ReadonlySet<string> = new Set(['qwen-image-2.1', 'krea-2-turbo'])

/** `master-<build>-<hash>` → the build number; anything else → undefined. */
function buildOf(tag: string): number | undefined {
  if (!tag.startsWith('master-')) return undefined
  const rest = tag.slice('master-'.length)
  const dash = rest.indexOf('-')
  if (dash < 0 || dash === rest.length - 1) return undefined
  const build = rest.slice(0, dash)
  return /^\d+$/.test(build) ? Number(build) : undefined
}

/**
 * Qwen Image 2.1 and Krea 2 Turbo need build 883 or newer; a tag that does not parse fails closed.
 * Every other family keeps whatever engine it has.
 */
export function checkEngineCompatibility(family: string, tag: string): void {
  if (!MODERN_FAMILIES.has(family)) return
  const build = buildOf(tag)
  if (build !== undefined && build >= MIN_MODERN_FAMILY_BUILD) return
  throw diffusionError(
    'ENGINE_UPDATE_REQUIRED',
    `${family} requires an image engine update. Update the engine, then retry loading the model.`,
    `installed=${tag}; required=master-883-137f740 or newer`
  )
}

/**
 * The install a load uses. The newest install of `engine` picks the backend; among that backend's
 * installs (newest first, as `listInstalledBackends` returns them) the first one compatible with
 * `family` wins, so an older compatible tree is used rather than the newest incompatible one. The
 * backend is never switched to find a compatible build.
 */
export function selectModelInstall(
  installed: readonly DiffusionBackendInstallRecord[],
  engine: DiffusionEngineId,
  family: string
): DiffusionBackendInstallRecord {
  const selected = installed.find((r) => r.engine === engine)
  if (!selected) throw diffusionError('ENGINE_MISSING', 'Install the image engine first.')
  const record =
    installed.find(
      (candidate) =>
        candidate.engine === engine &&
        candidate.backendId === selected.backendId &&
        isCompatible(family, candidate.tag)
    ) ?? selected
  checkEngineCompatibility(family, record.tag)
  return record
}

function isCompatible(family: string, tag: string): boolean {
  try {
    checkEngineCompatibility(family, tag)
    return true
  } catch {
    return false
  }
}
