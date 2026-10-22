/**
 * The `litert-lm` provider's sessions (openspec change `add-litert-lm-runtime`, task 6.3, design D5):
 * one `litert-host serve` process per model — this very binary in its hidden mode — on the sidecar
 * table Foundry Local uses, behind the session gateway the managed engines use.
 *
 *   load = model.yml → the variant runs on this platform (NPU: this machine's generation) → NPU: the
 *          OpenVINO accelerator is prepared → the active build → the file's facts (`inspect`, cached
 *          by path and mtime): newer engine needed? backend in the file? context cut to the file →
 *          [GPU claim, for gpu] → host on a random loopback port → readiness line → gateway (key + Host)
 *          → session on the gateway's port
 *
 * The host's server has no authentication; the gateway holds the key and lets through only
 * `/v1/chat/completions` and `/v1/models`. The host serves the model under core's id (`--id`).
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { LiteRtLmNpu, ModelYmlLiteRtLm, SessionInfo, UnloadResult } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import type { EngineHost } from '../../engine-builds/service.js'
import type { LiteRtLmPlatform } from '../../engine-builds/manifest.js'
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
import { compareVersions } from '../../backend/index.js'
import type { LiteRtFileInfo } from './host/library.js'
import { runLiteRtHostInspect } from './host-process.js'
import type { LiteRtHostCommand } from './host-process.js'
import { readLiteRtLmBlock } from './model-yml.js'

/** The settings' `timeout` default, in seconds: opening the file, compiling GPU shaders, the server. */
export const LITERT_LM_DEFAULT_TIMEOUT_SECS = 600
/** The context when neither the settings, `model.yml` nor the file name one. */
export const LITERT_LM_DEFAULT_CONTEXT = 4096

/** What a LiteRT-LM session serves (design D5); anything else is refused before it reaches the host. */
export const LITERT_LM_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'GET', path: '/v1/models' },
]

/** Whether a variant's backend runs here: `cpu` and `gpu` on every platform, `npu` on Windows only. */
export function backendRunsOn(platform: LiteRtLmPlatform, backend: ModelYmlLiteRtLm['backend']): boolean {
  return backend !== 'npu' || platform === 'win-x64'
}

/** `ctx_len` of the settings (0: the model's own), else `model.yml`'s, cut to the file's maximum. */
export function engineContext(settingCtx: unknown, block: ModelYmlLiteRtLm, fileMax: number | null): number {
  const asked =
    Number(settingCtx) > 0
      ? Math.round(Number(settingCtx))
      : (block.context_length ?? fileMax ?? LITERT_LM_DEFAULT_CONTEXT)
  return fileMax !== null ? Math.min(asked, fileMax) : asked
}

interface LiteRtSessionExtra {
  build: string
  block: ModelYmlLiteRtLm
  gateway: ManagedGateway
  context: number
}

export interface LiteRtLmRuntimeOptions {
  layout: DataLayout
  registry: ModelRegistry
  instanceId: string
  /** Which wheel this host runs (`liteRtLmHostPlatform`); the runtime exists only where there is one. */
  hostPlatform: LiteRtLmPlatform
  /** This binary in its `litert-host` mode (`liteRtHostCommand`). */
  hostCommand: LiteRtHostCommand
  /** The active build (engine-builds): its directory and LiteRT-LM version; nothing installed. */
  resolveBuild: () => Promise<{ dir: string; version: string } | undefined>
  /** The prepared OpenVINO libraries (task 6.4); `undefined` while not prepared. */
  openVinoLibs: () => Promise<string | undefined>
  /** This machine's Intel NPU generation (task 6.4); `null` without one LiteRT-LM files target. */
  npuGeneration: () => Promise<LiteRtLmNpu | null>
  /** The same live trusted-hosts list `:1337` and the managed gateways use. */
  trustedHosts: string[]
  /** The `litert-lm` provider settings, re-read per load. */
  readSettings: () => Promise<Record<string, unknown>>
  journal?: ProcessJournal | undefined
  emit?: EmitFn
  baseEnv?: NodeJS.ProcessEnv
  backendOutput?: BackendOutputSink
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /** GPU residency (spec `gpu-residency`): a `gpu` variant holds every card. */
  claimGpu?: GpuClaimHook | undefined
  /** Test seams. */
  spawn?: typeof spawnAndAwaitReady
  inspectFile?: (buildDir: string, file: string) => Promise<LiteRtFileInfo>
}

/** The host's exit codes (`host/run.ts` `EXIT`) as the core's errors. */
function hostError(exitCode: number | null, stderr: string): AtomicCoreError {
  const said = stderr.trim().split('\n').slice(-5).join('\n')
  const last = stderr.trim().split('\n').at(-1) ?? ''
  let line: Record<string, unknown> = {}
  try {
    line = JSON.parse(last) as Record<string, unknown>
  } catch {
    // Not one of the host's JSON error lines.
  }
  if (exitCode === 6)
    return new AtomicCoreError(
      'LITERT_LM_MODEL_REQUIRES_NEWER_ENGINE',
      `This model needs LiteRT-LM ${String(line['required'] ?? 'newer')}; update LiteRT-LM first.`,
      said
    )
  if (exitCode === 7)
    return new AtomicCoreError(
      'LITERT_LM_VARIANT_UNSUPPORTED',
      'This model file does not run on its backend here.',
      said
    )
  return new AtomicCoreError(
    'LITERT_LM_HOST_ERROR',
    exitCode === 3
      ? 'The LiteRT-LM library does not load on this computer.'
      : 'The LiteRT-LM host stopped before the model was ready.',
    said || `exit code ${String(exitCode)}`
  )
}

export class LiteRtLmRuntime implements LocalRuntime {
  private readonly table: SidecarTable<LiteRtSessionExtra>
  private readonly emit: EmitFn
  /** Loads past their GPU claim and not yet a session. */
  private readonly claimed = new Map<string, GpuOccupancy>()
  /** `inspect` answers by `<path>|<mtime>|<build>`: a file that changed is read again. */
  private readonly facts = new Map<string, LiteRtFileInfo>()

  get registry(): ModelRegistry {
    return this.options.registry
  }

  constructor(private readonly options: LiteRtLmRuntimeOptions) {
    this.emit = options.emit ?? (() => {})
    this.table = new SidecarTable<LiteRtSessionExtra>({
      provider: 'litert-lm',
      instanceId: options.instanceId,
      journal: options.journal,
      emit: this.emit,
      engine: 'LiteRT-LM',
      unloadGraceMs: 15_000,
      shutdownGraceMs: 5_000,
      describeExit: (exit, stderr) =>
        `The LiteRT-LM host exited (${exit.code !== null ? `code ${exit.code}` : `signal ${String(exit.signal)}`})${
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

  /** A `gpu` session holds every card (the library picks one we cannot name); `cpu` and `npu` none. */
  gpuOccupancy(): GpuOccupancy[] {
    const ready = this.table.getLoadedModels().flatMap((modelId): GpuOccupancy[] => {
      const session = this.table.get(modelId)
      return session
        ? [
            {
              model_id: modelId,
              cards: session.extra.block.backend === 'gpu' ? 'all' : [],
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
      routes: LITERT_LM_ROUTES,
      tools: session.extra.block.tools,
      structuredOutput: true,
      mapError: () => null,
      contextLength: session.extra.context,
    }
  }

  /** The file's facts, read by the build's own host once per path, modification time and build. */
  async inspect(buildDir: string, file: string): Promise<LiteRtFileInfo> {
    const mtime = await stat(file).then(
      (s) => s.mtimeMs,
      () => {
        throw new AtomicCoreError('MODEL_NOT_FOUND', `The model file ${file} is missing.`)
      }
    )
    const key = `${file}|${mtime}|${buildDir}`
    const known = this.facts.get(key)
    if (known) return known
    const read = this.options.inspectFile
      ? await this.options.inspectFile(buildDir, file)
      : await runLiteRtHostInspect(this.options.hostCommand, buildDir, file, {
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
    const block = readLiteRtLmBlock(yml)
    if (!backendRunsOn(this.options.hostPlatform, block.backend))
      throw new AtomicCoreError(
        'LITERT_LM_VARIANT_UNSUPPORTED',
        `LiteRT-LM runs ${block.backend.toUpperCase()} variants on Windows x64 only, not on ${this.options.hostPlatform}.`
      )
    let ovLibs: string | undefined
    if (block.backend === 'npu') {
      const generation = await this.options.npuGeneration()
      if (generation !== block.npu)
        throw new AtomicCoreError(
          'LITERT_LM_VARIANT_UNSUPPORTED',
          `This variant is built for the ${block.npu ?? 'unknown'} NPU; this computer has ${generation ?? 'no Intel NPU LiteRT-LM supports'}.`
        )
      ovLibs = await this.options.openVinoLibs()
      if (!ovLibs)
        throw new AtomicCoreError(
          'LITERT_LM_ACCELERATOR_NOT_PREPARED',
          'OpenVINO is not prepared; prepare it on the LiteRT-LM page before loading an NPU model.'
        )
    }
    const build = await this.options.resolveBuild()
    if (!build)
      throw new AtomicCoreError(
        'BINARY_NOT_FOUND',
        'LiteRT-LM is not installed; install it before loading a model.'
      )
    const { modelPath } = registry.resolvePaths(yml)
    const info = await this.inspect(build.dir, modelPath)
    if (info.min_runtime_version && compareVersions(info.min_runtime_version, build.version) > 0)
      throw new AtomicCoreError(
        'LITERT_LM_MODEL_REQUIRES_NEWER_ENGINE',
        `This model needs LiteRT-LM ${info.min_runtime_version}; the active build is ${build.version}. Update LiteRT-LM first.`,
        info.min_runtime_version
      )
    if (!info.backends.includes(block.backend))
      throw new AtomicCoreError(
        'LITERT_LM_VARIANT_UNSUPPORTED',
        `This file runs on ${info.backends.join(', ') || 'no backend'}, not ${block.backend}.`
      )
    const settings = await this.options.readSettings()
    const context = engineContext(settings['ctx_len'], block, info.max_context_tokens)
    const timeoutSecs =
      opts.timeoutSecs ??
      (Number(settings['timeout']) > 0 ? Number(settings['timeout']) : LITERT_LM_DEFAULT_TIMEOUT_SECS)
    const speculative = settings['speculative_decoding'] !== false && info.speculative_decoding

    if (!(opts.bypassAutoUnload ?? false))
      for (const loaded of this.table.getLoadedModels()) {
        throwIfLoadCancelled(opts.signal)
        await this.unload(loaded)
      }
    this.table.assertRunning()
    throwIfLoadCancelled(opts.signal)

    // GPU residency (design D6): a gpu variant holds every card; NPU and CPU claim nothing.
    const holdsGpu = block.backend === 'gpu'
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
        build,
        modelPath,
        context,
        timeoutSecs,
        speculative,
        ovLibs,
      })
    } finally {
      if (this.claimed.get(modelId) === occupancy) this.claimed.delete(modelId)
    }
  }

  private async startHost(
    modelId: string,
    opts: LocalLoadOptions,
    launch: {
      block: ModelYmlLiteRtLm
      build: { dir: string; version: string }
      modelPath: string
      context: number
      timeoutSecs: number
      speculative: boolean
      ovLibs: string | undefined
    }
  ): Promise<SessionInfo> {
    const { block, build, modelPath, context, timeoutSecs, speculative, ovLibs } = launch
    const paths = this.options.layout.provider('litert-lm')
    const hostPort = await randomFreePort(this.table.usedPorts())
    const args = [
      ...this.options.hostCommand.args,
      'serve',
      '--lib',
      build.dir,
      '--engine-version',
      build.version,
      '--model',
      modelPath,
      '--backend',
      block.backend,
      '--max-tokens',
      String(context),
      '--port',
      String(hostPort),
      '--cache',
      paths.cacheDir as string,
      '--id',
      modelId,
      ...(ovLibs
        ? ['--dispatch', join(build.dir, 'lib', 'vendors', 'intel_openvino', 'dispatch'), '--ov-libs', ovLibs]
        : []),
      ...(speculative ? ['--speculative'] : []),
      ...(block.reasoning ? ['--reasoning'] : []),
    ]
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.options.baseEnv ?? process.env))
      if (value !== undefined) env[key] = value
    const exe = this.options.hostCommand.exe
    const reportOutput = backendOutputReporter(this.options.backendOutput, this.options.log)
    this.options.log?.(
      'info',
      `starting the LiteRT-LM host for ${modelId} (${block.backend}) from ${build.dir}`
    )
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
            `The LiteRT-LM model did not load within ${timeoutSecs} seconds.`,
            stderr.trim().split('\n').slice(-5).join('\n')
          ),
        classifyExit: (exit, stderr) => hostError(exit.code, stderr),
        onLine: (stream, line) => {
          if (opts.verbose)
            this.emit('core:log', { level: 'debug', msg: `[litert-lm/${modelId}][${stream}] ${line}` })
          reportOutput({ provider: 'litert-lm', model: modelId, stream, line })
        },
      }
    )
    let gateway: ManagedGateway
    const apiKey = generateGatewayKey()
    try {
      gateway = await startManagedGateway({
        upstream: { host: '127.0.0.1', port: hostPort },
        apiKey,
        allowedHosts: this.options.trustedHosts,
        routes: LITERT_LM_ROUTES,
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
          extra: { build: build.dir, block, gateway, context },
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

  /** The context is fixed when the engine is created: nothing to grow. */
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
