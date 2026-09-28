/**
 * Getting a runtime descriptor onto disk and keeping the right one in play (openspec change
 * `add-tensorrt-llm-linux`, task 2.3; spec `runtime-descriptor-catalog`, "Core получает и кэширует
 * дескриптор", "Установка закрепляет свой дескриптор", "Минимальные версии соблюдаются"; design D7).
 *
 * `descriptor.ts` (task 2.1) only checks shape; this file decides which bytes ever reach it, and
 * what happens to the result. Two rules shape the whole thing:
 *
 *   - A descriptor is accepted only when it parses AND its `minimum_core_version` is no higher than
 *     this build's own `CORE_VERSION`. An accepted descriptor is cached forever, keyed by its own
 *     `descriptor_id` — conf's own rule is that a `descriptor_id`'s content never changes, so the
 *     cached copy is exactly as good as a fresh fetch would be, on every later read.
 *   - An existing installation is pinned to the `descriptor_id` it was set up with
 *     (`RuntimeInstallation.active_descriptor_id`). `forInstallation` only ever reads that one
 *     descriptor back off the cache; it never calls `fetch`, so a new release published in conf
 *     cannot change, or even touch, an installed engine. `forNewSetup` is the only path that talks
 *     to the network, and only for a setup that has not pinned anything yet.
 *
 * Fetch transport follows the house pattern in `src/backend/catalog/manifest.ts`: an injected
 * `fetch`, a hard timeout, `raw.githubusercontent.com` of `AtomicBot-ai/atomic-chat-conf` `main`.
 * `ATOMIC_RUNTIME_DESCRIPTOR_URL` overrides the source for development and tests — only `file://…`
 * (read from disk through an injected `readFile`) and `https://…` (fetched) are accepted; anything
 * else, including a plain `http://`, is refused as a source and treated the same as "could not
 * fetch" — a descriptor is production-only network input, and a scheme this provider does not
 * recognise is not worth guessing about.
 *
 * The cache never deletes anything: this file only ever writes `descriptors/<descriptor_id>.json`
 * and repoints `descriptors/latest.json`, so an installation's pinned descriptor survives a new
 * release exactly because nothing here ever removes a cache entry (removing one is future work, for
 * whichever task cleans up an uninstalled engine's cache). The cache directory is shared by an app
 * core and a CLI core with no lock over it (unlike `store.ts`'s operation records): every write goes
 * through a per-call random temp name (the same convention as `execution-journal.ts`/
 * `optimal-store.ts`) so two concurrent accepts never contend for the same temp file, and a cache
 * write that fails for any other reason (disk full, permissions) is swallowed rather than failing
 * the whole resolution — the freshly fetched, already-validated descriptor is still good to hand
 * back even if this core could not persist it this time.
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
import { AtomicCoreError } from '../../contracts/index.js'
import type { RuntimeDescriptor } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import { CORE_VERSION } from '../../version.js'
import { parseRuntimeDescriptor } from './descriptor.js'

/** Overrides the descriptor source: `file://…` is read from disk, anything else is fetched. */
export const RUNTIME_DESCRIPTOR_URL_ENV = 'ATOMIC_RUNTIME_DESCRIPTOR_URL'

/**
 * The engine whose descriptor this provider serves: its default source is the TensorRT-LLM
 * descriptor, so the installation it pins is that engine's (task 2.6, carry item 4).
 */
export const TENSORRT_LLM_ENGINE_ID = 'tensorrt-llm'

/** conf main, the published TensorRT-LLM descriptor (controller ruling for task 2.3). */
export const DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/tensorrt-llm.json'

/** Matches `MANIFEST_FETCH_TIMEOUT_MS` (`src/backend/catalog/manifest.ts`): the house budget. */
export const DESCRIPTOR_FETCH_TIMEOUT_MS = 8_000

/** One way of fetching the descriptor document; `timeoutMs` is the hard budget to honour. */
export type DescriptorFetch = (url: string, timeoutMs: number) => Promise<Response>

/** A transport over a `fetch`-compatible function with an abort-on-timeout, matching the manifest's. */
export function descriptorFetchFromFetch(fetchImpl: typeof fetch): DescriptorFetch {
  return (url, timeoutMs) => {
    const controller = new AbortController()
    const request = fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    return withHardTimeout(
      request,
      timeoutMs,
      `Runtime descriptor fetch timed out after ${timeoutMs}ms`
    ).catch((err: unknown) => {
      controller.abort()
      throw err
    })
  }
}

/** The slice of `node:fs/promises` the cache needs; tests pass an in-memory fake. */
export interface DescriptorCacheFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: 'utf8'; mode?: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  /** Cleans up an orphaned temp file after a failed rename; never the source of truth for anything. */
  rm(path: string, options?: { force?: boolean }): Promise<void>
}

const NODE_FS: DescriptorCacheFs = {
  readFile: (path) => nodeReadFile(path, 'utf8'),
  writeFile: nodeWriteFile,
  rename: nodeRename,
  mkdir: nodeMkdir,
  rm: (path, options) => nodeRm(path, { force: options?.force ?? false }),
}

export interface DescriptorProviderOptions {
  /** Where `ATOMIC_RUNTIME_DESCRIPTOR_URL` is read from; the real process env in production. */
  env: Record<string, string | undefined>
  fetch: DescriptorFetch
  /** Reads a `file://…` override; rejects when the file does not exist or cannot be read. */
  readFile: (path: string) => Promise<string>
  fs?: DescriptorCacheFs
  /** The shared per-user managed root (`managedSharedRoot`); both scopes share one cache. */
  root: string
  /** This build's own version; defaults to `CORE_VERSION`. A test pins it to check the gate. */
  coreVersion?: string
  /** Default source when no override is set; defaults to the published TensorRT-LLM descriptor. */
  url?: string
  timeoutMs?: number
  /** A rejected source scheme or a failed cache write is never fatal; this is where it is reported. */
  onWarn?: (message: string) => void
}

export type DescriptorProviderResult =
  { kind: 'available'; descriptor: RuntimeDescriptor } | { kind: 'unsupported'; error: AtomicCoreError }

/** Give the descriptor provider a clear API: one path for a pinned installation, one for a fresh setup. */
export interface RuntimeDescriptorProvider {
  /**
   * The descriptor a fresh setup (or a probe before one) would use. Fetches from the configured
   * source; on any failure to obtain a newly *accepted* descriptor — network failure, an invalid
   * document, or one that needs a newer core than this build — falls back to the latest previously
   * accepted descriptor in the cache, without ever surfacing that fallback as an error. `fetch` is
   * never called by anything else in this provider — only this method reaches the network.
   */
  forNewSetup(): Promise<DescriptorProviderResult>
  /**
   * The exact descriptor a pinned installation was set up with. Reads the cache only — this never
   * calls `fetch` or `readFile`, so a release published in conf after this installation exists
   * cannot change what it resolves to, or even be noticed by this call.
   */
  forInstallation(descriptorId: string): Promise<DescriptorProviderResult>
  /**
   * What `forNewSetup()` would answer if it could not reach the network at all: the latest
   * previously accepted descriptor in the cache, or `unsupported` when nothing has ever been
   * accepted. Network-free like `forInstallation` — never calls `fetch` or `readFile` — so a caller
   * that only wants to know "what governs this environment right now" (e.g. the environment
   * snapshot's `minimum_app_version`) never pays for, or waits on, a fetch just to answer that.
   */
  cachedForNewSetup(): Promise<DescriptorProviderResult>
}

const noDescriptorAvailable = (): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_METADATA_INVALID',
    'No TensorRT-LLM runtime descriptor is available: the network is unreachable and nothing has been cached yet.'
  )

const noCachedDescriptor = (): AtomicCoreError =>
  new AtomicCoreError('MANAGED_METADATA_INVALID', 'No TensorRT-LLM runtime descriptor has been cached yet.')

const updateRequired = (descriptorId: string): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_METADATA_INVALID',
    'This TensorRT-LLM engine release requires a newer version of Atomic Chat; update required.',
    descriptorId
  )

const missingPinnedDescriptor = (descriptorId: string): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_METADATA_INVALID',
    'The runtime descriptor this installation was set up with is no longer cached.',
    descriptorId
  )

/** `minimum_core_version` no higher than this build's own version (design D7, numeric semver compare). */
export function descriptorMeetsCoreVersion(descriptor: RuntimeDescriptor, coreVersion: string): boolean {
  return compareVersions(coreVersion, descriptor.minimum_core_version) >= 0
}

/**
 * `file://…` → a filesystem path via `readFile`; `https://…` → via `fetch`. `null` on any failure,
 * including a scheme this provider does not accept (`http://` included — a descriptor is production
 * network input, and an unencrypted source is never treated as equivalent to the real one).
 */
async function readSource(
  url: string,
  deps: {
    fetch: DescriptorFetch
    readFile: (path: string) => Promise<string>
    timeoutMs: number
    onWarn: (message: string) => void
  }
): Promise<string | null> {
  try {
    if (url.startsWith('file://')) {
      return await deps.readFile(fileURLToPath(url))
    }
    if (url.startsWith('https://')) {
      const response = await deps.fetch(url, deps.timeoutMs)
      if (!response.ok) return null
      return await response.text()
    }
    deps.onWarn(`Runtime descriptor source "${url}" is neither file:// nor https://; ignoring it.`)
    return null
  } catch {
    return null
  }
}

/** `JSON.parse` + shape validation; `null` for anything that fails either. */
function parseDocument(raw: string): RuntimeDescriptor | null {
  try {
    return parseRuntimeDescriptor(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Write-then-rename with a per-call random temp name, never a fixed `<path>.tmp`: this cache has no
 * lock over it (an app core and a CLI core write it directly, unlike `store.ts`'s operation records
 * behind `environment.lock`), so two concurrent writers sharing one temp name would clobber each
 * other's bytes or hit `ENOENT` on whichever renames second. The convention matches
 * `execution-journal.ts`/`optimal-store.ts`. `path` itself may still collide between two concurrent
 * writers (e.g. `latest.json`, or the same `descriptor_id` accepted twice at once) — that rename is
 * a single filesystem syscall, so the loser's write is simply superseded, never torn.
 */
async function atomicWrite(
  fs: DescriptorCacheFs,
  dir: string,
  path: string,
  contents: string
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, path).catch(async (error: unknown) => {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  })
}

async function readCachedDescriptor(
  fs: DescriptorCacheFs,
  root: string,
  descriptorId: string
): Promise<RuntimeDescriptor | null> {
  try {
    const raw = await fs.readFile(managedSharedPaths(root).descriptorFile(descriptorId), 'utf8')
    return parseDocument(raw)
  } catch {
    return null
  }
}

async function readLatestAccepted(fs: DescriptorCacheFs, root: string): Promise<RuntimeDescriptor | null> {
  try {
    const raw = await fs.readFile(managedSharedPaths(root).descriptorLatestFile, 'utf8')
    const parsed = JSON.parse(raw) as { descriptor_id?: unknown }
    if (typeof parsed.descriptor_id !== 'string') return null
    return readCachedDescriptor(fs, root, parsed.descriptor_id)
  } catch {
    return null
  }
}

/** Cache the accepted document by its own id, and repoint `latest.json` at it (atomic writes). */
async function acceptDescriptor(
  fs: DescriptorCacheFs,
  root: string,
  raw: string,
  descriptor: RuntimeDescriptor
): Promise<void> {
  const paths = managedSharedPaths(root)
  await atomicWrite(fs, paths.descriptorsDir, paths.descriptorFile(descriptor.descriptor_id), raw)
  await atomicWrite(
    fs,
    paths.descriptorsDir,
    paths.descriptorLatestFile,
    `${JSON.stringify({ descriptor_id: descriptor.descriptor_id }, null, 2)}\n`
  )
}

/** Build the provider. Construction does no I/O; every network or disk access happens per call. */
export function createRuntimeDescriptorProvider(
  options: DescriptorProviderOptions
): RuntimeDescriptorProvider {
  const fs = options.fs ?? NODE_FS
  const root = options.root
  const coreVersion = options.coreVersion ?? CORE_VERSION
  const timeoutMs = options.timeoutMs ?? DESCRIPTOR_FETCH_TIMEOUT_MS
  const onWarn = options.onWarn ?? ((): void => undefined)
  const sourceUrl = (): string => {
    const override = options.env[RUNTIME_DESCRIPTOR_URL_ENV]
    if (override !== undefined && override.trim() !== '') return override.trim()
    return options.url ?? DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL
  }

  return {
    async forNewSetup(): Promise<DescriptorProviderResult> {
      const raw = await readSource(sourceUrl(), {
        fetch: options.fetch,
        readFile: options.readFile,
        timeoutMs,
        onWarn,
      })
      const fetched = raw === null ? null : parseDocument(raw)

      // `raw !== null` always holds when `fetched` does (parsing needs bytes to parse); spelling it
      // out here, rather than casting, is what lets `acceptDescriptor` take a plain `string` and
      // cache the exact bytes received — the literal published document, not a re-serialization.
      if (raw !== null && fetched !== null && descriptorMeetsCoreVersion(fetched, coreVersion)) {
        // A cache write that fails (disk full, permissions, a losing rename race) must not fail
        // this resolution: the descriptor was already fetched and validated, and is still good to
        // hand back even if this core could not persist it this time around.
        await acceptDescriptor(fs, root, raw, fetched).catch((error: unknown) => {
          onWarn(
            `Could not cache runtime descriptor ${fetched.descriptor_id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        })
        return { kind: 'available', descriptor: fetched }
      }

      const previous = await readLatestAccepted(fs, root)
      if (previous !== null) return { kind: 'available', descriptor: previous }

      if (fetched !== null) {
        // Parsed fine, but this build is too old for it, and nothing was ever accepted before.
        return { kind: 'unsupported', error: updateRequired(fetched.descriptor_id) }
      }
      return { kind: 'unsupported', error: noDescriptorAvailable() }
    },

    async forInstallation(descriptorId: string): Promise<DescriptorProviderResult> {
      const cached = await readCachedDescriptor(fs, root, descriptorId)
      if (cached !== null) return { kind: 'available', descriptor: cached }
      return { kind: 'unsupported', error: missingPinnedDescriptor(descriptorId) }
    },

    async cachedForNewSetup(): Promise<DescriptorProviderResult> {
      const previous = await readLatestAccepted(fs, root)
      if (previous !== null) return { kind: 'available', descriptor: previous }
      return { kind: 'unsupported', error: noCachedDescriptor() }
    },
  }
}
