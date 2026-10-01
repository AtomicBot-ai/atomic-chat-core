/**
 * The Windows machine as the Windows provisioner reaches it (change `add-tensorrt-llm-windows`,
 * task 2.3): the read-only probe's dependencies (`WindowsProbeDeps`), where the user's own
 * distribution directory lives (`%LOCALAPPDATA%`), and the two disk facts the plan and the snapshot
 * show — free space on that directory's volume, and how big the distribution's `ext4.vhdx` has grown.
 * `windows-probe.ts` and `windows-plan.ts` stay pure; this is where the real machine comes in.
 */

import { readFileSync } from 'node:fs'
import { stat, statfs, readFile } from 'node:fs/promises'
import { machine as osMachine, release as osRelease } from 'node:os'
import { dirname, join, win32 } from 'node:path'
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

/**
 * Test hook only, the same kind as `ATOMIC_MANAGED_TEST_HOST`: production never sets it. It names a
 * folder standing in for a whole Windows machine with WSL, so the compiled core's e2e suite drives the
 * Windows managed path on any OS:
 *
 * - `windows.json` — the machine (`os.machine()`, `os.release()`, elevated or not, firmware
 *   virtualization, the NVIDIA driver and cards, `.wslconfig`'s text, the volume's free space, the
 *   distribution disk's size), read again at every call so a test can change it mid-run (a restart);
 * - `wsl-command.json` — the argv `wsl.exe` is: a Node executable and `test/helpers/fake-wsl.mjs` with
 *   its state folder;
 * - `local-app-data/` — `%LOCALAPPDATA%`;
 * - `guest-fs/` — the guests' file systems, standing in for `\\wsl.localhost`.
 */
export const MANAGED_TEST_WINDOWS_ENV = 'ATOMIC_MANAGED_TEST_WINDOWS'

export function managedTestWindowsDir(env: Record<string, string | undefined>): string | null {
  const dir = env[MANAGED_TEST_WINDOWS_ENV]
  return dir === undefined || dir.trim() === '' ? null : dir
}

interface TestWindowsMachine {
  machine: string
  release: string
  elevated: boolean
  virtualization: { firmware: boolean | null; hypervisor: boolean } | 'unreadable'
  nvidia: {
    driver: string
    gpus: { uuid: string; name: string; cc: string; total_mib: number; free_mib: number }[]
  } | null
  wslconfig: string | null
  volume_free_bytes: number | null
  vhdx_bytes: number | null
}

/** The machine a test describes in `dir` (see `MANAGED_TEST_WINDOWS_ENV`). */
export function testWindowsHost(dir: string): WindowsHost {
  const machine = async (): Promise<TestWindowsMachine> =>
    JSON.parse(await readFile(join(dir, 'windows.json'), 'utf8')) as TestWindowsMachine
  const [executable, ...executableArgs] = JSON.parse(
    readFileSync(join(dir, 'wsl-command.json'), 'utf8')
  ) as string[]
  const wsl = createWsl({ executable: executable as string, executableArgs })
  let snapshot: TestWindowsMachine = JSON.parse(
    readFileSync(join(dir, 'windows.json'), 'utf8')
  ) as TestWindowsMachine
  const fresh = async (): Promise<TestWindowsMachine> => (snapshot = await machine())
  return {
    probeDeps: {
      wsl,
      exec: async (command, args) => {
        const current = await fresh()
        const base = command.split(/[\\/]/).pop()?.toLowerCase()
        if (base === 'nvidia-smi.exe') {
          if (current.nvidia === null) return { code: null, stdout: '', stderr: 'not found' }
          if (current.nvidia.gpus.length === 0)
            return { code: 6, stdout: 'No devices were found\n', stderr: '' }
          const { driver, gpus } = current.nvidia
          return {
            code: 0,
            stdout: gpus
              .map((g) => `${g.uuid}, ${g.name}, ${g.cc}, ${g.total_mib}, ${g.free_mib}, ${driver}\n`)
              .join(''),
            stderr: '',
          }
        }
        if (base === 'whoami.exe') {
          const label = current.elevated ? 'S-1-16-12288' : 'S-1-16-8192'
          return { code: 0, stdout: `"Mandatory Label\\Level","Label","${label}",""\r\n`, stderr: '' }
        }
        if (base === 'powershell.exe') {
          if (current.virtualization === 'unreadable') return { code: 1, stdout: '', stderr: 'CIM failed' }
          return {
            code: 0,
            stdout: JSON.stringify({
              VirtualizationFirmwareEnabled: current.virtualization.firmware,
              HypervisorPresent: current.virtualization.hypervisor,
            }),
            stderr: '',
          }
        }
        void args
        return { code: null, stdout: '', stderr: `test windows host: unexpected ${command}` }
      },
      systemRoot: 'C:\\Windows',
      machine: () => snapshot.machine,
      release: () => snapshot.release,
      readWslConfig: async () => (await fresh()).wslconfig,
      pathExists: async (path) => !/nvidia-smi\.exe$/i.test(path) || (await fresh()).nvidia !== null,
    },
    localAppData: join(dir, 'local-app-data'),
    freeDiskBytes: async () => (await fresh()).volume_free_bytes,
    fileSize: async () => (await fresh()).vhdx_bytes,
  }
}
