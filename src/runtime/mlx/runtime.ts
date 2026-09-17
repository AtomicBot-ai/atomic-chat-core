/**
 * MLX models, served one process per model by the bundled `mlx-server` (mlx-vlm), Apple Silicon.
 *
 * Ported from: tauri-plugin-mlx/src/commands.rs (`load_mlx_model_impl`, unload, cleanup) and
 * extensions/mlx-extension/src/index.ts (`performLoad`, `handleAutoIncreaseCtx`).
 *
 * The extension planned a load (settings, drafter, context) and the plugin ran it; here both halves
 * are one. The core keeps the extension's model catalogue where it was — listing, importing and
 * downloading MLX models stays in the app — and takes over what needs a process: load, unload,
 * growing the context, restarting.
 *
 * Deliberate differences, each for a reason the app had no way to act on:
 *  - loading a loaded model answers with its session, and unloading an unloaded one succeeds — the
 *    shared semantics of every core runtime (the extension threw in both cases);
 *  - a drafter that is switched on but not on disk is not downloaded at load time: the app still
 *    downloads it before asking (its adapter passes `draft_model_path`), and a CLI load runs without
 *    it, as the extension already did whenever that download failed;
 *  - a session that dies is removed and reported with `session:died`; the plugin kept it until a
 *    chat request found the dead port.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DataLayout } from '../../config/index.js'
import type { SessionInfo, UnloadResult } from '../../contracts/index.js'
import type { ProcessJournal } from '../../lock/index.js'
import type { ModelRegistry } from '../../models/index.js'
import { resolveEagle3Draft, resolveMlxDflashDraft, resolveMtpDraft } from '../../speculative/index.js'
import { DEFAULT_CTX_LEN, computeNextCtxLen } from '../llamacpp/ctx-ladder.js'
import type {
  CtxIncreaseResult,
  EmitFn,
  LocalLoadOptions,
  LocalRuntime,
  RecreateResult,
} from '../shared/index.js'
import {
  closeLogStream,
  openLogStream,
  randomFreePort,
  SidecarTable,
  spawnAndAwaitReady,
} from '../shared/index.js'
import { buildMlxServerArgs, normalizeMlxModelPath } from './args.js'
import { asNumber, buildMlxConfig, selectMlxDraftSettings } from './config.js'
import type { MlxDraftKind, MlxExtensionConfigInput } from './config.js'
import {
  MLX_STDERR_READY_MARKERS,
  MLX_STDOUT_READY_MARKERS,
  classifyMlxStderr,
  describeMlxExit,
  mlxBinaryMissing,
  mlxModelMissing,
  mlxTimeout,
} from './errors.js'
import { readMlxMaxCtxTrain, repairLegacyShardName, resolveLocalDraftDir } from './model-files.js'

export const MLX_SERVER_BINARY = 'mlx-server'
/** The extension's `timeout` default, in seconds. */
export const MLX_DEFAULT_TIMEOUT_SECS = 600

interface MlxSessionExtra {
  /** The context the server was started with (`--max-kv-size`). */
  ctxSize: number
  maxCtxTrain: number | undefined
  /** The per-model settings of this load, so a reload keeps its drafter and quantization. */
  overrides: Record<string, unknown>
}

export interface MlxRuntimeOptions {
  layout: DataLayout
  registry: ModelRegistry
  instanceId: string
  /** The bundled binaries folder (the app's `resources/bin`); `mlx-server` is looked up here. */
  resourcesDir?: string | undefined
  /** The `mlx` provider settings, re-read per load. */
  readSettings: () => Promise<Record<string, unknown>>
  journal?: ProcessJournal | undefined
  emit?: EmitFn
  baseEnv?: NodeJS.ProcessEnv
  /**
   * A drafter that is switched on but has no path. Defaults to one already on disk; a caller that
   * can download may do so here.
   */
  resolveDraft?: (kind: MlxDraftKind, modelId: string) => Promise<string | undefined>
  /** Test seams. */
  spawn?: typeof spawnAndAwaitReady
  exists?: (path: string) => boolean
}

export class MlxRuntime implements LocalRuntime {
  private readonly table: SidecarTable<MlxSessionExtra>
  private readonly emit: EmitFn

  constructor(private readonly options: MlxRuntimeOptions) {
    this.emit = options.emit ?? (() => {})
    this.table = new SidecarTable<MlxSessionExtra>({
      provider: 'mlx',
      instanceId: options.instanceId,
      journal: options.journal,
      emit: this.emit,
      engine: 'MLX',
      unloadGraceMs: 5000,
      shutdownGraceMs: 2000,
      describeExit: (exit, stderr) => describeMlxExit(exit, stderr),
    })
  }

  binaryPath(): string | undefined {
    return this.options.resourcesDir ? join(this.options.resourcesDir, MLX_SERVER_BINARY) : undefined
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

  /** The context a loaded session runs with. */
  getCtxSize(modelId: string): number | undefined {
    return this.table.get(modelId)?.extra.ctxSize
  }

  async load(modelId: string, opts: LocalLoadOptions = {}): Promise<SessionInfo> {
    this.table.assertRunning()
    return this.table.load(modelId, () => this.start(modelId, opts))
  }

  private async start(modelId: string, opts: LocalLoadOptions): Promise<SessionInfo> {
    const settings = await this.options.readSettings()
    const overrides = { ...(opts.overrides ?? {}) }
    const cfg: MlxExtensionConfigInput & Record<string, unknown> = { ...settings, ...overrides }
    const isEmbedding = opts.isEmbedding ?? false

    const autoUnload =
      cfg['auto_unload'] === undefined || cfg['auto_unload'] === true || cfg['auto_unload'] === 'true'
    if (autoUnload && !isEmbedding && !(opts.bypassAutoUnload ?? false)) {
      // Loads are queued one at a time, so nothing else is starting: everything loaded goes.
      for (const loaded of this.table.getLoadedModels()) await this.table.unload(loaded)
    }
    this.table.assertRunning()

    const registry = this.options.registry
    const yml = await repairLegacyShardName(registry, modelId, await registry.read(modelId), (message) =>
      this.emit('core:log', { level: 'warn', msg: message })
    )
    const { modelPath } = registry.resolvePaths(yml)
    const exe = opts.exePath ?? this.binaryPath()
    if (!exe || !this.exists(exe)) throw mlxBinaryMissing(exe ?? join('<resources-dir>', MLX_SERVER_BINARY))
    if (!this.exists(modelPath)) throw mlxModelMissing(modelPath)

    const port = opts.port ?? (await randomFreePort(this.table.usedPorts()))
    const maxCtxTrain = await readMlxMaxCtxTrain(modelPath)
    const draft = selectMlxDraftSettings(cfg)
    const anyDrafter = Boolean(cfg.dflash_enabled) || Boolean(cfg.mtp_enabled) || Boolean(cfg.eagle3_enabled)
    if (anyDrafter && !draft.draftPath) {
      const restored = await (this.options.resolveDraft ?? ((kind, id) => this.localDraft(kind, id)))(
        draft.draftKind,
        modelId
      ).catch(() => undefined)
      if (restored) {
        draft.draftPath = restored
        overrides['draft_model_path'] = restored
      } else {
        this.emit('core:log', {
          level: 'warn',
          msg: `${modelId} has ${draft.draftKind}_enabled=true but no ${draft.draftKind} drafter on disk; loading without drafter`,
        })
      }
    }
    const config = buildMlxConfig(cfg, draft, { ...(maxCtxTrain !== undefined ? { maxCtxTrain } : {}) })
    const args = buildMlxServerArgs(modelPath, port, config)
    const timeoutSecs = opts.timeoutSecs ?? asNumber(cfg['timeout']) ?? MLX_DEFAULT_TIMEOUT_SECS
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.options.baseEnv ?? process.env))
      if (value !== undefined) env[key] = value
    env['MLX_VLM_SINGLE_MODEL'] = '1'

    const logStream = opts.logPath ? await openLogStream(opts.logPath, 'MLX') : undefined
    let started
    try {
      started = await (this.options.spawn ?? spawnAndAwaitReady)(
        { exe, args, env },
        {
          timeoutMs: timeoutSecs * 1000,
          signal: this.table.signal,
          streamReadyMarkers: { stdout: MLX_STDOUT_READY_MARKERS, stderr: MLX_STDERR_READY_MARKERS },
          // The plugin killed a server that did not come up at once, without a grace period.
          timeoutGraceMs: 0,
          timeoutError: (stderr) => mlxTimeout(timeoutSecs, stderr),
          classifyExit: (_exit, stderr) => classifyMlxStderr(stderr),
          onLine: (stream, line) => {
            logStream?.write(`[${stream}] ${line}\n`)
            if (opts.verbose)
              this.emit('core:log', { level: 'debug', msg: `[mlx/${modelId}][${stream}] ${line}` })
          },
        }
      )
    } catch (error) {
      await closeLogStream(logStream)
      throw error
    }
    return this.table.adopt({
      info: {
        pid: started.process.pid,
        port,
        model_id: modelId,
        model_path: normalizeMlxModelPath(modelPath),
        is_embedding: isEmbedding,
        api_key: '',
      },
      process: started.process,
      exe,
      extra: { ctxSize: config.ctx_size, maxCtxTrain, overrides },
      logStream,
    })
  }

  private async localDraft(kind: MlxDraftKind, modelId: string): Promise<string | undefined> {
    const resolution =
      kind === 'mtp'
        ? resolveMtpDraft(modelId)
        : kind === 'eagle3'
          ? resolveEagle3Draft(modelId)
          : resolveMlxDflashDraft(modelId)
    return resolution ? resolveLocalDraftDir(this.options.layout, resolution.repo) : undefined
  }

  unload(modelId: string): Promise<UnloadResult> {
    this.table.assertRunning()
    return this.table.unload(modelId)
  }

  /**
   * Reload with the next context up the ladder, because a request did not fit — clamped to what the
   * model was trained for, where the reload would change nothing (`at_max`).
   */
  async autoIncreaseCtx(modelId: string, reason = 'ctx-overflow'): Promise<CtxIncreaseResult> {
    this.table.assertRunning()
    const session = this.table.get(modelId)
    if (!session) return { ok: false, reason: 'not-loaded' }
    const current = session.extra.ctxSize || DEFAULT_CTX_LEN
    const max = session.extra.maxCtxTrain
    const next = computeNextCtxLen(current, max)
    if (next <= current)
      return {
        ok: false,
        reason: 'at_max',
        current_ctx_len: current,
        ...(max !== undefined ? { max_ctx_len: max } : {}),
      }
    const info = await this.reload(
      modelId,
      { ...session.extra.overrides, ctx_size: next },
      'auto_increase_ctx'
    )
    this.emit('session:ctx-increased', { provider: 'mlx', modelId, oldCtx: current, newCtx: next, reason })
    return { ok: true, new_ctx_len: next, session: info }
  }

  async recreateSession(modelId: string): Promise<RecreateResult> {
    this.table.assertRunning()
    const session = this.table.get(modelId)
    if (!session) return { ok: false, reason: 'not-loaded' }
    const info = await this.reload(
      modelId,
      { ...session.extra.overrides, ctx_size: session.extra.ctxSize },
      'compute_error_recovery'
    )
    return { ok: true, session: info }
  }

  /** Unload (a failure does not stop the reload) and load again without evicting other models. */
  private async reload(
    modelId: string,
    overrides: Record<string, unknown>,
    why: string
  ): Promise<SessionInfo> {
    const unloaded = await this.table.unload(modelId)
    if (!unloaded.success)
      this.emit('core:log', {
        level: 'warn',
        msg: `${why}: unload of ${modelId} failed, reloading anyway: ${unloaded.error}`,
      })
    return this.load(modelId, { overrides, bypassAutoUnload: true })
  }

  shutdown(): Promise<void> {
    return this.table.shutdown()
  }

  private exists(path: string): boolean {
    return (this.options.exists ?? existsSync)(path)
  }
}
