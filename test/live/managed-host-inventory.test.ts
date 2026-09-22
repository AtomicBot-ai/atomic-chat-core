/**
 * What a real machine can do for the managed runtime, read without changing anything on it.
 *
 * This is the first step on a test host (card T03a): before anything is installed, find out what is
 * there. It runs the product's own probes — `probeLinux` / `probeWindows` — through the product's
 * own command runner, attaches setup's verdict, redacts everything personal, and writes the report
 * where it can be read and pasted into the hardware evidence.
 *
 * It changes nothing. Every command it runs is recorded and checked against a list of read-only
 * ones; one that is not on the list fails the test, rather than having quietly run.
 *
 * Opt in with both:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_MANAGED_INVENTORY=1
 * Optional:
 *   ATOMIC_LIVE_INVENTORY_OUT=/path/report.json   (default: a file in the system temp folder)
 *   ATOMIC_LIVE_OWNED_DISTRO=atomic-app-7f3c       (Windows: the distribution this install owns, if any)
 *
 * Runs on Linux and Windows. On any other platform there is no managed runtime to ask about.
 */
import { readFile, statfs, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectInventory,
  hostExec,
  redactInventory,
  type HostInventory,
} from '../../src/runtime/environment/index.js'
import type { CommandOutput } from '../../src/runtime/environment/index.js'

const PLATFORM = process.platform
const ENABLED =
  process.env['ATOMIC_LIVE'] === '1' &&
  process.env['ATOMIC_LIVE_MANAGED_INVENTORY'] === '1' &&
  (PLATFORM === 'linux' || PLATFORM === 'win32')
const OUT = process.env['ATOMIC_LIVE_INVENTORY_OUT'] ?? join(tmpdir(), 'atomic-managed-inventory.json')

/**
 * The only commands this harness may run, each with the arguments that keep it read-only. A probe
 * that grows a new command has to be added here on purpose, which is the point.
 */
const READ_ONLY: { command: RegExp; args: (args: string[]) => boolean }[] = [
  {
    command: /^nvidia-smi$/,
    args: (a) => a.every((x) => x.startsWith('--query-gpu') || x.startsWith('--format')),
  },
  { command: /^docker$/, args: (a) => a[0] === '--version' || a[0] === 'info' },
  { command: /^id$/, args: (a) => a.length === 1 && a[0] === '-nG' },
  { command: /^getent$/, args: (a) => a[0] === 'group' && a[1] === 'docker' },
  { command: /^nvidia-ctk$/, args: (a) => a.length === 1 && a[0] === '--version' },
  { command: /^wsl\.exe$/, args: (a) => a[0] === '--status' || (a[0] === '--list' && a[1] === '--verbose') },
  {
    command: /^powershell\.exe$/,
    args: (a) =>
      a.some((x) => /^Get-(WindowsOptionalFeature|ComputerInfo)\b/.test(x)) &&
      !a.some((x) => /\b(Enable|Disable|Set|Remove|Install)-/.test(x)),
  },
  { command: /^whoami$/, args: (a) => a[0] === '/user' },
]

const isReadOnly = (command: string, args: string[]): boolean =>
  READ_ONLY.some((entry) => entry.command.test(command) && entry.args(args))

describe.skipIf(!ENABLED)('managed runtime: what this machine can do', () => {
  it('reads the machine, changes nothing, and writes a redacted report', { timeout: 120_000 }, async () => {
    const ran: { command: string; args: string[] }[] = []
    const real = hostExec({ timeoutMs: 30_000 })
    const exec = async (command: string, args: string[]): Promise<CommandOutput> => {
      ran.push({ command, args })
      // Refuse before running, so a probe that grew a mutating call never gets to make it.
      if (!isReadOnly(command, args)) throw new Error(`not a read-only probe: ${command} ${args.join(' ')}`)
      return real(command, args)
    }
    const freeDiskBytes = async (): Promise<number | null> => {
      const info = await statfs(homedir())
      return Number(info.bavail) * Number(info.bsize)
    }

    const me = userInfo().username
    const sid =
      PLATFORM === 'win32'
        ? (/S-1-[0-9-]+/.exec((await exec('whoami', ['/user', '/fo', 'csv', '/nh'])).stdout)?.[0] ?? '')
        : ''

    const inventory: HostInventory =
      PLATFORM === 'linux'
        ? await collectInventory({
            platform: 'linux',
            user: me,
            now: () => new Date(),
            options: {
              supportedDistributions: [{ id: 'ubuntu', versions: ['24.04'] }],
              requiredDiskBytes: null,
            },
            deps: {
              exec,
              readFile: async (path) => readFile(path, 'utf8').catch(() => null),
              freeDiskBytes,
            },
          })
        : await collectInventory({
            platform: 'win32',
            now: () => new Date(),
            options: { requiredDiskBytes: null },
            deps: {
              exec,
              originalUser: { name: me, sid },
              ownedDistribution: process.env['ATOMIC_LIVE_OWNED_DISTRO'] ?? null,
              freeDiskBytes,
            },
          })

    const report = redactInventory(inventory, { user: me, home: homedir(), hostname: hostname(), sid })
    await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    // Where to find it, since that is the whole purpose of running this.
    console.log(`managed host inventory written to ${OUT}`)
    console.log(
      `availability: ${report.assessment.availability}; missing: ${report.assessment.missing.join(', ') || 'nothing'}`
    )

    // Every command was a read-only one: nothing on this machine was installed, started or enabled.
    expect(ran.length).toBeGreaterThan(0)
    expect(ran.every(({ command, args }) => isReadOnly(command, args))).toBe(true)
    expect(report.platform).toBe(PLATFORM)

    // Nothing personal left the machine. Compared in the form it takes inside JSON, because a
    // Windows home directory is written there with its backslashes doubled and would otherwise
    // never match, redacted or not.
    const text = JSON.stringify(report).toLowerCase()
    for (const secret of [me, homedir(), hostname(), sid].filter((s) => s.length > 2)) {
      expect(text).not.toContain(JSON.stringify(secret).slice(1, -1).toLowerCase())
    }
  })
})

describe.skipIf(ENABLED)('managed runtime: host inventory without opting in', () => {
  it('does not touch the machine unless asked to', () => {
    // The default run of the suite must never probe a host; this is the proof it did not.
    expect(ENABLED).toBe(false)
  })
})
