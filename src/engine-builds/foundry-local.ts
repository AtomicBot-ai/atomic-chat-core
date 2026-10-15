/**
 * What is particular to Foundry Local builds (openspec change `add-foundry-local`, design D2): the
 * tree a release archive unpacks to is made runnable before the probe — Microsoft's debug symbols
 * go (`*.pdb` 129 MB, `*.so.dbg` 165 MB, `*.dSYM` 52 MB; integrity was already checked on the
 * archive's sha256) and on Linux the ONNX Runtime soname the library asks for is added — and each
 * build records the C API version it was published with, which decides whether this core can run it.
 */

import { lstat, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { INSTALL_RECORD, OWNER_MARKER } from '../diffusion/install.js'
import { isDateTime } from './manifest.js'

/** Names that are debug symbols only, on any of the three systems. */
const DEBUG_SYMBOLS_RE = /\.(pdb|so\.dbg|dSYM)$/
/** `libfoundry_local.so` needs this name; the archive ships `libonnxruntime.so` alone (spike, ruling S1). */
const ORT_SONAME = 'libonnxruntime.so.1'
const ORT_LIBRARY = 'libonnxruntime.so'

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )
/** The name itself, a dangling symlink included. */
const named = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false
  )

/** Delete debug symbols anywhere under `dir`; a `.dSYM` bundle is a directory. */
async function removeDebugSymbols(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (DEBUG_SYMBOLS_RE.test(entry.name)) await rm(path, { recursive: true, force: true })
    else if (entry.isDirectory()) await removeDebugSymbols(path)
  }
}

/** Debug symbols out; on Linux, `lib/libonnxruntime.so.1` → `libonnxruntime.so` unless it is there. */
export async function prepareFoundryLocalTree(staging: string, platform: NodeJS.Platform): Promise<void> {
  await removeDebugSymbols(staging)
  if (platform !== 'linux') return
  const lib = join(staging, 'lib')
  if ((await exists(join(lib, ORT_LIBRARY))) && !(await named(join(lib, ORT_SONAME))))
    await symlink(ORT_LIBRARY, join(lib, ORT_SONAME))
}

export interface FoundryLocalInstallRecord {
  tag: string
  backendId: string
  sha256: string | null
  installedAtMs: number
  publishedAt: string | null
  cApiVersion: number | null
  dir: string
}

/** The marker, then `install.json` without `dir`. */
export async function writeFoundryLocalInstallRecord(
  dir: string,
  record: Omit<FoundryLocalInstallRecord, 'dir'>
): Promise<void> {
  await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n')
  const file = {
    tag: record.tag,
    backendId: record.backendId,
    sha256: record.sha256,
    installedAtMs: record.installedAtMs,
    publishedAt: record.publishedAt,
    cApiVersion: record.cApiVersion,
  }
  await writeFile(join(dir, INSTALL_RECORD), JSON.stringify(file, null, 2))
}

async function readFoundryLocalInstallRecord(dir: string): Promise<FoundryLocalInstallRecord | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8'))
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { tag, backendId, sha256, installedAtMs, publishedAt, cApiVersion } = raw as Record<string, unknown>
  if (
    typeof tag !== 'string' ||
    typeof backendId !== 'string' ||
    typeof installedAtMs !== 'number' ||
    !Number.isSafeInteger(installedAtMs)
  )
    return undefined
  return {
    tag,
    backendId,
    sha256: typeof sha256 === 'string' ? sha256 : null,
    installedAtMs,
    publishedAt: isDateTime(publishedAt) ? publishedAt : null,
    cApiVersion: typeof cApiVersion === 'number' && Number.isSafeInteger(cApiVersion) ? cApiVersion : null,
    dir,
  }
}

/** The Foundry Local library under `lib/`, by each system's name for it. */
const LIBRARY_NAMES = ['libfoundry_local.dylib', 'libfoundry_local.so', 'foundry_local.dll']

async function hasLibrary(dir: string): Promise<boolean> {
  for (const name of LIBRARY_NAMES) if (await exists(join(dir, 'lib', name))) return true
  return false
}

/** Every marked `<root>/<tag>/<platform>/` with a record and its library, newest install first. */
export async function listFoundryLocalBuilds(root: string): Promise<FoundryLocalInstallRecord[]> {
  const out: FoundryLocalInstallRecord[] = []
  for (const tag of await readdir(root).catch(() => [] as string[]))
    for (const backend of await readdir(join(root, tag)).catch(() => [] as string[])) {
      const dir = join(root, tag, backend)
      if (!(await exists(join(dir, OWNER_MARKER)))) continue
      const record = await readFoundryLocalInstallRecord(dir)
      if (record && (await hasLibrary(dir))) out.push(record)
    }
  return out.sort((a, b) => b.installedAtMs - a.installedAtMs)
}
