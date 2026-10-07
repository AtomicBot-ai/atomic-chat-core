/**
 * `<data>/atomic-core/prism-setups/<setup id>.json`: one record per model setup. One core owns a
 * data folder at a time (the instance lock), so the store serialises writers in memory rather than
 * with a lock file. A write never overwrites the only good copy: the previous record is kept as
 * `.bak` and read back when the newest is torn. `commit` applies only against the revision it was
 * computed from, so a late writer cannot step on a newer state.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError, MODEL_SETUP_STAGES } from '../../contracts/index.js'
import type { ModelSetup } from '../../contracts/index.js'

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Enough of a shape check to tell a record from a truncated write or a foreign file. */
export function parseModelSetupRecord(text: string): ModelSetup | null {
  try {
    const raw = JSON.parse(text) as ModelSetup
    if (typeof raw?.setup_id !== 'string' || !SAFE_ID.test(raw.setup_id)) return null
    if (typeof raw.request_id !== 'string') return null
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) return null
    if (!(MODEL_SETUP_STAGES as readonly string[]).includes(raw.stage)) return null
    if (typeof raw.plan?.digest !== 'string' || typeof raw.plan.model_id !== 'string') return null
    return raw
  } catch {
    return null
  }
}

export class ModelSetupStore {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {}

  /** Every record that can be read, oldest first. */
  async list(): Promise<ModelSetup[]> {
    const names = await readdir(this.dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[]
      throw err
    })
    const ids = new Set(
      names
        .filter((n) => n.endsWith('.json') || n.endsWith('.json.bak'))
        .map((n) => n.replace(/\.json(\.bak)?$/, ''))
    )
    const records: ModelSetup[] = []
    for (const id of ids) {
      const record = SAFE_ID.test(id) ? await this.read(id) : null
      if (record) records.push(record)
    }
    return records.sort((a, b) => a.created_at - b.created_at || a.setup_id.localeCompare(b.setup_id))
  }

  /** The record, its `.bak` when the newest write was torn, or `null`. */
  async read(setupId: string): Promise<ModelSetup | null> {
    if (!SAFE_ID.test(setupId)) return null
    const path = this.path(setupId)
    for (const candidate of [path, `${path}.bak`]) {
      const text = await readFile(candidate, 'utf8').catch(() => undefined)
      const record = text === undefined ? null : parseModelSetupRecord(text)
      if (record) return record
    }
    return null
  }

  /** Write a new record; fails when one with that id exists. */
  async create(record: ModelSetup): Promise<ModelSetup> {
    return this.serialise(async () => {
      if (await this.read(record.setup_id)) {
        throw new AtomicCoreError(
          'INVALID_ARGUMENT',
          'A model setup with that id already exists.',
          record.setup_id
        )
      }
      await this.write(record)
      return record
    })
  }

  /**
   * Replace the record when it is still at `expectedRevision`; the stored one gets
   * `expectedRevision + 1`. Returns `null` without writing when another writer moved it first.
   */
  async commit(next: ModelSetup, expectedRevision: number): Promise<ModelSetup | null> {
    return this.serialise(async () => {
      const current = await this.read(next.setup_id)
      if (!current || current.revision !== expectedRevision) return null
      const stored = { ...next, revision: expectedRevision + 1 }
      await this.write(stored)
      return stored
    })
  }

  private path(setupId: string): string {
    return join(this.dir, `${setupId}.json`)
  }

  private async write(record: ModelSetup): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const path = this.path(record.setup_id)
    const temporary = `${path}.tmp-${process.pid}`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(path, `${path}.bak`).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
    await rename(temporary, path).catch(async (err: unknown) => {
      await rm(temporary, { force: true }).catch(() => {})
      throw err
    })
  }

  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.catch(() => {})
    return result
  }
}
