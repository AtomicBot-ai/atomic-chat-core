/**
 * What a Windows machine can already do, read without changing any of it (change
 * `add-tensorrt-llm-windows`, task 2.3; spec `wsl-runtime-environment`, "Probe Windows-хоста без
 * изменений на машине").
 *
 * Windows never adopts the user's own container setup: the engine runs inside a WSL distribution
 * Atomic Chat imports and owns, so this probe answers a narrower question than Linux's — can this
 * machine host one, what has to be turned on first, and is ours already there. What happens inside
 * that distribution is the Linux probe's job, run in the guest (`guest-host.ts`, design D1).
 *
 * Every read here works for a standard user. `Get-WindowsOptionalFeature -Online` would say whether
 * the WSL components are on, but it needs an administrator, and the core never runs elevated (design
 * D2); `wsl.exe` itself says it instead — `--version` answers only once the WSL package is installed,
 * `--status` only once its components can start a VM. The rest: firmware virtualization from CIM
 * (`Win32_Processor`, or a hypervisor already running, which proves it), the driver and cards from the
 * Windows `nvidia-smi`, this process's integrity level from `whoami /groups`, the network and memory
 * settings from `%UserProfile%\.wslconfig` (read, never written).
 *
 * A fact that could not be read lands in `unknown` — never assumed present or absent — and the plan
 * (`windows-plan.ts`) decides what that blocks. Every command `wsl.exe` writes may arrive as UTF-16;
 * the transport decodes it (`decodeWslBytes`), and `decodeWslOutput` still copes with a caller that
 * read it as UTF-8 and left a NUL between every character.
 */

import type { GpuFacts } from '../../contracts/index.js'
import type { Wsl, WslCommandOutput } from '../wsl/index.js'
import { parseNvidiaSmi, type CommandOutput } from './linux-probe.js'

/** One row of `wsl --list --verbose`. */
export interface WslDistribution {
  name: string
  state: string
  /** WSL 1 and WSL 2 are different machines; only 2 can carry this runtime. */
  version: number | null
  is_default: boolean
}

/** `%UserProfile%\.wslconfig`'s `[wsl2]` settings this integration reads — and never writes. */
export interface WslConfigFacts {
  /** `networkingMode` (`nat`, `mirrored`, …), lowercase; null when not set (WSL's default is NAT). */
  networking_mode: string | null
  /** `localhostForwarding`; null when not set (WSL's default is on). */
  localhost_forwarding: boolean | null
  /** `memory` as written (`16GB`); null when not set (WSL's default is half of the RAM). */
  memory: string | null
}

export interface WslFacts {
  /** The WSL package answers `--version`; false for the inbox stub of a machine without it. */
  installed: boolean | null
  /** `MAJOR.MINOR.PATCH` of the package (`--version`'s first line, its fourth part dropped). */
  version: string | null
  /** `--status` answers: the components are on and a WSL 2 VM can start. Null when not asked. */
  ready: boolean | null
}

export interface WindowsHostFacts {
  /** `x86_64`, `aarch64`, …: the machine's own architecture, not an emulated process's. */
  architecture: string | null
  /** The third part of the OS version (`10.0.22631` → 22631). */
  windows_build: number | null
  /** This process runs at high integrity (an administrator's elevated token). */
  elevated: boolean | null
  wsl: WslFacts
  /** Firmware virtualization is on (or a hypervisor runs, which proves it). Null when unread or not asked. */
  virtualization: boolean | null
  /** The NVIDIA driver is installed: its `nvidia-smi.exe` is in System32. Null when that could not be told. */
  driver_installed: boolean | null
  /** The Windows driver's own version (`591.44`), from the Windows `nvidia-smi`; null without a card. */
  driver_version: string | null
  gpus: GpuFacts[]
  distributions: WslDistribution[]
  wslconfig: WslConfigFacts
  /** Named checks whose answer could not be read. */
  unknown: string[]
}

/** What `probeWindowsHost` reads the machine through. */
export interface WindowsProbeDeps {
  wsl: Wsl
  /** A read-only command on Windows (PowerShell, `whoami`, `nvidia-smi`): `hostExec` in production. */
  exec: (command: string, args: string[]) => Promise<CommandOutput>
  /** `%SystemRoot%`, where the system's own `nvidia-smi.exe`, `whoami.exe` and `powershell.exe` live. */
  systemRoot: string
  /** `os.machine()`. */
  machine: () => string
  /** `os.release()`: `10.0.<build>`. */
  release: () => string
  /** `%UserProfile%\.wslconfig`'s text; null when there is none. Rejects when it exists but cannot be read. */
  readWslConfig: () => Promise<string | null>
  /** Whether a file exists: false only when it is not there, a rejection when that cannot be told. */
  pathExists: (path: string) => Promise<boolean>
}

const NUL = String.fromCharCode(0)
const BOM = String.fromCharCode(0xfeff)

/** `wsl.exe` speaks UTF-16; a caller that read it as UTF-8 leaves a NUL between every character. */
export function decodeWslOutput(text: string): string {
  return text.split(NUL).join('').split(BOM).join('')
}

/** `os.machine()` in Linux's spelling: `x86_64` (Node may say `x86_64` or `AMD64`), `aarch64` for ARM. */
export function normalizeWindowsArchitecture(machine: string): string {
  const raw = machine.trim().toLowerCase()
  if (raw === 'x86_64' || raw === 'amd64' || raw === 'x64') return 'x86_64'
  if (raw === 'arm64' || raw === 'aarch64') return 'aarch64'
  return raw
}

/** `os.release()` on Windows is `10.0.<build>`; the build is what minimum versions compare. */
export function parseWindowsBuild(release: string): number | null {
  const match = /^\d+\.\d+\.(\d+)/.exec(release.trim())
  return match === null ? null : Number(match[1])
}

/**
 * `wsl --version`: the package version is on the first line, whatever language its label is in
 * (`WSL version: 2.4.4.0`, `Версия WSL: 2.4.4.0`). Four parts on the wire; the manifest compares three
 * (conf ruling 1.1), so the build part is dropped here.
 */
export function parseWslVersion(output: WslCommandOutput | null): string | null {
  if (output === null || output.code !== 0) return null
  const first = decodeWslOutput(output.stdout)
    .split(/\r?\n/)
    .find((line) => line.trim() !== '')
  const match = first === undefined ? null : /(\d+)\.(\d+)\.(\d+)(?:\.\d+)?\s*$/.exec(first.trim())
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`
}

/**
 * `wsl --list --verbose`: a header, then one line per distribution, the default marked with `*`.
 * The header's own words change with the display language, so a row is recognised by shape instead:
 * a real one ends in a version number. No distributions at all is a nonzero exit — an empty list.
 */
export function parseWslDistributions(output: WslCommandOutput | null): WslDistribution[] {
  if (output === null || output.code !== 0) return []
  const rows: WslDistribution[] = []
  for (const raw of decodeWslOutput(output.stdout).split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    const isDefault = line.trimStart().startsWith('*')
    const cells = line
      .trim()
      .replace(/^\*/, '')
      .trim()
      .split(/\s{2,}|\t+/)
      .filter(Boolean)
    if (cells.length < 3) continue
    const version = Number(cells[cells.length - 1])
    if (!Number.isInteger(version)) continue
    rows.push({
      name: cells[0] as string,
      state: cells[1] as string,
      version,
      is_default: isDefault,
    })
  }
  return rows
}

/**
 * The CIM answer (`VirtualizationFirmwareEnabled`, `HypervisorPresent`): a running hypervisor proves
 * virtualization is on — and then the processor reports the firmware flag as false, so it is checked
 * first. Anything unreadable is null.
 */
export function parseVirtualization(output: CommandOutput | null): boolean | null {
  if (output === null || output.code !== 0) return null
  try {
    const parsed = JSON.parse(output.stdout) as Record<string, unknown>
    if (parsed['HypervisorPresent'] === true) return true
    const firmware = parsed['VirtualizationFirmwareEnabled']
    return typeof firmware === 'boolean' ? firmware : null
  } catch {
    return null
  }
}

const HIGH_INTEGRITY = 'S-1-16-12288'
const SYSTEM_INTEGRITY = 'S-1-16-16384'
const MEDIUM_INTEGRITY = 'S-1-16-8192'

/** `whoami /groups /fo csv /nh`: the mandatory label says whether this token is elevated. */
export function parseElevation(output: CommandOutput | null): boolean | null {
  if (output === null || output.code !== 0) return null
  if (output.stdout.includes(HIGH_INTEGRITY) || output.stdout.includes(SYSTEM_INTEGRITY)) return true
  return output.stdout.includes(MEDIUM_INTEGRITY) ? false : null
}

const truthy = (value: string): boolean | null => {
  const lower = value.trim().toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  return null
}

/** `.wslconfig` is INI; only `[wsl2]` matters, keys case-insensitive, `#`/`;` comments. */
export function parseWslConfig(text: string | null): WslConfigFacts {
  const facts: WslConfigFacts = { networking_mode: null, localhost_forwarding: null, memory: null }
  if (text === null) return facts
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim()
    if (line === '') continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header !== null) {
      section = (header[1] as string).trim().toLowerCase()
      continue
    }
    if (section !== 'wsl2') continue
    const pair = /^([^=]+)=(.*)$/.exec(line)
    if (pair === null) continue
    const key = (pair[1] as string).trim().toLowerCase()
    const value = (pair[2] as string).trim().replace(/^"(.*)"$/, '$1')
    if (key === 'networkingmode') facts.networking_mode = value.toLowerCase()
    else if (key === 'localhostforwarding') facts.localhost_forwarding = truthy(value)
    else if (key === 'memory') facts.memory = value
  }
  return facts
}

const VIRTUALIZATION_QUERY =
  '$p = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1; ' +
  '$s = Get-CimInstance -ClassName Win32_ComputerSystem; ' +
  '[pscustomobject]@{ VirtualizationFirmwareEnabled = $p.VirtualizationFirmwareEnabled; ' +
  'HypervisorPresent = $s.HypervisorPresent } | ConvertTo-Json -Compress'

/**
 * Read the machine. Nothing here enables a component, imports, starts or stops a distribution, or
 * writes a file. `wsl --status` and the firmware check are asked only when they can change the
 * answer: a package that is not installed has no status, and a WSL that already starts VMs proves
 * virtualization.
 */
export async function probeWindowsHost(deps: WindowsProbeDeps): Promise<WindowsHostFacts> {
  const unknown: string[] = []
  const system32 = `${deps.systemRoot.replace(/[\\/]+$/, '')}\\System32`
  const smiPath = `${system32}\\nvidia-smi.exe`
  // The driver installs `nvidia-smi.exe` into System32: no file there is no driver, not an unread fact.
  const smiInstalled = await deps.pathExists(smiPath).catch(() => null)
  const [version, smi, whoami, wslconfigText] = await Promise.all([
    deps.wsl.command(['--version'], { timeoutMs: 30_000 }),
    smiInstalled === false
      ? Promise.resolve<CommandOutput>({ code: 127, stdout: '', stderr: 'no nvidia-smi.exe' })
      : deps.exec(smiPath, [
          '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
          '--format=csv,noheader,nounits',
        ]),
    deps.exec(`${system32}\\whoami.exe`, ['/groups', '/fo', 'csv', '/nh']),
    deps.readWslConfig().then(
      (text) => ({ text, unreadable: false }),
      () => ({ text: null, unreadable: true })
    ),
  ])

  const installed = version.code === null ? null : version.code === 0
  if (installed === null) unknown.push('wsl')
  const wslVersion = parseWslVersion(version)
  if (installed === true && wslVersion === null) unknown.push('wsl-version')

  const [status, list] =
    installed === true
      ? await Promise.all([
          deps.wsl.command(['--status'], { timeoutMs: 30_000 }),
          deps.wsl.command(['--list', '--verbose'], { timeoutMs: 30_000 }),
        ])
      : [null, null]
  const ready = status === null ? null : status.code === null ? null : status.code === 0
  if (installed === true && ready === null) unknown.push('wsl-status')

  // Only a WSL that cannot start a VM leaves the question of firmware virtualization open.
  let virtualization: boolean | null = ready === true ? true : null
  if (ready !== true) {
    virtualization = parseVirtualization(
      await deps.exec(`${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        VIRTUALIZATION_QUERY,
      ])
    )
  }

  if (smiInstalled === null || (smiInstalled && smi.code === null)) unknown.push('nvidia-driver')
  const nvidia = parseNvidiaSmi(smi)
  const elevated = parseElevation(whoami)
  if (elevated === null) unknown.push('integrity-level')
  if (wslconfigText.unreadable) unknown.push('wslconfig')

  const architecture = normalizeWindowsArchitecture(deps.machine())
  const windowsBuild = parseWindowsBuild(deps.release())
  if (windowsBuild === null) unknown.push('windows-build')

  return {
    architecture,
    windows_build: windowsBuild,
    elevated,
    wsl: { installed, version: wslVersion, ready },
    virtualization,
    driver_installed: smiInstalled,
    driver_version: nvidia.driver_version,
    gpus: nvidia.gpus,
    distributions: parseWslDistributions(list),
    wslconfig: parseWslConfig(wslconfigText.text),
    unknown,
  }
}
