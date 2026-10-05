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
 * How a document is fetched, accepted and cached — the version gate, the `file://`/`https://`-only
 * override, the lock-free atomic cache writes, "a failed cache write is not fatal" — is the shared
 * mechanism in `cached-document.ts` (change `extract-environment-manifest`, design D3), which the
 * environment manifest uses too. This file only says which document it is and turns the
 * mechanism's answer into this provider's API and messages. `ATOMIC_RUNTIME_DESCRIPTOR_URL`
 * overrides the source for development and tests. Nothing here ever removes a cache entry, which is
 * exactly why an installation's pinned descriptor survives a new release.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { RuntimeDescriptor } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import {
  createCachedDocuments,
  documentFetchFromFetch,
  meetsCoreVersion,
  type DocumentCacheFs,
  type DocumentFetch,
} from './cached-document.js'
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

/** One way of fetching the descriptor document; `timeoutMs` is the hard budget to honour. */
export type DescriptorFetch = DocumentFetch

/** A transport over a `fetch`-compatible function with an abort-on-timeout, matching the manifest's. */
export function descriptorFetchFromFetch(fetchImpl: typeof fetch): DescriptorFetch {
  return documentFetchFromFetch(fetchImpl, 'Runtime descriptor')
}

export interface DescriptorProviderOptions {
  /** Where `ATOMIC_RUNTIME_DESCRIPTOR_URL` is read from; the real process env in production. */
  env: Record<string, string | undefined>
  fetch: DescriptorFetch
  /** Reads a `file://…` override; rejects when the file does not exist or cannot be read. */
  readFile: (path: string) => Promise<string>
  fs?: DocumentCacheFs
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
  return meetsCoreVersion(descriptor.minimum_core_version, coreVersion)
}

/** Build the provider. Construction does no I/O; every network or disk access happens per call. */
export function createRuntimeDescriptorProvider(
  options: DescriptorProviderOptions
): RuntimeDescriptorProvider {
  const paths = managedSharedPaths(options.root)
  const documents = createCachedDocuments<RuntimeDescriptor>(
    {
      label: 'Runtime descriptor',
      urlEnv: RUNTIME_DESCRIPTOR_URL_ENV,
      parse: parseRuntimeDescriptor,
      idField: 'descriptor_id',
      id: (descriptor) => descriptor.descriptor_id,
      minimumCoreVersion: (descriptor) => descriptor.minimum_core_version,
      cacheDir: paths.descriptorsDir,
      cacheFile: paths.descriptorFile,
      latestFile: paths.descriptorLatestFile,
    },
    {
      env: options.env,
      fetch: options.fetch,
      readFile: options.readFile,
      url: options.url ?? DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
      ...(options.coreVersion === undefined ? {} : { coreVersion: options.coreVersion }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
    }
  )

  return {
    async forNewSetup(): Promise<DescriptorProviderResult> {
      const latest = await documents.latest()
      switch (latest.kind) {
        case 'fresh':
        case 'cached':
          return { kind: 'available', descriptor: latest.document }
        case 'too-new':
          return { kind: 'unsupported', error: updateRequired(latest.id) }
        case 'none':
          return { kind: 'unsupported', error: noDescriptorAvailable() }
      }
    },

    async forInstallation(descriptorId: string): Promise<DescriptorProviderResult> {
      const cached = await documents.cached(descriptorId)
      if (cached !== null) return { kind: 'available', descriptor: cached }
      return { kind: 'unsupported', error: missingPinnedDescriptor(descriptorId) }
    },

    async cachedForNewSetup(): Promise<DescriptorProviderResult> {
      const previous = await documents.latestCached()
      if (previous !== null) return { kind: 'available', descriptor: previous }
      return { kind: 'unsupported', error: noCachedDescriptor() }
    },
  }
}
