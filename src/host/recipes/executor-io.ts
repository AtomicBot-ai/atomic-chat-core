/**
 * The real I/O behind `executeHostStep`, for a process that is already root.
 *
 * The request and result live in a folder the unprivileged user owns, so everything touching them
 * assumes someone may have planted a link there, or be racing us:
 *
 * - The folder itself must be a real directory (not a symlink), owned by root or the user who asked
 *   for elevation, and writable by nobody else. Otherwise a third account could swap files under us.
 * - The request is opened with `O_NOFOLLOW | O_NONBLOCK` — a link is refused, a FIFO cannot hang
 *   root — and, on the open handle, must be a small regular file owned by root or the invoking user
 *   and not group- or world-writable.
 * - Every file root writes (the result, keys, repository files) goes to a fresh temporary name
 *   opened `O_CREAT | O_EXCL | O_NOFOLLOW`, gets its mode through the handle (`fchmod`, never a
 *   path-based `chmod` that a swapped link would redirect), and is renamed into place, which
 *   replaces a planted link instead of writing through it.
 *
 * What remains: node has no `openat`, so the folder is checked by path and could in principle be
 * swapped between the check and the open by its owner. The worst that buys is a new file named
 * `.<name>.<random>.tmp` / `<step>.result.json` with our own JSON in it, created in some other
 * folder — never an existing file overwritten, since every open is exclusive. Seteuid-ing to the
 * user was ruled out (controller ruling, fix round 1).
 *
 * Commands run through `hostExec` — `spawn` without a shell — with the recipe's fixed environment.
 */

import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { hostExec } from '../../runtime/environment/index.js'
import type { HostStepExecutorDeps } from './executor.js'
import { INSTALL_CONTAINER_RUNTIME_RECIPE } from './install-container-runtime.js'

/** The slice of an open file the executor uses; node's `FileHandle` is one. */
export interface HostFileHandle {
  stat(): Promise<{ isFile(): boolean; uid: number; mode: number; size: number }>
  readFile(encoding: 'utf8'): Promise<string>
  writeFile(data: Uint8Array | string): Promise<void>
  /** `fchmod`: applies to this open file, whatever its path now points at. */
  chmod(mode: number): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/** The file-system calls the executor makes, injectable so tests can fake owners they cannot create. */
export interface HostFs {
  open(path: string, flags: number, mode?: number): Promise<HostFileHandle>
  lstat(
    path: string
  ): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }>
  rename(from: string, to: string): Promise<void>
  /** Removes one file if it is there; used only on our own temporary files. */
  remove(path: string): Promise<void>
  mkdir(path: string, mode: number): Promise<void>
  readFile(path: string): Promise<Uint8Array>
}

export const nodeHostFs: HostFs = {
  open: (path, flags, mode) => open(path, flags, mode),
  lstat: (path) => lstat(path),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
  mkdir: async (path, mode) => {
    await mkdir(path, { recursive: true, mode })
  },
  readFile: async (path) => new Uint8Array(await readFile(path)),
}

// `O_NOFOLLOW`/`O_NONBLOCK` exist on every POSIX platform node supports; this module only ever runs
// on Linux (the recipe is Linux-only), so there is no fallback that would silently drop them.
const REQUEST_SIZE_LIMIT = 64 * 1024
/** Checks, `nvidia-ctk`, `systemctl`, `usermod`: minutes at most. */
const COMMAND_TIMEOUT_MS = 10 * 60_000
/**
 * A package install over a slow mirror can take long, and killing dpkg mid-run can leave packages
 * half-configured: two hours, then SIGTERM and five more minutes to stop before SIGKILL.
 */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60_000
const INSTALL_TERMINATE_GRACE_MS = 5 * 60_000

const refuse = (message: string): never => {
  throw new AtomicCoreError('MANAGED_HOST_STEP_INVALID', message)
}

const GROUP_OR_WORLD_WRITABLE = 0o022

function trustedOwners(invokingUid: string | null): Set<number> {
  return new Set(invokingUid === null ? [0] : [0, Number(invokingUid)])
}

function checkOwnership(what: string, info: { uid: number; mode: number }, owners: Set<number>): void {
  if (!owners.has(info.uid))
    refuse(`${what} is owned by uid ${info.uid}, not by root or the user who asked for elevation`)
  if ((info.mode & GROUP_OR_WORLD_WRITABLE) !== 0)
    refuse(`${what} is group- or world-writable (mode ${(info.mode & 0o777).toString(8)})`)
}

/** The folder a file lives in: a real directory that only root or the invoking user can write. */
async function checkFolder(fs: HostFs, path: string, owners: Set<number>): Promise<void> {
  const folder = dirname(path)
  const info = await fs.lstat(folder)
  if (info.isSymbolicLink() || !info.isDirectory())
    refuse(`${folder} is not a directory (a symlink is refused)`)
  checkOwnership(folder, info, owners)
}

async function readRequest(fs: HostFs, owners: Set<number>, path: string): Promise<string> {
  await checkFolder(fs, path, owners)
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const handle = await fs.open(path, flags)
  try {
    const info = await handle.stat()
    if (!info.isFile()) refuse(`${path} is not a regular file`)
    checkOwnership(path, info, owners)
    if (info.size > REQUEST_SIZE_LIMIT) refuse(`${path} is too large to be a request`)
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

async function writeAtomically(
  fs: HostFs,
  owners: Set<number>,
  path: string,
  data: Uint8Array | string,
  mode: number
): Promise<void> {
  await checkFolder(fs, path, owners)
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  const handle = await fs.open(tmp, flags, mode)
  try {
    try {
      await handle.writeFile(data)
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, path)
  } catch (error) {
    // Only our own temporary file: it was created exclusively, so nobody else's can be at that name.
    await fs.remove(tmp)
    throw error
  }
}

async function readFileOrNull(fs: HostFs, path: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** `PKEXEC_UID` (set by pkexec itself) or `SUDO_UID`, when it is a number; otherwise null. */
export function invokingUidFrom(env: NodeJS.ProcessEnv): string | null {
  for (const name of ['PKEXEC_UID', 'SUDO_UID']) {
    const value = env[name]
    if (value !== undefined) return /^\d+$/.test(value) ? value : null
  }
  return null
}

/**
 * The executor's dependencies on this machine. `env` is only read for who asked for elevation,
 * which also decides whose folder and request file are trusted (root's alone when nobody is named).
 */
export function nodeHostStepDeps(env: NodeJS.ProcessEnv, fs: HostFs = nodeHostFs): HostStepExecutorDeps {
  const environment = { ...INSTALL_CONTAINER_RUNTIME_RECIPE.environment }
  const quick = hostExec({ timeoutMs: COMMAND_TIMEOUT_MS, env: environment })
  const long = hostExec({
    timeoutMs: INSTALL_TIMEOUT_MS,
    terminateGraceMs: INSTALL_TERMINATE_GRACE_MS,
    env: environment,
  })
  const invokingUid = invokingUidFrom(env)
  const owners = trustedOwners(invokingUid)
  return {
    readRequest: (path) => readRequest(fs, owners, path),
    writeResult: (path, text) => writeAtomically(fs, owners, path, text, 0o644),
    readFile: (path) => readFileOrNull(fs, path),
    writeFile: async (path, data, mode) => {
      await fs.mkdir(dirname(path), 0o755)
      await writeAtomically(fs, owners, path, data, mode)
    },
    exec: ([command, ...args], options) => (options?.longRunning ? long : quick)(command as string, args),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    invokingUid,
  }
}
