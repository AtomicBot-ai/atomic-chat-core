/**
 * A Windows machine in memory for the Windows provisioner's unit tests (change
 * `add-tensorrt-llm-windows`): `wsl.exe` answered by `fake-wsl.mjs`'s `answerWsl` against one state
 * (no process is spawned), the Windows-side commands the probe runs (`nvidia-smi.exe`, `whoami.exe`,
 * PowerShell's CIM query) answered from the same machine description, and the disk facts. Every call
 * is recorded, so a test proves what was — and was not — run.
 */
import type { WindowsHost } from '../../src/runtime/environment/index.js'
import type { CommandOutput } from '../../src/runtime/environment/index.js'
import { decodeWslBytes, type Wsl, type WslHold, type WslHoldEnd } from '../../src/runtime/wsl/index.js'
import { answerWsl, type FakeWslState } from './fake-wsl.mjs'

export interface FakeWindowsMachine {
  wsl: FakeWslState
  /** `os.machine()`. */
  machine: string
  /** `os.release()`. */
  release: string
  elevated: boolean
  /** The CIM answer; `'unreadable'` when PowerShell fails. */
  virtualization: { firmware: boolean | null; hypervisor: boolean } | 'unreadable'
  /** The Windows driver and cards; null without a driver. */
  nvidia: {
    driver: string
    gpus: { uuid: string; name: string; cc: string; total_mib: number; free_mib: number }[]
  } | null
  wslconfig: string | null
  volume_free_bytes: number | null
  vhdx_bytes: number | null
  /** CBS `RebootPending` as `reg.exe query` finds it; unread when absent. */
  reboot_pending?: boolean
}

export interface FakeWindows {
  machine: FakeWindowsMachine
  host: WindowsHost
  wsl: Wsl
  /** Every `wsl.exe` argv, in order. */
  wslCalls: string[][]
  /** Every Windows-side command, as `[command, ...args]`. */
  execCalls: string[][]
  /** Holds still running. */
  holds: () => number
  /** `wsl --shutdown` from outside: every hold ends, not released. */
  stopVm: () => void
}

const LOCAL_APP_DATA = 'C:\\Users\\ada\\AppData\\Local'

export function fakeWindows(machine: FakeWindowsMachine): FakeWindows {
  const wslCalls: string[][] = []
  const execCalls: string[][] = []
  const live = new Set<(end: WslHoldEnd) => void>()

  const answer = (argv: string[], input?: string | Buffer) => {
    wslCalls.push(argv)
    const answered = answerWsl(machine.wsl, argv, input, true)
    if (answered.next !== undefined) machine.wsl = answered.next
    return {
      code: answered.code,
      stdout: decodeWslBytes(answered.stdout),
      stderr: decodeWslBytes(answered.stderr),
    }
  }

  const wsl: Wsl = {
    command: async (args, call = {}) => answer(args, call.input),
    distribution: (name) => ({
      name,
      exec: async (argv, call = {}) => {
        const out = answer(
          ['-d', name, ...(call.user === undefined ? [] : ['-u', call.user]), '--exec', ...argv],
          call.input
        )
        if (call.onStdout !== undefined && out.stdout !== '') call.onStdout(out.stdout)
        return out
      },
      hold: (): WslHold => {
        wslCalls.push(['-d', name, '--exec', 'sleep', 'infinity'])
        let resolve!: (end: WslHoldEnd) => void
        const exited = new Promise<WslHoldEnd>((r) => (resolve = r))
        const end = (released: boolean) => {
          if (!live.has(finish)) return
          live.delete(finish)
          resolve({ code: released ? null : 1, signal: null, released })
        }
        const finish = () => end(false)
        live.add(finish)
        return { exited, release: () => end(true) }
      },
    }),
  }

  const exec = async (command: string, args: string[]): Promise<CommandOutput> => {
    execCalls.push([command, ...args])
    const base = command.split('\\').pop()?.toLowerCase()
    if (base === 'nvidia-smi.exe') {
      if (machine.nvidia === null) return { code: null, stdout: '', stderr: 'not found' }
      const { driver, gpus } = machine.nvidia
      // What the real one says with a driver and no card.
      if (gpus.length === 0) return { code: 6, stdout: 'No devices were found\n', stderr: '' }
      return {
        code: 0,
        stdout: gpus
          .map((g) => `${g.uuid}, ${g.name}, ${g.cc}, ${g.total_mib}, ${g.free_mib}, ${driver}\n`)
          .join(''),
        stderr: '',
      }
    }
    if (base === 'whoami.exe') {
      const label = machine.elevated ? 'S-1-16-12288' : 'S-1-16-8192'
      return {
        code: 0,
        stdout: `"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n"Mandatory Label\\Level","Label","${label}",""\r\n`,
        stderr: '',
      }
    }
    if (base === 'powershell.exe') {
      if (machine.virtualization === 'unreadable')
        return { code: 1, stdout: '', stderr: 'Get-CimInstance failed' }
      return {
        code: 0,
        stdout: JSON.stringify({
          VirtualizationFirmwareEnabled: machine.virtualization.firmware,
          HypervisorPresent: machine.virtualization.hypervisor,
        }),
        stderr: '',
      }
    }
    if (base === 'reg.exe' && machine.reboot_pending !== undefined) {
      // Exit 0 when the key exists, 1 when it does not; an empty key prints nothing.
      return { code: machine.reboot_pending ? 0 : 1, stdout: '', stderr: '' }
    }
    return { code: null, stdout: '', stderr: `fake windows: unexpected ${command}` }
  }

  const host: WindowsHost = {
    probeDeps: {
      wsl,
      exec,
      systemRoot: 'C:\\Windows',
      machine: () => machine.machine,
      release: () => machine.release,
      readWslConfig: async () => machine.wslconfig,
      // Only the driver puts `nvidia-smi.exe` into System32.
      pathExists: async (path) => !/nvidia-smi\.exe$/i.test(path) || machine.nvidia !== null,
    },
    localAppData: LOCAL_APP_DATA,
    freeDiskBytes: async () => machine.volume_free_bytes,
    fileSize: async () => machine.vhdx_bytes,
  }

  return {
    machine,
    host,
    wsl,
    wslCalls,
    execCalls,
    holds: () => live.size,
    stopVm: () => {
      for (const finish of [...live]) finish({ code: 1, signal: null, released: false })
    },
  }
}
