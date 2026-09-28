/**
 * The real I/O behind `executeHostStep`, for a process that is already root.
 *
 * The request and result live in a folder the unprivileged user owns, so everything touching them
 * assumes that user may have planted a link there:
 *
 * - the request is opened with `O_NOFOLLOW` and must be a small regular file, so root is never
 *   pointed at `/etc/shadow` and made to report on it;
 * - the result is written to a fresh temporary name (`wx`: fails rather than follows) and renamed
 *   over the result path, which replaces a planted link instead of writing through it.
 *
 * System files (keys, repository files) are written the same atomic way with an explicit mode, so a
 * half-written keyring never exists and the user's umask never decides who can read it. Commands
 * run through `hostExec` — `spawn` without a shell — with the recipe's fixed environment.
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { hostExec } from '../../runtime/environment/index.js'
import type { HostStepExecutorDeps } from './executor.js'
import { INSTALL_CONTAINER_RUNTIME_RECIPE } from './install-container-runtime.js'

const REQUEST_SIZE_LIMIT = 64 * 1024
/** A package install over a slow mirror takes minutes; a hung one should still end. */
const COMMAND_TIMEOUT_MS = 30 * 60_000

async function readRequest(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`${path} is not a regular file`)
    if (info.size > REQUEST_SIZE_LIMIT) throw new Error(`${path} is too large to be a request`)
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

async function writeAtomically(path: string, data: Uint8Array | string, mode: number): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    const handle = await open(tmp, 'wx', mode)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(tmp, mode)
    await rename(tmp, path)
  } catch (error) {
    // Only our own temporary file, which nobody else can have named.
    await rm(tmp, { force: true })
    throw error
  }
}

async function readFileOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
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

/** The executor's dependencies on this machine. `env` is only read for who asked for elevation. */
export function nodeHostStepDeps(env: NodeJS.ProcessEnv): HostStepExecutorDeps {
  const exec = hostExec({
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: { ...INSTALL_CONTAINER_RUNTIME_RECIPE.environment },
  })
  return {
    readRequest,
    writeResult: (path, text) => writeAtomically(path, text, 0o644),
    readFile: readFileOrNull,
    writeFile: async (path, data, mode) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o755 })
      await writeAtomically(path, data, mode)
    },
    exec: ([command, ...args]) => exec(command as string, args),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    invokingUid: invokingUidFrom(env),
  }
}
