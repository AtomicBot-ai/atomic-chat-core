/**
 * The `foundry-local` provider's sessions (openspec change `add-foundry-local`, task 6.3, design D5):
 * one `foundry-host serve` process per model — this very binary in its hidden mode — on the sidecar
 * table MLX and Foundation Models use, behind the session gateway the managed engines use.
 *
 *   load = model.yml → the variant runs on this platform → its accelerator is prepared → the active
 *          build → [GPU claim, for CUDA and WebGPU] → host on a random loopback port → readiness
 *          line → gateway (key + Host) → session on the gateway's port
 *
 * Foundry Local's built-in server has no authentication and serves the local catalog under
 * `/catalogs/local` with models named `<name>:<version>` (spike, rulings S1 finding 7): the gateway
 * holds the key, adds the prefix and renames the model both ways, so a client sees the core's model id.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelYmlFoundryLocal, SessionInfo, UnloadResult } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import type { EngineHost } from '../../engine-builds/service.js'
import type { ProcessJournal } from '../../lock/index.js'
import type { ModelRegistry } from '../../models/index.js'
import { generateGatewayKey, startManagedGateway } from '../managed-text/index.js'
import type { ManagedGateway, ManagedRoute } from '../managed-text/index.js'
import type {
  CtxIncreaseResult,
  EmitFn,
  GpuClaimHook,
  GpuOccupancy,
  LocalLoadOptions,
  LocalRuntime,
  RecreateResult,
  SessionRoutePolicy,
} from '../shared/index.js'
import {
  backendOutputReporter,
  randomFreePort,
  SidecarTable,
  spawnAndAwaitReady,
  throwIfLoadCancelled,
} from '../shared/index.js'
import type { BackendOutputSink } from '../shared/index.js'
import { executionProvider } from './host/execution-providers.js'
import { LOCAL_CATALOG_BASE_PATH } from './host/run.js'
import type { FoundryHostCommand } from './host-process.js'
import { readFoundryLocalBlock } from './model-yml.js'

/** The settings' `timeout` default, in seconds: registering, building the ORT session, compiling (OpenVINO). */
export const FOUNDRY_LOCAL_DEFAULT_TIMEOUT_SECS = 600

/** What a Foundry Local session serves (design D5); anything else is refused before it reaches the host. */
export const FOUNDRY_LOCAL_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'GET', path: '/v1/models' },
]
const CHAT_ROUTE = '/v1/chat/completions'

/**
 * The accelerators each platform runs variants on (spec "Провайдер регистрируется только на
 * поддерживаемых платформах"). Which of them this machine actually has is the probe's answer (6.4).
 */
export function variantRunsOn(
  platform: NodeJS.Platform,
  arch: string,
  ep: ModelYmlFoundryLocal['execution_provider']
): boolean {
  if (ep === 'cpu') return true
  if (platform === 'win32') return true
  if (platform === 'darwin') return ep === 'webgpu'
  if (platform === 'linux') return arch === 'x64' && ep === 'cuda'
  return false
}

/** The registration id the host serves the model under: `<name>:<version>`, one segment. */
export function registrationId(modelId: string): string {
  return `${modelId.replace(/[^A-Za-z0-9._-]+/g, '-')}:1`
}

interface FoundrySessionExtra {
  build: string
  block: ModelYmlFoundryLocal
  gateway: ManagedGateway
}

export interface FoundryLocalRuntimeOptions {
  layout: DataLayout
  registry: ModelRegistry
  instanceId: string
  platform: NodeJS.Platform
  arch: string
  /** This binary in its `foundry-host` mode (`foundryHostCommand`). */
  hostCommand: FoundryHostCommand
  /** The active build's directory (engine-builds), or nothing installed. */
  resolveBuild: () => Promise<string | undefined>
  /** The accelerators core recorded as prepared (`accelerators.json`, task 6.4). */
  preparedAccelerators: () => Promise<readonly string[]>
  /** The same live trusted-hosts list `:1337` and the managed gateways use. */
  trustedHosts: string[]
  /** The `foundry-local` provider settings, re-read per load. */
  readSettings: () => Promise<Record<string, unknown>>
  journal?: ProcessJournal | undefined
  emit?: EmitFn
  baseEnv?: NodeJS.ProcessEnv
  backendOutput?: BackendOutputSink
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /** GPU residency (spec `gpu-residency`): CUDA and WebGPU variants hold every card. */
  claimGpu?: GpuClaimHook | undefined
  /** Test seam. */
  spawn?: typeof spawnAndAwaitReady
}

/** The host's exit codes (`host/run.ts`) as the core's errors. */
function hostError(exitCode: number | null, stderr: string): AtomicCoreError {
  const said = stderr.trim().split('\n').slice(-5).join('\n')
  if (exitCode === 5)
    return new AtomicCoreError(
      'FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED',
      'The accelerator of this model is not prepared; prepare it on the Foundry Local page first.',
      said
    )
  return new AtomicCoreError(
    'FOUNDRY_LOCAL_HOST_ERROR',
    exitCode === 3
      ? 'The Foundry Local library does not load on this computer.'
      : 'The Foundry Local host stopped before the model was ready.',
    said || `exit code ${String(exitCode)}`
  )
}

export class FoundryLocalRuntime implements LocalRuntime {
  private readonly table: SidecarTable<FoundrySessionExtra>
  private readonly emit: EmitFn
  /** Loads past their GPU claim and not yet a session. */
  private readonly claimed = new Map<string, GpuOccupancy>()

  /** The `foundry-local` model registry this runtime reads (`<data>/foundry-local/models`). */
  get registry(): ModelRegistry {
    return this.options.registry
  }

  constructor(private readonly options: FoundryLocalRuntimeOptions) {
    this.emit = options.emit ?? (() => {})
    this.table = new SidecarTable<FoundrySessionExtra>({
      provider: 'foundry-local',
      instanceId: options.instanceId,
      journal: options.journal,
      emit: this.emit,
      engine: 'Foundry Local',
      // Manager_Shutdown stops generations and unloads the model; a large model takes a moment.
      unloadGraceMs: 15_000,
      shutdownGraceMs: 5_000,
      describeExit: (exit, stderr) =>
        `The Foundry Local host exited (${exit.code !== null ? `code ${exit.code}` : `signal ${String(exit.signal)}`})${
          stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''
        }`,
    })
  }

  list(): SessionInfo[] {
    return this.table.list()
  }

  findSession(modelId: string): SessionInfo | undefined {
    return this.table.findSession(modelId)
  }

  getLoadedModels(): string[] {
    return this.table.getLoadedModels()
  }

  isLoading(modelId: string): boolean {
    return this.table.isLoading(modelId)
  }

  /** CUDA and WebGPU sessions hold every card (the library picks one we cannot name); NPU and CPU none. */
  gpuOccupancy(): GpuOccupancy[] {
    const cards = (block: ModelYmlFoundryLocal): GpuOccupancy['cards'] =>
      block.execution_provider === 'cuda' || block.execution_provider === 'webgpu' ? 'all' : []
    const ready = this.table.getLoadedModels().flatMap((modelId): GpuOccupancy[] => {
      const session = this.table.get(modelId)
      return session
        ? [{ model_id: modelId, cards: cards(session.extra.block), auxiliary: false, state: 'ready' }]
        : []
    })
    const loading = [...this.claimed.values()].filter((claim) => !this.table.findSession(claim.model_id))
    return [...ready, ...loading]
  }

  /** What the engine-builds module needs: the load queue, and the builds sessions run from (design D2). */
  engineHost(): EngineHost {
    return {
      exclusive: (fn) => this.table.exclusive(fn),
      inUse: async () => [
        ...new Set(
          this.table.getLoadedModels().flatMap((modelId) => {
            const build = this.table.get(modelId)?.extra.build
            return build ? [build] : []
          })
        ),
      ],
      activate: async (dir) => {
        for (const modelId of this.table.getLoadedModels())
          if (this.table.get(modelId)?.extra.build !== dir) await this.unload(modelId)
      },
    }
  }

  routePolicy(modelId: string): SessionRoutePolicy | undefined {
    const session = this.table.get(modelId)
    if (!session) return undefined
    const { block } = session.extra
    return {
      routes: FOUNDRY_LOCAL_ROUTES,
      tools: block.tools,
      structuredOutput: false,
      mapError: () => null,
      ...(block.context_length !== undefined ? { contextLength: block.context_length } : {}),
    }
  }

  async load(modelId: string, opts: LocalLoadOptions = {}): Promise<SessionInfo> {
    this.table.assertRunning()
    return this.table.load(modelId, () => this.start(modelId, opts), opts.signal)
  }

  private async start(modelId: string, opts: LocalLoadOptions): Promise<SessionInfo> {
    throwIfLoadCancelled(opts.signal)
    const registry = this.options.registry
    const yml = await registry.read(modelId)
    const block = readFoundryLocalBlock(yml)
    const ep = executionProvider(block.execution_provider)
    if (!variantRunsOn(this.options.platform, this.options.arch, block.execution_provider))
      throw new AtomicCoreError(
        'FOUNDRY_LOCAL_VARIANT_UNSUPPORTED',
        `This ${block.execution_provider.toUpperCase()} variant does not run on ${this.options.platform} ${this.options.arch}.`
      )
    if (ep.register && !(await this.options.preparedAccelerators()).includes(ep.register))
      throw new AtomicCoreError(
        'FOUNDRY_LOCAL_ACCELERATOR_NOT_PREPARED',
        `${ep.register} is not prepared; prepare it on the Foundry Local page before loading this model.`
      )
    const build = await this.options.resolveBuild()
    if (!build)
      throw new AtomicCoreError(
        'BINARY_NOT_FOUND',
        'Foundry Local is not installed; install it before loading a model.'
      )
    const { modelPath } = registry.resolvePaths(yml)
    const settings = await this.options.readSettings()
    const timeoutSecs =
      opts.timeoutSecs ??
      (Number(settings['timeout']) > 0 ? Number(settings['timeout']) : FOUNDRY_LOCAL_DEFAULT_TIMEOUT_SECS)

    if (!(opts.bypassAutoUnload ?? false))
      for (const loaded of this.table.getLoadedModels()) {
        throwIfLoadCancelled(opts.signal)
        await this.unload(loaded)
      }
    this.table.assertRunning()
    throwIfLoadCancelled(opts.signal)

    // GPU residency (design D6): CUDA and WebGPU hold every card; NPU and CPU variants claim nothing.
    const holdsGpu = block.execution_provider === 'cuda' || block.execution_provider === 'webgpu'
    const occupancy: GpuOccupancy = {
      model_id: modelId,
      cards: holdsGpu ? 'all' : [],
      auxiliary: false,
      state: 'loading',
    }
    const hold = () => void this.claimed.set(modelId, occupancy)
    try {
      if (holdsGpu && this.options.claimGpu) {
        await this.options.claimGpu({ model_id: modelId, cards: 'all', auxiliary: false }, opts.signal, hold)
        this.table.assertRunning()
        throwIfLoadCancelled(opts.signal)
      }
      hold()
      return await this.startHost(modelId, opts, { block, build, modelPath, timeoutSecs })
    } finally {
      if (this.claimed.get(modelId) === occupancy) this.claimed.delete(modelId)
    }
  }

  private async startHost(
    modelId: string,
    opts: LocalLoadOptions,
    launch: { block: ModelYmlFoundryLocal; build: string; modelPath: string; timeoutSecs: number }
  ): Promise<SessionInfo> {
    const { block, build, modelPath, timeoutSecs } = launch
    const paths = this.options.layout.provider('foundry-local')
    const hostPort = await randomFreePort(this.table.usedPorts())
    const id = registrationId(modelId)
    const cache = join(paths.tmpDir, randomUUID())
    const args = [
      ...this.options.hostCommand.args,
      'serve',
      '--lib',
      build,
      '--app-data',
      paths.runtimeDir as string,
      '--logs',
      paths.logsDir as string,
      '--model',
      modelPath,
      '--ep',
      block.execution_provider,
      '--port',
      String(hostPort),
      '--cache',
      cache,
      '--id',
      id,
      ...(block.tools ? ['--tools'] : []),
      ...(block.reasoning_start !== undefined && block.reasoning_end !== undefined
        ? ['--reasoning-start', block.reasoning_start, '--reasoning-end', block.reasoning_end]
        : []),
      ...(block.context_length !== undefined ? ['--context-length', String(block.context_length)] : []),
    ]
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.options.baseEnv ?? process.env))
      if (value !== undefined) env[key] = value
    // Design D8: Microsoft's optional telemetry off; `ProcessInfo` still goes and is disclosed.
    env['ORT_TELEMETRY_DISABLED'] = '1'
    // ONNX Runtime's GroupQueryAttention picks cuDNN flash attention on compute capability >= 9, and
    // the cuDNN 9.20 of Microsoft's CUDA plugin cannot build that graph on Blackwell (sm_120): every
    // completion fails, the model loaded. Off unless the person set it; only the CUDA plugin reads it.
    // Drop once the plugin ships a cuDNN that builds it (microsoft/foundry-local#1179).
    env['ORT_ENABLE_CUDNN_FLASH_ATTENTION'] ??= '0'
    const exe = this.options.hostCommand.exe
    const reportOutput = backendOutputReporter(this.options.backendOutput, this.options.log)
    this.options.log?.(
      'info',
      `starting the Foundry Local host for ${modelId} (${block.execution_provider}) from ${build}`
    )
    const started = await (this.options.spawn ?? spawnAndAwaitReady)(
      { exe, args, env, stdin: 'pipe', platform: this.options.platform },
      {
        timeoutMs: timeoutSecs * 1000,
        signal: this.table.signal,
        ...(opts.signal ? { cancelSignal: opts.signal } : {}),
        streamReadyMarkers: { stdout: ['"ready":true'], stderr: [] },
        timeoutError: (stderr) =>
          new AtomicCoreError(
            'MODEL_LOAD_TIMED_OUT',
            `The Foundry Local model did not load within ${timeoutSecs} seconds.`,
            stderr.trim().split('\n').slice(-5).join('\n')
          ),
        classifyExit: (exit, stderr) => hostError(exit.code, stderr),
        onLine: (stream, line) => {
          if (opts.verbose)
            this.emit('core:log', { level: 'debug', msg: `[foundry-local/${modelId}][${stream}] ${line}` })
          reportOutput({ provider: 'foundry-local', model: modelId, stream, line })
        },
      }
    )
    let gateway: ManagedGateway
    const apiKey = generateGatewayKey()
    try {
      gateway = await startManagedGateway({
        upstream: { host: '127.0.0.1', port: hostPort, basePath: LOCAL_CATALOG_BASE_PATH },
        apiKey,
        allowedHosts: this.options.trustedHosts,
        routes: FOUNDRY_LOCAL_ROUTES,
        rewritableRoutes: [{ method: 'POST', path: CHAT_ROUTE }],
        // The host knows the model by its registration id; the client by the core's id.
        rewriteRequestBody: (_route, body) =>
          body !== null && typeof body === 'object' && !Array.isArray(body) ? { ...body, model: id } : body,
        rewriteResponseFor: () => (json) => ('model' in json ? { ...json, model: modelId } : json),
      })
    } catch (error) {
      await started.process.terminate(this.table.isClosing ? 0 : 5_000).catch(() => {})
      throw error
    }
    void started.process.exited.then(() => gateway.close().catch(() => {}))
    try {
      return await this.table.adopt(
        {
          info: {
            pid: started.process.pid,
            port: gateway.port,
            model_id: modelId,
            model_path: modelPath,
            is_embedding: false,
            api_key: apiKey,
          },
          process: started.process,
          exe,
          extra: { build, block, gateway },
        },
        opts.signal
      )
    } catch (error) {
      await gateway.close().catch(() => {})
      throw error
    }
  }

  /** Waits for the host to exit (spec "Выгрузка"); the gateway goes with it. */
  async unload(modelId: string): Promise<UnloadResult> {
    this.table.assertRunning()
    const gateway = this.table.get(modelId)?.extra.gateway
    const result = await this.table.unload(modelId)
    if (result.success) await gateway?.close().catch(() => {})
    return result
  }

  /** The context is the variant's own: nothing to grow. */
  async autoIncreaseCtx(modelId: string): Promise<CtxIncreaseResult> {
    return this.table.get(modelId)
      ? { ok: false, reason: 'unsupported' }
      : { ok: false, reason: 'not-loaded' }
  }

  async recreateSession(modelId: string): Promise<RecreateResult> {
    this.table.assertRunning()
    const session = this.table.get(modelId)
    if (!session) return { ok: false, reason: 'not-loaded' }
    await this.unload(modelId)
    return { ok: true, session: await this.load(modelId, { bypassAutoUnload: true }) }
  }

  async shutdown(): Promise<void> {
    const gateways = this.table.getLoadedModels().flatMap((id) => {
      const gateway = this.table.get(id)?.extra.gateway
      return gateway ? [gateway] : []
    })
    try {
      await this.table.shutdown()
    } finally {
      await Promise.all(gateways.map((gateway) => gateway.close().catch(() => {})))
    }
  }
}
