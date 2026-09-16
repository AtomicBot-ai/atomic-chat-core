import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  identityPermitsTakeover,
  isProcessAlive,
  processStartId,
  processStartEpoch,
  runProbe,
  verifyProcessIdentity,
} from './process-identity.js'

const LINUX_STAT = `4242 (llama server (x86)) S 1 4242 4242 0 -1 4194304 100 0 0 0 5 6 0 0 20 0 1 0 987654321 12345 0 0 0`

describe('processStartId', () => {
  it('reads the start ticks from procfs even when the command name contains spaces and parens', async () => {
    const id = await processStartId(4242, { platform: 'linux', readText: async () => LINUX_STAT })
    expect(id).toBe('linux:987654321')
  })

  it('normalises the macOS ps output and rejects junk from either platform', async () => {
    expect(
      await processStartId(1, { platform: 'darwin', run: async () => ' Mon Sep  15 10:00:00 2026 \n' })
    ).toBe('darwin:Mon Sep 15 10:00:00 2026')
    expect(await processStartId(1, { platform: 'darwin', run: async () => '  \n' })).toBeUndefined()
    expect(await processStartId(1, { platform: 'win32', run: async () => '638000000000000000\n' })).toBe(
      'win32:638000000000000000'
    )
    expect(
      await processStartId(1, { platform: 'win32', run: async () => 'Get-Process: no such process' })
    ).toBeUndefined()
    expect(await processStartId(1, { platform: 'linux', readText: async () => 'nonsense' })).toBeUndefined()
  })

  it('returns undefined for an impossible pid, a failing probe and an unsupported platform', async () => {
    expect(await processStartId(0, { platform: 'linux' })).toBeUndefined()
    expect(await processStartId(-1, { platform: 'darwin' })).toBeUndefined()
    expect(
      await processStartId(1, {
        platform: 'darwin',
        run: async () => {
          throw new Error('ps: refused')
        },
      })
    ).toBeUndefined()
    expect(await processStartId(1, { platform: 'aix' as NodeJS.Platform })).toBeUndefined()
  })

  it('identifies a real child process on this machine and tells two incarnations apart', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })
    await new Promise((r) => setTimeout(r, 150))
    const id = await processStartId(child.pid as number)
    expect(id, 'probe must work on the platform the tests run on').toBeTruthy()
    expect(await processStartId(child.pid as number)).toBe(id)
    expect(await verifyProcessIdentity(child.pid as number, id)).toBe('match')
    expect(await verifyProcessIdentity(child.pid as number, 'linux:1')).toBe('mismatch')
    child.kill('SIGKILL')
    await new Promise((r) => child.on('exit', r))
    expect(isProcessAlive(child.pid as number)).toBe(false)
    expect(await verifyProcessIdentity(child.pid as number, id)).toBe('dead')
  })
})

describe('processStartEpoch', () => {
  it('normalises Linux, macOS and Windows identities for Rust interoperability', async () => {
    expect(
      await processStartEpoch(4242, {
        platform: 'linux',
        readText: async (path) => (path === '/proc/stat' ? 'cpu  1\nbtime 1000\n' : LINUX_STAT),
      })
    ).toBe('epoch:9877543')
    expect(
      await processStartEpoch(1, {
        platform: 'darwin',
        run: async () => 'Mon Sep 15 10:00:00 2026',
      })
    ).toMatch(/^epoch:\d+$/)
    expect(await processStartEpoch(1, { platform: 'win32', run: async () => '1700000000\n' })).toBe(
      'epoch:1700000000'
    )
  })

  it('returns undefined for bad input, failed probes and unsupported systems', async () => {
    expect(await processStartEpoch(0)).toBeUndefined()
    expect(
      await processStartEpoch(1, {
        platform: 'linux',
        readText: async () => {
          throw new Error('gone')
        },
      })
    ).toBeUndefined()
    expect(await processStartEpoch(1, { platform: 'aix' as NodeJS.Platform })).toBeUndefined()
    expect(await processStartEpoch(1, { platform: 'darwin', run: async () => 'not a date' })).toBeUndefined()
    expect(
      await processStartEpoch(1, { platform: 'win32', run: async () => 'not an integer' })
    ).toBeUndefined()
    expect(
      await processStartEpoch(1, {
        platform: 'linux',
        readText: async (path) => (path === '/proc/stat' ? 'no btime' : 'bad stat'),
      })
    ).toBeUndefined()
  })
})

describe('runProbe', () => {
  it('captures stdout and rejects failed commands', async () => {
    await expect(runProbe(process.execPath, ['-e', 'process.stdout.write("ok")'])).resolves.toBe('ok')
    await expect(runProbe(process.execPath, ['-e', 'process.exit(2)'])).rejects.toBeTruthy()
  })
})

describe('verifyProcessIdentity', () => {
  const alive = () => true
  it('never claims mismatch when the identity cannot be proven', async () => {
    expect(await verifyProcessIdentity(1, null, { alive })).toBe('unknown')
    expect(await verifyProcessIdentity(1, '', { alive })).toBe('unknown')
    expect(
      await verifyProcessIdentity(1, 'darwin:x', { alive, platform: 'darwin', run: async () => '' })
    ).toBe('unknown')
  })

  it('permits takeover only for a dead or replaced process', () => {
    expect(identityPermitsTakeover('dead')).toBe(true)
    expect(identityPermitsTakeover('mismatch')).toBe(true)
    expect(identityPermitsTakeover('match')).toBe(false)
    expect(identityPermitsTakeover('unknown')).toBe(false)
  })
})

describe('isProcessAlive', () => {
  it('sees this process, rejects pid 0 and negatives, and reports a freed pid as dead', async () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-5)).toBe(false)
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true })
    await new Promise((r) => child.on('exit', r))
    expect(isProcessAlive(child.pid as number)).toBe(false)
  })
})
