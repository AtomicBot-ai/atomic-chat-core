/**
 * `probeLinux`'s view of the real machine (task 2.6): the read-only commands, files and free-space
 * check `LinuxProbeDeps` describes, over `node:*` builtins. `linux-probe.ts` stays pure; this is the
 * one place the Linux provisioner's probe touches the host.
 *
 * `docker` is never looked up on `PATH` (carry-forward from 2.8/2.12): the probe runs the same
 * absolute binary the executor does (`resolveDockerBinary`, the fixed system directories), resolved
 * on every probe because the setup's own privileged step may have installed it since the last one.
 * A host with no docker CLI in those directories reads as "no docker CLI", which is what it is.
 *
 * `ATOMIC_MANAGED_TEST_HOST` is a test hook only, the same kind as `ATOMIC_CHATGPT_*`: production
 * never sets it. It names a folder standing in for a whole Linux machine — `bin/<command>` for every
 * probe command and the docker CLI, `root/<path>` for every file the probe reads, `free-disk-bytes`
 * for the free space, `docker.sock` for the Engine API — so the compiled core's e2e suite can drive
 * a full setup on any host without a real Docker, GPU or package manager (brief 2.6 e2e list).
 */
import { readFile, stat, statfs } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { resolveDockerBinary } from '../container/index.js'
import { hostExec, type HostExec } from './host-exec.js'
import type { CommandOutput, LinuxProbeDeps, LinuxProbeOptions } from './linux-probe.js'

export const MANAGED_TEST_HOST_ENV = 'ATOMIC_MANAGED_TEST_HOST'

/** Everything the Linux provisioner reads the machine through. */
export interface LinuxHost {
  probeDeps: LinuxProbeDeps
  options: () => LinuxProbeOptions
  /** Overrides for the Docker executor: set only for the test host. */
  dockerPath?: string
  dockerSocketPath?: string
}

const NOT_THERE: CommandOutput = { code: null, stdout: '', stderr: 'no docker CLI in the system directories' }

/** `readFile` per `LinuxProbeDeps`' contract: null only for ENOENT, a rejection for anything else. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

async function freeBytesAt(path: string): Promise<number | null> {
  const info = await statfs(path)
  return Number(info.bavail) * Number(info.bsize)
}

/** The account this core runs as; `root` for uid 0 whatever the passwd name says. */
export function currentUserName(info: () => { uid: number; username: string } = userInfo): string {
  const { uid, username } = info()
  return uid === 0 ? 'root' : username
}

/** The real machine. `exec` is injectable so a test can run it without spawning anything. */
export function realLinuxHost(
  env: Record<string, string | undefined>,
  exec: HostExec = hostExec(),
  dockerPath: () => Promise<string | null> = () => resolveDockerBinary()
): LinuxHost {
  return {
    probeDeps: {
      exec: async (command, args, overlay) => {
        if (command !== 'docker') return exec(command, args, overlay)
        const path = await dockerPath()
        return path === null ? NOT_THERE : exec(path, args, overlay)
      },
      readFile: readIfPresent,
      pathExists: exists,
      freeDiskBytes: freeBytesAt,
    },
    options: () => ({ user: currentUserName(), xdgRuntimeDir: env['XDG_RUNTIME_DIR'] ?? null }),
  }
}

/** The test hook's folder, or null when it is not set (always, outside tests). */
export function managedTestHostDir(env: Record<string, string | undefined>): string | null {
  const dir = env[MANAGED_TEST_HOST_ENV]
  return dir === undefined || dir.trim() === '' ? null : dir
}

/** The machine a test describes in `dir` (see the module comment for the layout). */
export function testLinuxHost(
  dir: string,
  env: Record<string, string | undefined>,
  exec: HostExec = hostExec()
): LinuxHost {
  const inRoot = (path: string): string => join(dir, 'root', path)
  return {
    probeDeps: {
      exec: (command, args, overlay) => exec(join(dir, 'bin', command), args, overlay),
      readFile: (path) => readIfPresent(inRoot(path)),
      pathExists: (path) => exists(inRoot(path)),
      freeDiskBytes: async (path) => {
        const pinned = await readIfPresent(join(dir, 'free-disk-bytes'))
        return pinned === null ? freeBytesAt(inRoot(path)) : Number(pinned.trim())
      },
    },
    options: () => ({ user: currentUserName(), xdgRuntimeDir: env['XDG_RUNTIME_DIR'] ?? null }),
    dockerPath: join(dir, 'bin', 'docker'),
    dockerSocketPath: join(dir, 'docker.sock'),
  }
}
