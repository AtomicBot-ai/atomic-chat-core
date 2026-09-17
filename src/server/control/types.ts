/**
 * The control API's dependency surface: what the owner injects into the control server, and the
 * snapshot shape it answers with. Types and shared constants only.
 */

import type { CloudProviderInput, CloudProviderView, SubscriptionModel } from '../../cloud/index.js'
import type { ChatGptStatus } from '../../credentials/index.js'
import type {
  DeviceInfo,
  LocalApiServerState,
  LocalProviderId,
  SessionInfo,
  UnloadResult,
} from '../../contracts/index.js'
import type { CoreEmitter } from '../../events/index.js'
import type { CtxIncreaseResult } from '../../runtime/llamacpp/runtime.js'
import type { GgufValidation, ModelCapabilities } from '../../models/index.js'
import type { EmbeddingResponse } from '../../models/index.js'
import type { ProxyConfig } from '../../downloads/index.js'
import type { HardwareOverrideStore } from '../../hardware/index.js'
import type {
  InstallBackendResult,
  InstalledBackendPack,
  OptimalBackendCacheRecord,
} from '../../backend/index.js'
import type { OptimalState, OptimalUpdate } from '../../backend/index.js'
import type {
  ImportOptions,
  ImportResult,
  MigrationRecord,
  ProviderValues,
  UpdateResult,
} from '../../settings/index.js'
import type { ClientRegistry } from '../clients.js'
import type { ControlServer } from './server.js'

export const SSE_HEARTBEAT_MS = 15_000

export interface SessionSummary extends SessionInfo {
  provider: LocalProviderId
}

export interface PublicServerControl {
  status: () => LocalApiServerState
  start: (options: {
    host?: string
    port?: number
    prefix?: string
    apiKey?: string
    trustedHosts?: string[]
    proxyTimeoutSecs?: number
    writeStateFile?: boolean
    fallbackPort?: boolean
  }) => Promise<LocalApiServerState>
  stop: () => Promise<LocalApiServerState>
  /**
   * Whether the app's API screen is watching the public server. Previews of prompts and replies are
   * collected only while it is (ATO-113). Survives a server restart, like the app's own inspector.
   */
  setInspecting: (enabled: boolean) => void
}

/**
 * The settings surface the control API exposes. Narrower than `SettingsStore` on purpose: the app
 * reads a provider's values, patches them with a revision, and migrates its own copy across — it has
 * no business writing the migration bookkeeping directly.
 */
export interface SettingsControl {
  get: (provider: LocalProviderId) => ProviderValues
  revision: () => number
  migration: (scope: string) => MigrationRecord | null
  update: (
    provider: LocalProviderId,
    patch: ProviderValues,
    options: { expectedRevision?: number }
  ) => Promise<UpdateResult>
  importProvider: (
    provider: LocalProviderId,
    values: ProviderValues,
    options: ImportOptions
  ) => Promise<ImportResult>
  acknowledge: (scope: string, revision: number) => Promise<UpdateResult>
}

/**
 * The backend surface the app drives. Narrow on purpose: the updater screen installs, removes and
 * lists, and everything else it shows it computes from those three answers.
 */
export interface BackendControl {
  list: (provider: string, currentVersionBackend?: string) => Promise<InstalledBackendPack[]>
  install: (
    provider: string,
    version: string,
    backend: string,
    options: { taskId: string; force?: boolean; proxy?: ProxyConfig | null; assetName?: string }
  ) => Promise<InstallBackendResult>
  remove: (provider: string, version: string, backend: string) => Promise<boolean>
  cancel: (taskId: string) => boolean
  getOptimal: (provider: string) => Promise<OptimalState>
  setOptimal: (
    provider: string,
    record: OptimalBackendCacheRecord | null,
    expectedRevision: number
  ) => Promise<OptimalUpdate>
  optimalSnapshot: () => Record<string, OptimalState>
}

/**
 * The questions the app asks about models it has not loaded. Each answers rather than throws: the
 * caller is usually deciding what to show in a list, and one unreadable file must not empty it.
 */
export interface ModelControl {
  capabilities: (provider: string, modelId: string) => Promise<ModelCapabilities>
  validateGguf: (path: string) => Promise<GgufValidation>
  /** Devices the installed backend reports, which needs a backend to ask. */
  devices: (provider: string) => Promise<DeviceInfo[]>
  embed: (
    provider: string,
    modelId: string,
    input: string[],
    ubatchSize: number
  ) => Promise<EmbeddingResponse>
}

/** Engines another process owns, registered so the public server can route to them (stage 4d). */
export interface ExternalSessionControl {
  publish: (owner: string, generation: number, sessions: unknown) => { generation: number; sessions: number }
  heartbeat: (owner: string, generation: number) => { alive: boolean }
  unregister: (owner: string, generation?: number) => boolean
  list: () => unknown[]
  answerCtx: (owner: string, requestId: string, outcome: unknown) => boolean
}

/** Cloud providers the public server routes to (PLAN.md §4, stage 4c). Keys are never read back. */
export interface CloudControl {
  list: () => CloudProviderView[]
  upsert: (input: CloudProviderInput) => Promise<CloudProviderView>
  remove: (provider: string) => Promise<void>
}

/** The ChatGPT subscription session. Nothing here ever returns a token. */
export interface ChatGptControl {
  status: () => Promise<ChatGptStatus>
  reload?: () => Promise<ChatGptStatus>
  startLogin: () => Promise<{ authorize_url: string }>
  waitLogin: () => Promise<ChatGptStatus>
  cancelLogin: () => void
  logout: () => Promise<ChatGptStatus>
  models: () => Promise<SubscriptionModel[]>
}

export interface ControlServerDeps {
  token: string
  instanceId: string
  version: string
  ownerScope?: 'app' | 'cli'
  dataFolder: string
  emitter: CoreEmitter
  clients: ClientRegistry
  sessions: () => SessionSummary[]
  loadModel: (
    provider: string,
    modelId: string,
    body: Record<string, unknown>
  ) => Promise<SessionInfo | { session: SessionInfo; created: boolean }>
  unloadModel: (provider: string, modelId: string) => Promise<UnloadResult>
  /**
   * Reload a model one context step larger because a request overflowed. Answers rather than
   * throws when it declines: "the ladder is at its top" is an outcome the caller acts on, not an
   * error, and the proxy has to tell it apart from a failed reload.
   */
  increaseCtx: (provider: string, modelId: string, reason?: string) => Promise<CtxIncreaseResult>
  /**
   * Restart a model at the context it already has, because its engine is poisoned (a compute
   * failure). The app's extension asks for this when the core owns the runtime but the app's own
   * proxy saw the failure.
   */
  recreateSession: (provider: string, modelId: string) => Promise<{ ok: boolean; reason?: string }>
  publicServer: PublicServerControl
  /** The settings store, for the routes that read and migrate provider settings (PLAN.md §3.4). */
  settings: SettingsControl
  /** Hardware facts the app injects, which outrank the core's own probe (PLAN.md §2 decision 10). */
  hardware: HardwareOverrideStore
  /** Installing and removing llama.cpp backends (PLAN.md §4, stage 3c). */
  backends: BackendControl
  /** What a model is and can do, without loading it (PLAN.md §4, stage 3d). */
  models: ModelControl
  /**
   * Whether Apple's on-device model can run here: the server's own `--check` token (`available`,
   * `notEligible`, `appleIntelligenceNotEnabled`, `modelNotReady`, `unavailable`, `binaryNotFound`).
   * Answers `unavailable` on a platform without the runtime.
   */
  foundationModelsAvailability?: (force: boolean) => Promise<string>
  cloud: CloudControl
  chatgpt: ChatGptControl
  externalSessions: ExternalSessionControl
  /** Stop the whole core. The server has already answered by the time this runs. */
  shutdown: (options: { force: boolean; requestedBy?: string | undefined }) => Promise<void>
  startedAt?: number
  now?: () => number
}

export interface ControlSnapshot {
  instance_id: string
  owner_scope?: 'app' | 'cli' | undefined
  protocol: number
  version: string
  pid: number
  data_folder: string
  started_at: number
  uptime_ms: number
  cursor: string
  sessions: SessionSummary[]
  server: LocalApiServerState
  clients: ReturnType<ClientRegistry['list']>
  downloads: unknown[]
  optimal_backends: Record<string, OptimalState>
}

/**
 * What every route family shares, built once per router: the prefixed path helper, the clock the
 * uptime is measured with, the snapshot builder, and the server instance the events route attaches to.
 * Internal to this module; not re-exported.
 */
export interface ControlRouteContext {
  p: (suffix: string) => string
  now: () => number
  startedAt: number
  snapshot: () => ControlSnapshot
  /** The server being constructed; `undefined` until `ControlServer.start` has built it. */
  self: () => ControlServer | undefined
}
