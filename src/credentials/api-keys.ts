/**
 * `<data>/atomic-core/credentials.json`: cloud provider API keys, kept out of `settings.json` so the
 * settings file can be read, diffed and shown without exposing a secret (PLAN.md §3.4).
 *
 * `{version: 1, providers: {<id>: {api_key, updated_at, bound_to?}}}`, owner-readable only (0600 on Unix; on
 * Windows the file inherits the per-user ACL of the data folder). Written through `.tmp` + rename,
 * with the mode set when the temporary file is created, so the key is never on disk under a wider
 * mode even for an instant.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'

export const CREDENTIALS_VERSION = 1

export interface ApiKeyRecord {
  api_key: string
  updated_at: string
  /** Hash of the non-secret provider configuration this key may be sent to. */
  bound_to?: string
}

interface CredentialsDocument {
  version: number
  providers: Record<string, ApiKeyRecord>
}

export class ApiKeyStore {
  private doc: CredentialsDocument
  private chain: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly path: string,
    doc: CredentialsDocument,
    private readonly now: () => number
  ) {
    this.doc = doc
  }

  /**
   * Read the file, or start empty when it is absent. A file that cannot be parsed is refused rather
   * than silently replaced: overwriting it would throw away every key the user entered.
   */
  static async open(path: string, options: { now?: () => number } = {}): Promise<ApiKeyStore> {
    const now = options.now ?? Date.now
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return new ApiKeyStore(path, { version: CREDENTIALS_VERSION, providers: {} }, now)
      throw new AtomicCoreError('IO_ERROR', `cannot read ${path}`, (e as Error).message)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new AtomicCoreError(
        'IO_ERROR',
        `${path} is not valid JSON; fix or remove it`,
        (e as Error).message
      )
    }
    return new ApiKeyStore(path, normalize(parsed), now)
  }

  get(provider: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.doc.providers, provider)
      ? this.doc.providers[provider]?.api_key
      : undefined
  }

  has(provider: string): boolean {
    return this.get(provider) !== undefined
  }

  record(provider: string): ApiKeyRecord | undefined {
    const record = this.doc.providers[provider]
    return record ? { ...record } : undefined
  }

  /** Store a key; an empty or absent key removes the entry, the way the app's registration clears one. */
  set(provider: string, apiKey: string | null | undefined): Promise<void> {
    return this.mutate((doc) => {
      if (apiKey === undefined || apiKey === null || apiKey === '') {
        if (!Object.prototype.hasOwnProperty.call(doc.providers, provider)) return false
        delete doc.providers[provider]
        return true
      }
      if (doc.providers[provider]?.api_key === apiKey) return false
      doc.providers[provider] = { api_key: apiKey, updated_at: new Date(this.now()).toISOString() }
      return true
    })
  }

  remove(provider: string): Promise<void> {
    return this.set(provider, undefined)
  }

  /** Persist a key and its destination binding as one credentials-file update. */
  setBound(provider: string, apiKey: string | null | undefined, binding: string): Promise<void> {
    return this.mutate((doc) => {
      if (apiKey === undefined || apiKey === null || apiKey === '') {
        if (!Object.prototype.hasOwnProperty.call(doc.providers, provider)) return false
        delete doc.providers[provider]
        return true
      }
      const old = doc.providers[provider]
      if (old?.api_key === apiKey && old.bound_to === binding) return false
      doc.providers[provider] = {
        api_key: apiKey,
        updated_at: old?.api_key === apiKey ? old.updated_at : new Date(this.now()).toISOString(),
        bound_to: binding,
      }
      return true
    })
  }

  /** Restore the exact previous record after a failed settings write. */
  restore(provider: string, record: ApiKeyRecord | undefined): Promise<void> {
    return this.mutate((doc) => {
      const old = doc.providers[provider]
      if (JSON.stringify(old) === JSON.stringify(record)) return false
      if (record) doc.providers[provider] = { ...record }
      else delete doc.providers[provider]
      return true
    })
  }

  private mutate(change: (doc: CredentialsDocument) => boolean): Promise<void> {
    const next = this.chain.then(async () => {
      const draft: CredentialsDocument = structuredClone(this.doc)
      if (!change(draft)) return
      await persist(this.path, draft)
      this.doc = draft
    })
    this.chain = next.catch(() => {})
    return next
  }
}

function normalize(raw: unknown): CredentialsDocument {
  const doc: CredentialsDocument = { version: CREDENTIALS_VERSION, providers: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return doc
  const providers = (raw as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return doc
  for (const [id, entry] of Object.entries(providers)) {
    const key = (entry as { api_key?: unknown } | null)?.api_key
    const updated = (entry as { updated_at?: unknown } | null)?.updated_at
    const bound = (entry as { bound_to?: unknown } | null)?.bound_to
    if (typeof key === 'string' && key !== '')
      doc.providers[id] = {
        api_key: key,
        updated_at: typeof updated === 'string' ? updated : '',
        ...(typeof bound === 'string' ? { bound_to: bound } : {}),
      }
  }
  return doc
}

async function persist(path: string, doc: CredentialsDocument): Promise<void> {
  const tmp = `${path}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
    // `writeFile` keeps the mode of a leftover temporary file; restate it before the rename.
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (e) {
    throw new AtomicCoreError('IO_ERROR', `cannot write ${path}`, (e as Error).message)
  }
}
