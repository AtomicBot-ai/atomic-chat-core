/**
 * `<data>/atomic-core/managed-runtimes/executions` (task 2.10): the private record of the model
 * containers *this core instance* created. It is never a way to discover containers on the host —
 * `reconcile.ts` is the only reader, and it only ever acts on a container whose id is recorded here.
 * Container labels (`ModelContainerLabels`, `types.ts`) stay discovery-only and play no part in this
 * decision (spec `tensorrt-llm-runtime`, "Метки контейнера MUST NOT служить единственным основанием
 * для остановки").
 *
 * One file per container, named by its id, so a crash mid-write can only ever corrupt that one
 * record — the rest of the journal is unaffected. `process-journal.ts` gives the native-process
 * journal the same guarantee through a whole-array rewrite instead; a container journal that rarely
 * holds more than one record (spec `tensorrt-llm-runtime`, "Одна сессия tensorrt-llm одновременно")
 * gets it more simply by splitting one record per file.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'

/** One journalled container: identity enough to find it again and decide whether it is ours. */
export interface ExecutionRecord {
  container_id: string
  engine_id: string
  image_digest: string
  scope: string
  /** The core instance (`InstanceLock.instanceId`) that created this container. */
  instance_id: string
  created_at: string
}

const SAFE_FILENAME = /^[A-Za-z0-9_.-]+$/

function assertSafeContainerId(id: string): string {
  if (!SAFE_FILENAME.test(id)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Not a safe container id for the execution journal: ${id}`)
  }
  return id
}

function isExecutionRecord(value: unknown): value is ExecutionRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r['container_id'] === 'string' &&
    typeof r['engine_id'] === 'string' &&
    typeof r['image_digest'] === 'string' &&
    typeof r['scope'] === 'string' &&
    typeof r['instance_id'] === 'string' &&
    typeof r['created_at'] === 'string'
  )
}

async function readOne(path: string): Promise<ExecutionRecord | undefined> {
  const text = await readFile(path, 'utf8').catch(() => '')
  if (!text.trim()) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined // a torn write costs that one record, never the journal's correctness
  }
  return isExecutionRecord(raw) ? raw : undefined
}

async function readAll(dir: string): Promise<Map<string, ExecutionRecord>> {
  const records = new Map<string, ExecutionRecord>()
  const names = await readdir(dir).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  })
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const record = await readOne(join(dir, name))
    if (record) records.set(record.container_id, record)
  }
  return records
}

async function writeRecord(dir: string, path: string, record: ExecutionRecord): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`)
  await rename(tmp, path).catch(async (e) => {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  })
}

export class ExecutionJournal {
  private records = new Map<string, ExecutionRecord>()

  private constructor(private readonly dir: string) {}

  static async open(layout: DataLayout): Promise<ExecutionJournal> {
    const journal = new ExecutionJournal(layout.managed.executionsDir)
    journal.records = await readAll(journal.dir)
    return journal
  }

  list(): ExecutionRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }))
  }

  /** A record must exist before the container can serve anything, so this write is awaited. */
  async add(record: ExecutionRecord): Promise<void> {
    assertSafeContainerId(record.container_id)
    this.records.set(record.container_id, record)
    await writeRecord(this.dir, this.fileFor(record.container_id), record)
  }

  /** Drop the record for a container that is gone, stopped, or adopted by reconcile. Idempotent. */
  async remove(containerId: string): Promise<void> {
    if (!this.records.has(containerId)) return
    this.records.delete(containerId)
    await rm(this.fileFor(containerId), { force: true })
  }

  private fileFor(containerId: string): string {
    return join(this.dir, `${assertSafeContainerId(containerId)}.json`)
  }
}
