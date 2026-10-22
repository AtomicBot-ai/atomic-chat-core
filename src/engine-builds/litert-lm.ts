/**
 * What is particular to LiteRT-LM builds (openspec change `add-litert-lm-runtime`, design D2): a build
 * is a `litert-lm-api` wheel from PyPI, which is a zip. Only the native part of its `litert_lm/`
 * package is kept, under `lib/` — the library, on Windows its DirectX companions and the Intel NPU
 * dispatch library under `vendors/` — without the Python bindings and `*.dist-info` (task 4.2). Each
 * build records the `abi` it was published with, which decides whether this core's host binds it.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import { INSTALL_RECORD, OWNER_MARKER } from '../diffusion/install.js'
import { isDateTime } from './manifest.js'

/** The wheel's package; everything else in it is Python metadata. */
const PACKAGE_DIR = 'litert_lm'
/** Native files of the package: libraries anywhere, and every file under `vendors/`. */
const NATIVE_RE = /\.(dylib|so|dll)$/

const LIBRARY_FILE: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'liblitert-lm.dylib',
  linux: 'liblitert-lm.so',
  win32: 'litert-lm.dll',
}

/** The library's file name on `platform`; `null` where LiteRT-LM has none. */
export function liteRtLmLibraryFile(platform: NodeJS.Platform): string | null {
  return LIBRARY_FILE[platform] ?? null
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

async function nativeFiles(dir: string, at = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name)
    const rel = relative(dir, path).split('\\').join('/')
    if (entry.isDirectory()) out.push(...(await nativeFiles(dir, path)))
    else if (rel.startsWith('vendors/') || NATIVE_RE.test(entry.name)) out.push(rel)
  }
  return out
}

/**
 * Turn an unpacked wheel into a build: the native files of `litert_lm/` move to `lib/` with their
 * relative paths, everything else goes. Wheels carry `0777`; libraries become `0755`. Throws
 * `ENGINE_INSTALL_FAILED` when the wheel holds no LiteRT-LM library at all.
 */
export async function prepareLiteRtLmTree(staging: string): Promise<void> {
  const pkg = join(staging, PACKAGE_DIR)
  const keep = (await exists(pkg)) ? await nativeFiles(pkg) : []
  if (!keep.some((rel) => Object.values(LIBRARY_FILE).includes(rel)))
    throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'The LiteRT-LM wheel holds no LiteRT-LM library.')
  const lib = join(staging, 'lib')
  for (const rel of keep) {
    const to = join(lib, rel)
    await mkdir(dirname(to), { recursive: true })
    await rename(join(pkg, rel), to)
    await chmod(to, 0o755).catch(() => {})
  }
  for (const name of await readdir(staging))
    if (name !== 'lib') await rm(join(staging, name), { recursive: true, force: true })
}

export interface LiteRtLmInstallRecord {
  /** The LiteRT-LM version, `X.Y.Z`. */
  tag: string
  backendId: string
  sha256: string | null
  installedAtMs: number
  publishedAt: string | null
  abi: number | null
  dir: string
}

/** The marker, then `install.json` without `dir`. */
export async function writeLiteRtLmInstallRecord(
  dir: string,
  record: Omit<LiteRtLmInstallRecord, 'dir'>
): Promise<void> {
  await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n')
  const file = {
    tag: record.tag,
    backendId: record.backendId,
    sha256: record.sha256,
    installedAtMs: record.installedAtMs,
    publishedAt: record.publishedAt,
    abi: record.abi,
  }
  await writeFile(join(dir, INSTALL_RECORD), JSON.stringify(file, null, 2))
}

async function readLiteRtLmInstallRecord(dir: string): Promise<LiteRtLmInstallRecord | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8'))
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { tag, backendId, sha256, installedAtMs, publishedAt, abi } = raw as Record<string, unknown>
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
    abi: typeof abi === 'number' && Number.isSafeInteger(abi) ? abi : null,
    dir,
  }
}

async function hasLibrary(dir: string): Promise<boolean> {
  for (const name of Object.values(LIBRARY_FILE)) if (await exists(join(dir, 'lib', name))) return true
  return false
}

/** Every marked `<root>/<version>/<platform>/` with a record and its library, newest install first. */
export async function listLiteRtLmBuilds(root: string): Promise<LiteRtLmInstallRecord[]> {
  const out: LiteRtLmInstallRecord[] = []
  for (const tag of await readdir(root).catch(() => [] as string[]))
    for (const backend of await readdir(join(root, tag)).catch(() => [] as string[])) {
      const dir = join(root, tag, backend)
      if (!(await exists(join(dir, OWNER_MARKER)))) continue
      const record = await readLiteRtLmInstallRecord(dir)
      if (record && (await hasLibrary(dir))) out.push(record)
    }
  return out.sort((a, b) => b.installedAtMs - a.installedAtMs)
}
