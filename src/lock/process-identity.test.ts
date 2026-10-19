import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  identityPermitsTakeover,
  isProcessAlive,
  processName,
  processStartEpoch,
  processStartId,
  runProbe,
  verifyProcessIdentity,
  verifyStartEpoch,
} from './process-identity.js'
import type { IdentityDeps } from './process-identity.js'

const LINUX_STAT = `4242 (llama server (x86)) S 1 4242 4242 0 -1 4194304 100 0 0 0 5 6 0 0 20 0 1 0 987654321 12345 0 0 0`

describe('processStartId', () => {
  it('reads the start ticks from procfs even when the command name contains spaces and parens', async () => {
    const id = await processStartId(4242, { platform: 'linux', readText: async () => LINUX_STAT })
    expect(id).toBe('linux:987654321')
  })

  it('normalises the macOS ps output and rejects junk from either platform', async () => {
    expect(
      await processStartId(1, { platform: 'darwin', run: async () => ' Mon Sep  15 10:00:00 2026 \n' })
    ).toBe('darwin-utc:Mon Sep 15 10:00:00 2026')
    expect(await processStartId(1, { platform: 'darwin', run: async () => '  \n' })).toBeUndefined()
    expect(await processStartId(1, { platform: 'win32', run: async () => '638000000000000000\n' })).toBe(
      'win32-utc:638000000000000000'
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

// The identity is compared by whoever reads the file later: another core started from a terminal
// with another locale or time zone, or the same machine after it moved zones. What `ps` prints depends
// on both, so the probe pins them; an identity must not depend on the reader.
describe('an identity independent of who reads it', () => {
  const env =
    (seen: Array<Record<string, string> | undefined>) =>
    async (_file: string, args: string[], extra?: Record<string, string>) => {
      seen.push(extra)
      return args.some((a) => a.includes('ToUniversalTime'))
        ? '638000000000000000\n'
        : 'Mon Oct 19 10:33:52 2026\n'
    }

  it('asks ps in the C locale and UTC on macOS, and for UTC ticks on Windows', async () => {
    const seen: Array<Record<string, string> | undefined> = []
    expect(await processStartId(1, { platform: 'darwin', run: env(seen) })).toBe(
      'darwin-utc:Mon Oct 19 10:33:52 2026'
    )
    expect(seen[0]).toMatchObject({ LC_ALL: 'C', TZ: 'UTC' })
    expect(await processStartId(1, { platform: 'win32', run: env(seen) })).toBe(
      'win32-utc:638000000000000000'
    )
    expect(await processStartEpoch(1, { platform: 'darwin', run: env(seen) })).toBe(
      `epoch:${Date.UTC(2026, 9, 19, 10, 33, 52) / 1000}`
    )
    expect(seen[2]).toMatchObject({ LC_ALL: 'C', TZ: 'UTC' })
  })

  it('reads an identity an earlier core wrote in another locale as unproven, never as replaced', async () => {
    const alive = () => true
    // What this core's ps prints for the process, in the C locale and the local zone.
    const run = async () => 'Mon Oct 19 13:33:52 2026\n'
    const darwin = { alive, platform: 'darwin' as const, run }
    expect(await verifyProcessIdentity(1, 'darwin:Mon Oct 19 13:33:52 2026', darwin)).toBe('match')
    expect(await verifyProcessIdentity(1, 'darwin:понедельник, 19 октября 2026 г. 13:33:52', darwin)).toBe(
      'unknown'
    )
    expect(await verifyProcessIdentity(1, 'darwin:Mon 19 Oct 13:33:52 2026', darwin)).toBe('unknown')
    const win32 = { alive, platform: 'win32' as const, run: async () => '638000000000000001\n' }
    expect(await verifyProcessIdentity(1, 'win32:638000000000000000', win32)).toBe('unknown')
    expect(await verifyProcessIdentity(1, 'win32:638000000000000001', win32)).toBe('match')
    // A probe that fails, or a legacy identity from another platform: nothing is proven.
    const refused = async () => {
      throw new Error('ps: refused')
    }
    expect(
      await verifyProcessIdentity(1, 'darwin:Mon Oct 19 13:33:52 2026', { ...darwin, run: refused })
    ).toBe('unknown')
    expect(
      await verifyProcessIdentity(1, 'darwin:Mon Oct 19 13:33:52 2026', { alive, platform: 'linux' })
    ).toBe('unknown')
    expect(
      await verifyProcessIdentity(1, 'win32:1', {
        alive,
        platform: 'win32',
        run: async () => 'no such process',
      })
    ).toBe('unknown')
    expect(await verifyProcessIdentity(1, 'darwin-utc:x', { ...darwin, run: async () => '' })).toBe('unknown')
    // On this machine, with the real probe: a legacy identity in a locale nobody here uses.
    expect(await verifyProcessIdentity(process.pid, 'darwin:понедельник', { alive })).toBe('unknown')
  })

  it('still tells a replaced process apart by its new identity', async () => {
    const alive = () => true
    const run = async () => 'Mon Oct 19 11:00:00 2026\n'
    expect(
      await verifyProcessIdentity(1, 'darwin-utc:Mon Oct 19 10:33:52 2026', {
        alive,
        platform: 'darwin',
        run,
      })
    ).toBe('mismatch')
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

describe('processName', () => {
  it('reads the bare executable name on every platform, whatever the probe wraps it in', async () => {
    expect(await processName(7, { platform: 'linux', readText: async () => 'cloudflared\n' })).toBe(
      'cloudflared'
    )
    expect(
      await processName(7, {
        platform: 'darwin',
        run: async () => '/Applications/Atomic Chat.app/Contents/MacOS/cloudflared\n',
      })
    ).toBe('cloudflared')
    expect(await processName(7, { platform: 'win32', run: async () => 'cloudflared\r\n' })).toBe(
      'cloudflared'
    )
    expect(
      await processName(7, { platform: 'win32', run: async () => 'C:\\Tools\\Cloudflared.EXE\r\n' })
    ).toBe('Cloudflared')
  })

  it('answers nothing for an impossible pid, a failing or empty probe and an unsupported platform', async () => {
    expect(await processName(0)).toBeUndefined()
    expect(await processName(-1)).toBeUndefined()
    expect(
      await processName(7, {
        platform: 'linux',
        readText: async () => {
          throw new Error('ENOENT')
        },
      })
    ).toBeUndefined()
    expect(await processName(7, { platform: 'darwin', run: async () => '  \n' })).toBeUndefined()
    expect(await processName(7, { platform: 'freebsd' })).toBeUndefined()
  })

  it('names a real child process on this machine', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    try {
      await new Promise((resolve) => child.once('spawn', resolve))
      const name = await processName(child.pid as number)
      // `node` under vitest, `bun` under the Bun runner; never a path, never empty.
      expect(name).toMatch(/^[\w.-]+$/)
    } finally {
      child.kill('SIGKILL')
    }
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

describe('verifyStartEpoch', () => {
  const linux = (btime: number): IdentityDeps => ({
    platform: 'linux',
    alive: (): boolean => true,
    readText: async (path: string) => (path === '/proc/stat' ? `btime ${btime}\n` : LINUX_STAT),
  })
  it.each([
    ['the same start', 'epoch:9877543', linux(1000), 'match'],
    ['the same start read a second later', 'epoch:9877544', linux(1000), 'match'],
    ['another process behind the pid', 'epoch:1', linux(1000), 'mismatch'],
    ['nothing recorded', null, linux(1000), 'unknown'],
    ['a junk record', 'darwin:x', linux(1000), 'unknown'],
    [
      'a probe that cannot answer',
      'epoch:9877543',
      { platform: 'aix' as NodeJS.Platform, alive: () => true },
      'unknown',
    ],
    ['a dead process', 'epoch:9877543', { ...linux(1000), alive: (): boolean => false }, 'dead'],
  ])('%s → %s', async (_name, expected, deps, verdict) => {
    expect(await verifyStartEpoch(4242, expected, deps)).toBe(verdict)
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
