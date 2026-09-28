/**
 * The real I/O behind `executeHostStep`, for a process that is already root.
 *
 * The request and result live in a folder the unprivileged user owns, so everything touching them
 * assumes someone may have planted a link there, or be racing us:
 *
 * - The folder itself must be a real directory (not a symlink), writable by nobody but its owner,
 *   and owned by the user who asked for elevation (`PKEXEC_UID`/`SUDO_UID`) — not by root, so
 *   `host-step exec /etc/<dir>/<x>.request.json` can never make root write a result into a system
 *   folder. Only when nobody is named (root ran it directly) is a root-owned folder the trusted one.
 *   Clients create it `0700` and the request `0600` (see `request-file.ts`).
 * - System files (keys, repository files) are written only into root-owned folders that nobody else
 *   can write.
 * - The request is opened with `O_NOFOLLOW | O_NONBLOCK` — a link is refused, a FIFO cannot hang
 *   root — and, on the open handle, must be a small regular file owned by root or the invoking user
 *   and not group- or world-writable.
 * - Every file root writes (the result, keys, repository files) goes to a fresh temporary name
 *   opened `O_CREAT | O_EXCL | O_NOFOLLOW`, gets its mode through the handle (`fchmod`, never a
 *   path-based `chmod` that a swapped link would redirect), and is renamed into place, which
 *   replaces a planted link instead of writing through it.
 *
 * What remains: node has no `openat`, so the folder is checked by path, and its owner could swap it
 * for a link between the check and the write. The temporary file is created exclusively, so no
 * existing file is written through; but `rename` does replace an existing destination, so the swap
 * can make root create — or replace — a file named `<step_id>.result.json` (0644, our own JSON) in
 * whatever folder the link points at. Only files with that suffix are reachable, and only by the
 * user who already holds the elevation prompt. Seteuid-ing to the user was ruled out (controller
 * ruling, fix round 1).
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

/** Who may own the request/result folder: the invoking user when known, otherwise root only. */
function folderOwners(invokingUid: string | null): Set<number> {
  return new Set([invokingUid === null ? 0 : Number(invokingUid)])
}

/** Who may own the request file inside that folder: root or the invoking user. */
function requestOwners(invokingUid: string | null): Set<number> {
  return new Set(invokingUid === null ? [0] : [0, Number(invokingUid)])
}

/** System folders (`/etc/apt/keyrings`, `/etc/yum.repos.d`, ...): root's alone. */
const SYSTEM_OWNERS = new Set([0])

function checkOwnership(what: string, info: { uid: number; mode: number }, owners: Set<number>): void {
  if (!owners.has(info.uid))
    refuse(`${what} is owned by uid ${info.uid}; only uid ${[...owners].join(' or ')} is trusted here`)
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

async function readRequest(
  fs: HostFs,
  folder: Set<number>,
  owners: Set<number>,
  path: string
): Promise<string> {
  await checkFolder(fs, path, folder)
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
  const folder = folderOwners(invokingUid)
  return {
    readRequest: (path) => readRequest(fs, folder, requestOwners(invokingUid), path),
    writeResult: (path, text) => writeAtomically(fs, folder, path, text, 0o644),
    readFile: (path) => readFileOrNull(fs, path),
    writeFile: async (path, data, mode) => {
      await fs.mkdir(dirname(path), 0o755)
      await writeAtomically(fs, SYSTEM_OWNERS, path, data, mode)
    },
    exec: ([command, ...args], options) => (options?.longRunning ? long : quick)(command as string, args),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    invokingUid,
  }
}
