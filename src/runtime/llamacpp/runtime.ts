/**
 * The live half of the llama.cpp runtime: it turns a load plan into a running `llama-server` and
 * keeps the session table the app's `model-factory.ts`, the Rust agent and `/v1` all read
 * (PLAN.md §3.2, §3.3). Policy lives in `load-plan.ts` and `args.ts`; this file owns processes.
 *
 * What it guarantees:
 *  - a session exists only while its process does — the exit watcher removes it and emits
 *    `session:died`, so nothing dials a dead port;
 *  - every spawned process is journalled *before* it can be forgotten, so a crashed owner leaves a
 *    trail the next owner can clean up (PLAN.md §3.4);
 *  - the two post-failure retries of `performLoad` (drop mmproj, drop MTP) happen here, once each;
 *  - stderr is fed to the device accumulator while loading, which is the only place llama.cpp says
 *    which device it actually used.
 */

import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  CoreEvents,
  DeviceInfo,
  LocalProviderId,
  RuntimeDeviceInfo,
  SessionInfo,
  UnloadResult,
} from '../../contracts/index.js'
import { DEFAULT_CTX_LEN, computeNextCtxLen } from './ctx-ladder.js'
import type { DataLayout } from '../../config/index.js'
import type { ChildProcessRecord, ProcessJournal } from '../../lock/index.js'
import { processStartId } from '../../lock/index.js'
import type { ModelRegistry } from '../../models/index.js'
import { readGgufMetadataFromFile } from '../../models/index.js'
import { resolveLlama3TemplateOverride, STRICT_SYSTEM_GUARD_SIGNATURE } from '../../speculative/index.js'
import { checkDflashSupport } from '../../speculative/dflash-registry.js'
import { checkGemmaMtpSupport } from '../../speculative/gemma-mtp-registry.js'
import { buildProcessEnv, discoverCudaPaths, nodeCudaProbeEnv, textMentionsCudaRuntime } from '../env.js'
import { randomFreePort } from '../ports.js'
import { spawnAndAwaitReady, spawnManaged, LLAMA_READY_MARKERS } from '../process.js'
import type { ManagedProcess, SpawnSpec } from '../process.js'
import { planLlamaArgs } from './args.js'
import type { LlamacppConfigInput } from './args.js'
import { parseDeviceOutput } from './devices.js'
import { classifyProcessOutput } from './errors.js'
import type { ExitInfo } from './errors.js'
import { autoUnloadTargets, nextRetry, planLlamaLoad } from './load-plan.js'
import type { LlamacppEngineSettings, LoadPlan, LoadPlanDeps } from './load-plan.js'
import { classifyBackendMismatch, formatLoadError, isConcreteVersionBackend } from './policy.js'
import { checkSpecTypeSupport, DFLASH_SPEC_TYPE } from './probe.js'
import { RuntimeDeviceAccumulator } from './runtime-device.js'

export type EmitFn = <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void

export interface RuntimeSettings {
  config: LlamacppConfigInput
  engine: LlamacppEngineSettings
}

/** What `autoIncreaseCtx` did, or why it declined to do anything. */
export type CtxIncreaseResult =
  | { ok: true; new_ctx_len: number; session: SessionInfo }
  | {
      ok: false
      reason: 'fit' | 'at_max' | 'not-loaded'
      current_ctx_len?: number
      max_ctx_len?: number
    }

export interface LoadOptions {
  /** Per-model overrides, canonical keys (the `settings` argument of the extension's `load()`). */
  overrides?: Partial<LlamacppConfigInput>
  isEmbedding?: boolean
  /** Use this executable instead of resolving one (CLI `--bin`). */
  exePath?: string
  /** Feature-gating tag for an explicit executable; neutral when omitted. */
  versionBackend?: string
  /** Explicit model/projector paths bypass `model.yml` resolution (CLI flags). */
  modelPath?: string
  mmprojPath?: string
  /** Exact readiness timeout for CLI parity; provider loads keep the application floor. */
  timeoutSecs?: number
  /** Append backend stdout/stderr to this path for the lifetime of the session. */
  logPath?: string
  /** Relay backend stdout/stderr through authenticated `core:log` events. */
  verbose?: boolean
  /** Bind the server to this port instead of a random free one (CLI `--port`). */
  port?: number
  /** Skip the auto-unload of other text models. */
  bypassAutoUnload?: boolean
}

export interface LlamacppRuntimeOptions {
  layout: DataLayout
  registry: ModelRegistry
  /** Owner instance that will be recorded as the parent of every spawned process. */
  instanceId: string
  provider?: LocalProviderId
  journal?: ProcessJournal | undefined
  emit?: EmitFn
  platform?: NodeJS.Platform
  baseEnv?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** Provider settings for a load; re-read per load so a settings change lands on the next one. */
  readSettings: () => Promise<RuntimeSettings>
  /** Resolve `<version>/<backend>` to an installed executable (the backend service in a full core). */
  ensureBackendReady?: LoadPlanDeps['ensureBackendReady'] | undefined
  resolveLatestBackend?: LoadPlanDeps['resolveLatestBackend'] | undefined
  cpuInfo?: LoadPlanDeps['cpuInfo'] | undefined
  ensureGemmaMtpDraft?: LoadPlanDeps['ensureGemmaMtpDraft'] | undefined
  ensureDflashDraft?: LoadPlanDeps['ensureDflashDraft'] | undefined
  /** Model that must never be auto-unloaded. */
  transcriptionModelId?: string
  /**
   * Read a model's GGUF metadata. A seam because the model's trained context comes from here, and
   * it is what decides when the context ladder has nowhere left to climb — untestable otherwise
   * without hand-building a GGUF file.
   */
  readGgufMetadata?: LoadPlanDeps['readGgufMetadata'] | undefined
  /** Test seam. */
  spawn?: typeof spawnAndAwaitReady | undefined
  probeDevicesWith?: ((spec: SpawnSpec) => ManagedProcess) | undefined
}

interface Session {
  info: SessionInfo
  process: ManagedProcess
  plan: LoadPlan
  devices: RuntimeDeviceAccumulator
  journalled: boolean
  logStream?: WriteStream
}

export const DEVICE_PROBE_TIMEOUT_MS = 10_000

export class LlamacppRuntime {
  private readonly sessions = new Map<string, Session>()
  private readonly loading = new Map<string, Promise<SessionInfo>>()
  private loadTail: Promise<void> = Promise.resolve()
  private readonly shutdownController = new AbortController()
  private closing = false
  private shutdownPromise: Promise<void> | undefined
  private readonly provider: LocalProviderId
  private readonly platform: NodeJS.Platform
  private readonly emit: EmitFn
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: LlamacppRuntimeOptions) {
    this.provider = options.provider ?? 'llamacpp-upstream'
    this.platform = options.platform ?? process.platform
    this.emit = options.emit ?? (() => {})
    this.fetchImpl = options.fetch ?? fetch
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  findSession(modelId: string): SessionInfo | undefined {
    const session = this.sessions.get(modelId)
    return session ? { ...session.info } : undefined
  }

  getLoadedModels(): string[] {
    return [...this.sessions.keys()]
  }

  getRuntimeDeviceInfo(modelId: string): RuntimeDeviceInfo | undefined {
    return this.sessions.get(modelId)?.devices.snapshot()
  }

  getMaxCtxTrain(modelId: string): number | undefined {
    return this.sessions.get(modelId)?.plan.maxCtxTrain
  }

  isLoading(modelId: string): boolean {
    return this.loading.has(modelId)
  }

  /** Load a model, or join the load already in flight for it. */
  async load(modelId: string, opts: LoadOptions = {}): Promise<SessionInfo> {
    this.assertRunning()
    const existing = this.sessions.get(modelId)
    if (existing) return { ...existing.info }
    const inFlight = this.loading.get(modelId)
    if (inFlight) return inFlight
    const started = this.enqueueLoad(() => this.loadOnce(modelId, opts)).finally(() =>
      this.loading.delete(modelId)
    )
    this.loading.set(modelId, started)
    return started
  }

  private async loadOnce(modelId: string, opts: LoadOptions): Promise<SessionInfo> {
    this.assertRunning()
    const settings = await this.options.readSettings()
    const config: LlamacppConfigInput = { ...settings.config }
    if (opts.exePath) config.version_backend = opts.versionBackend ?? 'cli/llama-server'
    else {
      const configured = String(config.version_backend ?? '').trim()
      if (configured === '' || configured === 'none') {
        throw new AtomicCoreError(
          'BINARY_NOT_FOUND',
          'No llama.cpp backend is installed in this data folder.',
          `install one in the app, or point at a binary with --bin (${this.options.layout.provider(this.provider).backendsDir})`
        )
      }
      if (!isConcreteVersionBackend(configured) && !configured.startsWith('latest/')) {
        // Preserve the load-plan's INVALID_ARGUMENT wording for malformed, non-empty settings.
        config.version_backend = configured
      }
    }
    const isEmbedding = opts.isEmbedding ?? false
    const targets = autoUnloadTargets(this.list(), {
      autoUnload: opts.overrides?.auto_unload ?? config.auto_unload ?? true,
      isEmbedding,
      bypassAutoUnload: opts.bypassAutoUnload ?? false,
      ...(this.options.transcriptionModelId !== undefined
        ? { transcriptionModelId: this.options.transcriptionModelId }
        : {}),
    })
    for (const target of targets) {
      const result = await this.unloadSession(target)
      if (!result.success) {
        throw new AtomicCoreError(
          'LLAMA_CPP_PROCESS_ERROR',
          `Could not auto-unload model "${target}" before loading "${modelId}".`,
          result.error
        )
      }
    }
    this.assertRunning()
    if (opts.timeoutSecs !== undefined && (!Number.isFinite(opts.timeoutSecs) || opts.timeoutSecs <= 0)) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Load timeout must be a positive number of seconds.')
    }
    let plan = await planLlamaLoad(
      {
        provider: this.provider,
        modelId,
        config,
        engine: settings.engine,
        overrides: opts.overrides as Partial<LlamacppConfigInput> | undefined,
        ...(opts.modelPath !== undefined ? { modelPath: opts.modelPath } : {}),
        ...(opts.mmprojPath !== undefined ? { mmprojPath: opts.mmprojPath } : {}),
        ...(opts.timeoutSecs !== undefined ? { timeoutSecs: opts.timeoutSecs } : {}),
        isEmbedding,
        dataFolder: this.options.layout.root,
        ...(this.options.transcriptionModelId !== undefined
          ? { transcriptionModelId: this.options.transcriptionModelId }
          : {}),
      },
      this.planDeps(opts)
    )
    if (opts.port !== undefined) plan = { ...plan, port: opts.port }

    for (let attempt = 0; attempt < 3; attempt++) {
      this.assertRunning()
      try {
        return await this.spawnSession(plan, opts)
      } catch (error) {
        if (this.closing) throw error
        const retry = nextRetry(error, plan, this.options.transcriptionModelId)
        if (!retry) throw error
        if (retry.kind === 'text-only') {
          plan = retry.plan
          plan.warnings.push(
            `Vision support is unavailable for "${modelId}": the projector failed to load, retrying without it.`
          )
        } else {
          plan = retry.plan
          plan.warnings.push(`Retrying "${modelId}" without MTP: ${formatLoadError(error)}`)
        }
      }
    }
    throw new AtomicCoreError(
      'MODEL_LOAD_FAILED',
      `Could not load model "${modelId}" after fallback attempts.`
    )
  }

  private enqueueLoad<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.loadTail.then(operation)
    this.loadTail = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private planDeps(opts: LoadOptions): LoadPlanDeps {
    const { layout, registry } = this.options
    const joinData = (relative: string) => registry.resolvePaths({ model_path: relative } as never).modelPath
    return {
      joinData,
      readModelYml: (id) => registry.read(id),
      resolveLatestBackend: this.options.resolveLatestBackend ?? (async () => undefined),
      ensureBackendReady: async (backend, version) => {
        if (opts.exePath) return { backend, version, exePath: opts.exePath }
        if (this.options.ensureBackendReady) return this.options.ensureBackendReady(backend, version)
        throw new AtomicCoreError(
          'BINARY_NOT_FOUND',
          'No llama.cpp backend is available for this data folder.',
          `${version}/${backend} in ${layout.provider(this.provider).backendsDir}`
        )
      },
      cpuInfo: this.options.cpuInfo ?? (async () => undefined),
      exists: async (path) => {
        const { stat } = await import('node:fs/promises')
        return stat(path).then(
          () => true,
          () => false
        )
      },
      fileSize: async (path) => {
        const { stat } = await import('node:fs/promises')
        return stat(path).then(
          (s) => s.size,
          () => undefined
        )
      },
      readGgufMetadata:
        this.options.readGgufMetadata ?? (async (path) => (await readGgufMetadataFromFile(path)).metadata),
      randomPort: () => randomFreePort(this.usedPorts()),
      checkGemmaMtpSupport,
      ensureGemmaMtpDraft: this.options.ensureGemmaMtpDraft ?? draftDownloadUnavailable,
      checkDflashSupport,
      ensureDflashDraft: this.options.ensureDflashDraft ?? draftDownloadUnavailable,
      backendSupportsDflashSpec: (exePath, env) =>
        checkSpecTypeSupport(exePath, DFLASH_SPEC_TYPE, env, dirname(exePath)),
      resolveLlama3TemplateOverride: (modelId, embedded) =>
        resolveLlama3TemplateOverride(modelId, embedded) ?? undefined,
      strictSystemGuardSignature: STRICT_SYSTEM_GUARD_SIGNATURE,
    }
  }

  /** Ports this runtime already handed out, so a second load never lands on the same one. */
  private usedPorts(): number[] {
    return [...this.sessions.values()].map((s) => s.info.port)
  }

  private async spawnSession(plan: LoadPlan, opts: LoadOptions): Promise<SessionInfo> {
    const args = planLlamaArgs(plan.config, {
      provider: plan.provider,
      isEmbedding: plan.isEmbedding,
      modelId: plan.modelId,
      modelPath: plan.modelPath,
      port: plan.port,
      mmprojPath: plan.mmprojPath ?? null,
    })
    const exeDir = dirname(plan.exePath)
    const { env, cwd } = buildProcessEnv({
      platform: this.platform,
      baseEnv: this.options.baseEnv ?? process.env,
      exeDir,
      cuda: discoverCudaPaths(nodeCudaProbeEnv(this.platform, this.options.baseEnv ?? process.env)),
      userEnv: plan.env,
    })
    const devices = new RuntimeDeviceAccumulator()
    const spawn = this.options.spawn ?? spawnAndAwaitReady
    const apiKey = plan.apiKey
    const logStream = opts.logPath ? await openLogStream(opts.logPath) : undefined

    let proc: ManagedProcess
    try {
      ;({ process: proc } = await spawn(
        { exe: plan.exePath, args: args.argv, env, cwd },
        {
          timeoutMs: plan.timeoutSecs * 1000,
          signal: this.shutdownController.signal,
          readyMarkers: LLAMA_READY_MARKERS,
          healthCheck: () => this.healthy(plan.port, apiKey),
          onLine: (stream, line) => {
            if (stream === 'stderr') devices.ingest(line)
            if (textMentionsCudaRuntime(line, this.platform)) devices.markCudaRuntimeMissing()
            logStream?.write(`[${stream}] ${line}\n`)
            if (opts.verbose)
              this.emit('core:log', {
                level: 'debug',
                msg: `[${plan.provider}/${plan.modelId}][${stream}] ${line}`,
              })
          },
          classifyExit: (exit, stderr, stdout) => classifyProcessOutput(exit, stderr, stdout, this.platform),
          timeoutMessage: `Timeout: ${plan.timeoutSecs}s`,
        }
      ))
    } catch (error) {
      await closeLogStream(logStream)
      throw error
    }

    const info: SessionInfo = {
      pid: proc.pid,
      port: plan.port,
      model_id: plan.modelId,
      model_path: plan.modelPath,
      is_embedding: plan.isEmbedding,
      api_key: apiKey,
      mmproj_path: plan.mmprojPath ?? null,
      runtime_device: devices.snapshot(),
    }
    const session: Session = {
      info,
      process: proc,
      plan,
      devices,
      journalled: false,
      ...(logStream ? { logStream } : {}),
    }
    try {
      await this.journalSpawn(session)
      this.assertRunning()
      this.sessions.set(plan.modelId, session)
      this.watchExit(session)
    } catch (error) {
      await proc.terminate().catch(() => {})
      if (session.journalled) await this.options.journal?.remove(session.info.pid).catch(() => {})
      await closeLogStream(session.logStream)
      throw error
    }

    this.emit('session:started', { ...info, provider: plan.provider })
    this.reportRuntimeDevice(plan, devices.snapshot())
    return { ...info }
  }

  private async journalSpawn(session: Session): Promise<void> {
    const journal = this.options.journal
    if (!journal) return
    const record: ChildProcessRecord = {
      instance_id: this.options.instanceId,
      pid: session.info.pid,
      process_start_id: (await processStartId(session.info.pid)) ?? null,
      exe: session.plan.exePath,
      provider: session.plan.provider,
      model_id: session.plan.modelId,
      port: session.info.port,
      started_at: new Date().toISOString(),
    }
    await journal.add(record)
    session.journalled = true
  }

  private watchExit(session: Session): void {
    void session.process.exited.then(async (exit: ExitInfo) => {
      const current = this.sessions.get(session.plan.modelId)
      if (current !== session) return // already replaced or unloaded
      this.sessions.delete(session.plan.modelId)
      if (session.journalled) await this.options.journal?.remove(session.info.pid).catch(() => {})
      await closeLogStream(session.logStream)
      const { stderr, stdout } = session.process.output()
      const error = classifyProcessOutput(exit, stderr, stdout, this.platform)
      this.emit('session:died', {
        provider: session.plan.provider,
        pid: session.info.pid,
        model_id: session.plan.modelId,
        exit_code: exit.code,
        signal: exit.signal === null ? null : String(exit.signal),
        message: error.message,
      })
    })
  }

  private reportRuntimeDevice(plan: LoadPlan, runtimeDevice: RuntimeDeviceInfo): void {
    const configured = `${plan.version}/${plan.backend}`
    const mismatch = classifyBackendMismatch({
      configuredBackend: plan.config.version_backend.split('/')[1] ?? '',
      effectiveBackend: plan.backend,
      runtimeDevice,
      requestedGpuLayers: plan.config.n_gpu_layers,
      categoryOf: (backend) => backend,
    })
    this.emit('backend:runtime-reported', {
      provider: plan.provider,
      modelId: plan.modelId,
      configuredVersionBackend: plan.config.version_backend,
      effectiveVersionBackend: configured,
      runtimeDevice,
      mismatch: mismatch.kind !== 'ok',
    })
  }

  private async healthy(port: number, apiKey: string): Promise<boolean> {
    const res = await this.fetchImpl(`http://127.0.0.1:${port}/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }).catch(() => undefined)
    return res !== undefined && res.ok
  }

  /** Stop one session. Unloading something that is not loaded is not an error. */
  async unload(modelId: string): Promise<UnloadResult> {
    this.assertRunning()
    return this.unloadSession(modelId)
  }

  /** The context window a loaded session is actually running with. */
  getCtxSize(modelId: string): number | undefined {
    const configured = this.sessions.get(modelId)?.plan.config.ctx_size
    return typeof configured === 'number' && configured > 0 ? configured : undefined
  }

  /**
   * Reload a model with the next context size up the ladder, because a request did not fit.
   *
   * Ported from the app's `auto_increase_ctx` handler, including the two cases where it declines:
   *
   * - `fit`: with fit on, llama.cpp sizes the window itself at load and `--ctx-size` is not even
   *   emitted, so a reload would change nothing and cost the user a model load.
   * - `at_max`: the ladder has reached what the model was trained for. Reloading at the same size
   *   would loop — the next request would overflow again and ask again.
   *
   * The unload is allowed to fail: a session that is already gone is still a reload candidate, and
   * refusing to reload because the corpse would not die is worse than reloading.
   */
  async autoIncreaseCtx(modelId: string, reason = 'ctx-overflow'): Promise<CtxIncreaseResult> {
    this.assertRunning()
    const session = this.sessions.get(modelId)
    if (!session) return { ok: false, reason: 'not-loaded' }
    if (session.plan.config.fit === true) return { ok: false, reason: 'fit' }

    const currentCtxLen = this.getCtxSize(modelId) ?? DEFAULT_CTX_LEN
    const maxCtxLen = session.plan.maxCtxTrain
    const newCtxLen = computeNextCtxLen(currentCtxLen, maxCtxLen)
    if (newCtxLen <= currentCtxLen)
      return {
        ok: false,
        reason: 'at_max',
        current_ctx_len: currentCtxLen,
        ...(maxCtxLen !== undefined ? { max_ctx_len: maxCtxLen } : {}),
      }

    const unloaded = await this.unloadSession(modelId)
    if (!unloaded.success)
      this.emit('core:log', {
        level: 'warn',
        msg: `auto_increase_ctx: unload of ${modelId} failed, reloading anyway: ${unloaded.error}`,
      })

    // `bypassAutoUnload`: this is a reload of the model the user is talking to, not a new model
    // taking its place, so it must not evict anything else.
    const info = await this.load(modelId, {
      overrides: { ctx_size: newCtxLen },
      bypassAutoUnload: true,
    })
    // Informational only: the reload emitted `session:started` with the new port and pid, so a
    // mirror that is following events already knows where the model moved to. This says why.
    this.emit('session:ctx-increased', {
      provider: this.provider,
      modelId,
      oldCtx: currentCtxLen,
      newCtx: newCtxLen,
      reason,
    })
    return { ok: true, new_ctx_len: newCtxLen, session: info }
  }

  /**
   * Reload a model at the context it already has, because its engine is unusable: a fatal compute
   * failure (a Metal OOM during prompt processing) leaves the ggml backend in an error state that
   * only a new process clears. The window is deliberately not grown — more context would only make
   * an out-of-memory failure more likely. As with `autoIncreaseCtx`, a failed unload does not stop
   * the reload.
   */
  async recreateSession(
    modelId: string
  ): Promise<{ ok: true; session: SessionInfo } | { ok: false; reason: 'not-loaded' }> {
    this.assertRunning()
    if (!this.sessions.has(modelId)) return { ok: false, reason: 'not-loaded' }
    const ctxLen = this.getCtxSize(modelId)
    const unloaded = await this.unloadSession(modelId)
    if (!unloaded.success)
      this.emit('core:log', {
        level: 'warn',
        msg: `compute_error_recovery: unload of ${modelId} failed, reloading anyway: ${unloaded.error}`,
      })
    const info = await this.load(modelId, {
      ...(ctxLen !== undefined ? { overrides: { ctx_size: ctxLen } } : {}),
      bypassAutoUnload: true,
    })
    return { ok: true, session: info }
  }

  private async unloadSession(modelId: string): Promise<UnloadResult> {
    const session = this.sessions.get(modelId)
    if (!session) return { success: true }
    this.sessions.delete(modelId)
    try {
      await session.process.terminate()
      if (session.journalled) await this.options.journal?.remove(session.info.pid).catch(() => {})
      await closeLogStream(session.logStream)
      this.emit('session:unloaded', {
        provider: session.plan.provider,
        model_id: modelId,
        pid: session.info.pid,
      })
      return { success: true }
    } catch (e) {
      if (session.process.child.exitCode === null && session.process.child.signalCode === null)
        this.sessions.set(modelId, session)
      else if (session.journalled) await this.options.journal?.remove(session.info.pid).catch(() => {})
      return { success: false, error: (e as Error).message }
    }
  }

  async unloadAll(): Promise<void> {
    this.assertRunning()
    await Promise.all([...this.sessions.keys()].map((id) => this.unloadSession(id)))
  }

  /** `llama-server --list-devices` against an installed backend. */
  async getDevices(exePath: string): Promise<DeviceInfo[]> {
    this.assertRunning()
    const spawnOne = this.options.probeDevicesWith ?? spawnManaged
    const { env, cwd } = buildProcessEnv({
      platform: this.platform,
      baseEnv: this.options.baseEnv ?? process.env,
      exeDir: dirname(exePath),
      cuda: discoverCudaPaths(nodeCudaProbeEnv(this.platform, this.options.baseEnv ?? process.env)),
      userEnv: {},
    })
    const proc = spawnOne({ exe: exePath, args: ['--list-devices'], env, cwd })
    const timeout = new Promise<'timeout'>((r) =>
      setTimeout(() => r('timeout'), DEVICE_PROBE_TIMEOUT_MS).unref()
    )
    const outcome = await Promise.race([proc.exited.then(() => 'exited' as const), timeout])
    if (outcome === 'timeout') {
      await proc.terminate(500)
      throw new AtomicCoreError(
        'DEVICE_LIST_PARSE_FAILED',
        'Timed out while listing llama.cpp devices.',
        `${exePath} --list-devices`
      )
    }
    const failure = proc.spawnFailure()
    if (failure)
      throw new AtomicCoreError('BINARY_NOT_FOUND', 'Cannot run the llama.cpp backend.', failure.message)
    await new Promise((r) => setTimeout(r, 10)) // let the line readers drain
    const { stdout, stderr } = proc.output()
    return parseDeviceOutput(`${stdout}\n${stderr}`)
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.shutdownController.abort()
    this.shutdownPromise = (async () => {
      await this.loadTail
      const results = await Promise.all([...this.sessions.keys()].map((id) => this.unloadSession(id)))
      const failure = results.find((result) => !result.success)
      if (failure) {
        throw new AtomicCoreError(
          'LLAMA_CPP_PROCESS_ERROR',
          'Could not stop every llama.cpp session during shutdown.',
          failure.error
        )
      }
    })()
    return this.shutdownPromise
  }

  async dispose(): Promise<void> {
    await this.shutdown()
  }

  private assertRunning(): void {
    if (this.closing) {
      throw new AtomicCoreError('CORE_NOT_RUNNING', 'The llama.cpp runtime is stopping or has stopped.')
    }
  }
}

function draftDownloadUnavailable(): Promise<void> {
  return Promise.reject(
    new AtomicCoreError(
      'INTERNAL_ERROR',
      'Downloading speculative draft models is not wired into this core yet.',
      'pass ensureGemmaMtpDraft / ensureDflashDraft to LlamacppRuntime'
    )
  )
}

async function openLogStream(path: string): Promise<WriteStream> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const stream = createWriteStream(path, { flags: 'a' })
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    })
    // A later disk error cannot retroactively fail a running model, but it must not become an
    // unhandled EventEmitter error either.
    stream.on('error', () => {})
    return stream
  } catch (error) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `Cannot open llama.cpp log file "${path}".`,
      (error as Error).message
    )
  }
}

function closeLogStream(stream: WriteStream | undefined): Promise<void> {
  if (!stream || stream.closed) return Promise.resolve()
  return new Promise((resolve) => stream.end(resolve))
}
