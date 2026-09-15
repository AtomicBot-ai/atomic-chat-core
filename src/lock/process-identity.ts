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
  /** Run a probe and return its stdout. */
  run?: (file: string, args: string[]) => Promise<string>
  /** Signal-0 liveness probe. */
  alive?: (pid: number) => boolean
}

export const IDENTITY_PROBE_TIMEOUT_MS = 5000

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function runProbe(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: IDENTITY_PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * An opaque, comparable token for "this incarnation of this PID", or `undefined` when the platform
 * cannot tell us. Only ever compared for equality, never parsed.
 */
export async function processStartId(pid: number, deps: IdentityDeps = {}): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const platform = deps.platform ?? process.platform
  const readText = deps.readText ?? ((p: string) => readFile(p, 'utf8'))
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
      const out = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])
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
    return undefined // process gone, probe missing or refused
  }
  return undefined
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
  const actual = await processStartId(pid, deps)
  if (!actual) return 'unknown'
  return actual === expected ? 'match' : 'mismatch'
}

/** Only a proven-gone process releases what it held. */
export function identityPermitsTakeover(verdict: IdentityVerdict): boolean {
  return verdict === 'dead' || verdict === 'mismatch'
}
