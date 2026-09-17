/**
 * `<data>/atomic-core/settings.json` — the core's replacement for the app's `localStorage[<extension>]`
 * descriptor arrays (core/src/browser/extension.ts:150-240) and its loose service keys
 * (`llama_cpp_pending_backend`, `llama_cpp_better_backend_recommendation`, … — PLAN.md §8.1).
 *
 * Shape (PLAN.md §3.4):
 *   { version, revision, updated_at,
 *     providers: { <provider>: { <canonical key>: <typed value> } },
 *     server: ServerSettings, cloud: { providers: [] },
 *     state: { providers: { <provider>: { backend_type, pending_backend, better_backend_recommendation,
 *                                          last_recheck_outcome } },
 *              migrations: { <scope>: { baseline, legacy_hash, acknowledged_revision } } } }
 *
 * Rules:
 *  - `revision` is monotonic and only moves when a value actually changed; callers pass
 *    `expectedRevision` to get a conflict (`INVALID_ARGUMENT`) instead of a lost update.
 *  - Every write is atomic: `<file>.tmp` then rename, mode 0600 (protected like credentials).
 *  - Unknown keys — at the top level, inside a provider, inside `state` — survive read → write, so an
 *    older core never destroys what a newer one stored (PLAN.md §5.1).
 *  - Values are canonicalized on read and on write (`canonicalizeSettingValues`), so `get()` returns
 *    the types Rust `LlamacppConfig` expects even when the file was hand-edited with strings.
 *  - I/O is injected (`fs`, `now`) so tests run on an in-memory fake.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError, DEFAULT_SERVER_SETTINGS } from '../contracts/index.js'
import type { LocalProviderId, ServerSettings } from '../contracts/index.js'
import { LOCAL_PROVIDER_IDS, canonicalizeSettingValues, defaultSettingValues } from './schema.js'
import { classifyImport, legacyHash, planImport } from './import.js'
import type { ImportOutcome, Resolutions } from './import.js'

export const SETTINGS_FILE_VERSION = 1

export type ProviderValues = Record<string, unknown>

/** Per-provider runtime facts the app kept as loose `localStorage` keys; all `string | null` there too. */
export interface ProviderRuntimeState {
  backend_type: string | null
  pending_backend: string | null
  better_backend_recommendation: string | null
  last_recheck_outcome: string | null
  [extra: string]: unknown
}

/** One migration scope (a provider, `server` or `cloud`), see PLAN.md §3.4 "Settings migration". */
export interface MigrationRecord {
  baseline: Record<string, unknown> | null
  legacy_hash: string | null
  acknowledged_revision: number | null
  [extra: string]: unknown
}

export interface CoreState {
  providers: Record<LocalProviderId, ProviderRuntimeState> & Record<string, unknown>
  migrations: Record<string, MigrationRecord>
  [extra: string]: unknown
}

export interface CloudSettings {
  providers: Record<string, unknown>[]
  [extra: string]: unknown
}

export interface SettingsDocument {
  version: number
  owner_scope?: 'app' | 'cli'
  revision: number
  /** ISO-8601 of the last write, from the injected clock. */
  updated_at: string
  providers: Record<LocalProviderId, ProviderValues> & Record<string, unknown>
  server: ServerSettings & Record<string, unknown>
  cloud: CloudSettings
  state: CoreState
  [extra: string]: unknown
}

export type SettingsScope = LocalProviderId | 'server' | 'cloud' | 'state'

/** What `onChange` listeners receive; the events module maps it onto `settings:changed`. */
export interface SettingsChange {
  scope: SettingsScope
  /** The setting key; for `state` changes it is `<provider>.<key>`. */
  key: string
  value: unknown
  revision: number
}

export interface UpdateOptions {
  /** Refuse the write when the on-disk revision moved past this (`INVALID_ARGUMENT`). */
  expectedRevision?: number
}

export interface UpdateResult {
  revision: number
  /** Keys whose value actually changed (empty ⇒ nothing was written). */
  changed: string[]
}

export interface ImportOptions extends UpdateOptions {
  /** How to settle keys both sides changed; without one, the import reports the conflict instead. */
  resolutions?: Resolutions
}

export interface ImportResult extends ImportOutcome {
  revision: number
}

/** The subset of `node:fs/promises` the store needs; tests pass an in-memory fake. */
export interface SettingsFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: 'utf8'; mode?: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  stat(path: string): Promise<unknown>
}

export interface SettingsStoreOptions {
  ownerScope?: 'app' | 'cli'
  fs?: SettingsFs
  /** Milliseconds since epoch; defaults to `Date.now`. */
  now?: () => number
}

const NODE_FS: SettingsFs = { readFile, writeFile, rename, mkdir, stat }

export const EMPTY_PROVIDER_STATE: ProviderRuntimeState = {
  backend_type: null,
  pending_backend: null,
  better_backend_recommendation: null,
  last_recheck_outcome: null,
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {}
}

function isEnoent(e: unknown): boolean {
  return isRecord(e) && e['code'] === 'ENOENT'
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** Schema defaults with the wire types applied — what a fresh provider section holds. */
export function canonicalProviderDefaults(provider: LocalProviderId): ProviderValues {
  return canonicalizeSettingValues(provider, defaultSettingValues(provider))
}

/**
 * Fill every known section with defaults, keep everything else. `raw` may be `{}` (fresh file) or
 * anything a previous core wrote. Throws `IO_ERROR` when the file claims a newer format version.
 */
export function normalizeSettingsDocument(raw: Record<string, unknown>, nowMs: number): SettingsDocument {
  const version = raw['version']
  if (typeof version === 'number' && version > SETTINGS_FILE_VERSION) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `settings.json version ${version} is newer than this core supports (${SETTINGS_FILE_VERSION})`
    )
  }
  const revisionRaw = raw['revision']
  const revision =
    typeof revisionRaw === 'number' && Number.isInteger(revisionRaw) && revisionRaw >= 0 ? revisionRaw : 0

  const rawProviders = asRecord(raw['providers'])
  const providers = { ...rawProviders } as SettingsDocument['providers']
  for (const p of LOCAL_PROVIDER_IDS) {
    providers[p] = canonicalizeSettingValues(p, {
      ...canonicalProviderDefaults(p),
      ...asRecord(rawProviders[p]),
    })
  }

  const rawState = asRecord(raw['state'])
  const rawStateProviders = asRecord(rawState['providers'])
  const stateProviders = { ...rawStateProviders } as CoreState['providers']
  for (const p of LOCAL_PROVIDER_IDS) {
    stateProviders[p] = { ...EMPTY_PROVIDER_STATE, ...asRecord(rawStateProviders[p]) }
  }
  const rawMigrations = asRecord(rawState['migrations'])
  const migrations: Record<string, MigrationRecord> = {}
  for (const [scope, rec] of Object.entries(rawMigrations)) {
    const r = asRecord(rec)
    migrations[scope] = {
      ...r,
      baseline: isRecord(r['baseline']) ? r['baseline'] : null,
      legacy_hash: typeof r['legacy_hash'] === 'string' ? r['legacy_hash'] : null,
      acknowledged_revision:
        typeof r['acknowledged_revision'] === 'number' ? r['acknowledged_revision'] : null,
    }
  }

  const rawCloud = asRecord(raw['cloud'])
  const cloudProviders = Array.isArray(rawCloud['providers'])
    ? (rawCloud['providers'].filter(isRecord) as Record<string, unknown>[])
    : []

  return {
    ...raw,
    version: SETTINGS_FILE_VERSION,
    revision,
    updated_at: typeof raw['updated_at'] === 'string' ? raw['updated_at'] : new Date(nowMs).toISOString(),
    providers,
    server: { ...DEFAULT_SERVER_SETTINGS, ...asRecord(raw['server']) } as SettingsDocument['server'],
    cloud: { ...rawCloud, providers: cloudProviders },
    state: { ...rawState, providers: stateProviders, migrations },
  }
}

export class SettingsStore {
  readonly path: string
  private doc: SettingsDocument
  private readonly fs: SettingsFs
  private readonly now: () => number
  private readonly listeners = new Set<(change: SettingsChange) => void>()
  /** Serialises mutations so two concurrent `update`s never race on `.tmp`. */
  private chain: Promise<unknown> = Promise.resolve()

  private constructor(path: string, doc: SettingsDocument, fs: SettingsFs, now: () => number) {
    this.path = path
    this.doc = doc
    this.fs = fs
    this.now = now
  }

  /** Read the file, or create it with schema defaults when absent. Corrupt JSON is an `IO_ERROR`. */
  static async open(path: string, options: SettingsStoreOptions = {}): Promise<SettingsStore> {
    const fs = options.fs ?? NODE_FS
    const now = options.now ?? Date.now

    let exists = true
    try {
      await fs.stat(path)
    } catch (e) {
      if (!isEnoent(e)) throw new AtomicCoreError('IO_ERROR', `cannot stat ${path}: ${(e as Error).message}`)
      exists = false
    }

    if (!exists) {
      const store = new SettingsStore(
        path,
        normalizeSettingsDocument(options.ownerScope ? { owner_scope: options.ownerScope } : {}, now()),
        fs,
        now
      )
      await store.persist()
      return store
    }

    let text: string
    try {
      text = await fs.readFile(path, 'utf8')
    } catch (e) {
      throw new AtomicCoreError('IO_ERROR', `cannot read ${path}: ${(e as Error).message}`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      throw new AtomicCoreError('IO_ERROR', `${path} is not valid JSON: ${(e as Error).message}`)
    }
    if (!isRecord(raw)) throw new AtomicCoreError('IO_ERROR', `${path} is not a JSON object`)
    if (options.ownerScope && raw['owner_scope'] && raw['owner_scope'] !== options.ownerScope)
      throw new AtomicCoreError('CORE_ALREADY_RUNNING', 'This data folder belongs to another core scope.')
    const store = new SettingsStore(
      path,
      normalizeSettingsDocument(
        options.ownerScope ? { ...raw, owner_scope: options.ownerScope } : raw,
        now()
      ),
      fs,
      now
    )
    if (options.ownerScope && !raw['owner_scope']) await store.persist()
    return store
  }

  get revision(): number {
    return this.doc.revision
  }

  /** Full deep copy of the document (control API snapshot). */
  snapshot(): SettingsDocument {
    return structuredClone(this.doc)
  }

  get(provider: LocalProviderId): ProviderValues {
    assertProvider(provider)
    return structuredClone(this.doc.providers[provider])
  }

  get server(): ServerSettings & Record<string, unknown> {
    return structuredClone(this.doc.server)
  }

  get state(): CoreState {
    return structuredClone(this.doc.state)
  }

  /** Apply `patch` (canonicalized) to a provider; keys whose value is unchanged are ignored. */
  async update(
    provider: LocalProviderId,
    patch: ProviderValues,
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    assertProvider(provider)
    const canonical = canonicalizeSettingValues(provider, patch)
    return this.mutate(options, (doc) =>
      applyPatch(doc.providers[provider], canonical, (key, value) => ({ scope: provider, key, value }))
    )
  }

  async updateServer(
    patch: Partial<ServerSettings> & Record<string, unknown>,
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    return this.mutate(options, (doc) =>
      applyPatch(doc.server, patch, (key, value) => ({ scope: 'server', key, value }))
    )
  }

  /**
   * Replace the cloud provider list (non-secret parts only; keys live in credentials.json). One
   * change is reported for the whole list when anything in it differs.
   */
  async setCloudProviders(
    providers: Record<string, unknown>[],
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    return this.mutate(options, (doc) => {
      if (JSON.stringify(doc.cloud.providers) === JSON.stringify(providers)) return []
      doc.cloud.providers = structuredClone(providers)
      return [{ scope: 'cloud', key: 'providers', value: providers.map((p) => p['provider']) }]
    })
  }

  async updateState(
    provider: LocalProviderId,
    patch: Partial<ProviderRuntimeState>,
    options: UpdateOptions = {}
  ): Promise<UpdateResult> {
    assertProvider(provider)
    return this.mutate(options, (doc) =>
      applyPatch(doc.state.providers[provider], patch, (key, value) => ({
        scope: 'state',
        key: `${provider}.${key}`,
        value,
      }))
    )
  }

  /**
   * Take the desktop app's settings for a provider (PLAN.md §3.4).
   *
   * Three-way, not a copy: see `import.ts`. Nothing is written when any key conflicts, so a scope
   * is either fully migrated or not migrated at all — a half-applied import would leave the app and
   * the core disagreeing about settings neither side accepted.
   *
   * The migration record is written even when the merge applies no values, because the record is
   * what stops the next start from merging the same change all over again.
   */
  async importProvider(
    provider: LocalProviderId,
    legacyValues: ProviderValues,
    options: ImportOptions = {}
  ): Promise<ImportResult> {
    assertProvider(provider)
    const canonicalLegacy = canonicalizeSettingValues(provider, legacyValues)
    const hash = legacyHash(canonicalLegacy)
    let outcome: ImportOutcome = { status: 'unchanged', applied: [], conflicts: [] }

    const result = await this.mutate(options, (doc) => {
      const record = doc.state.migrations[provider] ?? null
      // A first import has no base of its own: the provider's defaults stand in, so a value the CLI
      // already changed reads as a change rather than as where both sides started.
      const base = record?.baseline ?? canonicalProviderDefaults(provider)
      const core = doc.providers[provider]
      const plan = planImport(base, core, canonicalLegacy, options.resolutions ?? {})
      const status = classifyImport(record?.legacy_hash ?? null, record?.baseline != null, hash, plan)
      outcome = { status, applied: Object.keys(plan.apply), conflicts: plan.conflicts }
      if (status === 'conflict' || status === 'unchanged') return []

      const changes = applyPatch(core, plan.apply, (key, value) => ({
        scope: provider,
        key,
        value,
      }))
      doc.state.migrations[provider] = {
        ...(record ?? { acknowledged_revision: null }),
        baseline: structuredClone(canonicalLegacy),
        legacy_hash: hash,
      }
      changes.push({ scope: 'state', key: `migrations.${provider}`, value: hash })
      return changes
    })

    return { ...outcome, revision: result.revision }
  }

  /**
   * Record that the app has mirrored the core's settings up to `revision`.
   *
   * Only meaningful after an import: it is how a planned rollback knows whether the app's copy is
   * current enough to hand ownership back (PLAN.md §3.4). The acknowledgement itself is a
   * metadata-only write, but it advances the file's revision like every other write. Store that
   * resulting revision as the equivalent mirrored state so status is in sync immediately after it.
   */
  async acknowledge(scope: SettingsScope, revision: number): Promise<UpdateResult> {
    return this.mutate({}, (doc) => {
      const record = doc.state.migrations[scope]
      if (!record) return []
      // The app can retry after losing the response. Both its original snapshot revision and
      // the post-ack revision identify the same provider values, so neither retry is a new write.
      if (
        record.acknowledged_revision === doc.revision &&
        (revision === doc.revision || revision === doc.revision - 1)
      )
        return []
      // A value changed while the app was copying the snapshot. Acknowledging that stale copy
      // would authorize rollback with settings that the core has already replaced.
      if (revision !== doc.revision) {
        throw new AtomicCoreError(
          'INVALID_ARGUMENT',
          `settings revision conflict: expected ${revision}, current ${doc.revision}`,
          this.path
        )
      }
      const acknowledged = doc.revision + 1
      record.acknowledged_revision = acknowledged
      return [{ scope: 'state', key: `migrations.${scope}.acknowledged_revision`, value: acknowledged }]
    })
  }

  /** What the core knows about a scope's migration, or `null` when it has never been imported. */
  migration(scope: SettingsScope): MigrationRecord | null {
    const record = this.doc.state.migrations[scope]
    return record ? structuredClone(record) : null
  }

  /** Called once per changed key after the write landed; returns the unsubscribe function. */
  onChange(listener: (change: SettingsChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private mutate(
    options: UpdateOptions,
    apply: (doc: SettingsDocument) => Omit<SettingsChange, 'revision'>[]
  ): Promise<UpdateResult> {
    const run = this.chain.then(async (): Promise<UpdateResult> => {
      const expected = options.expectedRevision
      if (expected !== undefined && expected !== this.doc.revision) {
        throw new AtomicCoreError(
          'INVALID_ARGUMENT',
          `settings revision conflict: expected ${expected}, current ${this.doc.revision}`,
          this.path
        )
      }
      const next = structuredClone(this.doc)
      const changes = apply(next)
      if (changes.length === 0) return { revision: this.doc.revision, changed: [] }

      next.revision = this.doc.revision + 1
      next.updated_at = new Date(this.now()).toISOString()
      const previous = this.doc
      this.doc = next
      try {
        await this.persist()
      } catch (e) {
        this.doc = previous
        throw e
      }
      for (const change of changes) {
        for (const listener of this.listeners) {
          try {
            listener({ ...change, revision: next.revision })
          } catch {
            // a broken listener must not undo a write that already landed
          }
        }
      }
      return { revision: next.revision, changed: changes.map((c) => c.key) }
    })
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async persist(): Promise<void> {
    const text = JSON.stringify(this.doc, null, 2) + '\n'
    const tmp = `${this.path}.tmp`
    try {
      await this.fs.mkdir(dirname(this.path), { recursive: true })
      await this.fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
      await this.fs.rename(tmp, this.path)
    } catch (e) {
      throw new AtomicCoreError('IO_ERROR', `cannot write ${this.path}: ${(e as Error).message}`)
    }
  }
}

function assertProvider(provider: string): asserts provider is LocalProviderId {
  if (!(LOCAL_PROVIDER_IDS as readonly string[]).includes(provider))
    throw new AtomicCoreError('PROVIDER_NOT_FOUND', `unknown provider '${provider}'`)
}

/** Write the differing keys of `patch` into `target`; `undefined` means "leave as is". */
function applyPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  describe: (key: string, value: unknown) => Omit<SettingsChange, 'revision'>
): Omit<SettingsChange, 'revision'>[] {
  const changes: Omit<SettingsChange, 'revision'>[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || sameValue(target[key], value)) continue
    target[key] = value
    changes.push(describe(key, value))
  }
  return changes
}
