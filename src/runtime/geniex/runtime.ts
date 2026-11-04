/**
 * The `geniex` provider's sessions (openspec change `add-geniex-runtime`, task 6.3, design D4–D7):
 * one `geniex-host serve` process per model — this very binary in its hidden mode — on the sidecar
 * table Foundry Local and LiteRT-LM use, behind the session gateway the managed engines use.
 *
 *   load = model.yml → a bundle is for this chip → the device (settings, else model.yml; a bundle on
 *          the NPU only) → the active build → the device is one the build's probe found → the model's
 *          facts (`inspect`, cached by path and mtime): a bundle for a newer GenieX? context cut to
 *          the model → [GPU claim, for gpu] → host on a random loopback port → readiness line →
 *          gateway (key + Host) → session on the gateway's port
 *
 * The host's server has no authentication; the gateway holds the key and lets through only
 * `/v1/chat/completions` and `/v1/models`. The host serves the model under core's id (`--id`).
 */

import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AtomicCoreError, GENIEX_DEVICES } from '../../contracts/index.js'
import type {
  GeniexChip,
  GeniexDevice,
  GeniexModelMetadata,
  ModelYmlGeniex,
  SessionInfo,
  UnloadResult,
} from '../../contracts/index.js'
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
  exitedOnTakenPort,
  randomFreePort,
  retryOnTakenPort,
  SidecarTable,
  spawnAndAwaitReady,
  throwIfLoadCancelled,
} from '../shared/index.js'
import type { BackendOutputSink } from '../shared/index.js'
import { compareVersions } from '../../backend/index.js'
import { deviceFound, deviceMissingReason } from './devices.js'
import { GENIEX_POWER_MODES } from './host/library.js'
import type { GeniexPowerMode } from './host/library.js'
import { runGeniexHostInspect } from './host-process.js'
import type { GeniexHostCommand } from './host-process.js'
import { readGeniexBlock } from './model-yml.js'

/** The settings' `timeout` default, in seconds: opening the file, compiling for the NPU, the server. */
export const GENIEX_DEFAULT_TIMEOUT_SECS = 600

/** What a GenieX session serves (design D6); anything else is refused before it reaches the host. */
export const GENIEX_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'GET', path: '/v1/models' },
]

/** The active build as the runtime needs it: its folder, GenieX version and the devices its probe found. */
export interface GeniexBuild {
  dir: string
  version: string
  devices: string[]
}

/** `device` of the settings when it names one, else `model.yml`'s default. */
export function launchDevice(settingDevice: unknown, block: ModelYmlGeniex): GeniexDevice {
  return GENIEX_DEVICES.some((known) => known === settingDevice)
    ? (settingDevice as GeniexDevice)
    : block.backend
}

/** `ctx_len` of the settings (0: the model's own), else `model.yml`'s, cut to the model's maximum. */
export function engineContext(settingCtx: unknown, block: ModelYmlGeniex, modelMax: number | null): number {
  const asked = Number(settingCtx) > 0 ? Math.round(Number(settingCtx)) : block.context_length
  return modelMax !== null ? Math.min(asked, modelMax) : asked
}

const powerMode = (value: unknown): GeniexPowerMode =>
  GENIEX_POWER_MODES.some((known) => known === value) ? (value as GeniexPowerMode) : 'burst'

interface GeniexSessionExtra {
  build: string
  block: ModelYmlGeniex
  device: GeniexDevice
  gateway: ManagedGateway
  context: number
}

export interface GeniexRuntimeOptions {
  layout: DataLayout
  registry: ModelRegistry
  instanceId: string
  /** This machine's chip (`geniexHostPlatform`); the runtime exists only where there is one. */
  chip: GeniexChip
  /** This binary in its `geniex-host` mode (`geniexHostCommand`). */
  hostCommand: GeniexHostCommand
  /** The active build (engine-builds); `undefined` with nothing installed. */
  resolveBuild: () => Promise<GeniexBuild | undefined>
  /** The same live trusted-hosts list `:1337` and the managed gateways use. */
  trustedHosts: string[]
  /** The `geniex` provider settings, re-read per load. */
  readSettings: () => Promise<Record<string, unknown>>
  journal?: ProcessJournal | undefined
  emit?: EmitFn
  baseEnv?: NodeJS.ProcessEnv
  backendOutput?: BackendOutputSink
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /** GPU residency (spec `gpu-residency`): a `gpu` session holds every card. */
  claimGpu?: GpuClaimHook | undefined
  /** Test seams. */
  spawn?: typeof spawnAndAwaitReady
  inspectModel?: (path: string) => Promise<GeniexModelMetadata>
}

/** The host's exit codes (`host/run.ts` `EXIT`) as the core's errors. */
function hostError(exitCode: number | null, stderr: string): AtomicCoreError {
  const lines = stderr.trim().split('\n')
  // A bind failure sits above Node's stack, outside the last five lines: kept first, the retry reads it.
  const taken = lines.find((line) => exitedOnTakenPort(line))
  const said = [...(taken ? [taken] : []), ...lines.slice(-5).filter((line) => line !== taken)].join('\n')
  const last = stderr.trim().split('\n').at(-1) ?? ''
  let line: Record<string, unknown> = {}
  try {
    line = JSON.parse(last) as Record<string, unknown>
  } catch {
    // Not one of the host's JSON error lines.
  }
  if (exitCode === 6)
    return new AtomicCoreError(
      'GENIEX_MODEL_REQUIRES_NEWER_ENGINE',
      `This model needs GenieX ${String(line['required'] ?? 'newer')}; update GenieX first.`,
      said
    )
  if (exitCode === 7)
    return new AtomicCoreError(
      'GENIEX_VARIANT_UNSUPPORTED',
      typeof line['message'] === 'string' ? line['message'] : 'This model does not run on its device here.',
      said
    )
  return new AtomicCoreError(
    'GENIEX_HOST_ERROR',
    exitCode === 3
      ? 'The GenieX library does not load on this computer.'
      : 'The GenieX host stopped before the model was ready.',
    said || `exit code ${String(exitCode)}`
  )
}

export class GeniexRuntime implements LocalRuntime {
  private readonly table: SidecarTable<GeniexSessionExtra>
  private readonly emit: EmitFn
  /** Loads past their GPU claim and not yet a session. */
  private readonly claimed = new Map<string, GpuOccupancy>()
  /** `inspect` answers by `<path>|<mtime>`: a model that changed is read again. */
  private readonly facts = new Map<string, GeniexModelMetadata>()

  get registry(): ModelRegistry {
    return this.options.registry
  }

  constructor(private readonly options: GeniexRuntimeOptions) {
    this.emit = options.emit ?? (() => {})
    this.table = new SidecarTable<GeniexSessionExtra>({
      provider: 'geniex',
      instanceId: options.instanceId,
      journal: options.journal,
      emit: this.emit,
      engine: 'GenieX',
      unloadGraceMs: 15_000,
      shutdownGraceMs: 5_000,
      describeExit: (exit, stderr) =>
        `The GenieX host exited (${exit.code !== null ? `code ${exit.code}` : `signal ${String(exit.signal)}`})${
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

  /** A `gpu` session holds every card (the library picks one we cannot name); `npu`, `cpu` and `hybrid` none (design D7). */
  gpuOccupancy(): GpuOccupancy[] {
    const ready = this.table.getLoadedModels().flatMap((modelId): GpuOccupancy[] => {
      const session = this.table.get(modelId)
      return session
        ? [
            {
              model_id: modelId,
              cards: session.extra.device === 'gpu' ? 'all' : [],
              auxiliary: false,
              state: 'ready',
            },
          ]
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
    return {
      routes: GENIEX_ROUTES,
      tools: session.extra.block.tools,
      structuredOutput: true,
      mapError: () => null,
      contextLength: session.extra.context,
    }
  }

  /** The model's facts, read by this binary's host once per path and modification time. */
  async inspect(path: string): Promise<GeniexModelMetadata> {
    const mtime = await stat(path).then(
      (s) => s.mtimeMs,
      () => {
        throw new AtomicCoreError('MODEL_NOT_FOUND', `The model ${path} is missing.`)
      }
    )
    const key = `${path}|${mtime}`
    const known = this.facts.get(key)
    if (known) return known
    const read = this.options.inspectModel
      ? await this.options.inspectModel(path)
      : await runGeniexHostInspect(this.options.hostCommand, path, {
          env: this.options.baseEnv ?? process.env,
        })
    this.facts.set(key, read)
    return read
  }

  async load(modelId: string, opts: LocalLoadOptions = {}): Promise<SessionInfo> {
    this.table.assertRunning()
    return this.table.load(modelId, () => this.start(modelId, opts), opts.signal)
  }

  private async start(modelId: string, opts: LocalLoadOptions): Promise<SessionInfo> {
    throwIfLoadCancelled(opts.signal)
    const registry = this.options.registry
    const yml = await registry.read(modelId)
    const block = readGeniexBlock(yml)
    if (block.plugin === 'qairt' && block.chip !== this.options.chip)
      throw new AtomicCoreError(
        'GENIEX_VARIANT_UNSUPPORTED',
        `This AI Hub bundle is built for the Snapdragon ${block.chip ?? 'unknown'}; this computer has the ${this.options.chip}.`
      )
    const settings = await this.options.readSettings()
    const device = launchDevice(settings['device'], block)
    if (block.plugin === 'qairt' && device !== 'npu')
      throw new AtomicCoreError(
        'GENIEX_VARIANT_UNSUPPORTED',
        `AI Hub bundles run on the NPU only, not on the ${device}; set the device to NPU in the GenieX settings.`
      )
    const build = await this.options.resolveBuild()
    if (!build)
      throw new AtomicCoreError(
        'BINARY_NOT_FOUND',
        'GenieX is not installed; install it before loading a model.'
      )
    if (!deviceFound(device, build.devices))
      throw new AtomicCoreError(
        'GENIEX_VARIANT_UNSUPPORTED',
        deviceMissingReason(device),
        build.devices.join(', ') || 'no devices'
      )
    const { modelPath, mmprojPath: declared } = registry.resolvePaths(yml)
    // The projector: `mmproj_path` of model.yml, else the block's file name beside the model.
    const mmprojPath = declared ?? (block.mmproj ? join(dirname(modelPath), block.mmproj) : undefined)
    const info = await this.inspect(modelPath)
    if (
      info.kind === 'qairt' &&
      info.min_runtime_version &&
      compareVersions(info.min_runtime_version, build.version) > 0
    )
      throw new AtomicCoreError(
        'GENIEX_MODEL_REQUIRES_NEWER_ENGINE',
        `This bundle needs GenieX ${info.min_runtime_version}; the active build is ${build.version}. Update GenieX first.`,
        info.min_runtime_version
      )
    const context = engineContext(settings['ctx_len'], block, info.max_context_tokens)
    const timeoutSecs =
      opts.timeoutSecs ??
      (Number(settings['timeout']) > 0 ? Number(settings['timeout']) : GENIEX_DEFAULT_TIMEOUT_SECS)
    const mode = powerMode(settings['power_mode'])

    if (!(opts.bypassAutoUnload ?? false))
      for (const loaded of this.table.getLoadedModels()) {
        throwIfLoadCancelled(opts.signal)
        await this.unload(loaded)
      }
    this.table.assertRunning()
    throwIfLoadCancelled(opts.signal)

    // GPU residency (design D7): a gpu session holds every card; the NPU, the CPU and hybrid claim nothing.
    const holdsGpu = device === 'gpu'
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
      return await this.startHost(modelId, opts, {
        block,
        device,
        build,
        modelPath,
        mmprojPath,
        context,
        timeoutSecs,
        mode,
      })
    } finally {
      if (this.claimed.get(modelId) === occupancy) this.claimed.delete(modelId)
    }
  }

  private async startHost(
    modelId: string,
    opts: LocalLoadOptions,
    launch: {
      block: ModelYmlGeniex
      device: GeniexDevice
      build: GeniexBuild
      modelPath: string
      mmprojPath: string | undefined
      context: number
      timeoutSecs: number
      mode: GeniexPowerMode
    }
  ): Promise<SessionInfo> {
    const { block, device, build, modelPath, mmprojPath, context, timeoutSecs, mode } = launch
    const paths = this.options.layout.provider('geniex')
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.options.baseEnv ?? process.env))
      if (value !== undefined) env[key] = value
    const exe = this.options.hostCommand.exe
    const reportOutput = backendOutputReporter(this.options.backendOutput, this.options.log)
    this.options.log?.(
      'info',
      `starting the GenieX host for ${modelId} (${block.plugin} on ${device}) from ${build.dir}`
    )
    // The free-port probe is racy: another process may bind the port before the host does. The host
    // then exits on EADDRINUSE, and is started again on a port picked anew (as llama-server is).
    const { started, hostPort } = await retryOnTakenPort(
      async () => {
        const hostPort = await randomFreePort(this.table.usedPorts())
        const tmp = join(paths.tmpDir, `${modelId.replace(/[^A-Za-z0-9._-]+/g, '_')}-${hostPort}`)
        const args = [
          ...this.options.hostCommand.args,
          'serve',
          '--lib',
          build.dir,
          '--engine-version',
          build.version,
          '--model',
          modelPath,
          '--plugin',
          block.plugin,
          '--device',
          device,
          ...(mmprojPath ? ['--mmproj', mmprojPath] : []),
          '--nctx',
          String(context),
          '--max-tokens',
          String(context),
          '--power-mode',
          mode,
          '--port',
          String(hostPort),
          '--tmp',
          tmp,
          '--id',
          modelId,
          ...(block.reasoning ? ['--reasoning'] : []),
        ]
        const started = await (this.options.spawn ?? spawnAndAwaitReady)(
          { exe, args, env, stdin: 'pipe', platform: process.platform },
          {
            timeoutMs: timeoutSecs * 1000,
            signal: this.table.signal,
            ...(opts.signal ? { cancelSignal: opts.signal } : {}),
            streamReadyMarkers: { stdout: ['"ready":true'], stderr: [] },
            timeoutError: (stderr) =>
              new AtomicCoreError(
                'MODEL_LOAD_TIMED_OUT',
                `The GenieX model did not load within ${timeoutSecs} seconds.`,
                stderr.trim().split('\n').slice(-5).join('\n')
              ),
            classifyExit: (exit, stderr) => hostError(exit.code, stderr),
            onLine: (stream, line) => {
              if (opts.verbose)
                this.emit('core:log', { level: 'debug', msg: `[geniex/${modelId}][${stream}] ${line}` })
              reportOutput({ provider: 'geniex', model: modelId, stream, line })
            },
          }
        )
        return { started, hostPort }
      },
      (error) => error instanceof AtomicCoreError && exitedOnTakenPort(error.details),
      (attempt) =>
        this.options.log?.(
          'warn',
          `the GenieX host for ${modelId} found its port taken (attempt ${attempt}); starting it on another`
        )
    )
    let gateway: ManagedGateway
    const apiKey = generateGatewayKey()
    try {
      gateway = await startManagedGateway({
        upstream: { host: '127.0.0.1', port: hostPort },
        apiKey,
        allowedHosts: this.options.trustedHosts,
        routes: GENIEX_ROUTES,
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
          extra: { build: build.dir, block, device, gateway, context },
        },
        opts.signal
      )
    } catch (error) {
      await gateway.close().catch(() => {})
      throw error
    }
  }

  /** Waits for the host to exit; the gateway goes with it. */
  async unload(modelId: string): Promise<UnloadResult> {
    this.table.assertRunning()
    const gateway = this.table.get(modelId)?.extra.gateway
    const result = await this.table.unload(modelId)
    if (result.success) await gateway?.close().catch(() => {})
    return result
  }

  /** The context is fixed when the model is created: nothing to grow. */
  async autoIncreaseCtx(modelId: string): Promise<CtxIncreaseResult> {
    return this.table.get(modelId)
      ? { ok: false, reason: 'unsupported' }
      : { ok: false, reason: 'not-loaded' }
  }

  async recreateSession(modelId: string): Promise<RecreateResult> {
    this.table.assertRunning()
    if (!this.table.get(modelId)) return { ok: false, reason: 'not-loaded' }
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
