/**
 * `AtomicCore` — the owner process assembled from its parts (PLAN.md §3.3, §3.4, §3.6).
 *
 * Creating one *is* taking ownership of a data folder: it acquires the instance lock, mints the
 * control token, cleans up backend processes the previous owner left behind, starts the control
 * listener and only then publishes its endpoint. A client that sees `state: "ready"` in the lock can
 * dial the port and expect an answer.
 *
 * The public `/v1` listener is deliberately not started here — it is a separate, optional listener
 * whose stop must never take control down with it.
 */

import { AtomicCoreError, CONTROL_PROTOCOL_VERSION } from '../contracts/index.js'
import type { ReadyLine } from '../contracts/index.js'
import type {
  LocalApiServerState,
  LocalProviderId,
  RemoteAccessStatus,
  SessionInfo,
  UnloadResult,
} from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import type { DiffusionService } from '../diffusion/index.js'
import type { CoreEmitter } from '../events/index.js'
import { assertNotLoadedByLegacy } from '../lock/index.js'
import type { InstanceLock } from '../lock/index.js'
import type { ModelRegistry } from '../models/index.js'
import { RemoteAccessManager } from '../remote-access/index.js'
import type { RemoteAccessManagerDeps } from '../remote-access/index.js'
import { LlamacppRuntime } from '../runtime/llamacpp/index.js'
import type { CtxIncreaseResult, ExternalSessions, LocalRuntime, RecreateResult } from '../runtime/index.js'
import type { SettingsStore } from '../settings/index.js'
import { captureReport, loadFailureReport } from '../telemetry/index.js'
import type { ErrorSink, TelemetryControl } from '../telemetry/index.js'
import type { ApiKeyStore, ChatGptAuth } from '../credentials/index.js'
import type { ChatGptBackend, CloudRegistry } from '../cloud/index.js'
import { DynamicTrustedHosts } from '../server/index.js'
import type { ClientRegistry, ControlServer, SessionSummary } from '../server/index.js'
import { CORE_VERSION } from '../version.js'
import { createAtomicCore } from './create.js'
import { PublicServerLifecycle } from './public-server.js'
import type { PublicServerStartOptions } from './public-server.js'
import type { ClaudeCodeRuntime } from '../claude-code/index.js'
import { LocalSessions, sessionsOf, unknownProvider } from './sessions.js'
import { LOCAL_PROVIDER } from './types.js'
import type { AtomicCoreOptions, CoreLoadOptions, CoreLogger } from './types.js'

/** Everything `create()` wires before the facade exists; see `create.ts`. */
export interface AtomicCoreParts {
  layout: DataLayout
  events: CoreEmitter
  settings: SettingsStore
  clients: ClientRegistry
  lock: InstanceLock
  runtimes: Map<LocalProviderId, LocalRuntime>
  registries: Map<LocalProviderId, ModelRegistry>
  control: ControlServer
  log: CoreLogger
  controlToken: string
  apiKeys: ApiKeyStore
  cloud: CloudRegistry
  claudeCode: ClaudeCodeRuntime
  chatgpt: ChatGptAuth
  chatgptBackend: ChatGptBackend
  externalSessions: ExternalSessions
  /** Set for an app owner: the timer that shuts the core down once the app's registration lapses. */
  appLeaseTimer: NodeJS.Timeout | undefined
  /** How the remote-access tunnel is started, proven and journalled; the facade supplies the rest. */
  remoteAccess: Pick<RemoteAccessManagerDeps, 'spawner' | 'prober' | 'timings' | 'journal'>
  /** Image generation (stage 7): its own module, not a runtime. */
  diffusion: DiffusionService
  /** Where a failed load and the public server's failures are reported; absent, nothing is. */
  errors?: ErrorSink | undefined
  /** The same reporter, for a host that changes consent, user or tags at run time. */
  telemetry?: TelemetryControl | undefined
}

export class AtomicCore {
  readonly version = CORE_VERSION
  private lifecycle: 'running' | 'stopping' | 'stopped' = 'running'
  private shutdownPromise: Promise<void> | undefined
  /** Whether the app's API screen is watching; previews are collected only then. */
  inspecting = false
  private resolveStopped: (() => void) | undefined
  /** Resolves once this core has stopped, however that was triggered (API, signal, or in-process). */
  readonly stopped: Promise<void> = new Promise<void>((resolve) => {
    this.resolveStopped = resolve
  })

  readonly layout: DataLayout
  readonly events: CoreEmitter
  readonly settings: SettingsStore
  readonly clients: ClientRegistry
  readonly control: ControlServer
  readonly controlToken: string
  /** Cloud provider API keys (`credentials.json`). */
  readonly apiKeys: ApiKeyStore
  readonly cloud: CloudRegistry
  /** The ChatGPT subscription session (`atomic-chatgpt-auth.json`). */
  readonly chatgpt: ChatGptAuth
  private readonly claudeCode: ClaudeCodeRuntime
  /** Engines the desktop app still owns, registered for routing only (stage 4d). */
  readonly externalSessions: ExternalSessions
  private readonly lock: InstanceLock
  private readonly runtimes: Map<LocalProviderId, LocalRuntime>
  private readonly registries: Map<LocalProviderId, ModelRegistry>
  private readonly log: CoreLogger
  private readonly appLeaseTimer: NodeJS.Timeout | undefined
  private readonly errors: ErrorSink | undefined
  /**
   * This core's error reporting, for an embedding program: `state()` says whether it reports and
   * why, `update({ enabled, user_id, tags })` is what `PUT /atomic/v1/telemetry` does. Undefined
   * when the host turned reporting off with `telemetry: false`.
   */
  readonly telemetry: TelemetryControl | undefined
  /** Model claims and per-model load/unload transitions. */
  private readonly localSessions: LocalSessions
  /** The public `/v1` listener and its serialized start/stop. */
  private readonly publicServer: PublicServerLifecycle
  /** What the public listener trusts beyond its configuration: the tunnel name, the socket's address. */
  private readonly trustedHosts = new DynamicTrustedHosts()
  /** The Cloudflare quick tunnel in front of the public listener. */
  private readonly remoteAccess: RemoteAccessManager
  /** Image generation on stable-diffusion.cpp: the resident `sd-server`, its jobs and the gallery. */
  readonly diffusion: DiffusionService

  private constructor(parts: AtomicCoreParts) {
    this.layout = parts.layout
    this.events = parts.events
    this.settings = parts.settings
    this.clients = parts.clients
    this.control = parts.control
    this.controlToken = parts.controlToken
    this.apiKeys = parts.apiKeys
    this.cloud = parts.cloud
    this.chatgpt = parts.chatgpt
    this.claudeCode = parts.claudeCode
    this.externalSessions = parts.externalSessions
    this.lock = parts.lock
    this.runtimes = parts.runtimes
    this.registries = parts.registries
    this.log = parts.log
    this.appLeaseTimer = parts.appLeaseTimer
    this.diffusion = parts.diffusion
    this.errors = parts.errors
    this.telemetry = parts.telemetry
    this.localSessions = new LocalSessions({
      layout: parts.layout,
      instanceId: parts.lock.instanceId,
      runtimes: parts.runtimes,
      externalSessions: parts.externalSessions,
      runtime: (provider) => this.runtime(provider),
      assertRunning: () => this.assertRunning(),
      increaseCtx: (provider, modelId, reason) => this.increaseCtx(provider, modelId, reason),
      recreateSession: (provider, modelId) => this.recreateSession(provider, modelId),
    })
    this.remoteAccess = new RemoteAccessManager({
      ...parts.remoteAccess,
      server: () => this.publicServer.endpoint(),
      hosts: this.trustedHosts,
      emit: (status) => this.events.emit('remote-access:status', status),
      log: parts.log,
    })
    this.publicServer = new PublicServerLifecycle({
      layout: parts.layout,
      events: parts.events,
      log: parts.log,
      assertRunning: () => this.assertRunning(),
      remoteAccess: this.remoteAccess,
      serverDeps: () => ({
        findLocal: (provider, modelId) => this.localSessions.localTarget(provider, modelId),
        listLocal: () => this.localSessions.listLocalTargets(),
        providers: () => this.cloud.routing(),
        chatgpt: parts.chatgptBackend,
        increaseCtx: (provider, modelId, trigger) =>
          this.localSessions.serverCtxRequest(provider, modelId, trigger),
        emit: (name, payload) => this.events.emit(name, payload),
        inspecting: () => this.inspecting,
        dynamicTrustedHosts: (localAddress) => this.trustedHosts.groupFor(localAddress),
        images: this.diffusion.imagesBackend(),
        videos: this.diffusion.videosBackend(),
        errors: parts.errors,
      }),
    })
  }

  get instanceId(): string {
    return this.lock.instanceId
  }

  /** Take ownership of a data folder and start the control listener. */
  static create(options: AtomicCoreOptions = {}): Promise<AtomicCore> {
    return createAtomicCore(options, (parts) => new AtomicCore(parts))
  }

  readyLine(): ReadyLine {
    return {
      event: 'core:ready',
      pid: process.pid,
      instance_id: this.instanceId,
      protocol: CONTROL_PROTOCOL_VERSION,
      version: CORE_VERSION,
      control_host: this.control.host,
      control_port: this.control.port,
    }
  }

  registry(provider: LocalProviderId = LOCAL_PROVIDER): ModelRegistry {
    const registry = this.registries.get(provider)
    if (!registry) throw unknownProvider(provider, this.registries.keys())
    return registry
  }

  runtime(provider: LocalProviderId = LOCAL_PROVIDER): LocalRuntime {
    const runtime = this.runtimes.get(provider)
    if (!runtime) throw unknownProvider(provider, this.runtimes.keys())
    return runtime
  }

  /** A llama.cpp runtime, for what only llama.cpp has (devices, runtime device info, context size). */
  llamacpp(provider: 'llamacpp' | 'llamacpp-upstream' = 'llamacpp-upstream'): LlamacppRuntime {
    const runtime = this.runtime(provider)
    if (!(runtime instanceof LlamacppRuntime)) throw unknownProvider(provider, this.runtimes.keys())
    return runtime
  }

  sessions(): SessionSummary[] {
    return sessionsOf(this.runtimes)
  }

  async load(
    provider: LocalProviderId,
    modelId: string,
    options: CoreLoadOptions = {}
  ): Promise<SessionInfo> {
    return (await this.acquire(provider, modelId, options)).session
  }

  /** Load or attach without making an attaching client accidentally own the shared session. */
  async acquire(
    provider: LocalProviderId,
    modelId: string,
    options: CoreLoadOptions = {}
  ): Promise<{ session: SessionInfo; created: boolean }> {
    this.assertRunning()
    return this.reportingLoad(provider, modelId, options, () =>
      this.localSessions.acquire(provider, modelId, options)
    )
  }

  /**
   * Reload a model with a larger context because a request did not fit. Guarded like `load`: the
   * desktop app may still own this model, and reloading it here would take it from under the app.
   */
  async increaseCtx(provider: LocalProviderId, modelId: string, reason?: string): Promise<CtxIncreaseResult> {
    this.assertRunning()
    await assertNotLoadedByLegacy(this.layout, modelId)
    return this.reportingLoad(provider, modelId, {}, () =>
      this.runtime(provider).autoIncreaseCtx(modelId, reason)
    )
  }

  /** Restart a poisoned engine at its current context; guarded like `load`. */
  async recreateSession(provider: LocalProviderId, modelId: string): Promise<RecreateResult> {
    this.assertRunning()
    await assertNotLoadedByLegacy(this.layout, modelId)
    return this.reportingLoad(provider, modelId, {}, () => this.runtime(provider).recreateSession(modelId))
  }

  /**
   * Cancel a load that has not answered yet. `false` when nothing is pending for the model — it has
   * already loaded (unload it instead) or the load has not arrived.
   */
  cancelLoad(provider: LocalProviderId, modelId: string): boolean {
    this.assertRunning()
    return this.localSessions.cancelLoad(provider, modelId)
  }

  async unload(provider: LocalProviderId, modelId: string): Promise<UnloadResult> {
    this.assertRunning()
    return this.localSessions.unload(provider, modelId)
  }

  publicState(): LocalApiServerState {
    return this.publicServer.state()
  }

  /** Start the public listener; an identical start is idempotent, an incompatible one is a conflict. */
  async startPublicServer(options: PublicServerStartOptions = {}): Promise<LocalApiServerState> {
    this.assertRunning()
    return this.publicServer.start(options)
  }

  async stopPublicServer(): Promise<LocalApiServerState> {
    this.assertRunning()
    return this.publicServer.stop()
  }

  remoteAccessStatus(): RemoteAccessStatus {
    return this.remoteAccess.status()
  }

  /** Open the tunnel; answers `starting` at once, the rest arrives as `remote-access:status`. */
  startRemoteAccess(): RemoteAccessStatus {
    this.assertRunning()
    return this.remoteAccess.start()
  }

  /** Close the tunnel; answers once its process is gone. */
  async stopRemoteAccess(): Promise<RemoteAccessStatus> {
    this.assertRunning()
    return this.remoteAccess.stop()
  }

  /** Stop everything this core owns and release the lock last. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // Before anything that can wait: a public URL must not outlive the core that answers behind it.
    this.remoteAccess.killNow()
    this.lifecycle = 'stopping'
    if (this.appLeaseTimer) clearInterval(this.appLeaseTimer)
    this.shutdownPromise = (async () => {
      this.claudeCode.shutdown()
      await this.publicServer.stop()
      // A multi-gigabyte sd-server must not outlive the core; it goes before the chat runtimes.
      await this.diffusion.shutdown()
      for (const runtime of this.runtimes.values()) await runtime.shutdown()
      await this.localSessions.releaseAll()
      await this.control.close()
      await this.lock.release()
      this.lifecycle = 'stopped'
      this.log('info', 'core stopped')
      this.resolveStopped?.()
    })()
    return this.shutdownPromise
  }

  /** Alias so the facade reads the same as the library docs. */
  dispose(): Promise<void> {
    return this.shutdown()
  }

  /**
   * Run a load (or a reload at another context) and report it when it fails, from whichever caller:
   * the app, the public API, a remote client or the CLI. The error still reaches the caller.
   */
  private async reportingLoad<T>(
    provider: LocalProviderId,
    modelId: string,
    options: CoreLoadOptions,
    load: () => Promise<T>
  ): Promise<T> {
    try {
      return await load()
    } catch (error) {
      if (this.errors) {
        // The settings the runtime loads with, so the report names the backend and context it used.
        let settings: Record<string, unknown> = {}
        try {
          settings = this.settings.get(provider)
        } catch {
          // an unknown provider: the error being reported already says so
        }
        captureReport(
          this.errors,
          loadFailureReport({
            provider,
            modelId,
            error,
            overrides: { ...settings, ...options.overrides },
            isEmbedding: options.isEmbedding,
          })
        )
      }
      throw error
    }
  }

  private assertRunning(): void {
    if (this.lifecycle !== 'running') {
      throw new AtomicCoreError('CORE_NOT_RUNNING', 'The Atomic Chat core is stopping or has stopped.')
    }
  }
}
