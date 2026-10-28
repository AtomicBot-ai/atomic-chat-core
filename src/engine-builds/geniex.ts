/**
 * What is particular to GenieX builds (openspec change `add-geniex-runtime`, design D2): a build is
 * Qualcomm's SDK zip (`geniex-sdk-windows-arm64-<tag>.zip`), of which only the library folder is kept
 * — `lib/geniex.dll`, the `llama_cpp` and `qairt` plugins, QAIRT and the Microsoft-signed HTP files —
 * without the zip's top folder (`sdk-windows-arm64/`), its `bin/` and `include/` (task 4.2). Each
 * build records the `abi` it was published with, which decides whether this core's host binds it, and
 * the devices `geniex-host probe` found when it was installed (task 4.4), which
 * `GET /runtimes/geniex/accelerators` answers from without starting a host again.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import { INSTALL_RECORD, OWNER_MARKER } from '../diffusion/install.js'
import { isDateTime } from './manifest.js'

/** The C API's library; the plugins load beside it. GenieX has no macOS or Linux x64 build. */
export const GENIEX_LIBRARY_FILE = 'geniex.dll'
const LIB_DIR = 'lib'

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )
const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false
  )

/**
 * Turn the unpacked zip into a build: `<top>/lib` (or `lib` already at the root) becomes `<staging>/lib`,
 * everything else goes. Throws `ENGINE_INSTALL_FAILED` when the zip holds no `lib/geniex.dll`.
 * Path traversal is refused earlier, by `extractArchive`.
 */
export async function prepareGeniexTree(staging: string): Promise<void> {
  const lib = join(staging, LIB_DIR)
  let found: string | undefined
  if (await exists(join(lib, GENIEX_LIBRARY_FILE))) found = lib
  else
    for (const name of await readdir(staging)) {
      const candidate = join(staging, name, LIB_DIR)
      if ((await isDirectory(join(staging, name))) && (await exists(join(candidate, GENIEX_LIBRARY_FILE)))) {
        found = candidate
        break
      }
    }
  if (!found)
    throw new AtomicCoreError(
      'ENGINE_INSTALL_FAILED',
      `The GenieX SDK zip holds no lib/${GENIEX_LIBRARY_FILE}.`
    )
  if (found !== lib) {
    const parked = join(staging, `.lib-${process.pid}`)
    await rename(found, parked)
    for (const name of await readdir(staging))
      if (name !== `.lib-${process.pid}`) await rm(join(staging, name), { recursive: true, force: true })
    await rename(parked, lib)
    return
  }
  for (const name of await readdir(staging))
    if (name !== LIB_DIR) await rm(join(staging, name), { recursive: true, force: true })
}

export interface GeniexInstallRecord {
  /** The GenieX version, `X.Y.Z`. */
  tag: string
  backendId: string
  sha256: string | null
  installedAtMs: number
  publishedAt: string | null
  abi: number | null
  /** `geniex_version()` as the probe read it; `null` where it could not. */
  libraryVersion: string | null
  /** The device ids `geniex_get_device_list` gave at the install's probe (`HTP0`, `GPUOpenCL`, `CPU`). */
  devices: string[]
  dir: string
}

/** The marker, then `install.json` without `dir`. */
export async function writeGeniexInstallRecord(
  dir: string,
  record: Omit<GeniexInstallRecord, 'dir'>
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n')
  const file = {
    tag: record.tag,
    backendId: record.backendId,
    sha256: record.sha256,
    installedAtMs: record.installedAtMs,
    publishedAt: record.publishedAt,
    abi: record.abi,
    libraryVersion: record.libraryVersion,
    devices: record.devices,
  }
  await writeFile(join(dir, INSTALL_RECORD), JSON.stringify(file, null, 2))
}

async function readGeniexInstallRecord(dir: string): Promise<GeniexInstallRecord | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8'))
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { tag, backendId, sha256, installedAtMs, publishedAt, abi, libraryVersion, devices } = raw as Record<
    string,
    unknown
  >
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
    libraryVersion: typeof libraryVersion === 'string' ? libraryVersion : null,
    devices: Array.isArray(devices) ? devices.filter((d): d is string => typeof d === 'string') : [],
    dir,
  }
}

/** Every marked `<root>/<version>/<platform>/` with a record and its library, newest install first. */
export async function listGeniexBuilds(root: string): Promise<GeniexInstallRecord[]> {
  const out: GeniexInstallRecord[] = []
  for (const tag of await readdir(root).catch(() => [] as string[]))
    for (const backend of await readdir(join(root, tag)).catch(() => [] as string[])) {
      const dir = join(root, tag, backend)
      if (!(await exists(join(dir, OWNER_MARKER)))) continue
      const record = await readGeniexInstallRecord(dir)
      if (record && (await exists(join(dir, LIB_DIR, GENIEX_LIBRARY_FILE)))) out.push(record)
    }
  return out.sort((a, b) => b.installedAtMs - a.installedAtMs)
}
