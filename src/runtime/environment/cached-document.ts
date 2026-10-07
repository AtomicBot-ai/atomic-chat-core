/**
 * Getting one kind of conf document onto disk and keeping the right one in play — the mechanism
 * the runtime descriptor (`descriptor-provider.ts`) and the environment manifest
 * (`environment-manifest-provider.ts`) share (openspec change `extract-environment-manifest`, design
 * D3). Each provider only says which document it is: where it comes from, which variable overrides
 * that, how it parses, which field is its immutable id, and where its cache lives. Everything below
 * is the same for both, so a fix to one is a fix to the other.
 *
 * Two rules shape the whole thing:
 *
 *   - A document is accepted only when it parses AND its `minimum_core_version` is no higher than
 *     this build's own `CORE_VERSION`. An accepted document is cached forever, keyed by its own id —
 *     conf's own rule is that an id's content never changes, so the cached copy is exactly as good as
 *     a fresh fetch would be, on every later read.
 *   - Only `latest()` talks to the network. `cached(id)` and `latestCached()` read the cache alone,
 *     so whatever pinned an id (an installation, a consented operation) is never moved by a newer
 *     document published in conf, and never waits on a fetch.
 *
 * Fetch transport follows the house pattern in `src/backend/catalog/manifest.ts`: an injected
 * `fetch`, a hard timeout, `raw.githubusercontent.com` of `AtomicBot-ai/atomic-chat-conf` `main`. The
 * override variable accepts only `file://…` (read from disk through an injected `readFile`) and
 * `https://…` (fetched); anything else, including a plain `http://`, is refused as a source and
 * treated the same as "could not fetch" — the document is production-only network input, and a
 * scheme this mechanism does not recognise is not worth guessing about.
 *
 * The cache never deletes anything: this file only ever writes `<dir>/<id>.json` and repoints
 * `<dir>/latest.json`. The cache directory is shared by an app core and a CLI core with no lock over
 * it (unlike `store.ts`'s operation records): every write goes through a per-call random temp name
 * (the same convention as `execution-journal.ts`/`optimal-store.ts`) so two concurrent accepts never
 * contend for the same temp file, and a cache write that fails for any other reason (disk full,
 * permissions) is swallowed rather than failing the whole resolution — the freshly fetched,
 * already-validated document is still good to hand back even if this core could not persist it.
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  readFile as nodeReadFile,
  mkdir as nodeMkdir,
  rename as nodeRename,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from 'node:fs/promises'
import { compareVersions, withHardTimeout } from '../../backend/index.js'
import { CORE_VERSION } from '../../version.js'

/** Matches `MANIFEST_FETCH_TIMEOUT_MS` (`src/backend/catalog/manifest.ts`): the house budget. */
export const DOCUMENT_FETCH_TIMEOUT_MS = 8_000

/** One way of fetching a conf document; `timeoutMs` is the hard budget to honour. */
export type DocumentFetch = (url: string, timeoutMs: number) => Promise<Response>

/**
 * A transport over a `fetch`-compatible function with an abort-on-timeout, matching the catalog
 * manifest's. `label` names the document in the timeout message ("Runtime descriptor fetch timed out…").
 */
export function documentFetchFromFetch(fetchImpl: typeof fetch, label: string): DocumentFetch {
  return (url, timeoutMs) => {
    const controller = new AbortController()
    const request = fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    return withHardTimeout(request, timeoutMs, `${label} fetch timed out after ${timeoutMs}ms`).catch(
      (err: unknown) => {
        controller.abort()
        throw err
      }
    )
  }
}

/** The slice of `node:fs/promises` the cache needs; tests pass an in-memory fake. */
export interface DocumentCacheFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: 'utf8'; mode?: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  /** Cleans up an orphaned temp file after a failed rename; never the source of truth for anything. */
  rm(path: string, options?: { force?: boolean }): Promise<void>
}

const NODE_FS: DocumentCacheFs = {
  readFile: (path) => nodeReadFile(path, 'utf8'),
  writeFile: nodeWriteFile,
  rename: nodeRename,
  mkdir: nodeMkdir,
  rm: (path, options) => nodeRm(path, { force: options?.force ?? false }),
}

/** Which document this is: everything that differs between a descriptor and a manifest. */
export interface CachedDocumentKind<T> {
  /** Names the document in warnings: "Runtime descriptor", "Environment manifest". */
  label: string
  /**
   * The variable that overrides the source, e.g. `ATOMIC_RUNTIME_DESCRIPTOR_URL`; or several, the
   * first one set winning (a descriptor's per-engine variable, then the legacy one).
   */
  urlEnv: string | readonly string[]
  /** Throws on anything that is not a valid document of this kind. */
  parse(input: unknown): T
  /** The document's immutable id field, e.g. `descriptor_id`; also the key `latest.json` holds. */
  idField: string
  id(document: T): string
  minimumCoreVersion(document: T): string
  /** The cache directory, one document's file in it, and `latest.json`. */
  cacheDir: string
  cacheFile(id: string): string
  latestFile: string
  /**
   * Pointers an older core wrote, read in order only while `latestFile` does not exist yet; a
   * pointer whose document `parse` rejects (another engine's descriptor) counts as absent.
   */
  legacyLatestFiles?: readonly string[]
}

export interface CachedDocumentOptions {
  /** Where the override variable is read from; the real process env in production. */
  env: Record<string, string | undefined>
  fetch: DocumentFetch
  /** Reads a `file://…` override; rejects when the file does not exist or cannot be read. */
  readFile: (path: string) => Promise<string>
  fs?: DocumentCacheFs
  /** This build's own version; defaults to `CORE_VERSION`. A test pins it to check the gate. */
  coreVersion?: string
  /** The source when no override is set: conf main's published document. */
  url: string
  timeoutMs?: number
  /** A rejected source scheme or a failed cache write is never fatal; this is where it is reported. */
  onWarn?: (message: string) => void
}

/**
 * What `latest()` found. `fresh` — fetched and accepted now; `cached` — the fetch gave nothing
 * acceptable, the latest previously accepted document stands in (never an error); `too-new` — the
 * fetched document parsed but needs a newer core, and nothing was ever accepted before; `none` —
 * nothing to fetch and nothing cached.
 */
export type LatestDocument<T> =
  | { kind: 'fresh'; document: T }
  | { kind: 'cached'; document: T }
  | { kind: 'too-new'; id: string }
  | { kind: 'none' }

export interface CachedDocuments<T> {
  /** Fetch from the configured source; on any failure to obtain a newly accepted one, the cache. */
  latest(): Promise<LatestDocument<T>>
  /** One accepted document by id, from the cache alone: no fetch, no `readFile`. */
  cached(id: string): Promise<T | null>
  /** What `latest()` would fall back to: the newest accepted document, from the cache alone. */
  latestCached(): Promise<T | null>
}

/** `minimum_core_version` no higher than this build's own version (numeric semver compare). */
export function meetsCoreVersion(minimumCoreVersion: string, coreVersion: string): boolean {
  return compareVersions(coreVersion, minimumCoreVersion) >= 0
}

/**
 * Write-then-rename with a per-call random temp name, never a fixed `<path>.tmp`: this cache has no
 * lock over it, so two concurrent writers sharing one temp name would clobber each other's bytes or
 * hit `ENOENT` on whichever renames second. `path` itself may still collide between two concurrent
 * writers (`latest.json`, or the same id accepted twice at once) — that rename is a single
 * filesystem syscall, so the loser's write is simply superseded, never torn.
 */
async function atomicWrite(fs: DocumentCacheFs, dir: string, path: string, contents: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, path).catch(async (error: unknown) => {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  })
}

/** Build the mechanism for one kind. Construction does no I/O; every access happens per call. */
export function createCachedDocuments<T>(
  kind: CachedDocumentKind<T>,
  options: CachedDocumentOptions
): CachedDocuments<T> {
  const fs = options.fs ?? NODE_FS
  const coreVersion = options.coreVersion ?? CORE_VERSION
  const timeoutMs = options.timeoutMs ?? DOCUMENT_FETCH_TIMEOUT_MS
  const onWarn = options.onWarn ?? ((): void => undefined)
  // `latest()` runs on every probe: the same warning is written once per process, not per call.
  const warned = new Set<string>()
  const warnOnce = (message: string): void => {
    if (warned.has(message)) return
    warned.add(message)
    onWarn(message)
  }

  const urlEnvs: readonly string[] = typeof kind.urlEnv === 'string' ? [kind.urlEnv] : kind.urlEnv
  const sourceUrl = (): string => {
    for (const variable of urlEnvs) {
      const override = options.env[variable]
      if (override === undefined || override.trim() === '') continue
      // A pinned source silently hides every newer document conf publishes (a test machine kept a
      // commit-pinned descriptor URL and never saw the next one, 2026-10-06): say so in the log.
      warnOnce(
        `${kind.label} source is overridden by ${variable}=${override.trim()}; ${options.url} is not read.`
      )
      return override.trim()
    }
    return options.url
  }

  /** `JSON.parse` + shape validation; `null` for anything that fails either. */
  const parse = (raw: string): T | null => parseWithProblem(raw).document

  const parseWithProblem = (raw: string): { document: T | null; problem: string | null } => {
    try {
      return { document: kind.parse(JSON.parse(raw)), problem: null }
    } catch (error) {
      return { document: null, problem: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * `file://…` via `readFile`, `https://…` via `fetch`; on any failure or another scheme no text,
   * and why, for the warning `latest()` writes when it falls back.
   */
  const readSource = async (url: string): Promise<{ raw: string } | { problem: string }> => {
    try {
      if (url.startsWith('file://')) return { raw: await options.readFile(fileURLToPath(url)) }
      if (url.startsWith('https://')) {
        const response = await options.fetch(url, timeoutMs)
        if (!response.ok) return { problem: `HTTP ${response.status}` }
        return { raw: await response.text() }
      }
      return { problem: 'the source is neither file:// nor https://' }
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) }
    }
  }

  const cached = async (id: string): Promise<T | null> => {
    try {
      return parse(await fs.readFile(kind.cacheFile(id), 'utf8'))
    } catch {
      return null
    }
  }

  /** The id a pointer file names: `undefined` when the file is absent, `null` when it is unreadable. */
  const pointedId = async (file: string): Promise<string | null | undefined> => {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return undefined
    }
    try {
      const id = (JSON.parse(text) as Record<string, unknown>)[kind.idField]
      return typeof id === 'string' ? id : null
    } catch {
      return null
    }
  }

  const latestCached = async (): Promise<T | null> => {
    const current = await pointedId(kind.latestFile)
    if (current !== undefined) return current === null ? null : await cached(current)
    for (const legacy of kind.legacyLatestFiles ?? []) {
      const id = await pointedId(legacy)
      const document = typeof id === 'string' ? await cached(id) : null
      if (document !== null) return document
    }
    return null
  }

  /** Cache the accepted document's exact bytes by its own id, and repoint `latestFile` at it. */
  const accept = async (raw: string, document: T): Promise<void> => {
    const id = kind.id(document)
    await atomicWrite(fs, kind.cacheDir, kind.cacheFile(id), raw)
    await atomicWrite(
      fs,
      kind.cacheDir,
      kind.latestFile,
      `${JSON.stringify({ [kind.idField]: id }, null, 2)}\n`
    )
  }

  return {
    async latest(): Promise<LatestDocument<T>> {
      const url = sourceUrl()
      const source = await readSource(url)
      const raw = 'raw' in source ? source.raw : null
      const parsed = raw === null ? null : parseWithProblem(raw)
      const fetched = parsed?.document ?? null

      // `raw !== null` always holds when `fetched` does; spelling it out is what lets `accept` cache
      // the exact bytes received — the literal published document, not a re-serialization.
      if (
        raw !== null &&
        fetched !== null &&
        meetsCoreVersion(kind.minimumCoreVersion(fetched), coreVersion)
      ) {
        await accept(raw, fetched).catch((error: unknown) => {
          onWarn(
            `Could not cache ${kind.label.toLowerCase()} ${kind.id(fetched)}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        })
        return { kind: 'fresh', document: fetched }
      }

      const previous = await latestCached()
      // Falling back is never an error to the caller, but it must not be invisible either.
      const why =
        'problem' in source
          ? `could not be read (${source.problem})`
          : fetched === null
            ? `is not a valid ${kind.label.toLowerCase()} (${parsed?.problem ?? 'unreadable'})`
            : `is ${kind.id(fetched)}, which needs core ${kind.minimumCoreVersion(fetched)} (this is ${coreVersion})`
      warnOnce(
        `${kind.label} from ${url} ${why}; ${
          previous === null ? 'none is cached' : `using the cached ${kind.id(previous)}`
        }.`
      )
      if (previous !== null) return { kind: 'cached', document: previous }
      // Parsed fine, but this build is too old for it, and nothing was ever accepted before.
      if (fetched !== null) return { kind: 'too-new', id: kind.id(fetched) }
      return { kind: 'none' }
    },
    cached,
    latestCached,
  }
}
