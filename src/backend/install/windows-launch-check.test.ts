import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AtomicCoreError, parseLoadDiag } from '../../contracts/index.js'
import {
  WINDOWS_LAUNCH_CHECK_TIMEOUT_MS,
  runLaunch,
  verifyWindowsBackendBinary,
  windowsExitCodeHex,
  windowsLaunchVerdict,
} from './windows-launch-check.js'
import type { LaunchExec, LaunchOutcome } from './windows-launch-check.js'

const PACK = { version: 'b12019', backend: 'win-cuda-13.3-x64' }
const exited = (code: number, stderr = '', stdout = ''): LaunchOutcome => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
})
/** What `execFile` rejects with when the process ran and exited non-zero. */
const exitError = (code: number, stderr = '') =>
  Object.assign(new Error(`Command failed: llama-server.exe --version\n${stderr}`), {
    code,
    signal: null,
    killed: false,
    stdout: '',
    stderr,
  })
const spawnError = (code: string) =>
  Object.assign(new Error(`spawn C:\\packs\\llama-server.exe ${code}`), {
    code,
    errno: -4058,
    syscall: 'spawn',
  })

describe('windowsExitCodeHex', () => {
  it.each([
    [0xc000_0135, '0xC0000135'],
    [-1_073_741_515, '0xC0000135'],
    [3_221_225_501, '0xC000001D'],
    [1, '0x1'],
  ])('%s → %s', (code, hex) => expect(windowsExitCodeHex(code)).toBe(hex))
})

describe('windowsLaunchVerdict', () => {
  it('passes a clean exit and a run that timed out', () => {
    expect(windowsLaunchVerdict(exited(0, 'version: 12019 (abc)'), PACK)).toBeUndefined()
    expect(
      windowsLaunchVerdict({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }, PACK)
    ).toBeUndefined()
  })

  it.each([
    [0xc000_0135, 'STATUS_DLL_NOT_FOUND', /a library it needs is missing or was blocked/],
    [0xc000_007b, 'STATUS_INVALID_IMAGE_FORMAT', /a library it needs is missing or was blocked/],
    [0xc000_0142, 'STATUS_DLL_INIT_FAILED', /a library it needs is missing or was blocked/],
  ])('reads loader code %s as ENGINE_BINARY_BROKEN (%s), diag line last', (code, name, message) => {
    const error = windowsLaunchVerdict(exited(code), PACK)
    expect(error).toBeInstanceOf(AtomicCoreError)
    expect(error?.code).toBe('ENGINE_BINARY_BROKEN')
    expect(error?.message).toMatch(message)
    expect(error?.message).toContain('b12019/win-cuda-13.3-x64')
    expect(error?.details?.split('\n')[0]).toBe(
      `llama-server.exe --version: exit code ${windowsExitCodeHex(code)} (${name})`
    )
    expect(error?.details?.split('\n').at(-1)).toMatch(/^atomic-core-diag /)
    expect(parseLoadDiag(error?.details)).toEqual({
      exit_code: windowsExitCodeHex(code),
      stage: 'spawn',
      backend: 'win-cuda-13.3-x64',
      build: 'b12019',
      empty_stderr: true,
    })
    expect(error?.diagnostic).toEqual({
      component: 'backend',
      operation: 'install',
      stage: 'spawn',
      exitCode: code,
      engineVersion: 'b12019',
    })
  })

  it('reads an illegal instruction as CPU_INSTRUCTION_UNSUPPORTED, signed or not', () => {
    for (const code of [0xc000_001d, -1_073_741_795]) {
      const error = windowsLaunchVerdict(exited(code), PACK)
      expect(error?.code).toBe('CPU_INSTRUCTION_UNSUPPORTED')
      expect(error?.message).toMatch(/CPU instruction this processor does not have/)
      expect(parseLoadDiag(error?.details)?.exit_code).toBe('0xC000001D')
      expect(error?.diagnostic?.exitCode).toBe(0xc000_001d)
    }
  })

  it('fails any other non-zero exit, keeping the tail of what the server printed', () => {
    const error = windowsLaunchVerdict(exited(1, 'error: unknown argument', 'x'.repeat(900)), PACK)
    expect(error?.code).toBe('ENGINE_BINARY_BROKEN')
    expect(error?.message).toMatch(/failed its launch check/)
    const lines = error?.details?.split('\n') ?? []
    expect(lines[0]).toBe('llama-server.exe --version: exit code 0x1')
    expect(lines[1]?.startsWith('…')).toBe(true)
    expect(lines[1]?.length).toBe(801)
    expect(parseLoadDiag(error?.details)).toEqual({
      exit_code: '0x1',
      stage: 'spawn',
      backend: 'win-cuda-13.3-x64',
      build: 'b12019',
    })
    const short = windowsLaunchVerdict(exited(2, 'error: unknown argument'), PACK)
    expect(short?.details?.split('\n')[1]).toBe('error: unknown argument')
  })

  it('fails a file Windows would not start, and a run ended by a signal', () => {
    const refused = windowsLaunchVerdict(
      { ...exited(0), code: null, spawnError: { code: 'ENOENT', message: 'spawn llama-server.exe ENOENT' } },
      PACK
    )
    expect(refused?.code).toBe('ENGINE_BINARY_BROKEN')
    expect(refused?.message).toMatch(/Windows would not start .*\(ENOENT\)/)
    expect(refused?.details?.split('\n')[0]).toBe(
      'llama-server.exe could not be started: spawn llama-server.exe ENOENT'
    )
    expect(parseLoadDiag(refused?.details)).toEqual({
      stage: 'spawn',
      backend: 'win-cuda-13.3-x64',
      build: 'b12019',
      empty_stderr: true,
    })
    expect(refused?.diagnostic?.exitCode).toBeNull()
    const killed = windowsLaunchVerdict({ ...exited(0), code: null, signal: 'SIGKILL' }, PACK)
    expect(killed?.details?.split('\n')[0]).toBe('llama-server.exe --version: ended on SIGKILL')
    expect(parseLoadDiag(killed?.details)?.signal).toBe('SIGKILL')
  })
})

describe('runLaunch', () => {
  const options = { env: {}, cwd: 'C:\\pack', timeout: 10, windowsHide: true as const }
  it.each<[string, () => Promise<{ stdout: string; stderr: string }>, Partial<LaunchOutcome>]>([
    ['a clean run', async () => ({ stdout: 'version: 1', stderr: '' }), { code: 0, stdout: 'version: 1' }],
    [
      'a non-zero exit',
      async () => Promise.reject(exitError(0xc000_0135, 'x')),
      { code: 0xc000_0135, stderr: 'x' },
    ],
    [
      'a deadline',
      async () =>
        Promise.reject(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null })),
      { timedOut: true, signal: 'SIGTERM' },
    ],
    [
      'a deadline without a signal name',
      async () => Promise.reject(Object.assign(new Error('killed'), { killed: true })),
      { timedOut: true, signal: 'SIGTERM' },
    ],
    [
      'a signal',
      async () =>
        Promise.reject(Object.assign(new Error('sig'), { killed: false, signal: 'SIGSEGV', code: null })),
      { signal: 'SIGSEGV', timedOut: false },
    ],
    [
      'a spawn error',
      async () => Promise.reject(spawnError('EACCES')),
      { spawnError: { code: 'EACCES', message: 'spawn C:\\packs\\llama-server.exe EACCES' } },
    ],
    [
      'a thrown string',
      async () => Promise.reject('odd'),
      { spawnError: { code: 'UNKNOWN', message: 'odd' } },
    ],
  ])('reads %s', async (_label, behaviour, expected) => {
    const exec: LaunchExec = () => behaviour()
    expect(await runLaunch(exec, 'C:\\pack\\llama-server.exe', options)).toMatchObject(expected)
  })
})

describe('verifyWindowsBackendBinary', () => {
  const staging = join('C:', 'data', 'backends', 'b12019', 'win-cuda-13.3-x64.incoming-1')
  const bin = join(staging, 'build', 'bin')

  it('runs the staged llama-server.exe --version with the load PATH, hidden, in its own folder', async () => {
    const calls: Array<{ file: string; args: string[]; options: Parameters<LaunchExec>[2] }> = []
    await verifyWindowsBackendBinary(staging, 'b12019', 'win-cuda-13.3-x64', {
      env: { Path: 'C:\\Windows\\System32', CUDA_PATH: 'Z:\\missing' },
      exec: async (file, args, options) => {
        calls.push({ file, args, options })
        return { stdout: 'version: 12019 (abc)', stderr: '' }
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.file).toBe(join(bin, 'llama-server.exe'))
    expect(calls[0]?.args).toEqual(['--version'])
    expect(calls[0]?.options).toMatchObject({
      cwd: bin,
      timeout: WINDOWS_LAUNCH_CHECK_TIMEOUT_MS,
      windowsHide: true,
    })
    // `buildProcessEnv`'s Windows rule: the pack's own folder first, `Path` folded into `PATH`.
    expect(calls[0]?.options.env['PATH']?.startsWith(`${bin};`)).toBe(true)
    expect(calls[0]?.options.env['PATH']?.endsWith(';C:\\Windows\\System32')).toBe(true)
    expect(calls[0]?.options.env['Path']).toBeUndefined()
  })

  it('throws the verdict with the pack named, so the install fails and is retried clean', async () => {
    await expect(
      verifyWindowsBackendBinary(staging, 'b12019', 'win-cuda-13.3-x64', {
        env: {},
        exec: async () => Promise.reject(exitError(0xc000_0135)),
      })
    ).rejects.toMatchObject({
      code: 'ENGINE_BINARY_BROKEN',
      details: expect.stringContaining('"exit_code":"0xC0000135"'),
    })
  })

  it('retries a spawn a scanner refused, then gives up; never retries a missing file', async () => {
    const slept: number[] = []
    let runs = 0
    await expect(
      verifyWindowsBackendBinary(staging, 'b1', 'win-cpu-x64', {
        env: {},
        sleep: async (ms) => void slept.push(ms),
        exec: async () => {
          runs += 1
          if (runs < 3) throw spawnError('EBUSY')
          return { stdout: '', stderr: 'version: 1' }
        },
      })
    ).resolves.toBeUndefined()
    expect(runs).toBe(3)
    expect(slept).toEqual([1_000, 1_000])

    runs = 0
    await expect(
      verifyWindowsBackendBinary(staging, 'b1', 'win-cpu-x64', {
        env: {},
        spawnAttempts: 2,
        spawnRetryMs: 0,
        exec: async () => {
          runs += 1
          throw spawnError('EPERM')
        },
      })
    ).rejects.toMatchObject({ code: 'ENGINE_BINARY_BROKEN' })
    expect(runs).toBe(2)

    runs = 0
    await expect(
      verifyWindowsBackendBinary(staging, 'b1', 'win-cpu-x64', {
        env: {},
        exec: async () => {
          runs += 1
          throw spawnError('ENOENT')
        },
      })
    ).rejects.toMatchObject({ code: 'ENGINE_BINARY_BROKEN', message: expect.stringContaining('(ENOENT)') })
    expect(runs).toBe(1)
  })

  it('keeps a pack whose check ran out of time, and says so', async () => {
    const logs: string[] = []
    await expect(
      verifyWindowsBackendBinary(staging, 'b1', 'win-vulkan-x64', {
        env: {},
        timeoutMs: 5,
        log: (message) => logs.push(message),
        exec: async () =>
          Promise.reject(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })),
      })
    ).resolves.toBeUndefined()
    expect(logs).toEqual([
      'b1/win-vulkan-x64: llama-server.exe --version did not answer in 5 ms; installing it unverified',
    ])
    // Without a log sink the run is still accepted.
    await expect(
      verifyWindowsBackendBinary(staging, 'b1', 'win-vulkan-x64', {
        exec: async () => Promise.reject(Object.assign(new Error('killed'), { killed: true })),
      })
    ).resolves.toBeUndefined()
  })

  it('runs the real execFile by default and reads its failure', async () => {
    // Nothing is staged at this path, so the spawn fails the way a quarantined llama-server.exe would.
    await expect(
      verifyWindowsBackendBinary(join(staging, 'nowhere'), 'b1', 'win-cpu-x64', { env: {} })
    ).rejects.toMatchObject({
      code: 'ENGINE_BINARY_BROKEN',
    })
  })
})
