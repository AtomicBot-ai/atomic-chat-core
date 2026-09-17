/**
 * Crash recovery for the tunnel process.
 *
 * A normal shutdown ends cloudflared, but a crash, an OOM kill or a force quit runs none of that. An
 * orphaned tunnel is worse than an orphaned model backend: it keeps a *public* URL pointed at a local
 * port that is now dead — or that the next process to bind it inherits.
 *
 * The process journal of the model backends does not fit: a tunnel has no provider, model or port,
 * and people who want this feature often run a `cloudflared` of their own that must never be
 * touched. So the tunnel gets its own record, and is ended only when two independent checks agree:
 * the recorded start identity (the PID-reuse guard) and the process name.
 *
 * Ported from: src-tauri/src/core/server/remote_access/journal.rs (image-generation line, `767ff6350`).
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import {
  isProcessAlive,
  processName,
  processStartEpoch,
  processStartId,
  verifyProcessIdentity,
} from '../lock/index.js'

export const TUNNEL_JOURNAL_FILE = 'remote-access-tunnel.json'
const PROCESS_NAME_PREFIX = 'cloudflared'
/** The kernel's start time and our clock reading a moment after `spawn` differ by a second or two at most. */
const START_TIME_TOLERANCE_SECS = 5

export interface TunnelJournalEntry {
  pid: number
  /** `processStartId` of the child, once the probe has answered; `null` until then. */
  process_start_id: string | null
  /** Wall clock at spawn, in seconds: the fallback identity while the probe has not answered. */
  started_at_secs: number
  instance_id: string
  exe: string
}

export interface TunnelJournalDeps {
  startId?: (pid: number) => Promise<string | undefined>
  now?: () => number
  log?: (message: string) => void
}

export interface ReapDeps {
  selfPid?: number
  alive?: (pid: number) => boolean
  name?: (pid: number) => Promise<string | undefined>
  verifyIdentity?: (pid: number, expected: string) => Promise<'match' | 'mismatch' | 'dead' | 'unknown'>
  startEpoch?: (pid: number) => Promise<string | undefined>
  kill?: (pid: number) => void
  log?: (message: string) => void
}

/** What startup did about the tunnel a previous owner may have left behind. */
export type ReapOutcome = 'none' | 'gone' | 'spared' | 'killed'

export function isTunnelName(name: string | undefined): boolean {
  return name !== undefined && name.trim().toLowerCase().startsWith(PROCESS_NAME_PREFIX)
}

/** Records the live tunnel. Best effort: a journal that cannot be written costs crash recovery, never the tunnel. */
export class TunnelJournal {
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly instanceId: string,
    private readonly deps: TunnelJournalDeps = {}
  ) {}

  /**
   * Written at once with what is known, then again with the start identity: the identity probe takes
   * about a second on Windows, and a crash inside that second must still leave a trail.
   */
  record(pid: number, exe: string): Promise<void> {
    const entry: TunnelJournalEntry = {
      pid,
      process_start_id: null,
      started_at_secs: Math.floor((this.deps.now ?? Date.now)() / 1000),
      instance_id: this.instanceId,
      exe,
    }
    return this.enqueue(async () => {
      await this.write(entry)
      const startId = await (this.deps.startId ?? processStartId)(pid).catch(() => undefined)
      if (startId !== undefined && (await this.current())?.pid === pid)
        await this.write({ ...entry, process_start_id: startId })
    })
  }

  clear(): Promise<void> {
    return this.enqueue(() => rm(this.path, { force: true }))
  }

  private async current(): Promise<TunnelJournalEntry | undefined> {
    return parseEntry(await readFile(this.path, 'utf8').catch(() => ''))
  }

  private async write(entry: TunnelJournalEntry): Promise<void> {
    // Write-then-rename: a crash mid-write must not leave a journal the next startup cannot parse.
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(entry)}\n`)
    await rename(temporary, this.path)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation).catch((error: Error) => {
      this.deps.log?.(`could not update the remote-access journal: ${error.message}`)
    })
    this.writes = next
    return next
  }
}

function parseEntry(text: string): TunnelJournalEntry | undefined {
  try {
    const value = JSON.parse(text) as Partial<TunnelJournalEntry> | null
    if (!value || !Number.isInteger(value.pid) || (value.pid as number) <= 0) return undefined
    return {
      pid: value.pid as number,
      process_start_id: typeof value.process_start_id === 'string' ? value.process_start_id : null,
      started_at_secs: typeof value.started_at_secs === 'number' ? value.started_at_secs : 0,
      instance_id: typeof value.instance_id === 'string' ? value.instance_id : '',
      exe: typeof value.exe === 'string' ? value.exe : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Ends the tunnel a previous, abnormally ended owner left behind. Called once at startup, before the
 * endpoint is published and before anything could have started a new one.
 */
export async function reapTunnelOrphan(path: string, deps: ReapDeps = {}): Promise<ReapOutcome> {
  const log = deps.log ?? (() => {})
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return 'none'
  // Whatever it says, it describes a previous run; never read it twice.
  await rm(path, { force: true }).catch(() => {})
  const entry = parseEntry(text)
  if (!entry) {
    log('ignoring an unreadable remote-access journal')
    return 'none'
  }
  const alive = deps.alive ?? isProcessAlive
  if (entry.pid === (deps.selfPid ?? process.pid) || !alive(entry.pid)) return 'gone'

  const name = await (deps.name ?? processName)(entry.pid)
  const sameProcess = await isRecordedProcess(entry, deps)
  if (!sameProcess || !isTunnelName(name)) {
    log(`pid ${entry.pid} is no longer our tunnel (${name ?? 'unknown'}); leaving it alone`)
    return 'spared'
  }
  try {
    ;(deps.kill ?? ((pid) => process.kill(pid, 'SIGKILL')))(entry.pid)
    log(`ended a tunnel (pid ${entry.pid}) orphaned by a previous run`)
    return 'killed'
  } catch {
    return 'gone'
  }
}

/** The PID-reuse guard: the recorded identity when there is one, else the start time within tolerance. */
async function isRecordedProcess(entry: TunnelJournalEntry, deps: ReapDeps): Promise<boolean> {
  if (entry.process_start_id !== null) {
    const verdict = await (deps.verifyIdentity ?? verifyProcessIdentity)(entry.pid, entry.process_start_id)
    return verdict === 'match'
  }
  const epoch = await (deps.startEpoch ?? processStartEpoch)(entry.pid)
  const startedAt = Number(epoch?.slice('epoch:'.length))
  return (
    Number.isFinite(startedAt) && Math.abs(startedAt - entry.started_at_secs) <= START_TIME_TOLERANCE_SECS
  )
}
