/**
 * Browser-safe client of the control API (`/atomic/v1`). The CLI uses it over plain `fetch`; the
 * Tauri adapter will hand it an `invoke`-backed transport so the control token never enters the
 * webview (PLAN.md §3.6). No `node:*` may appear in this folder.
 *
 * Every failure comes back as `AtomicCoreError` with the code the core sent, so callers branch on
 * the same strings whether the core is in-process or across a socket.
 */

import type { CloudProviderInput, CloudProviderView, SubscriptionModel } from '../cloud/index.js'
import type { ChatGptStatus } from '../credentials/index.js'
import { AtomicCoreError, CONTROL_API_PREFIX, CONTROL_PROTOCOL_VERSION } from '../contracts/index.js'
import { CORE_VERSION } from '../version.js'
import type {
  BeginOperation,
  CoreEventName,
  DiffusionBackendInstallRecord,
  DiffusionCancelResult,
  DiffusionConfig,
  DiffusionModelFile,
  DiffusionStatus,
  ErrorCode,
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
  EnvironmentOperation,
  EnvironmentSnapshot,
  LocalApiServerState,
  ManagedHostReceipt,
  ProbeEnvironmentInput,
  RemoteAccessStatus,
  RequirementPlan,
  ResumeOperation,
  SessionInfo,
  UnloadResult,
} from '../contracts/index.js'

export interface CoreClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  /** Identify this client in `clients` and in the core's logs. */
  name?: string
}

export interface ClientRegistration {
  client: { id: string; name: string; pid: number | null }
  heartbeat_interval_ms: number
  snapshot: CoreSnapshot
}

export interface CoreSnapshot {
  instance_id: string
  owner_scope?: 'app' | 'cli'
  protocol: number
  version: string
  pid: number
  data_folder: string
  cursor: string
  sessions: Array<SessionInfo & { provider: string }>
  server: LocalApiServerState
  clients: Array<{ id: string; name: string; pid: number | null }>
  downloads: unknown[]
  optimal_backends?: Record<string, { revision: number; optimal: unknown | null }>
  /**
   * The managed container runtimes and the changes in flight on them. Optional so a client can
   * still read a snapshot from a core that predates them.
   */
  environments?: EnvironmentSnapshot[]
  environment_operations?: EnvironmentOperation[]
}

export interface CoreEventMessage {
  id: string
  event: CoreEventName | 'resync'
  data: unknown
}

export class CoreClient {
  private readonly fetchImpl: typeof fetch
  readonly baseUrl: string

  constructor(private readonly options: CoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  private url(path: string): string {
    return `${this.baseUrl}${CONTROL_API_PREFIX}${path}`
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(this.url(path), {
        ...init,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      })
    } catch (e) {
      throw new AtomicCoreError(
        'CORE_NOT_RUNNING',
        'Cannot reach the Atomic Chat core.',
        (e as Error).message
      )
    }
    const text = await res.text()
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!res.ok) throw errorFromBody(body, res.status)
    return body as T
  }

  health(): Promise<{ ok: true; pid: number; version: string; instance_id: string; protocol: number }> {
    return this.call('/health')
  }

  snapshot(): Promise<CoreSnapshot> {
    return this.call('/snapshot')
  }

  /** Refuse a binary or ownership scope we cannot safely share. */
  async handshake(expectedScope?: 'app' | 'cli'): Promise<CoreSnapshot> {
    const snapshot = await this.snapshot()
    if (snapshot.protocol !== CONTROL_PROTOCOL_VERSION) {
      throw new AtomicCoreError(
        'CORE_PROTOCOL_MISMATCH',
        'The running Atomic Chat core speaks a different control protocol.',
        `core protocol ${snapshot.protocol} (version ${snapshot.version}), this build expects ${CONTROL_PROTOCOL_VERSION}`
      )
    }
    if (snapshot.version !== CORE_VERSION || (expectedScope && snapshot.owner_scope !== expectedScope))
      throw new AtomicCoreError(
        'CORE_PROTOCOL_MISMATCH',
        'The running Atomic Chat core has a different version or ownership scope.',
        `running ${snapshot.version}/${snapshot.owner_scope ?? 'legacy'}, expected ${CORE_VERSION}/${expectedScope ?? 'any'}`
      )
    return snapshot
  }

  register(pid?: number): Promise<ClientRegistration> {
    return this.call('/clients', {
      method: 'POST',
      body: JSON.stringify({ name: this.options.name ?? 'atomic-chat-core client', pid: pid ?? null }),
    })
  }

  heartbeat(clientId: string): Promise<{ ok: true }> {
    return this.call(`/clients/${encodeURIComponent(clientId)}/heartbeat`, { method: 'POST' })
  }

  unregister(clientId: string): Promise<{ ok: true }> {
    return this.call(`/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' })
  }

  sessions(): Promise<{ sessions: Array<SessionInfo & { provider: string }> }> {
    return this.call('/sessions')
  }

  async loadModel(
    provider: string,
    modelId: string,
    body: Record<string, unknown> = {}
  ): Promise<SessionInfo> {
    return (await this.acquireModel(provider, modelId, body)).session
  }

  /** Load or attach, while preserving whether this request created the session. */
  async acquireModel(
    provider: string,
    modelId: string,
    body: Record<string, unknown> = {}
  ): Promise<{ session: SessionInfo; created: boolean }> {
    return this.call<{ session: SessionInfo; created: boolean }>(`/models/${provider}/${modelId}/load`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  /**
   * Cancel a load that has not answered yet. `false` means nothing was pending for the model: the
   * load request has not arrived, or it has already answered and the model is to be unloaded.
   */
  async cancelModelLoad(provider: string, modelId: string): Promise<boolean> {
    const result = await this.call<{ cancelled: boolean }>(`/models/${provider}/${modelId}/load/cancel`, {
      method: 'POST',
    })
    return result.cancelled === true
  }

  /**
   * Free bytes where a download would land, or `null` when the platform cannot say. `path` must be
   * inside the data folder; without one the answer is for the data folder itself.
   */
  async availableDiskSpace(path?: string): Promise<number | null> {
    const result = await this.call<{ bytes: number | null }>('/disk/available', {
      method: 'POST',
      body: JSON.stringify(path === undefined ? {} : { path }),
    })
    return result.bytes
  }

  /** The Cloudflare quick tunnel in front of the public server. */
  remoteAccessStatus(): Promise<RemoteAccessStatus> {
    return this.call('/remote-access')
  }

  /** Answers `starting` at once; a refusal carries the app's reason (`server_stopped`, …) in `details`. */
  startRemoteAccess(): Promise<RemoteAccessStatus> {
    return this.call('/remote-access/start', { method: 'POST' })
  }

  /** Answers once the tunnel's process is gone. */
  stopRemoteAccess(): Promise<RemoteAccessStatus> {
    return this.call('/remote-access/stop', { method: 'POST' })
  }

  /** IPv4 literals a device on the network can dial, default-route address first. Display only. */
  async lanAddresses(): Promise<string[]> {
    return (await this.call<{ addresses: string[] }>('/lan-addresses')).addresses
  }

  // --- image generation (stage 7h): the app's `DiffusionService`, one method each -------------

  /** Once per core generation, before anything else; `dataFolder` must be the core's own. */
  configureDiffusion(config: DiffusionConfig): Promise<DiffusionStatus> {
    return this.call('/diffusion/config', { method: 'PUT', body: JSON.stringify(config) })
  }

  diffusionStatus(): Promise<DiffusionStatus> {
    return this.call('/diffusion/status')
  }

  /** An empty path restores `<data>/images`. */
  setDiffusionOutputDir(path: string): Promise<DiffusionStatus> {
    return this.call('/diffusion/output-dir', { method: 'PUT', body: JSON.stringify({ path }) })
  }

  finalizeDiffusionBackend(args: FinalizeBackendInstallArgs): Promise<DiffusionBackendInstallRecord> {
    return this.call('/diffusion/backends/finalize', { method: 'POST', body: JSON.stringify(args) })
  }

  async listDiffusionBackends(): Promise<DiffusionBackendInstallRecord[]> {
    return (await this.call<{ backends: DiffusionBackendInstallRecord[] }>('/diffusion/backends')).backends
  }

  /** Refuses (`BACKEND_IN_USE`) while a model runs from that tree. */
  async removeDiffusionBackend(dir: string): Promise<void> {
    await this.call('/diffusion/backends/remove', { method: 'POST', body: JSON.stringify({ dir }) })
  }

  async listDiffusionModelFiles(): Promise<DiffusionModelFile[]> {
    return (await this.call<{ files: DiffusionModelFile[] }>('/diffusion/model-files')).files
  }

  async deleteDiffusionModelFile(path: string): Promise<void> {
    await this.call('/diffusion/model-files/delete', { method: 'POST', body: JSON.stringify({ path }) })
  }

  /** Answers once the server serves the model: minutes for a large one. */
  loadDiffusionModel(request: LoadDiffusionModelRequest): Promise<LoadedDiffusionModel> {
    return this.call('/diffusion/model/load', { method: 'POST', body: JSON.stringify(request) })
  }

  async unloadDiffusionModel(): Promise<void> {
    await this.call('/diffusion/model/unload', { method: 'POST' })
  }

  diffusionCapabilities(): Promise<ImageCapabilities> {
    return this.call('/diffusion/capabilities')
  }

  /** Reset the idle-unload deadline without generating. */
  async touchDiffusionIdle(): Promise<void> {
    await this.call('/diffusion/idle/touch', { method: 'POST' })
  }

  /** Answers with the job id at once; progress and the outcome arrive as `diffusion:*` events. */
  generateImage(request: ImageGenerateRequest): Promise<{ jobId: string }> {
    return this.call('/diffusion/jobs', { method: 'POST', body: JSON.stringify(request) })
  }

  async diffusionJob(jobId: string): Promise<ImageJob | null> {
    return (await this.call<{ job: ImageJob | null }>(`/diffusion/jobs/${encodeURIComponent(jobId)}`)).job
  }

  cancelImageJob(jobId: string): Promise<DiffusionCancelResult> {
    return this.call(`/diffusion/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
  }

  listGallery(options: GalleryListOptions): Promise<GalleryPage> {
    const query = new URLSearchParams({ offset: String(options.offset), limit: String(options.limit) })
    if (options.includeArchived !== undefined) query.set('includeArchived', String(options.includeArchived))
    return this.call(`/diffusion/gallery?${query.toString()}`)
  }

  async galleryItem(id: string): Promise<GalleryImageItem | null> {
    return (
      await this.call<{ item: GalleryImageItem | null }>(`/diffusion/gallery/${encodeURIComponent(id)}`)
    ).item
  }

  async deleteGalleryItems(ids: string[]): Promise<void> {
    await this.call('/diffusion/gallery/delete', { method: 'POST', body: JSON.stringify({ ids }) })
  }

  setGalleryFlags(id: string, flags: GalleryFlags): Promise<GalleryImageItem> {
    return this.call(`/diffusion/gallery/${encodeURIComponent(id)}/flags`, {
      method: 'PATCH',
      body: JSON.stringify(flags),
    })
  }

  async exportGalleryItem(id: string, targetPath: string): Promise<void> {
    await this.call(`/diffusion/gallery/${encodeURIComponent(id)}/export`, {
      method: 'POST',
      body: JSON.stringify({ targetPath }),
    })
  }

  /** Restart a poisoned engine at the context it already has. */
  recreateSession(provider: string, modelId: string): Promise<{ ok: boolean; reason?: string }> {
    return this.call(`/models/${provider}/${modelId}/recreate`, { method: 'POST' })
  }

  unloadModel(provider: string, modelId: string): Promise<UnloadResult> {
    return this.call(`/models/${provider}/${modelId}/unload`, { method: 'POST' })
  }

  cloudProviders(): Promise<{ providers: CloudProviderView[] }> {
    return this.call('/cloud/providers')
  }

  setCloudProvider(
    provider: string,
    input: Omit<CloudProviderInput, 'provider'>
  ): Promise<CloudProviderView> {
    return this.call(`/cloud/providers/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  }

  removeCloudProvider(provider: string): Promise<{ removed: true }> {
    return this.call(`/cloud/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' })
  }

  chatgptStatus(): Promise<ChatGptStatus> {
    return this.call('/auth/chatgpt')
  }

  chatgptStartLogin(): Promise<{ authorize_url: string }> {
    return this.call('/auth/chatgpt/login', { method: 'POST' })
  }

  chatgptWaitLogin(): Promise<ChatGptStatus> {
    return this.call('/auth/chatgpt/login/wait', { method: 'POST' })
  }

  chatgptCancelLogin(): Promise<{ cancelled: true }> {
    return this.call('/auth/chatgpt/login/cancel', { method: 'POST' })
  }

  chatgptLogout(): Promise<ChatGptStatus> {
    return this.call('/auth/chatgpt/logout', { method: 'POST' })
  }

  chatgptModels(): Promise<{ models: SubscriptionModel[] }> {
    return this.call('/auth/chatgpt/models')
  }

  serverStatus(): Promise<LocalApiServerState> {
    return this.call('/server')
  }

  startServer(options: {
    host?: string
    port?: number
    prefix?: string
    api_key?: string
    trusted_hosts?: string[]
    proxy_timeout_secs?: number
    state_file?: boolean
    fallback_port?: boolean
  }): Promise<LocalApiServerState> {
    return this.call('/server/start', { method: 'POST', body: JSON.stringify(options) })
  }

  /** Tell the core whether the app's API screen is watching, which gates prompt previews. */
  setInspecting(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.call('/server/inspector', { method: 'PUT', body: JSON.stringify({ enabled }) })
  }

  stopServer(): Promise<LocalApiServerState> {
    return this.call('/server/stop', { method: 'POST' })
  }

  shutdown(options: { force?: boolean; client_id?: string } = {}): Promise<{ ok: true }> {
    return this.call('/shutdown', { method: 'POST', body: JSON.stringify(options) })
  }

  /**
   * Subscribe to the event stream. Resolves when the stream ends; `onEvent` sees each frame,
   * including the `resync` the core sends when a cursor is too old to replay.
   */
  // ── Managed container runtimes ───────────────────────────────────────────────────────────────

  /** Every environment this user has, with the engines installed into it. */
  async environments(): Promise<EnvironmentSnapshot[]> {
    return (await this.call<{ environments: EnvironmentSnapshot[] }>('/environments')).environments
  }

  /** What setting this up would involve. Reads the machine; changes nothing on it. */
  probeEnvironment(input: ProbeEnvironmentInput): Promise<RequirementPlan> {
    return this.call('/environments/probe', { method: 'POST', body: JSON.stringify(input) })
  }

  /**
   * Start a change, or get back the one this request already started. Answers as soon as the
   * operation is recorded: what it does next outlives the call, and is watched through `get`.
   */
  beginEnvironmentOperation(environmentId: string, input: BeginOperation): Promise<EnvironmentOperation> {
    return this.call(`/environments/${encodeURIComponent(environmentId)}/operations`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  environmentOperation(operationId: string): Promise<EnvironmentOperation> {
    return this.call(`/environments/operations/${encodeURIComponent(operationId)}`)
  }

  /** Ask it to stop. Work that cannot be interrupted safely finishes first. */
  cancelEnvironmentOperation(operationId: string): Promise<EnvironmentOperation> {
    return this.call(`/environments/operations/${encodeURIComponent(operationId)}/cancel`, {
      method: 'POST',
    })
  }

  /**
   * Approve the plan, or carry on after a sign-out, a restart, a failure or a cancellation. The
   * revision is what the caller saw: if the operation has moved since, this is refused rather than
   * applied to a state nobody looked at.
   */
  resumeEnvironmentOperation(operationId: string, input: ResumeOperation): Promise<EnvironmentOperation> {
    return this.call(`/environments/operations/${encodeURIComponent(operationId)}/resume`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  /**
   * Report what the system authorization prompt did. The core checks it against the machine before
   * the step counts, and an identical receipt arriving twice authorizes nothing a second time.
   */
  reportHostStep(operationId: string, receipt: ManagedHostReceipt): Promise<EnvironmentOperation> {
    return this.call(`/environments/operations/${encodeURIComponent(operationId)}/host-step-result`, {
      method: 'POST',
      body: JSON.stringify(receipt),
    })
  }

  async events(
    onEvent: (message: CoreEventMessage) => void,
    options: { cursor?: string; signal?: AbortSignal; onOpen?: () => void } = {}
  ): Promise<void> {
    const res = await this.fetchImpl(
      this.url(`/events${options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ''}`),
      {
        headers: { authorization: `Bearer ${this.options.token}`, accept: 'text/event-stream' },
        ...(options.signal ? { signal: options.signal } : {}),
      }
    )
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw errorFromBody(text ? (JSON.parse(text) as Record<string, unknown>) : {}, res.status)
    }
    options.onOpen?.()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let split = buffer.indexOf('\n\n')
      while (split >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const message = parseFrame(frame)
        if (message) onEvent(message)
        split = buffer.indexOf('\n\n')
      }
    }
  }
}

function parseFrame(frame: string): CoreEventMessage | undefined {
  let id = ''
  let event = ''
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue // heartbeat comment
    if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!event) return undefined
  let data: unknown
  try {
    data = dataLines.length ? JSON.parse(dataLines.join('\n')) : undefined
  } catch {
    data = dataLines.join('\n')
  }
  return { id, event: event as CoreEventMessage['event'], data }
}

function errorFromBody(body: Record<string, unknown>, status: number): AtomicCoreError {
  const error = body['error'] as { code?: string; message?: string; details?: string } | undefined
  return new AtomicCoreError(
    (error?.code as ErrorCode) ?? 'INTERNAL_ERROR',
    error?.message ?? `The core answered ${status}.`,
    error?.details
  )
}
