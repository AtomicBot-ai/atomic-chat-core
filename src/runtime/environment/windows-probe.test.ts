import { describe, expect, it } from 'vitest'
import { fakeWindows, type FakeWindowsMachine } from '../../../test/helpers/fake-windows-host.js'
import type { CommandOutput } from './linux-probe.js'
import {
  decodeWslOutput,
  normalizeWindowsArchitecture,
  parseElevation,
  parseVirtualization,
  parseWindowsBuild,
  parseWslConfig,
  parseWslDistributions,
  parseWslVersion,
  probeWindowsHost,
} from './windows-probe.js'

const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' })
const failed = (code: number | null): CommandOutput => ({ code, stdout: '', stderr: '' })

/** What `wsl.exe` hands back when its UTF-16 output was read as UTF-8. */
const asUtf16 = (text: string): string => String.fromCharCode(0xfeff) + [...text].join(String.fromCharCode(0))

const LIST = [
  '  NAME                   STATE           VERSION',
  '* Ubuntu                 Running         2',
  '  AtomicChat             Stopped         2',
  '  Legacy                 Stopped         1',
].join('\r\n')

describe('reading what wsl.exe says', () => {
  it('reads the UTF-16 output a caller decoded as UTF-8, instead of finding nothing', () => {
    expect(decodeWslOutput(asUtf16('Default Version: 2'))).toBe('Default Version: 2')
    expect(parseWslDistributions(ok(asUtf16(LIST)))).toHaveLength(3)
  })

  it('lists every distribution with its state, version and which one is default', () => {
    expect(parseWslDistributions(ok(LIST))).toEqual([
      { name: 'Ubuntu', state: 'Running', version: 2, is_default: true },
      { name: 'AtomicChat', state: 'Stopped', version: 2, is_default: false },
      { name: 'Legacy', state: 'Stopped', version: 1, is_default: false },
    ])
  })

  it('reads a localized header the same way: a row is recognised by its shape', () => {
    const russian = ['  ИМЯ          СОСТОЯНИЕ     ВЕРСИЯ', '* Ubuntu       Работает      2'].join('\r\n')
    expect(parseWslDistributions(ok(russian))).toEqual([
      { name: 'Ubuntu', state: 'Работает', version: 2, is_default: true },
    ])
  })

  it('reads no distributions at all — a nonzero exit — as an empty list', () => {
    expect(parseWslDistributions(failed(255))).toEqual([])
    expect(parseWslDistributions(null)).toEqual([])
  })

  it.each([
    ['WSL version: 2.4.4.0\r\nKernel version: 6.6.87.2-1\r\n', '2.4.4'],
    ['Версия WSL: 2.6.1.0\r\nВерсия ядра: 6.6.87.2-1\r\n', '2.6.1'],
    ['\r\nWSL version: 2.5.10\r\n', '2.5.10'],
    ['Copyright (c) Microsoft Corporation\r\n', null],
  ])('takes the package version out of `wsl --version` (%j)', (stdout, version) => {
    expect(parseWslVersion(ok(stdout))).toBe(version)
  })

  it('has no version when `--version` failed: the inbox stub of a machine without the package', () => {
    expect(parseWslVersion(failed(1))).toBeNull()
  })
})

describe('reading Windows', () => {
  it.each([
    [{ HypervisorPresent: true, VirtualizationFirmwareEnabled: false }, true],
    [{ HypervisorPresent: false, VirtualizationFirmwareEnabled: true }, true],
    [{ HypervisorPresent: false, VirtualizationFirmwareEnabled: false }, false],
    [{ HypervisorPresent: false, VirtualizationFirmwareEnabled: null }, null],
  ])('reads virtualization from %j — a running hypervisor proves it', (answer, enabled) => {
    expect(parseVirtualization(ok(JSON.stringify(answer)))).toBe(enabled)
  })

  it('says nothing about virtualization when PowerShell did not answer', () => {
    expect(parseVirtualization(failed(1))).toBeNull()
    expect(parseVirtualization(ok('not json'))).toBeNull()
  })

  it.each([
    ['"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""', true],
    ['"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""', false],
    ['"Everyone","Well-known group","S-1-1-0",""', null],
  ])('reads the integrity level from whoami (%s)', (line, elevated) => {
    expect(parseElevation(ok(`${line}\r\n`))).toBe(elevated)
  })

  it.each([
    ['10.0.22631', 22631],
    ['10.0.26100', 26100],
    ['10.0', null],
  ])('takes the build out of os.release() %s', (release, build) => {
    expect(parseWindowsBuild(release)).toBe(build)
  })

  it.each([
    ['x86_64', 'x86_64'],
    ['AMD64', 'x86_64'],
    ['arm64', 'aarch64'],
    ['ARM64', 'aarch64'],
  ])('spells the architecture %s as Linux does', (machine, architecture) => {
    expect(normalizeWindowsArchitecture(machine)).toBe(architecture)
  })

  it('reads the network and memory settings of [wsl2] in .wslconfig, and nothing else', () => {
    const text = [
      '# user settings',
      '[wsl2]',
      'networkingMode=Mirrored',
      'localhostForwarding = false ; turned off for a VPN',
      'memory=8GB',
      '[experimental]',
      'memory=1GB',
    ].join('\r\n')
    expect(parseWslConfig(text)).toEqual({
      networking_mode: 'mirrored',
      localhost_forwarding: false,
      memory: '8GB',
    })
    expect(parseWslConfig(null)).toEqual({ networking_mode: null, localhost_forwarding: null, memory: null })
  })
})

const machine = (over: Partial<FakeWindowsMachine> = {}): FakeWindowsMachine => ({
  wsl: {
    installed: true,
    wsl_version: '2.4.4.0',
    ready: true,
    distributions: [{ name: 'Ubuntu', state: 'Stopped', version: 2, is_default: true }],
    guests: {},
  },
  machine: 'x86_64',
  release: '10.0.22631',
  elevated: false,
  virtualization: { firmware: true, hypervisor: false },
  nvidia: {
    driver: '591.44',
    gpus: [{ uuid: 'GPU-1', name: 'NVIDIA GeForce RTX 4070', cc: '8.9', total_mib: 12282, free_mib: 11000 }],
  },
  wslconfig: '[wsl2]\nmemory=12GB\n',
  volume_free_bytes: 1,
  vhdx_bytes: null,
  ...over,
})

describe('probeWindowsHost', () => {
  it('reads a machine with WSL: version, status, distributions, driver, cards, settings — without entering any distribution', async () => {
    const windows = fakeWindows(machine())
    const facts = await probeWindowsHost(windows.host.probeDeps)

    expect(facts).toMatchObject({
      architecture: 'x86_64',
      windows_build: 22631,
      elevated: false,
      wsl: { installed: true, version: '2.4.4', ready: true },
      // A WSL that starts VMs proves virtualization; the firmware is not even asked.
      virtualization: true,
      driver_installed: true,
      driver_version: '591.44',
      distributions: [{ name: 'Ubuntu', state: 'Stopped', version: 2, is_default: true }],
      wslconfig: { memory: '12GB' },
      unknown: [],
    })
    expect(facts.gpus.map((gpu) => gpu.gpu_id)).toEqual(['GPU-1'])
    expect(windows.wslCalls).toEqual([['--version'], ['--status'], ['--list', '--verbose']])
    expect(windows.execCalls.some((call) => call[0]?.endsWith('powershell.exe'))).toBe(false)
  })

  it('without the WSL package: no status, no list, and the firmware is asked instead', async () => {
    const windows = fakeWindows(machine({ wsl: { installed: false } }))
    const facts = await probeWindowsHost(windows.host.probeDeps)

    expect(facts.wsl).toEqual({ installed: false, version: null, ready: null, reboot_pending: null })
    expect(facts.virtualization).toBe(true)
    expect(windows.wslCalls).toEqual([['--version']])
    expect(windows.execCalls.some((call) => call[0]?.endsWith('powershell.exe'))).toBe(true)
  })

  it('a package whose components are off answers --version but not --status', async () => {
    const windows = fakeWindows(machine({ wsl: { installed: true, wsl_version: '2.4.4.0', ready: false } }))
    const facts = await probeWindowsHost(windows.host.probeDeps)
    expect(facts.wsl).toEqual({ installed: true, version: '2.4.4', ready: false, reboot_pending: null })
  })

  it('no nvidia-smi.exe in System32 is no driver, not an unread fact', async () => {
    const facts = await probeWindowsHost(fakeWindows(machine({ nvidia: null })).host.probeDeps)
    expect(facts.driver_installed).toBe(false)
    expect(facts.driver_version).toBeNull()
    expect(facts.unknown).not.toContain('nvidia-driver')
  })

  it('records each answer it could not read rather than assuming one', async () => {
    const windows = fakeWindows(machine({ wsl: { installed: false }, virtualization: 'unreadable' }))
    windows.host.probeDeps.readWslConfig = async () => {
      throw new Error('EACCES')
    }
    windows.host.probeDeps.release = () => 'unknown'
    const facts = await probeWindowsHost(windows.host.probeDeps)
    expect(facts.virtualization).toBeNull()
    expect(facts.unknown).toEqual(expect.arrayContaining(['wslconfig', 'windows-build']))
  })
})

describe('the edges of reading Windows', () => {
  it.each([
    ['riscv64', 'riscv64'],
    ['x64', 'x86_64'],
  ])('passes an unknown architecture %s through as itself', (machine, architecture) => {
    expect(normalizeWindowsArchitecture(machine)).toBe(architecture)
  })

  it('reads the system integrity level as elevated, and an unanswered whoami as unknown', () => {
    expect(
      parseElevation(ok('"Mandatory Label\\System Mandatory Level","Label","S-1-16-16384",""\r\n'))
    ).toBe(true)
    expect(parseElevation(failed(1))).toBeNull()
  })

  it('reads yes/no values of .wslconfig, and ignores a value it cannot read and a line that is not a setting', () => {
    expect(parseWslConfig('[wsl2]\nlocalhostForwarding=TRUE\n').localhost_forwarding).toBe(true)
    expect(
      parseWslConfig('[wsl2]\nlocalhostForwarding=maybe\nnot a setting\n').localhost_forwarding
    ).toBeNull()
  })

  it('records a WSL whose version or status it could not read, and a driver it could not ask', async () => {
    const windows = fakeWindows(machine())
    const wsl = windows.host.probeDeps.wsl
    windows.host.probeDeps.wsl = {
      ...wsl,
      command: async (args, call) =>
        args[0] === '--version'
          ? { code: 0, stdout: 'Copyright\r\n', stderr: '' }
          : args[0] === '--status'
            ? { code: null, stdout: '', stderr: 'timed out' }
            : wsl.command(args, call),
    }
    windows.host.probeDeps.pathExists = async () => {
      throw new Error('EACCES')
    }
    const facts = await probeWindowsHost(windows.host.probeDeps)
    expect(facts.unknown).toEqual(expect.arrayContaining(['wsl-version', 'wsl-status', 'nvidia-driver']))
  })

  it('without wsl.exe answering at all, WSL is an unread fact', async () => {
    const windows = fakeWindows(machine())
    windows.host.probeDeps.wsl = {
      ...windows.host.probeDeps.wsl,
      command: async () => ({ code: null, stdout: '', stderr: '' }),
    }
    const facts = await probeWindowsHost(windows.host.probeDeps)
    expect(facts.wsl.installed).toBeNull()
    expect(facts.unknown).toContain('wsl')
  })
})
