/**
 * Engine installs under `<data>/diffusion/backends/<tag>/<backendId>/` and the model-file store
 * under `<data>/diffusion/models/`. Port of `install.rs` in `tauri-plugin-atomic-diffusion` (app
 * commit `767ff6350`).
 *
 * The download and the extraction happen in the app, through its ordinary download pipeline. This
 * module finalises a tree (permissions, sanity probe, ownership marker, install record) and refuses
 * to delete anything it did not mark as its own.
 */

import { chmod, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type {
  DiffusionBackend,
  DiffusionBackendInstallRecord,
  DiffusionEngineId,
  DiffusionModelFile,
  FinalizeBackendInstallArgs,
} from '../contracts/index.js'
import { buildProcessEnv, spawnManaged } from '../runtime/shared/index.js'
import { locate, samePath } from './containment.js'
import { diffusionError, ioError } from './errors.js'

export const OWNER_MARKER = '.atomic-owned'
export const INSTALL_RECORD = 'install.json'

/**
 * The first launch of a just-unpacked tree is slow for reasons unrelated to the binary: Gatekeeper
 * looks every new Mach-O up at Apple and XProtect scans the 109 MB dylib (1.5–2.3 s on an idle M4
 * Pro, 0.02 s the second time); Windows real-time protection scans each unseen DLL, and the CUDA
 * tree is 1.2 GB of them written the moment before. A 10 s budget failed a healthy install that
 * passed on retry.
 */
export const PROBE_TIMEOUT_MS = 120_000
/** A scanner can hold a freshly written executable for a moment, which surfaces as a spawn error. */
export const PROBE_SPAWN_ATTEMPTS = 3
export const PROBE_SPAWN_RETRY_DELAY_MS = 1_000
const PROBE_MARKERS = ['stable-diffusion.cpp', '--cfg-scale']

export function serverBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'sd-server.exe' : 'sd-server'
}

export function cliBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'
}

export interface InstallDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: () => number
  probeTimeoutMs?: number
  spawnRetryDelayMs?: number
  log?: (level: 'info' | 'warn', msg: string) => void
}

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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const ENGINES: readonly DiffusionEngineId[] = ['sd-cpp', 'diffusers']
const BACKENDS: readonly DiffusionBackend[] = ['cpu', 'metal', 'cuda', 'vulkan', 'rocm']

/** `install.json` holds the record minus `dir`, which is where the file lives. */
export async function writeInstallRecord(dir: string, record: DiffusionBackendInstallRecord): Promise<void> {
  const file = {
    tag: record.tag,
    backendId: record.backendId,
    backend: record.backend,
    engine: record.engine,
    sha256: record.sha256,
    installedAtMs: record.installedAtMs,
  }
  await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n').catch((error: unknown) => {
    throw ioError('Could not write the ownership marker.', error)
  })
  await writeFile(join(dir, INSTALL_RECORD), JSON.stringify(file, null, 2)).catch((error: unknown) => {
    throw ioError('Could not write the install record.', error)
  })
}

export async function readInstallRecord(dir: string): Promise<DiffusionBackendInstallRecord | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8'))
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const file = raw as Record<string, unknown>
  const sha256 = file['sha256'] ?? null
  const { tag, backendId, backend, engine, installedAtMs } = file
  if (
    typeof tag !== 'string' ||
    typeof backendId !== 'string' ||
    typeof backend !== 'string' ||
    !(BACKENDS as readonly string[]).includes(backend) ||
    typeof engine !== 'string' ||
    !(ENGINES as readonly string[]).includes(engine) ||
    (sha256 !== null && typeof sha256 !== 'string') ||
    typeof installedAtMs !== 'number' ||
    !Number.isInteger(installedAtMs) ||
    installedAtMs < 0
  )
    return undefined
  return {
    tag,
    backendId,
    backend: backend as DiffusionBackend,
    engine: engine as DiffusionEngineId,
    sha256,
    installedAtMs,
    dir,
  }
}

export function isOwned(dir: string): Promise<boolean> {
  return isFile(join(dir, OWNER_MARKER))
}

async function setExecutable(path: string, deps: InstallDeps): Promise<void> {
  if ((deps.platform ?? process.platform) === 'win32' || !(await isFile(path))) return
  await chmod(path, 0o755).catch((error: unknown) => {
    deps.log?.('warn', `chmod ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

export function probeOutputIsSdcpp(text: string): boolean {
  const lower = text.toLowerCase()
  return PROBE_MARKERS.some((marker) => lower.includes(marker))
}

function couldNotStart(binary: string, error: Error) {
  return diffusionError(
    'ENGINE_INSTALL_FAILED',
    'The image engine could not be started.',
    `${binary}: ${error.message}`
  )
}

/**
 * Run `<binary> --help` and check that the output is stable-diffusion.cpp's. A spawn failure is
 * retried (a scanner may still be holding the file); a binary that never answers is killed.
 */
export async function probeBinary(binary: string, deps: InstallDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  const started = Date.now()
  const elapsed = () => ((Date.now() - started) / 1000).toFixed(1)
  try {
    await probeOnce(binary, platform, timeoutMs, deps)
    deps.log?.('info', `engine probe passed in ${elapsed()}s`)
  } catch (error) {
    // The UI shows only the message, so the log is where the details live.
    const { message, details } = error as { message: string; details?: string }
    deps.log?.('warn', `engine probe failed after ${elapsed()}s: ${message} (${details ?? 'no details'})`)
    throw error
  }
}

async function probeOnce(
  binary: string,
  platform: NodeJS.Platform,
  timeoutMs: number,
  deps: InstallDeps
): Promise<void> {
  const { env, cwd } = buildProcessEnv({
    platform,
    baseEnv: deps.env ?? process.env,
    exeDir: dirname(binary),
    cuda: { libDirs: [], binDirs: [] },
    userEnv: {},
  })
  for (let attempt = 1; ; attempt++) {
    const proc = spawnManaged({ exe: binary, args: ['--help'], env, cwd })
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const outcome = await Promise.race([proc.exited, timedOut])
    clearTimeout(timer)
    if (outcome === 'timeout') {
      await proc.terminate(0)
      throw diffusionError(
        'ENGINE_INSTALL_FAILED',
        'The image engine did not respond to --help.',
        `${binary} timed out after ${Math.round(timeoutMs / 1000)}s`
      )
    }
    const failure = proc.spawnFailure()
    if (failure) {
      if (attempt >= PROBE_SPAWN_ATTEMPTS) throw couldNotStart(binary, failure)
      deps.log?.(
        'warn',
        `engine probe did not start (attempt ${attempt}/${PROBE_SPAWN_ATTEMPTS}): ${failure.message}`
      )
      await sleep(deps.spawnRetryDelayMs ?? PROBE_SPAWN_RETRY_DELAY_MS)
      continue
    }
    // Give the pipes a tick to flush their last lines.
    await sleep(10)
    const { stdout, stderr } = proc.output()
    const text = stdout + stderr
    if (probeOutputIsSdcpp(text)) return
    throw diffusionError(
      'ENGINE_INSTALL_FAILED',
      'The downloaded binary is not stable-diffusion.cpp.',
      [...text].slice(0, 800).join('')
    )
  }
}

/** Finalise a tree the app extracted: permissions, probe, then marker and record. */
export async function finalizeBackendInstall(
  backendsRoot: string,
  args: FinalizeBackendInstallArgs,
  deps: InstallDeps = {}
): Promise<DiffusionBackendInstallRecord> {
  const platform = deps.platform ?? process.platform
  const { dir } = args
  if (!(await isDirectory(dir)))
    throw diffusionError('ENGINE_INSTALL_FAILED', 'The engine directory does not exist.', dir)
  if ((await locate(dir, backendsRoot, platform)) === 'outside')
    throw diffusionError(
      'INVALID_REQUEST',
      'The engine directory is outside the diffusion backends folder.',
      dir
    )
  const server = join(dir, serverBinaryName(platform))
  if (!(await isFile(server)))
    throw diffusionError('ENGINE_INSTALL_FAILED', 'The archive did not contain sd-server.', server)
  const cli = join(dir, cliBinaryName(platform))
  await setExecutable(server, deps)
  await setExecutable(cli, deps)
  // Some release layouts ship a bare `sd` too.
  await setExecutable(join(dir, platform === 'win32' ? 'sd.exe' : 'sd'), deps)

  await probeBinary((await isFile(cli)) ? cli : server, deps)

  const record: DiffusionBackendInstallRecord = {
    tag: args.tag,
    backendId: args.backendId,
    backend: args.backend,
    engine: args.engine,
    sha256: args.sha256 ?? null,
    installedAtMs: (deps.now ?? Date.now)(),
    dir,
  }
  await writeInstallRecord(dir, record)
  return record
}

/** Every `<root>/<tag>/<backendId>/install.json` with its marker and its server binary, newest first. */
export async function listInstalledBackends(
  backendsRoot: string,
  platform: NodeJS.Platform = process.platform
): Promise<DiffusionBackendInstallRecord[]> {
  const out: DiffusionBackendInstallRecord[] = []
  for (const tag of await readdir(backendsRoot).catch(() => [] as string[])) {
    const tagPath = join(backendsRoot, tag)
    if (!(await isDirectory(tagPath))) continue
    for (const backend of await readdir(tagPath).catch(() => [] as string[])) {
      const dir = join(tagPath, backend)
      if (!(await isDirectory(dir)) || !(await isOwned(dir))) continue
      const record = await readInstallRecord(dir)
      if (record && (await isFile(join(dir, serverBinaryName(platform))))) out.push(record)
    }
  }
  return out.sort((a, b) => b.installedAtMs - a.installedAtMs)
}

const isEmptyDir = (dir: string): Promise<boolean> =>
  readdir(dir).then(
    (names) => names.length === 0,
    () => false
  )

/**
 * Delete an installed tree. Refuses trees without the ownership marker and anything outside the
 * backends root; whether the tree is in use is the caller's question.
 */
export async function removeBackend(
  backendsRoot: string,
  dir: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if ((await locate(dir, backendsRoot, platform)) !== 'inside')
    throw diffusionError('INVALID_REQUEST', 'That directory is not a diffusion backend install.', dir)
  if (!(await isDirectory(dir))) return
  if (!(await isOwned(dir)))
    throw diffusionError(
      'INVALID_REQUEST',
      'Refusing to delete a directory Atomic Chat did not install.',
      `${dir} has no ${OWNER_MARKER} marker`
    )
  await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
    throw ioError('Could not remove the engine directory.', error)
  })
  // Drop the now-empty `<tag>` parent so the listing stays tidy.
  const parent = dirname(dir)
  if (!(await samePath(parent, backendsRoot, platform)) && (await isEmptyDir(parent)))
    await rmdir(parent).catch(() => {})
}

/**
 * Regular files under the models root, recursively, with `/`-separated relative paths. Hidden files
 * and in-flight downloads are skipped.
 */
export async function listModelFiles(modelsRoot: string): Promise<DiffusionModelFile[]> {
  const out: DiffusionModelFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      const meta = await stat(path).catch(() => undefined)
      if (!meta) continue
      if (meta.isDirectory()) {
        await walk(path)
        continue
      }
      // A link to a file is not a model file of ours (the plugin read the entry itself, not its target).
      if (entry.isSymbolicLink() || !meta.isFile()) continue
      if (['.tmp', '.part', '.download'].some((suffix) => entry.name.endsWith(suffix))) continue
      out.push({ path, relativePath: relative(modelsRoot, path).split(sep).join('/'), bytes: meta.size })
    }
  }
  await walk(modelsRoot)
  return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
}

/** Delete one file under the models root, and the family folders it leaves empty. Anything outside is refused. */
export async function deleteModelFile(
  modelsRoot: string,
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if ((await locate(path, modelsRoot, platform)) !== 'inside')
    throw diffusionError('INVALID_REQUEST', 'That file is not in the diffusion models folder.', path)
  const meta = await stat(path).catch(() => undefined)
  if (!meta) return
  if (meta.isDirectory())
    throw diffusionError('INVALID_REQUEST', 'That path is a directory, not a model file.', path)
  await rm(path).catch((error: unknown) => {
    throw ioError('Could not delete the model file.', error)
  })
  // Prune empty family directories on the way up, never the root itself.
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if ((await locate(dir, modelsRoot, platform)) !== 'inside' || !(await isEmptyDir(dir))) break
    await rmdir(dir).catch(() => {})
  }
}

/** Make sure the folders the rest of the module assumes are there. */
export async function ensureDirs(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs)
    await mkdir(dir, { recursive: true }).catch((error: unknown) => {
      throw ioError('Could not create the diffusion folders.', error)
    })
}
