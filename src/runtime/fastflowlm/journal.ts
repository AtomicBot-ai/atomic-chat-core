import { ownedFlmPath } from './owned-path.js'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalDigest } from '../environment/index.js'

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
function missing(id: string) {
  return new AtomicCoreError('MANAGED_OPERATION_NOT_FOUND', 'Unknown FastFlowLM operation.', id)
}

/** The data-folder owner lock excludes other writers. Only a completed rename publishes a revision. */
export class FlmJournal<T> {
  constructor(
    private readonly dir: string,
    private readonly idOf: (record: T) => string,
    private readonly dataRoot = dir
  ) {}
  async read(id: string): Promise<T> {
    if (typeof id !== 'string' || !uuid.test(id)) throw missing(String(id))
    const text = await readFile(
      await ownedFlmPath(this.dataRoot, join(this.dir, id + '.json')),
      'utf8'
    ).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'ENOENT' ? missing(id) : e
    })
    const data = JSON.parse(text)
    if (
      data.version !== 1 ||
      !data.record ||
      this.idOf(data.record) !== id ||
      data.digest !== canonicalDigest(data.record)
    )
      throw new AtomicCoreError('MANAGED_METADATA_INVALID', 'Invalid FastFlowLM operation journal.', id)
    return data.record
  }
  async all(): Promise<T[]> {
    const files = await readdir(await ownedFlmPath(this.dataRoot, this.dir)).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return []
        throw e
      }
    )
    return Promise.all(
      files
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => this.read(name.slice(0, -5)))
    )
  }
  async write(record: T) {
    await ownedFlmPath(this.dataRoot, this.dir)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, this.idOf(record) + '.json'),
      tmp = path + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(tmp, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ version: 1, digest: canonicalDigest(record), record }))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(tmp, path)
      if (process.platform !== 'win32') {
        const dir = await open(this.dir, 'r')
        try {
          await dir.sync()
        } finally {
          await dir.close()
        }
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }
}
