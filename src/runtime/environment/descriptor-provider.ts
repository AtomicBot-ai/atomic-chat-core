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
 * mechanism's answer into this provider's API and messages. Nothing here ever removes a cache entry,
 * which is exactly why an installation's pinned descriptor survives a new release.
 *
 * One descriptor per engine (change `add-vllm-runtime`, design D2; spec `runtime-descriptor-catalog`,
 * "Core получает и кэширует дескриптор"): every engine core has an adapter for has its own source
 * (`runtimes/<engine_id>.json`), its own override `ATOMIC_RUNTIME_DESCRIPTOR_URL_<ENGINE>` (the
 * legacy `ATOMIC_RUNTIME_DESCRIPTOR_URL` still moves `tensorrt-llm`'s) and its own "last accepted"
 * pointer `descriptors/latest-<engine_id>.json`. The cache by `descriptor_id` stays one folder, so
 * `forInstallation(id)` does not need to know the engine. A document whose `engine_id` is not the
 * engine it was fetched for is rejected on receipt, like any invalid document; one engine's source
 * being unreachable never touches another's answer.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { RuntimeDescriptor } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import {
  createCachedDocuments,
  documentFetchFromFetch,
  meetsCoreVersion,
  type CachedDocuments,
  type DocumentCacheFs,
  type DocumentFetch,
} from './cached-document.js'
import { parseRuntimeDescriptor } from './descriptor.js'

/** The legacy override: still moves the `tensorrt-llm` source (e2e, `docs/`, manual checks). */
export const RUNTIME_DESCRIPTOR_URL_ENV = 'ATOMIC_RUNTIME_DESCRIPTOR_URL'

/** `ATOMIC_RUNTIME_DESCRIPTOR_URL_<ENGINE>`: the engine id upper-cased, `-` as `_`. */
export function runtimeDescriptorUrlEnv(engineId: string): string {
  return `${RUNTIME_DESCRIPTOR_URL_ENV}_${engineId.toUpperCase().replace(/-/g, '_')}`
}

/** The variables that override one engine's source, in the order they win. */
export function runtimeDescriptorUrlEnvs(engineId: string): string[] {
  return engineId === TENSORRT_LLM_ENGINE_ID
    ? [runtimeDescriptorUrlEnv(engineId), RUNTIME_DESCRIPTOR_URL_ENV]
    : [runtimeDescriptorUrlEnv(engineId)]
}

/** The TensorRT-LLM engine: the first managed engine, and the one the legacy pointer and variable mean. */
export const TENSORRT_LLM_ENGINE_ID = 'tensorrt-llm'

/** conf main, the published TensorRT-LLM descriptor (controller ruling for task 2.3). */
export const DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/tensorrt-llm.json'

/** conf main's published descriptor of one engine: `runtimes/<engine_id>.json`. */
export function defaultDescriptorUrl(engineId: string): string {
  return `https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/${engineId}.json`
}

/** Where one engine's descriptor comes from: its id, the name messages use, and conf main's file. */
export interface DescriptorSource {
  engine_id: string
  /** "TensorRT-LLM", "vLLM": the engine in messages. */
  label: string
  url: string
}

export const TENSORRT_LLM_DESCRIPTOR_SOURCE: DescriptorSource = {
  engine_id: TENSORRT_LLM_ENGINE_ID,
  label: 'TensorRT-LLM',
  url: DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL,
}

/** One way of fetching the descriptor document; `timeoutMs` is the hard budget to honour. */
export type DescriptorFetch = DocumentFetch

/** A transport over a `fetch`-compatible function with an abort-on-timeout, matching the manifest's. */
export function descriptorFetchFromFetch(fetchImpl: typeof fetch): DescriptorFetch {
  return documentFetchFromFetch(fetchImpl, 'Runtime descriptor')
}

export interface DescriptorProviderOptions {
  /** Where the override variables are read from; the real process env in production. */
  env: Record<string, string | undefined>
  fetch: DescriptorFetch
  /** Reads a `file://…` override; rejects when the file does not exist or cannot be read. */
  readFile: (path: string) => Promise<string>
  fs?: DocumentCacheFs
  /** The shared per-user managed root (`managedSharedRoot`); both scopes share one cache. */
  root: string
  /** This build's own version; defaults to `CORE_VERSION`. A test pins it to check the gate. */
  coreVersion?: string
  /** The engines core has an adapter for, each with its source; defaults to TensorRT-LLM alone. */
  engines?: readonly DescriptorSource[] | undefined
  timeoutMs?: number
  /** A rejected source scheme or a failed cache write is never fatal; this is where it is reported. */
  onWarn?: (message: string) => void
}

export type DescriptorProviderResult =
  { kind: 'available'; descriptor: RuntimeDescriptor } | { kind: 'unsupported'; error: AtomicCoreError }

/** Give the descriptor provider a clear API: one path for a pinned installation, one for a fresh setup. */
export interface RuntimeDescriptorProvider {
  /** The engines this provider has a source for, in registration order. */
  readonly engines: readonly DescriptorSource[]
  /**
   * The descriptor a fresh setup of `engineId` (or a probe before one) would use. Fetches from that
   * engine's source; on any failure to obtain a newly *accepted* descriptor — network failure, an
   * invalid document, another engine's document, or one that needs a newer core than this build —
   * falls back to that engine's latest previously accepted descriptor in the cache, without ever
   * surfacing that fallback as an error. `fetch` is never called by anything else in this provider.
   */
  forNewSetup(engineId: string): Promise<DescriptorProviderResult>
  /**
   * The exact descriptor a pinned installation was set up with. Reads the cache only — this never
   * calls `fetch` or `readFile`, so a release published in conf after this installation exists
   * cannot change what it resolves to, or even be noticed by this call.
   */
  forInstallation(descriptorId: string): Promise<DescriptorProviderResult>
  /**
   * What `forNewSetup(engineId)` would answer if it could not reach the network at all: that
   * engine's latest previously accepted descriptor in the cache, or `unsupported` when nothing has
   * ever been accepted for it. Network-free like `forInstallation` — never calls `fetch` or
   * `readFile` — so a caller that only wants to know "what governs this engine right now" (the
   * compatibility check, the snapshot's `minimum_app_version`) never pays for, or waits on, a fetch.
   */
  cachedForNewSetup(engineId: string): Promise<DescriptorProviderResult>
}

const noSource = (engineId: string): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_METADATA_INVALID',
    `This core has no runtime descriptor source for ${engineId}.`
  )

const noDescriptorAvailable = (label: string): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_METADATA_INVALID',
    `No ${label} runtime descriptor is available: the network is unreachable or it is not published yet, and nothing has been cached.`
  )

const noCachedDescriptor = (label: string): AtomicCoreError =>
  new AtomicCoreError('MANAGED_METADATA_INVALID', `No ${label} runtime descriptor has been cached yet.`)

const updateRequired = (label: string, descriptorId: string): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_METADATA_INVALID',
    `This ${label} engine release requires a newer version of Atomic Chat; update required.`,
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
  const engines = options.engines ?? [TENSORRT_LLM_DESCRIPTOR_SOURCE]

  const shared = {
    env: options.env,
    fetch: options.fetch,
    readFile: options.readFile,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.coreVersion === undefined ? {} : { coreVersion: options.coreVersion }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
  }
  const documentsOf = (source: DescriptorSource): CachedDocuments<RuntimeDescriptor> =>
    createCachedDocuments<RuntimeDescriptor>(
      {
        label: `${source.label} runtime descriptor`,
        urlEnv: runtimeDescriptorUrlEnvs(source.engine_id),
        parse: (input) => {
          const descriptor = parseRuntimeDescriptor(input)
          if (descriptor.engine_id !== source.engine_id) {
            throw new Error(
              `descriptor ${descriptor.descriptor_id} is for ${descriptor.engine_id}, not ${source.engine_id}`
            )
          }
          return descriptor
        },
        idField: 'descriptor_id',
        id: (descriptor) => descriptor.descriptor_id,
        minimumCoreVersion: (descriptor) => descriptor.minimum_core_version,
        cacheDir: paths.descriptorsDir,
        cacheFile: paths.descriptorFile,
        latestFile: paths.descriptorLatestFileFor(source.engine_id),
        ...(source.engine_id === TENSORRT_LLM_ENGINE_ID
          ? { legacyLatestFiles: [paths.descriptorLatestFile] }
          : {}),
      },
      { ...shared, url: source.url }
    )
  const byEngine = new Map(
    engines.map((source) => [source.engine_id, { source, documents: documentsOf(source) }] as const)
  )
  // Any engine's parse accepts any descriptor for the cache-by-id read: a pinned installation names
  // its own descriptor, and `forInstallation` never needs to know which engine that is.
  const anyDocuments = createCachedDocuments<RuntimeDescriptor>(
    {
      label: 'Runtime descriptor',
      urlEnv: [],
      parse: parseRuntimeDescriptor,
      idField: 'descriptor_id',
      id: (descriptor) => descriptor.descriptor_id,
      minimumCoreVersion: (descriptor) => descriptor.minimum_core_version,
      cacheDir: paths.descriptorsDir,
      cacheFile: paths.descriptorFile,
      latestFile: paths.descriptorLatestFile,
    },
    { ...shared, url: '' }
  )

  return {
    engines,

    async forNewSetup(engineId: string): Promise<DescriptorProviderResult> {
      const entry = byEngine.get(engineId)
      if (entry === undefined) return { kind: 'unsupported', error: noSource(engineId) }
      const latest = await entry.documents.latest()
      switch (latest.kind) {
        case 'fresh':
        case 'cached':
          return { kind: 'available', descriptor: latest.document }
        case 'too-new':
          return { kind: 'unsupported', error: updateRequired(entry.source.label, latest.id) }
        case 'none':
          return { kind: 'unsupported', error: noDescriptorAvailable(entry.source.label) }
      }
    },

    async forInstallation(descriptorId: string): Promise<DescriptorProviderResult> {
      const cached = await anyDocuments.cached(descriptorId)
      if (cached !== null) return { kind: 'available', descriptor: cached }
      return { kind: 'unsupported', error: missingPinnedDescriptor(descriptorId) }
    },

    async cachedForNewSetup(engineId: string): Promise<DescriptorProviderResult> {
      const entry = byEngine.get(engineId)
      if (entry === undefined) return { kind: 'unsupported', error: noSource(engineId) }
      const previous = await entry.documents.latestCached()
      if (previous !== null) return { kind: 'available', descriptor: previous }
      return { kind: 'unsupported', error: noCachedDescriptor(entry.source.label) }
    },
  }
}
