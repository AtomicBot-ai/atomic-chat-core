/**
 * The llama.cpp build the desktop installer brings (change `unify-engine-lifecycle`, design D4, spec
 * `engine-lifecycle`, "Сборка llama.cpp из установщика"). `--resources-dir` is `<resources>/bin`;
 * the installer's packs sit beside it in `<resources>/llamacpp-backend-upstream` (upstream) and
 * `<resources>/llamacpp-backend` (TurboQuant), each with `version.txt` and `backend.txt`. The app's
 * extensions copy that pack into `<data>/<provider>/backends/<version>/<backend>` at every start,
 * so the copy is `bundled`: deleting it is undone at the next launch, and the core never deletes it.
 *
 * Read-only; the files are read the way the app's `install_bundled_backend` reads them (BOM
 * stripped, trimmed, empty means none). `atc` passes no `--resources-dir`, so it has none.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LocalProviderId } from '../../contracts/index.js'
import { stripBom } from '../version.js'

const BUNDLED_FOLDER: Partial<Record<LocalProviderId, string>> = {
  'llamacpp-upstream': 'llamacpp-backend-upstream',
  'llamacpp': 'llamacpp-backend',
}

/** `<resources>/llamacpp-backend[-upstream]`, or `null` for a provider the installer brings nothing for. */
export function bundledLlamacppDir(resourcesDir: string, provider: LocalProviderId): string | null {
  const folder = BUNDLED_FOLDER[provider]
  return folder === undefined ? null : join(dirname(resourcesDir), folder)
}

async function readLine(path: string): Promise<string> {
  try {
    return stripBom(await readFile(path, 'utf8')).trim()
  } catch {
    return ''
  }
}

/** The installer's `<version>/<backend>` of this provider, or `null`. */
export async function readBundledLlamacppPack(
  resourcesDir: string | undefined,
  provider: LocalProviderId
): Promise<{ version: string; backend: string } | null> {
  if (!resourcesDir) return null
  const dir = bundledLlamacppDir(resourcesDir, provider)
  if (dir === null) return null
  const [version, backend] = await Promise.all([
    readLine(join(dir, 'version.txt')),
    readLine(join(dir, 'backend.txt')),
  ])
  return version && backend ? { version, backend } : null
}
