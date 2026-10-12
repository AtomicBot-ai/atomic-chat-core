/**
 * What is on disk for each engine: the builds the core downloaded (marked with `.atomic-owned` and an
 * `install.json`), and for MLX the build the desktop installer ships in `--resources-dir`.
 *
 * sd.cpp keeps the record the app's `finalize` has always written (`diffusion/install.ts`,
 * camelCase), so builds the desktop installed before this change are recognised as they are. MLX
 * writes the same shape plus `publishedAt`, the only order MLX builds have (design D3, D4).
 *
 * Nothing here deletes a directory the core did not mark as its own, or one outside its root.
 */

import { chmod, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import { locate, samePath } from '../diffusion/containment.js'
import { INSTALL_RECORD, OWNER_MARKER, runHelpProbe } from '../diffusion/install.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import { isDateTime } from './manifest.js'

export const MLX_SERVER_BINARY = 'mlx-server'
/** The installer's description of its `mlx-server`, written by the desktop Makefile. */
export const BUNDLED_MLX_METADATA = 'mlx-server.json'

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )
const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false
  )

export interface MlxInstallRecord {
  tag: string
  backendId: string
  sha256: string | null
  installedAtMs: number
  publishedAt: string | null
  dir: string
}

/** The marker, then `install.json` without `dir`. */
export async function writeMlxInstallRecord(
  dir: string,
  record: Omit<MlxInstallRecord, 'dir'>
): Promise<void> {
  await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n')
  const file = {
    tag: record.tag,
    backendId: record.backendId,
    sha256: record.sha256,
    installedAtMs: record.installedAtMs,
    publishedAt: record.publishedAt,
  }
  await writeFile(join(dir, INSTALL_RECORD), JSON.stringify(file, null, 2))
}

export async function readMlxInstallRecord(dir: string): Promise<MlxInstallRecord | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8'))
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { tag, backendId, sha256, installedAtMs, publishedAt } = raw as Record<string, unknown>
  if (
    typeof tag !== 'string' ||
    typeof backendId !== 'string' ||
    (sha256 !== null && sha256 !== undefined && typeof sha256 !== 'string') ||
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
    dir,
  }
}

/** Every marked `<root>/<tag>/<backendId>/` with its record and its `mlx-server`, newest install first. */
export async function listDownloadedMlx(root: string): Promise<MlxInstallRecord[]> {
  const out: MlxInstallRecord[] = []
  for (const tag of await readdir(root).catch(() => [] as string[])) {
    const tagPath = join(root, tag)
    if (!(await isDirectory(tagPath))) continue
    for (const backend of await readdir(tagPath).catch(() => [] as string[])) {
      const dir = join(tagPath, backend)
      if (!(await isDirectory(dir)) || !(await isFile(join(dir, OWNER_MARKER)))) continue
      const record = await readMlxInstallRecord(dir)
      if (record && (await isFile(join(dir, MLX_SERVER_BINARY)))) out.push(record)
    }
  }
  return out.sort((a, b) => b.installedAtMs - a.installedAtMs)
}

export interface BundledMlx {
  binary: string
  /** From `mlx-server.json`; `null` when the installer has none (a dev stub, an older installer). */
  tag: string | null
  published_at: string | null
}

/** `<resources-dir>/mlx-server` and what `mlx-server.json` beside it says; `null` without the binary. */
export async function readBundledMlx(resourcesDir: string | undefined): Promise<BundledMlx | null> {
  if (!resourcesDir) return null
  const binary = join(resourcesDir, MLX_SERVER_BINARY)
  if (!(await isFile(binary))) return null
  let meta: Record<string, unknown> = {}
  try {
    const raw: unknown = JSON.parse(await readFile(join(resourcesDir, BUNDLED_MLX_METADATA), 'utf8'))
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) meta = raw as Record<string, unknown>
  } catch {
    // No metadata: the oldest build of all (design D4).
  }
  return {
    binary,
    tag: typeof meta['tag'] === 'string' && meta['tag'] !== '' ? meta['tag'] : null,
    published_at: isDateTime(meta['published_at']) ? meta['published_at'] : null,
  }
}

/**
 * Delete one build directory under `root`. Refuses anything outside the root and anything without
 * the ownership marker (`INVALID_REQUEST`); a directory that is not there is `false`. Whether the
 * build is in use is the caller's question.
 */
export async function removeOwnedBuild(
  root: string,
  dir: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if ((await locate(dir, root, platform)) !== 'inside')
    throw new AtomicCoreError('INVALID_REQUEST', 'That directory is not an engine build of this core.', dir)
  if (!(await isDirectory(dir))) return false
  if (!(await isFile(join(dir, OWNER_MARKER))))
    throw new AtomicCoreError(
      'INVALID_REQUEST',
      'Refusing to delete a build Atomic Chat did not install.',
      `${dir} has no ${OWNER_MARKER} marker`
    )
  await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
    throw new AtomicCoreError('IO_ERROR', 'Could not remove the engine build.', String(error))
  })
  const parent = dirname(dir)
  if (!(await samePath(parent, root, platform)))
    await readdir(parent).then(
      (names) => (names.length === 0 ? rmdir(parent).catch(() => {}) : undefined),
      () => {}
    )
  return true
}

/** The first run of a freshly unpacked 210 MB PyInstaller binary is scanned by Gatekeeper and XProtect. */
export const MLX_PROBE_TIMEOUT_MS = 120_000

/**
 * `mlx-server --help` must exit 0 and print its argparse usage. A failure is `ENGINE_INSTALL_FAILED`
 * with what the binary printed.
 */
export async function probeMlxServer(
  dir: string,
  deps: { env?: NodeJS.ProcessEnv; timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<void> {
  const binary = join(dir, MLX_SERVER_BINARY)
  if (!(await isFile(binary)))
    throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'The archive did not contain mlx-server.', binary)
  await chmod(binary, 0o755)
  const { exit, text } = await runHelpProbe(binary, {
    platform: deps.platform ?? process.platform,
    timeoutMs: deps.timeoutMs ?? MLX_PROBE_TIMEOUT_MS,
    deps: { ...(deps.env ? { env: deps.env } : {}) },
    noResponse: 'mlx-server did not respond to --help.',
    couldNotStart: 'mlx-server could not be started.',
  })
  if (mlxProbePassed(text, exit)) return
  throw new AtomicCoreError(
    'ENGINE_INSTALL_FAILED',
    'The downloaded mlx-server does not run on this Mac.',
    `${describeExit(exit)}\n${[...text].slice(0, 800).join('')}`.trim()
  )
}

/** Exit 0 and argparse's `usage: mlx-server`. */
export function mlxProbePassed(text: string, exit: ExitInfo): boolean {
  return exit.code === 0 && /usage:\s*mlx-server/i.test(text)
}

function describeExit(exit: ExitInfo): string {
  if (exit.code !== null) return `exit code ${exit.code}`
  return exit.signal === null ? 'unknown status' : `signal ${String(exit.signal)}`
}
