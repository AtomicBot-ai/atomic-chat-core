/**
 * Atomic Chat's own WSL distribution, seen as a Linux host (change `add-tensorrt-llm-windows`,
 * design D1): the same `LinuxProbeDeps` the Linux provisioner reads a machine through, answered by
 * commands run in the guest through the WSL transport — so `probeLinux` and `assessLinux` judge the
 * guest exactly as they judge a Linux host, and nothing about Docker or the toolkit is written twice.
 *
 * Everything runs as the guest's root (design D3): root in a distribution the user owns gives no
 * rights on Windows, and Docker is reached through its system socket without a `docker` group. No
 * command goes through a shell: a file is read with `cat`, its existence checked with `test -e`, free
 * space with `df`, each as its own argv.
 *
 * Two facts only the guest has (spec "Память и драйвер оцениваются по гостю"): the version of the
 * NVIDIA user-space libraries WSL hands the guest (`/usr/lib/wsl/lib`), in Linux numbering — the guest's
 * `nvidia-smi` reports the *Windows* driver's number (591.xx), which is not comparable with a
 * descriptor's `minimum_driver_version`, while the NVML library's own version is (design D10:
 * `nvidia-smi --version`'s `NVML version` line) — and the VM's memory, from the guest's
 * `/proc/meminfo` (by default half of the Windows RAM).
 */

import type { WslDistributionTransport } from '../wsl/index.js'
import type { LinuxHost } from './linux-host.js'
import type { CommandOutput, LinuxProbeDeps } from './linux-probe.js'

/** The guest account every probe, recipe and docker call runs as. */
export const GUEST_ROOT = 'root'

/** The docker CLI the guest recipe installs; never whatever `PATH` would find (a Windows `docker.exe`). */
export const GUEST_DOCKER = '/usr/bin/docker'

/** How long one guest command may take: the first one also boots the distribution. */
const GUEST_TIMEOUT_MS = 120_000

const run = (transport: WslDistributionTransport, argv: string[]): Promise<CommandOutput> =>
  transport.exec(argv, { user: GUEST_ROOT, timeoutMs: GUEST_TIMEOUT_MS })

/** `df --output=avail -B1 <path>`: a header line, then the bytes. */
export function parseDfAvail(output: CommandOutput): number | null {
  if (output.code !== 0) return null
  const lines = output.stdout.trim().split('\n')
  const value = Number(lines[lines.length - 1]?.trim())
  return lines.length >= 2 && Number.isSafeInteger(value) ? value : null
}

/** `nvidia-smi --version`'s `NVML version : 580.95.02` — the library version, Linux numbering. */
export function parseNvmlVersion(output: CommandOutput): string | null {
  if (output.code !== 0) return null
  const match = /^\s*NVML version\s*:\s*([0-9][0-9.]*)\s*$/im.exec(output.stdout)
  return match === null ? null : (match[1] as string)
}

/** `/proc/meminfo`'s `MemTotal:  16303452 kB`, in bytes. */
export function parseMemTotal(text: string | null): number | null {
  if (text === null) return null
  const match = /^MemTotal:\s+(\d+)\s*kB\s*$/m.exec(text)
  return match === null ? null : Number(match[1]) * 1024
}

/** The guest's `LinuxProbeDeps`, honouring their contracts: `null`/`false` only for "not there". */
export function guestProbeDeps(transport: WslDistributionTransport): LinuxProbeDeps {
  const exists = async (path: string): Promise<boolean> => {
    const tested = await run(transport, ['test', '-e', path])
    if (tested.code === 0) return true
    if (tested.code === 1) return false
    throw new Error(`could not check ${path} in the distribution: ${tested.stderr.trim()}`)
  }
  return {
    // The guest's own environment is not this process's: an `env` overlay has nothing to apply to.
    exec: (command, args) => run(transport, [command === 'docker' ? GUEST_DOCKER : command, ...args]),
    readFile: async (path) => {
      if (!(await exists(path))) return null
      const read = await run(transport, ['cat', '--', path])
      if (read.code !== 0)
        throw new Error(`could not read ${path} in the distribution: ${read.stderr.trim()}`)
      return read.stdout
    },
    pathExists: exists,
    freeDiskBytes: async (path) => parseDfAvail(await run(transport, ['df', '--output=avail', '-B1', path])),
  }
}

/** The guest as `probeLinux` reads it: root, no session runtime directory. */
export function guestLinuxHost(transport: WslDistributionTransport): LinuxHost {
  return {
    probeDeps: guestProbeDeps(transport),
    options: () => ({ user: GUEST_ROOT, xdgRuntimeDir: null }),
  }
}

/** What only the guest knows, read alongside `probeLinux`. */
export interface GuestExtras {
  /** The NVIDIA libraries WSL provides, Linux numbering; null when unread. */
  nvidia_library_version: string | null
  /** The VM's memory, bytes; null when unread. */
  memory_bytes: number | null
}

export async function probeGuestExtras(transport: WslDistributionTransport): Promise<GuestExtras> {
  const deps = guestProbeDeps(transport)
  const [smi, meminfo] = await Promise.all([
    run(transport, ['nvidia-smi', '--version']),
    deps.readFile('/proc/meminfo').catch(() => null),
  ])
  return { nvidia_library_version: parseNvmlVersion(smi), memory_bytes: parseMemTotal(meminfo) }
}
