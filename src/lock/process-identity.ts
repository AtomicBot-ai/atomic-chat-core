/**
 * "Is the process that wrote this file still the process behind that PID?"
 *
 * A PID alone cannot answer it: the OS reuses PIDs, so a dead owner's PID can belong to something
 * else by the time a client looks (PLAN.md §3.4). Every owner therefore records a *start identity*
 * next to its PID, and a taker-over must see that identity gone or different before it may steal
 * the lock. When the identity cannot be established (no procfs, probe refused, unknown platform)
 * the answer is `unknown`, never `mismatch` — an unproven claim must not kill a live owner.
 *
 * No native addons: Linux reads procfs, macOS asks `ps`, Windows asks PowerShell.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export type IdentityVerdict = 'match' | 'mismatch' | 'dead' | 'unknown'

export interface IdentityDeps {
  platform?: NodeJS.Platform
  /** Read a procfs entry (Linux). */
  readText?: (path: string) => Promise<string>
  /** Run a probe and return its stdout; `env` is laid over this process's environment. */
  run?: (file: string, args: string[], env?: Record<string, string>) => Promise<string>
  /** Signal-0 liveness probe. */
  alive?: (pid: number) => boolean
}

/**
 * PowerShell on Windows takes several seconds to start cold, and on a loaded CI runner more than
 * five; a probe that is cut short answers `undefined`, which is safe for takeover but leaves a
 * child journalled without its identity. The budget is generous because a slow answer is worth
 * more than a fast "unknown".
 */
export const IDENTITY_PROBE_TIMEOUT_MS = 15_000

const readUtf8 = (path: string) => readFile(path, 'utf8')

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function runProbe(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: IDENTITY_PROBE_TIMEOUT_MS,
        windowsHide: true,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      }
    )
  })
}

/**
 * What `ps` prints depends on the locale and the time zone of whoever runs it; an identity compared
 * later by another process (a core started from another terminal, a laptop in another zone) must not.
 */
const PINNED_PS_ENV = { LC_ALL: 'C', TZ: 'UTC' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Mon Oct 19 10:33:52 2026` (C locale, UTC) → seconds since the epoch; `undefined` for anything else. */
function utcLstartSeconds(text: string): number | undefined {
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text)
  const month = m ? MONTHS.indexOf(m[1] as string) : -1
  if (!m || month < 0) return undefined
  const [day, h, min, sec, year] = m.slice(2).map(Number) as [number, number, number, number, number]
  return Date.UTC(year, month, day, h, min, sec) / 1000
}

/**
 * An opaque, comparable token for "this incarnation of this PID", or `undefined` when the platform
 * cannot tell us. Only ever compared for equality, never parsed.
 */
export async function processStartId(pid: number, deps: IdentityDeps = {}): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const platform = deps.platform ?? process.platform
  const readText = deps.readText ?? readUtf8
  const run = deps.run ?? runProbe
  try {
    if (platform === 'linux') {
      // /proc/<pid>/stat field 22 (starttime, in clock ticks since boot). The comm field may contain
      // spaces and parentheses, so fields are counted after the last ')'.
      const stat = await readText(`/proc/${pid}/stat`)
      const tail = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)
      const startTicks = tail[19] // field 22 = 3rd after state, which is tail[0]
      return startTicks && /^\d+$/.test(startTicks) ? `linux:${startTicks}` : undefined
    }
    if (platform === 'darwin') {
      // `lstart` has one-second resolution; a PID reused inside the same second is indistinguishable,
      // which the takeover path treats as "unknown", never as a free lock.
      const out = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], PINNED_PS_ENV)
      const value = out.trim().replace(/\s+/g, ' ')
      return value ? `darwin-utc:${value}` : undefined
    }
    if (platform === 'win32') {
      const out = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ])
      const value = out.trim()
      return /^\d+$/.test(value) ? `win32-utc:${value}` : undefined
    }
  } catch {
    return undefined // process gone, probe missing or refused
  }
  return undefined
}

/** Cross-language process identity used in files shared with the Rust desktop app. */
export async function processStartEpoch(pid: number, deps: IdentityDeps = {}): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const platform = deps.platform ?? process.platform
  const readText = deps.readText ?? readUtf8
  const run = deps.run ?? runProbe
  try {
    if (platform === 'linux') {
      const [stat, procStat] = await Promise.all([readText(`/proc/${pid}/stat`), readText('/proc/stat')])
      const tail = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)
      const ticks = Number(tail[19])
      const boot = Number(/^btime\s+(\d+)$/m.exec(procStat)?.[1])
      if (!Number.isFinite(ticks) || !Number.isFinite(boot)) return undefined
      // Linux USER_HZ is 100 on the desktop targets Atomic Chat supports.
      return `epoch:${Math.floor(boot + ticks / 100)}`
    }
    if (platform === 'darwin') {
      const out = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], PINNED_PS_ENV)
      const epoch = utcLstartSeconds(out.trim().replace(/\s+/g, ' '))
      return epoch === undefined ? undefined : `epoch:${epoch}`
    }
    if (platform === 'win32') {
      const out = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime | ForEach-Object { $_.ToUnixTimeSeconds() }`,
      ])
      const epoch = Number(out.trim())
      return Number.isInteger(epoch) ? `epoch:${epoch}` : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The executable name of a live process, without its directory (and without `.exe`), or `undefined`
 * when it cannot be read. A second, independent check next to the start identity for a process that
 * is only ever ended by name *and* identity — the remote-access tunnel, because people who want that
 * feature often run a `cloudflared` of their own that must never be touched.
 */
export async function processName(pid: number, deps: IdentityDeps = {}): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const platform = deps.platform ?? process.platform
  const readText = deps.readText ?? readUtf8
  const run = deps.run ?? runProbe
  try {
    let raw: string
    if (platform === 'linux') raw = await readText(`/proc/${pid}/comm`)
    else if (platform === 'darwin') raw = await run('/bin/ps', ['-o', 'comm=', '-p', String(pid)])
    else if (platform === 'win32')
      raw = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).ProcessName`,
      ])
    else return undefined
    const name = (raw.trim().split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
    return name === '' ? undefined : name
  } catch {
    return undefined // process gone, probe missing or refused
  }
}

/** Compare a recorded identity with the live process. `unknown` means "cannot prove"; treat as live. */
export async function verifyProcessIdentity(
  pid: number,
  expected: string | null | undefined,
  deps: IdentityDeps = {}
): Promise<IdentityVerdict> {
  const alive = deps.alive ?? isProcessAlive
  if (!alive(pid)) return 'dead'
  if (!expected) return 'unknown'
  // Written before identities were pinned: in the writer's locale and zone, which this reader cannot
  // know. Equal still proves it; a difference proves nothing, so it never frees what the owner holds.
  if (/^(darwin|win32):/.test(expected)) {
    const legacy = await legacyStartId(pid, deps)
    return legacy !== undefined && legacy === expected ? 'match' : 'unknown'
  }
  const actual = await processStartId(pid, deps)
  if (!actual) return 'unknown'
  return actual === expected ? 'match' : 'mismatch'
}

/** The identity as cores before 0.18.3 wrote it: `ps` in the C locale and local zone, local ticks. */
async function legacyStartId(pid: number, deps: IdentityDeps): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runProbe
  try {
    if (platform === 'darwin') {
      const out = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { LC_ALL: 'C' })
      const value = out.trim().replace(/\s+/g, ' ')
      return value ? `darwin:${value}` : undefined
    }
    if (platform === 'win32') {
      const out = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.Ticks`,
      ])
      const value = out.trim()
      return /^\d+$/.test(value) ? `win32:${value}` : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Compare a recorded start time (`epoch:<seconds>`, `processStartEpoch`) with the live process. Seconds
 * since the epoch read the same in every locale and zone, so a difference is proof of another process
 * behind the PID; a second either way is the same start read at a different instant.
 */
export async function verifyStartEpoch(
  pid: number,
  expected: string | null | undefined,
  deps: IdentityDeps = {}
): Promise<IdentityVerdict> {
  const alive = deps.alive ?? isProcessAlive
  if (!alive(pid)) return 'dead'
  const want = Number(/^epoch:(\d+)$/.exec(expected ?? '')?.[1])
  const got = Number(/^epoch:(\d+)$/.exec((await processStartEpoch(pid, deps)) ?? '')?.[1])
  if (!Number.isFinite(want) || !Number.isFinite(got)) return 'unknown'
  return Math.abs(want - got) <= 1 ? 'match' : 'mismatch'
}

/** Only a proven-gone process releases what it held. */
export function identityPermitsTakeover(verdict: IdentityVerdict): boolean {
  return verdict === 'dead' || verdict === 'mismatch'
}
