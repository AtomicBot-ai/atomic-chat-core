/** Durable, revisioned owner of optimal-backend recommendations. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { LocalProviderId } from '../../contracts/index.js'
import { parseOptimalBackendCache } from './optimal-cache.js'
import type { OptimalBackendCacheRecord } from '../types.js'

export interface OptimalState {
  revision: number
  optimal: OptimalBackendCacheRecord | null
}

export type OptimalUpdate =
  { status: 'updated'; current: OptimalState } | { status: 'conflict'; current: OptimalState }

export class OptimalBackendStore {
  private readonly entries = new Map<string, OptimalState>()
  private pending: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly onChange: (provider: LocalProviderId, state: OptimalState) => void
  ) {}

  static async open(
    path: string,
    onChange: (provider: LocalProviderId, state: OptimalState) => void = () => {}
  ): Promise<OptimalBackendStore> {
    const store = new OptimalBackendStore(path, onChange)
    const text = await readFile(path, 'utf8').catch(() => '')
    if (!text.trim()) return store
    try {
      const raw: unknown = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store
      const document = raw as Record<string, unknown>
      const entries =
        document['schemaVersion'] === 2 &&
        document['providers'] &&
        typeof document['providers'] === 'object' &&
        !Array.isArray(document['providers'])
          ? (document['providers'] as Record<string, unknown>)
          : document
      for (const [provider, value] of Object.entries(entries)) {
        if (document['schemaVersion'] === 2) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          const entry = value as Record<string, unknown>
          if (!Number.isSafeInteger(entry['revision']) || (entry['revision'] as number) < 0) continue
          const record = entry['optimal'] === null ? null : parseRecord(entry['optimal'], provider)
          if (entry['optimal'] !== null && !record) continue
          store.entries.set(provider, { revision: entry['revision'] as number, optimal: record })
        } else {
          // Stage 3c initially wrote `{provider: record}` without a revision.
          const record = parseRecord(value, provider)
          if (record) store.entries.set(provider, { revision: 0, optimal: record })
        }
      }
    } catch {
      // One corrupt cache must not keep the core from starting.
    }
    return store
  }

  get(provider: LocalProviderId): OptimalState {
    const state = this.entries.get(provider)
    return state ? { ...state } : { revision: 0, optimal: null }
  }

  snapshot(): Record<string, OptimalState> {
    return Object.fromEntries([...this.entries].map(([provider, state]) => [provider, { ...state }]))
  }

  async set(
    provider: LocalProviderId,
    optimal: OptimalBackendCacheRecord | null,
    expectedRevision: number
  ): Promise<OptimalUpdate> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'expected_revision must be a non-negative integer')
    }
    if (optimal && !parseRecord(optimal, provider)) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid optimal-backend record for provider')
    }
    const action = this.pending.then(async (): Promise<OptimalUpdate> => {
      const previous = this.get(provider)
      if (previous.revision !== expectedRevision) return { status: 'conflict', current: previous }
      const current = { revision: previous.revision + 1, optimal }
      const next = Object.fromEntries(this.entries)
      next[provider] = current
      const temporary = `${this.path}.tmp-${randomUUID()}`
      await mkdir(dirname(this.path), { recursive: true })
      try {
        await writeFile(
          temporary,
          `${JSON.stringify({ schemaVersion: 2, providers: next }, null, 2)}\n`,
          'utf8'
        )
        await rename(temporary, this.path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
      this.entries.set(provider, current)
      this.onChange(provider, current)
      return { status: 'updated', current }
    })
    this.pending = action.catch(() => {})
    return action
  }
}

function parseRecord(value: unknown, provider: string): OptimalBackendCacheRecord | null {
  if (!value || typeof value !== 'object') return null
  if (provider !== 'llamacpp-upstream' && provider !== 'llamacpp') return null
  return parseOptimalBackendCache(JSON.stringify(value), provider)
}
