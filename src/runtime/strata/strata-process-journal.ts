import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { verifyProcessIdentity } from '../../lock/index.js'
import type { IdentityVerdict } from '../../lock/index.js'
import { FifoLock } from '../shared/index.js'

export interface StrataProcessIdentity {
  role: 'owner' | 'server' | 'compute' | 'vision' | 'guardian' | 'launcher' | 'converter'
  pid: number
  startId: string | null
}
export interface StrataLaunchIntent {
  generation: string
  profile: string
  modelId: string
  cards: string[]
  build?: string
  core: { instanceId: string; pid: number; startId: string }
}
export interface StrataProcessEntry extends StrataLaunchIntent {
  ownerId?: string
  instanceId?: string
  profileRevision?: string
  /** True only after the launcher has proved that no unobserved child can still be started. */
  launchComplete: boolean
  processes: StrataProcessIdentity[]
}
export interface StrataProcessObservation {
  ownerId?: string
  instanceId?: string
  profileRevision?: string
  processes: StrataProcessIdentity[]
  /** A stopped HTTP listener or a successful CLI exit alone cannot attest this. */
  launchComplete?: boolean
}
interface State {
  version: 1
  scopeId: string
  entries: StrataProcessEntry[]
}
type Verify = (pid: number, startId: string | null) => Promise<IdentityVerdict>
interface ProcessRow {
  generation: string
  process: StrataProcessIdentity
}
export interface StrataOrphanScan {
  /** Candidates only: the caller must compare the identity again immediately before signalling. */
  confirmed: ProcessRow[]
  gone: ProcessRow[]
  blocked: Array<{
    generation: string
    process?: StrataProcessIdentity
    reason: 'current-owner' | 'owner-live-or-unknown' | 'incomplete-launch' | 'identity-unknown'
  }>
}

const token = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.includes('\0')
const pid = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
function corrupt(): never {
  throw new AtomicCoreError('IO_ERROR', 'Strata process journal is invalid; GPU ownership remains blocked.')
}
function validate(raw: unknown, scopeId: string): asserts raw is State {
  if (!raw || typeof raw !== 'object') corrupt()
  const s = raw as State
  if (s.version !== 1 || s.scopeId !== scopeId || !text(scopeId) || !Array.isArray(s.entries)) corrupt()
  const generations = new Set<string>()
  for (const e of s.entries) {
    if (
      !e ||
      !token(e.generation) ||
      generations.has(e.generation) ||
      e.profile !== `atomic-${e.generation}` ||
      !text(e.modelId) ||
      (e.build !== undefined && !text(e.build)) ||
      !Array.isArray(e.cards) ||
      !e.cards.every(text) ||
      new Set(e.cards).size !== e.cards.length ||
      !e.core ||
      !text(e.core.instanceId) ||
      !pid(e.core.pid) ||
      !text(e.core.startId) ||
      typeof e.launchComplete !== 'boolean' ||
      !Array.isArray(e.processes)
    )
      corrupt()
    generations.add(e.generation)
    for (const id of [e.ownerId, e.instanceId]) if (id !== undefined && !token(id)) corrupt()
    if (e.profileRevision !== undefined && !/^[a-f0-9]{16}$/.test(e.profileRevision)) corrupt()
    const pids = new Set<number>()
    for (const p of e.processes) {
      if (
        !p ||
        !pid(p.pid) ||
        pids.has(p.pid) ||
        p.pid === e.core.pid ||
        !['owner', 'server', 'compute', 'vision', 'guardian', 'launcher', 'converter'].includes(p.role) ||
        (p.startId !== null && !text(p.startId))
      )
        corrupt()
      pids.add(p.pid)
    }
  }
}

/** Durable scope-local ownership. Missing evidence never becomes permission to free the GPU. */
export class StrataProcessJournal {
  private readonly lock = new FifoLock()
  private constructor(
    private readonly root: string,
    private state: State,
    private readonly verify: Verify
  ) {}

  static async open(
    root: string,
    scopeId: string,
    verify: Verify = verifyProcessIdentity
  ): Promise<StrataProcessJournal> {
    let canonical: string
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
      if (!(await lstat(root)).isDirectory()) corrupt()
      canonical = await realpath(root)
    } catch (error) {
      // The journal root is the GPU-ownership evidence, so refusal stays fatal here. It must
      // cross the core boundary as a coded error that keeps the filesystem cause.
      if (error instanceof AtomicCoreError) throw error
      throw new AtomicCoreError(
        'IO_ERROR',
        'Strata process journal is unavailable; GPU ownership remains blocked.',
        undefined,
        { cause: error }
      )
    }
    let state: State = { version: 1, scopeId, entries: [] }
    const path = join(canonical, 'processes.json')
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) corrupt()
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const opened = await file.stat()
        if (!opened.isFile() || opened.size > 16 * 1024 * 1024) corrupt()
        const raw: unknown = JSON.parse(await file.readFile('utf8'))
        if (raw && typeof raw === 'object' && (raw as State).scopeId !== scopeId)
          throw new AtomicCoreError('IO_ERROR', 'Strata process journal belongs to a different scope.')
        validate(raw, scopeId)
        state = raw
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof AtomicCoreError) throw error
        corrupt()
      }
    }
    validate(state, scopeId)
    return new StrataProcessJournal(canonical, state, verify)
  }

  list(): StrataProcessEntry[] {
    return structuredClone(this.state.entries)
  }

  /** Await this before launching Control or a converter, including before a long startup. */
  begin(intent: StrataLaunchIntent): Promise<void> {
    return this.change((next) => {
      if (next.entries.some((e) => e.generation === intent.generation))
        throw new AtomicCoreError('GPU_BUSY', 'This Strata generation already owns a process claim.')
      next.entries.push({ ...structuredClone(intent), launchComplete: false, processes: [] })
    })
  }

  observe(generation: string, observation: StrataProcessObservation): Promise<void> {
    return this.change((next) => {
      const entry = next.entries.find((e) => e.generation === generation)
      if (!entry) corrupt()
      const mismatch = (): never => {
        throw new AtomicCoreError('GPU_BUSY', 'Strata process identity changed within a generation.')
      }
      for (const key of ['ownerId', 'instanceId', 'profileRevision'] as const) {
        const value = observation[key]
        if (value === undefined) continue
        if (entry[key] !== undefined && entry[key] !== value) mismatch()
        entry[key] = value
      }
      for (const process of observation.processes) {
        const previous = entry.processes.find((p) => p.pid === process.pid)
        if (previous && (previous.startId !== process.startId || previous.role !== process.role)) mismatch()
        if (!previous) {
          // A sealed launch promises no new children; a later child invalidates that promise.
          if (entry.launchComplete) mismatch()
          entry.processes.push(structuredClone(process))
        }
      }
      if (observation.launchComplete === true) entry.launchComplete = true
    })
  }

  /** The caller still retains its GPU claim unless this removes the complete generation durably. */
  confirmStopped(generation: string, verify: Verify = this.verify): Promise<boolean> {
    return this.lock.run(async () => {
      const entry = this.state.entries.find((e) => e.generation === generation)
      if (!entry) return true
      if (!entry.launchComplete) return false
      for (const process of entry.processes) {
        const verdict = await verify(process.pid, process.startId)
        if (verdict !== 'dead' && verdict !== 'mismatch') return false
      }
      const next = structuredClone(this.state)
      next.entries = next.entries.filter((e) => e.generation !== generation)
      await this.persist(next)
      this.state = next
      return true
    })
  }

  async orphans(currentInstanceId: string): Promise<StrataOrphanScan> {
    const result: StrataOrphanScan = { confirmed: [], gone: [], blocked: [] }
    for (const entry of this.list()) {
      const generation = entry.generation
      if (entry.core.instanceId === currentInstanceId) {
        result.blocked.push({ generation, reason: 'current-owner' })
        continue
      }
      const owner = await this.verify(entry.core.pid, entry.core.startId)
      if (owner !== 'dead' && owner !== 'mismatch') {
        result.blocked.push({ generation, reason: 'owner-live-or-unknown' })
        continue
      }
      if (!entry.launchComplete) result.blocked.push({ generation, reason: 'incomplete-launch' })
      for (const process of entry.processes) {
        const verdict = await this.verify(process.pid, process.startId)
        if (verdict === 'match') result.confirmed.push({ generation, process })
        else if (verdict === 'dead' || verdict === 'mismatch') result.gone.push({ generation, process })
        else result.blocked.push({ generation, process, reason: 'identity-unknown' })
      }
    }
    return result
  }

  private change(update: (next: State) => void): Promise<void> {
    return this.lock.run(async () => {
      const next = structuredClone(this.state)
      update(next)
      validate(next, this.state.scopeId)
      await this.persist(next)
      this.state = next
    })
  }
  private async persist(state: State): Promise<void> {
    const path = join(this.root, `.processes-${randomUUID()}.tmp`)
    try {
      const file = await open(path, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(state) + '\n')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(path, join(this.root, 'processes.json'))
    } finally {
      await rm(path, { force: true })
    }
  }
}
