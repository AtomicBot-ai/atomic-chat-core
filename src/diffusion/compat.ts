/**
 * Which installed engine build may serve a model family. `check_engine_compatibility` and
 * `select_model_install` in `session.rs` of `tauri-plugin-atomic-diffusion` (app commit
 * `ec1fd3ea7`); messages verbatim. FLUX.3 Klein's floor came after the plugin.
 */

import type { DiffusionBackendInstallRecord, DiffusionEngineId } from '../contracts/index.js'
import { diffusionError } from './errors.js'

/** The first upstream build that runs Qwen Image 2.1 (and its Turbo) and Krea 2 Turbo. */
export const MIN_MODERN_FAMILY_BUILD = 883

type EngineFloor = { build: number; tag: string }
const MODERN: EngineFloor = { build: MIN_MODERN_FAMILY_BUILD, tag: 'master-883-137f740' }
/** The first upstream build that runs FLUX.3 Image Klein (leejet/stable-diffusion.cpp#2143). */
const FLUX3: EngineFloor = { build: 968, tag: 'master-968-8cd731e' }
const ENGINE_FLOORS: ReadonlyMap<string, EngineFloor> = new Map([
  ['qwen-image-2.1', MODERN],
  ['qwen-image-2.1-turbo', MODERN],
  ['krea-2-turbo', MODERN],
  ['flux.3-klein', FLUX3],
])

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
 * Qwen Image 2.1 and Krea 2 Turbo need build 883 or newer, FLUX.3 Klein 968; a tag that does not
 * parse fails closed. Every other family keeps whatever engine it has.
 */
export function checkEngineCompatibility(family: string, tag: string): void {
  const floor = ENGINE_FLOORS.get(family)
  if (!floor) return
  const build = buildOf(tag)
  if (build !== undefined && build >= floor.build) return
  throw diffusionError(
    'ENGINE_UPDATE_REQUIRED',
    `${family} requires an image engine update. Update the engine, then retry loading the model.`,
    `installed=${tag}; required=${floor.tag} or newer`
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
