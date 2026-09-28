/**
 * The seam between the engine-neutral managed-text lifecycle (`lifecycle.ts`) and one containerized
 * engine (openspec change `add-tensorrt-llm-linux`, task 2.12; the TensorRT-LLM adapter is task 2.13).
 *
 * An adapter is compiled into core and looked up by the `adapter_id` a pinned runtime descriptor
 * names — never loaded from metadata. Everything engine-specific the lifecycle needs goes through
 * this interface: the engine's argv and port, how to tell it is ready, which log lines mark its
 * progress, how long it may take, and what its exit meant. The lifecycle itself holds no
 * `engine_id` branch anywhere; a second engine is a second adapter, not an `if`.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelFamilySupport, SessionLoadStage } from '../../contracts/index.js'
import type { EngineLaunchSpec } from './types.js'

/** The adapter contract this core implements; a descriptor's `adapter_contract_version` must match. */
export const MANAGED_TEXT_ADAPTER_CONTRACT_VERSION = 1

/**
 * The load stages an engine's own log can move a load into. `stopping-previous` and `ready` belong
 * to the lifecycle alone: the first happens before any container exists, the second only once the
 * readiness probe answers.
 */
export type EngineLoadStage = Extract<SessionLoadStage, 'starting-container' | 'initializing-engine'>

/**
 * A log line that tells the lifecycle the engine reached `stage`. With no markers the lifecycle moves
 * to `initializing-engine` as soon as the container starts; with markers it stays in
 * `starting-container` until one of them shows up in the container's log.
 */
export interface ManagedStageMarker {
  stage: EngineLoadStage
  pattern: RegExp
}

/** An HTTP GET against the engine's server root that answers `expectedStatus` once it can serve. */
export interface ManagedReadinessProbe {
  /** Absolute path, no query, no `..`: joined onto the internal `BackendTarget`, never a full URL. */
  path: string
  /** A 2xx status. A redirect is never readiness: the probe does not follow redirects at all. */
  expectedStatus: number
}

/** What an adapter is told when it builds a launch. Container paths are fixed by the executor. */
export interface ManagedLaunchContext<S> {
  modelId: string
  settings: S
  /** The model directory as the container sees it, mounted read-only. */
  modelPath: string
  /** The engine cache directory as the container sees it, mounted read-write and kept across loads. */
  engineCachePath: string
  weightBytes: number
  /** The pinned descriptor's `model_families` entry for this model's architecture, or null. */
  family: ModelFamilySupport | null
}

export interface ManagedEngineLaunch {
  engine: EngineLaunchSpec
  /** The engine's own argv. The container runs `<watchdog entrypoint> -- <argv>`. */
  argv: string[]
  /** Engine env vars; the watchdog's own `ATOMIC_WATCHDOG_*` vars are the lifecycle's and win. */
  env?: Record<string, string>
}

export type ManagedExitKind = 'out-of-memory' | 'unsupported-model' | 'other'

/** What an engine's exit before readiness meant, read from its log tail and exit code. */
export interface ManagedExitClassification {
  kind: ManagedExitKind
  /** Human wording, including whatever numbers the log gave (e.g. requested vs. free memory). */
  message: string
  /** The numbers behind `message`, for a caller that wants to render them itself. */
  numbers?: Record<string, number>
}

/** What a loaded model can do through this engine (spec `tensorrt-llm-runtime`, design D9). */
export interface ManagedTextCapabilities {
  tools: boolean
  reasoning: boolean
  structured_output: boolean
  vision: boolean
  embeddings: boolean
  responses: boolean
}

/**
 * One containerized text engine. `S` is the adapter's own validated settings shape; the lifecycle
 * treats it as opaque and only ever hands back what `validateSettings` returned.
 */
export interface ManagedTextAdapter<S = unknown> {
  /** Matches the descriptor's `adapter_id`. */
  readonly id: string
  /** Matches the descriptor's `adapter_contract_version`. */
  readonly contractVersion: number
  readonly readiness: ManagedReadinessProbe
  readonly stageMarkers: readonly ManagedStageMarker[]
  /** Throws `AtomicCoreError('INVALID_ARGUMENT', ...)` before any container exists. */
  validateSettings(raw: unknown): S
  buildLaunch(context: ManagedLaunchContext<S>): ManagedEngineLaunch
  /** How long readiness may take for this much weight, with margin; a provider setting overrides it. */
  readinessTimeoutMs(weightBytes: number, settings: S): number
  classifyExit(logTail: string, exitCode: number | null): ManagedExitClassification
  capabilities(context: { settings: S; family: ModelFamilySupport | null }): ManagedTextCapabilities
}

const READINESS_PATH = /^\/(?!\/)[A-Za-z0-9._~/-]*$/

function invalid(message: string, detail: string): never {
  throw new AtomicCoreError('INVALID_ARGUMENT', message, detail)
}

function assertAdapterShape(adapter: ManagedTextAdapter): void {
  if (adapter.id === '') invalid('A managed text adapter needs an id.', adapter.id)
  if (!Number.isInteger(adapter.contractVersion) || adapter.contractVersion < 1) {
    invalid('A managed text adapter contract version is a positive integer.', String(adapter.contractVersion))
  }
  const { path, expectedStatus } = adapter.readiness
  if (!READINESS_PATH.test(path) || path.split('/').some((segment) => segment === '..')) {
    invalid('A readiness path is an absolute path with no query, fragment or `..`.', path)
  }
  if (!Number.isInteger(expectedStatus) || expectedStatus < 200 || expectedStatus > 299) {
    invalid('A readiness probe expects a 2xx status.', String(expectedStatus))
  }
}

/** The adapters compiled into this core, keyed by `adapter_id`. */
export class ManagedTextAdapterRegistry {
  private readonly adapters = new Map<string, ManagedTextAdapter>()

  register(adapter: ManagedTextAdapter): void {
    assertAdapterShape(adapter)
    if (this.adapters.has(adapter.id)) {
      invalid('A managed text adapter with this id is already registered.', adapter.id)
    }
    this.adapters.set(adapter.id, adapter)
  }

  has(adapterId: string): boolean {
    return this.adapters.has(adapterId)
  }

  ids(): string[] {
    return [...this.adapters.keys()]
  }

  /**
   * The adapter a pinned descriptor asks for. An id this core does not know, or a contract version
   * it does not implement, is `MANAGED_ADAPTER_UNAVAILABLE`: the installation cannot be served by
   * this core, whatever the descriptor says.
   */
  resolve(adapterId: string, contractVersion?: number): ManagedTextAdapter {
    const adapter = this.adapters.get(adapterId)
    if (adapter === undefined) {
      throw new AtomicCoreError(
        'MANAGED_ADAPTER_UNAVAILABLE',
        'This core has no adapter for the engine this installation needs.',
        adapterId
      )
    }
    if (contractVersion !== undefined && contractVersion !== adapter.contractVersion) {
      throw new AtomicCoreError(
        'MANAGED_ADAPTER_UNAVAILABLE',
        'The installation needs a different adapter contract version than this core implements.',
        `${adapterId}: wants ${contractVersion}, core implements ${adapter.contractVersion}`
      )
    }
    return adapter
  }
}
