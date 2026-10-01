/**
 * The Windows machine as the Windows provisioner reaches it (change `add-tensorrt-llm-windows`,
 * task 2.3): the read-only probe's dependencies (`WindowsProbeDeps`), where the user's own
 * distribution directory lives (`%LOCALAPPDATA%`), and the two disk facts the plan and the snapshot
 * show — free space on that directory's volume, and how big the distribution's `ext4.vhdx` has grown.
 * `windows-probe.ts` and `windows-plan.ts` stay pure; this is where the real machine comes in.
 */

import { stat, statfs, readFile } from 'node:fs/promises'
import { machine as osMachine, release as osRelease } from 'node:os'
import { dirname, win32 } from 'node:path'
import { createWsl, type Wsl } from '../wsl/index.js'
import { hostExec, type HostExec } from './host-exec.js'
import type { WindowsProbeDeps } from './windows-probe.js'

/** The fixed name Atomic Chat registers its own distribution under (design D9). */
export const ATOMIC_CHAT_DISTRIBUTION = 'AtomicChat'

export interface WindowsHost {
  probeDeps: WindowsProbeDeps
  /** `%LOCALAPPDATA%` of the user running the core. */
  localAppData: string
  /** Free bytes on the volume holding `path`, read at its nearest existing ancestor; null when unread. */
  freeDiskBytes(path: string): Promise<number | null>
  /** A file's size in bytes; null when it is not there or cannot be read. */
  fileSize(path: string): Promise<number | null>
}

/** Where Atomic Chat's own distribution lives: `%LOCALAPPDATA%\AtomicChat\wsl\<name>`. */
export function distributionDirectory(localAppData: string, name: string = ATOMIC_CHAT_DISTRIBUTION): string {
  return win32.join(localAppData, 'AtomicChat', 'wsl', name)
}

/** The disk image WSL keeps a distribution in, inside its directory. */
export function distributionDisk(directory: string): string {
  return win32.join(directory, 'ext4.vhdx')
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Free space at the nearest ancestor of `path` that exists: the distribution's directory may not yet. */
async function freeAt(path: string): Promise<number | null> {
  let current = path
  for (;;) {
    try {
      const info = await statfs(current)
      return Number(info.bavail) * Number(info.bsize)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = dirname(current)
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) return null
      current = parent
    }
  }
}

/** The real machine. `wsl` and `exec` are injectable so a test can run it without spawning anything. */
export function realWindowsHost(
  env: Record<string, string | undefined>,
  wsl: Wsl = createWsl(),
  exec: HostExec = hostExec()
): WindowsHost {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  const profile = env['USERPROFILE'] ?? ''
  return {
    probeDeps: {
      wsl,
      exec: (command, args) => exec(command, args),
      systemRoot,
      machine: osMachine,
      release: osRelease,
      readWslConfig: () =>
        profile === '' ? Promise.resolve(null) : readIfPresent(win32.join(profile, '.wslconfig')),
      pathExists: async (path) => {
        try {
          await stat(path)
          return true
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') return false
          throw error
        }
      },
    },
    localAppData: env['LOCALAPPDATA'] ?? win32.join(profile, 'AppData', 'Local'),
    freeDiskBytes: freeAt,
    fileSize: async (path) => {
      try {
        return (await stat(path)).size
      } catch {
        return null
      }
    },
  }
}
