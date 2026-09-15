/**
 * `<data>/atomic-core/processes.json` — every backend process this core spawned, with the identity
 * needed to recognise it later (PLAN.md §3.4).
 *
 * After a crash the new owner must clean up the previous owner's `llama-server` processes without
 * killing anything else. A PID from a dead owner's journal may have been recycled, so a process is
 * only a *confirmed* orphan when its recorded start identity still matches the live process and the
 * owner that spawned it is provably gone. Anything unproven is left running and reported.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LocalProviderId } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { verifyProcessIdentity } from './process-identity.js'
import type { IdentityDeps } from './process-identity.js'

export interface ChildProcessRecord {
  /** Core instance that spawned it. */
  instance_id: string
  pid: number
  process_start_id: string | null
  exe: string
  provider: LocalProviderId
  model_id: string
  port: number
  started_at: string
}

export interface OrphanScan {
  /** Same process, spawned by an owner that is gone: safe to terminate. */
  confirmed: ChildProcessRecord[]
  /** Alive but unprovable, or owned by the live owner: left alone. */
  skipped: Array<{
    record: ChildProcessRecord
    reason: 'owner-alive' | 'identity-unproven' | 'current-instance'
  }>
  /** Already gone: drop from the journal. */
  gone: ChildProcessRecord[]
}

export class ProcessJournal {
  private records: ChildProcessRecord[] = []
  private queue: Promise<void> = Promise.resolve()

  private constructor(private readonly path: string) {}

  static async open(layout: DataLayout): Promise<ProcessJournal> {
    const journal = new ProcessJournal(layout.core.processes)
    journal.records = await readJournal(layout.core.processes)
    return journal
  }

  list(): ChildProcessRecord[] {
    return this.records.map((r) => ({ ...r }))
  }

  /** A journal entry must exist before the child can produce work, so this write is awaited. */
  async add(record: ChildProcessRecord): Promise<void> {
    this.records = [...this.records.filter((r) => r.pid !== record.pid), record]
    await this.flush()
  }

  async remove(pid: number): Promise<void> {
    if (!this.records.some((r) => r.pid === pid)) return
    this.records = this.records.filter((r) => r.pid !== pid)
    await this.flush()
  }

  async replace(records: ChildProcessRecord[]): Promise<void> {
    this.records = [...records]
    await this.flush()
  }

  /**
   * Classify the journal against reality. `currentInstanceId` is this owner: its own children are
   * never orphans, and an entry from an owner that is still alive belongs to that owner.
   */
  async scanOrphans(
    currentInstanceId: string,
    liveOwnerInstanceIds: ReadonlySet<string>,
    deps: IdentityDeps = {}
  ): Promise<OrphanScan> {
    const scan: OrphanScan = { confirmed: [], skipped: [], gone: [] }
    for (const record of this.records) {
      if (record.instance_id === currentInstanceId) {
        scan.skipped.push({ record, reason: 'current-instance' })
        continue
      }
      if (liveOwnerInstanceIds.has(record.instance_id)) {
        scan.skipped.push({ record, reason: 'owner-alive' })
        continue
      }
      const verdict = await verifyProcessIdentity(record.pid, record.process_start_id, deps)
      if (verdict === 'dead' || verdict === 'mismatch') scan.gone.push(record)
      else if (verdict === 'match') scan.confirmed.push(record)
      else scan.skipped.push({ record, reason: 'identity-unproven' })
    }
    return scan
  }

  /** Forget entries for processes that are gone or were adopted elsewhere. */
  async forget(records: ChildProcessRecord[]): Promise<void> {
    if (records.length === 0) return
    const drop = new Set(records.map((r) => r.pid))
    this.records = this.records.filter((r) => !drop.has(r.pid))
    await this.flush()
  }

  /** Serialised so concurrent adds cannot interleave a read-modify-write. */
  private flush(): Promise<void> {
    this.queue = this.queue.then(() => writeJournal(this.path, this.records))
    return this.queue
  }
}

async function readJournal(path: string): Promise<ChildProcessRecord[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  if (!text.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return [] // a truncated journal costs cleanup, not correctness: unknown processes are never killed
  }
  const list = Array.isArray(raw) ? raw : (raw as { processes?: unknown })?.processes
  if (!Array.isArray(list)) return []
  return list.filter(isChildProcessRecord)
}

function isChildProcessRecord(value: unknown): value is ChildProcessRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r['pid'] === 'number' && typeof r['instance_id'] === 'string' && typeof r['exe'] === 'string'
}

async function writeJournal(path: string, records: ChildProcessRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: 1, processes: records }, null, 2)}\n`)
  await rename(tmp, path).catch(async (e) => {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  })
}
