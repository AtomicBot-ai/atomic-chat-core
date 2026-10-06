/**
 * The control API's dependency surface: what the owner injects into the control server, and the
 * snapshot shape it answers with. Types and shared constants only.
 */

import type { CloudProviderInput, CloudProviderView, SubscriptionModel } from '../../cloud/index.js'
import type { ChatGptStatus } from '../../credentials/index.js'
import type {
  BeginOperation,
  DecisionDecideRequest,
  DecisionOutcome,
  DecisionScoreRequest,
  DecisionSettings,
  DecisionStatus,
  RouterScoreResponse,
  SystemoneResponse,
  DeviceInfo,
  DiffusionBackendInstallRecord,
  DiffusionCancelResult,
  DiffusionConfig,
  DiffusionModelFile,
  DiffusionStatus,
  EnvironmentDiagnostics,
  EnvironmentOperation,
  EnvironmentResetResult,
  EnvironmentSnapshot,
  FinalizeBackendInstallArgs,
  GalleryFlags,
  GalleryImageItem,
  GalleryListOptions,
  GalleryPage,
  ImageCapabilities,
  ImageGenerateRequest,
  ImageJob,
  LoadDiffusionModelRequest,
  LoadedDiffusionModel,
  VideoCapabilities,
  VideoEstimate,
  VideoGalleryPage,
  VideoGenerateRequest,
  VideoJob,
  GalleryVideoItem,
  HardwareInfoResponse,
  HardwareOverride,
  HardwareOverrideInput,
  LocalApiServerState,
  LocalProviderId,
  ManagedHostReceipt,
  ModelCompatibility,
  ManagedModelDeletion,
  ManagedModelLocation,
  ProbeEnvironmentInput,
  RemoteAccessStatus,
  RequirementPlan,
  ResumeOperation,
  RuntimeDescriptorSummary,
  SessionInfo,
  UnloadResult,
} from '../../contracts/index.js'
import type { CoreEmitter } from '../../events/index.js'
import type { CtxIncreaseResult } from '../../runtime/llamacpp/runtime.js'
import type { GgufValidation, ModelCapabilities } from '../../models/index.js'
import type { EmbeddingResponse } from '../../models/index.js'
import type { ProxyConfig } from '../../downloads/index.js'
import type { TelemetryControl } from '../../telemetry/index.js'
import type {
  BackendCatalogRequest,
  BackendCatalogResponse,
  BackendRecommendationRequest,
  BackendRecommendationResponse,
  BackendUpdateCheckRequest,
  BackendUpdateCheckResponse,
} from '../../contracts/index.js'
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

/**
 * The managed container runtime, as the control API needs it (openspec change
 * `add-tensorrt-llm-linux`, task 2.2). A narrow view on purpose: the control layer does not depend
 * on the runtime module's class, and a build with no managed runtime wired simply leaves it out.
 */
export interface ManagedEnvironmentControl {
  list(): Promise<EnvironmentSnapshot[]>
  probe(input: ProbeEnvironmentInput): Promise<RequirementPlan>
  /** One cached runtime descriptor, read from the core's cache only, never fetched (task 2.22). */
  descriptor(descriptorId: string): Promise<RuntimeDescriptorSummary>
  begin(environmentId: string, input: BeginOperation): Promise<EnvironmentOperation>
  get(operationId: string): Promise<EnvironmentOperation>
  cancel(operationId: string): Promise<EnvironmentOperation>
  resume(operationId: string, input: ResumeOperation): Promise<EnvironmentOperation>
  acceptHostReceipt(operationId: string, receipt: ManagedHostReceipt): Promise<EnvironmentOperation>
  /** Archive the finished operations; nothing installed is touched. */
  reset(environmentId: string): Promise<EnvironmentResetResult>
  /** A read-only report for a support message. */
  diagnostics(environmentId: string): Promise<EnvironmentDiagnostics>
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
 * The backend surface the app drives: the updater screen installs, removes and lists, and asks the
 * advisor three questions (what fits this machine, what is recommended, is there an update) that it
 * used to answer itself (ADR 2026-09-27). When to act on the answers stays the app's decision.
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
  catalog: (provider: string, request: BackendCatalogRequest) => Promise<BackendCatalogResponse>
  recommend: (
    provider: string,
    request: BackendRecommendationRequest
  ) => Promise<BackendRecommendationResponse>
  checkUpdates: (provider: string, request: BackendUpdateCheckRequest) => Promise<BackendUpdateCheckResponse>
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
  /**
   * `GET /models/:provider/:id/logs`: a container-backed model's recent log lines — the loaded
   * container's, or the last failed attempt's until the next load (spec `tensorrt-llm-runtime`,
   * "Логи контейнера доступны"). Throws `PROVIDER_NOT_FOUND` for a provider that keeps none; absent
   * in a build that has no such provider at all.
   */
  logs?: (provider: string, modelId: string) => Promise<object>
}

/**
 * The machine as the core measured it (`GET /hardware/info`, `POST /hardware/refresh`) and the
 * override a host may inject in its place (`/hardware/override`). Reads never throw: a probe that
 * failed answers what it could read plus `warnings`.
 */
export interface HardwareControl {
  info: () => Promise<HardwareInfoResponse>
  /** Probe again and answer with the new description. */
  refresh: () => Promise<HardwareInfoResponse>
  getOverride: () => HardwareOverride | undefined
  /** Throws `INVALID_ARGUMENT` for a payload it cannot read; nothing is applied then. */
  setOverride: (input: HardwareOverrideInput) => HardwareOverride
  clearOverride: () => boolean
}

/** Room left for a download. Answers for the data folder only; `null` when the platform cannot say. */
export interface DiskControl {
  available: (path: unknown) => Promise<number | null>
}

/** Reaching the public listener from outside this machine (stage 7c–7d). */
export interface RemoteAccessControl {
  /** IPv4 literals a device on the network can dial, default-route address first. Display only. */
  lanAddresses: () => Promise<string[]>
  status: () => RemoteAccessStatus
  /** Answers `starting` at once; throws a `REMOTE_ACCESS_*` refusal with the app's reason in `details`. */
  start: () => RemoteAccessStatus
  /** Answers once the tunnel's process is gone. */
  stop: () => Promise<RemoteAccessStatus>
}

/**
 * Image generation (stage 7h): the app's twenty `DiffusionService` operations, one route each. The
 * routes parse and validate the bodies; what arrives here is already typed.
 */
export interface DiffusionControl {
  configure: (config: DiffusionConfig) => Promise<DiffusionStatus>
  getStatus: () => Promise<DiffusionStatus>
  setOutputDir: (path: string) => Promise<DiffusionStatus>
  finalizeBackendInstall: (args: FinalizeBackendInstallArgs) => Promise<DiffusionBackendInstallRecord>
  listInstalledBackends: () => Promise<DiffusionBackendInstallRecord[]>
  removeBackend: (dir: string) => Promise<void>
  listModelFiles: () => Promise<DiffusionModelFile[]>
  deleteModelFile: (path: string) => Promise<void>
  /** Answers once the server serves the model, which can take minutes. */
  loadModel: (request: LoadDiffusionModelRequest) => Promise<LoadedDiffusionModel>
  unloadModel: () => Promise<void>
  getCapabilities: () => ImageCapabilities
  touchIdle: () => void
  generate: (request: ImageGenerateRequest) => Promise<{ jobId: string }>
  getJob: (jobId: string) => ImageJob | null
  cancelJob: (jobId: string) => Promise<DiffusionCancelResult>
  listGallery: (options: GalleryListOptions) => Promise<GalleryPage>
  getGalleryItem: (id: string) => Promise<GalleryImageItem | null>
  deleteGalleryItems: (ids: string[]) => Promise<void>
  setGalleryFlags: (id: string, flags: GalleryFlags) => Promise<GalleryImageItem>
  exportGalleryItem: (id: string, targetPath: string) => Promise<void>
  // --- video (stage 9d): the same session, its own jobs, gallery and poster ---
  getVideoCapabilities: () => VideoCapabilities
  generateVideo: (request: VideoGenerateRequest) => Promise<{ jobId: string }>
  /** What `request` would cost with the loaded model; starts nothing, answers while a job runs. */
  estimateVideo: (request: VideoGenerateRequest) => Promise<VideoEstimate>
  getVideoJob: (jobId: string) => VideoJob | null
  cancelVideoJob: (jobId: string) => Promise<DiffusionCancelResult>
  listVideoGallery: (options: GalleryListOptions) => Promise<VideoGalleryPage>
  getVideoGalleryItem: (id: string) => Promise<GalleryVideoItem | null>
  deleteVideoGalleryItems: (ids: string[]) => Promise<void>
  setVideoGalleryFlags: (id: string, flags: GalleryFlags) => Promise<GalleryVideoItem>
  exportVideoGalleryItem: (id: string, targetPath: string) => Promise<void>
  /** The poster the app rendered from the clip's first frame; the bare base64 of a PNG. */
  setVideoPoster: (id: string, pngBase64: string) => Promise<GalleryVideoItem>
}

/**
 * The decision model (ADR 2026-09-30-the-decision-model-is-its-own-core-module). Bodies snake_case,
 * like the engine and `settings.json`. `score` and `decide` are fail-open: they answer an outcome,
 * never an error, so the app's router sees exactly what an in-core caller sees.
 */
export interface DecisionControl {
  status: () => DecisionStatus
  config: () => DecisionSettings
  /** A checked patch of the `decision` settings section; the process follows (start, restart or stop). */
  configure: (patch: Record<string, unknown>) => Promise<DecisionStatus>
  /** Start now and answer once ready; a failure is an error with the start's code. */
  load: () => Promise<DecisionStatus>
  unload: () => Promise<DecisionStatus>
  score: (request: DecisionScoreRequest) => Promise<DecisionOutcome<RouterScoreResponse>>
  decide: (request: DecisionDecideRequest) => Promise<DecisionOutcome<SystemoneResponse>>
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
  /** Absent in a build with no managed runtime wired; its routes then answer that it is not there. */
  environments?: ManagedEnvironmentControl
  /** The snapshot's view of them, kept in memory so it needs no disk read. */
  environmentsSnapshot?: () => EnvironmentSnapshot[]
  environmentOperations?: () => EnvironmentOperation[]
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
  /**
   * Cancel a load that has not answered yet. Answers rather than throws when there is nothing to
   * cancel: the app retries while its load request is still travelling, and unloads once it lands.
   */
  cancelModelLoad: (provider: string, modelId: string) => boolean
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
  /** The core's hardware probe, and the override a host may inject over it (PLAN.md §2 decision 10). */
  hardware: HardwareControl
  /** Installing and removing llama.cpp backends (PLAN.md §4, stage 3c). */
  backends: BackendControl
  /** Free space inside the data folder, which the app asks before a download (stage 7b). */
  disk: DiskControl
  remoteAccess: RemoteAccessControl
  diffusion: DiffusionControl
  /** The decision model; without it the `/decision/*` routes answer `DECISION_UNAVAILABLE`. */
  decision?: DecisionControl
  /** What a model is and can do, without loading it (PLAN.md §4, stage 3d). */
  models: ModelControl
  /**
   * `POST /models/:provider/check` (spec `managed-model-store`, "Проверка совместимости одинакова по
   * форме для всех managed-движков"): for each managed provider this core offers, whether a Hugging
   * Face checkpoint the caller has not downloaded yet would run on it, computed without touching the
   * network. A provider absent here (any non-managed one, or every managed one off Linux and
   * Windows) answers `PROVIDER_NOT_FOUND`.
   */
  managedModelChecks?: Readonly<Record<string, (body: unknown) => Promise<ModelCompatibility>>>
  /**
   * `DELETE /models/tensorrt-llm/:id` (task 2.24, design D12a): stop the model with Docker's
   * confirmation, then remove every engine cache of it and its folder. Absent off Linux.
   */
  tensorrtLlmModelDelete?: (modelId: string) => Promise<ManagedModelDeletion>
  /**
   * `GET /models/tensorrt-llm/location` (change `add-tensorrt-llm-windows`, task 2.8): where clients put
   * `tensorrt-llm` models and how much room is left. Absent where the provider is not offered;
   * `MANAGED_ADAPTER_UNAVAILABLE` on Windows before Atomic Chat's distribution exists.
   */
  tensorrtLlmModelLocation?: () => Promise<ManagedModelLocation>
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
  /**
   * Error reporting: where a route that failed on our side is reported, and the app's consent,
   * user and tags behind `/telemetry`. Absent in a CLI owner, which reports nothing.
   */
  telemetry?: TelemetryControl
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
  /** The managed container runtimes this user has, and the changes in flight on them. */
  environments: EnvironmentSnapshot[]
  environment_operations: EnvironmentOperation[]
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
