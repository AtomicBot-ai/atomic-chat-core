/**
 * Apple's on-device model, served by the bundled `foundation-models-server` (macOS 26+, Apple
 * Silicon, Apple Intelligence enabled).
 *
 * Ported from: tauri-plugin-foundation-models/src/commands.rs (`load_foundation_models_server`,
 * `check_foundation_models_availability`, unload, cleanup) and
 * extensions/foundation-models-extension/src/index.ts (`load`, `unload`).
 *
 * There is one model, `apple/on-device`, and nothing to configure: the server takes a port and a
 * key. What the core adds over the plugin is what every runtime gives — one start at a time, a
 * journalled PID, and a session that disappears (with `session:died`) when its process does.
 *
 * The server prints its "listening" lines just before it binds, so readiness is optimistic in the
 * app too; a bind failure after that shows up as `session:died` here instead of a dead port.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ProcessJournal } from '../../lock/index.js'
import type { SessionInfo, UnloadResult } from '../../contracts/index.js'
import type { CtxIncreaseResult, LocalLoadOptions, LocalRuntime, RecreateResult } from '../local-runtime.js'
import { closeLogStream, openLogStream } from '../log-stream.js'
import { generateApiKey, randomFreePort } from '../ports.js'
import { spawnAndAwaitReady } from '../process.js'
import { SidecarTable } from '../sidecar.js'
import type { EmitFn } from '../sidecar.js'
import {
  FOUNDATION_MODELS_ERROR_PREFIX,
  FOUNDATION_MODELS_READY_MARKERS,
  classifyFoundationModelsExit,
  classifyFoundationModelsStderr,
  foundationModelsBinaryMissing,
  foundationModelsTimeout,
} from './errors.js'

export const APPLE_MODEL_ID = 'apple/on-device'
export const FOUNDATION_MODELS_BINARY = 'foundation-models-server'
/** The extension's HMAC secret for session keys (`index.ts:52`). */
export const FOUNDATION_MODELS_API_SECRET = 'JanFoundationModels'
export const FOUNDATION_MODELS_STARTUP_TIMEOUT_SECS = 60
/** How long an availability answer is trusted (the plugin's and the webview's cache: 30 min). */
export const AVAILABILITY_TTL_MS = 30 * 60 * 1000
/** The plugin waited on `--check` forever; a wedged binary must not wedge the control API. */
export const AVAILABILITY_CHECK_TIMEOUT_MS = 30_000

/**
 * What `--check` reports: `available`, `notEligible`, `appleIntelligenceNotEnabled`,
 * `modelNotReady`, `unavailable`, or `binaryNotFound` when there is no server to ask.
 */
export type FoundationModelsAvailability = string

export interface FoundationModelsRuntimeOptions {
  instanceId: string
  /** The bundled binaries folder (the app's `resources/bin`); the server is looked up here. */
  resourcesDir?: string | undefined
  journal?: ProcessJournal | undefined
  emit?: EmitFn
  baseEnv?: NodeJS.ProcessEnv
  now?: () => number
  /** Test seams. */
  spawn?: typeof spawnAndAwaitReady
  runCheck?: (exe: string) => Promise<string>
  exists?: (path: string) => boolean
}

export class FoundationModelsRuntime implements LocalRuntime {
  private readonly table: SidecarTable
  private readonly emit: EmitFn
  private availability: { status: FoundationModelsAvailability; at: number } | undefined

  constructor(private readonly options: FoundationModelsRuntimeOptions) {
    this.emit = options.emit ?? (() => {})
    this.table = new SidecarTable({
      provider: 'foundation-models',
      instanceId: options.instanceId,
      journal: options.journal,
      emit: this.emit,
      engine: 'Foundation Models',
      unloadGraceMs: 5000,
      shutdownGraceMs: 2000,
      describeExit: (exit, stderr) => {
        const reason = stderr.split('\n').find((line) => line.includes(FOUNDATION_MODELS_ERROR_PREFIX))
        if (reason) return classifyFoundationModelsStderr(reason).message
        return exit.signal
          ? `The Foundation Models server was stopped by signal ${exit.signal}.`
          : `The Foundation Models server exited with code ${exit.code ?? -1}.`
      },
    })
  }

  /** Where the server binary is expected, or undefined when no resources folder was given. */
  binaryPath(): string | undefined {
    return this.options.resourcesDir ? join(this.options.resourcesDir, FOUNDATION_MODELS_BINARY) : undefined
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

  /**
   * Whether this Mac can run the model. The binary decides (macOS version, Apple Silicon, Apple
   * Intelligence), so this only runs it and trusts the token for 30 minutes; a missing binary is not
   * cached, because an install can put it back.
   */
  async checkAvailability(force = false): Promise<FoundationModelsAvailability> {
    const now = this.options.now?.() ?? Date.now()
    if (!force && this.availability && now - this.availability.at < AVAILABILITY_TTL_MS)
      return this.availability.status
    const exe = this.binaryPath()
    if (!exe || !this.exists(exe)) return 'binaryNotFound'
    const stdout = await (this.options.runCheck ?? runCheck)(exe)
    const status = stdout.trim() || 'unavailable'
    this.availability = { status, at: now }
    return status
  }

  async load(modelId: string, opts: LocalLoadOptions = {}): Promise<SessionInfo> {
    this.table.assertRunning()
    if (modelId !== APPLE_MODEL_ID)
      throw new AtomicCoreError(
        'MODEL_NOT_FOUND',
        `Foundation Models extension only supports model '${APPLE_MODEL_ID}', got '${modelId}'`
      )
    return this.table.load(modelId, () => this.start(modelId, opts))
  }

  private async start(modelId: string, opts: LocalLoadOptions): Promise<SessionInfo> {
    const exe = opts.exePath ?? this.binaryPath()
    if (!exe || !this.exists(exe))
      throw foundationModelsBinaryMissing(exe ?? join('<resources-dir>', FOUNDATION_MODELS_BINARY))
    const timeoutSecs = opts.timeoutSecs ?? FOUNDATION_MODELS_STARTUP_TIMEOUT_SECS
    if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0)
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Load timeout must be a positive number of seconds.')
    const port = opts.port ?? (await randomFreePort(this.table.usedPorts()))
    const apiKey = generateApiKey(modelId, port, FOUNDATION_MODELS_API_SECRET)
    const args = ['--port', String(port), '--api-key', apiKey]
    const logStream = opts.logPath ? await openLogStream(opts.logPath, 'Foundation Models') : undefined
    const env = Object.fromEntries(
      Object.entries(this.options.baseEnv ?? process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    let started
    try {
      started = await (this.options.spawn ?? spawnAndAwaitReady)(
        { exe, args, env },
        {
          timeoutMs: timeoutSecs * 1000,
          signal: this.table.signal,
          // stdout only, as in the plugin: Hummingbird's own stderr log says "listening on" too.
          streamReadyMarkers: { stdout: FOUNDATION_MODELS_READY_MARKERS, stderr: [] },
          timeoutGraceMs: 5000,
          timeoutError: () => foundationModelsTimeout(timeoutSecs),
          failOnLine: (stream, line) =>
            stream === 'stderr' && line.includes(FOUNDATION_MODELS_ERROR_PREFIX)
              ? classifyFoundationModelsStderr(line)
              : undefined,
          classifyExit: (exit, stderr) => classifyFoundationModelsExit(exit, stderr),
          onLine: (stream, line) => {
            logStream?.write(`[${stream}] ${line}\n`)
            if (opts.verbose)
              this.emit('core:log', { level: 'debug', msg: `[foundation-models][${stream}] ${line}` })
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
        model_path: '',
        is_embedding: false,
        api_key: apiKey,
      },
      process: started.process,
      exe,
      extra: undefined,
      logStream,
    })
  }

  unload(modelId: string): Promise<UnloadResult> {
    this.table.assertRunning()
    return this.table.unload(modelId)
  }

  /** The on-device model has no context setting the core could grow. */
  async autoIncreaseCtx(modelId: string): Promise<CtxIncreaseResult> {
    this.table.assertRunning()
    return this.table.get(modelId)
      ? { ok: false, reason: 'unsupported' }
      : { ok: false, reason: 'not-loaded' }
  }

  async recreateSession(modelId: string): Promise<RecreateResult> {
    this.table.assertRunning()
    if (!this.table.get(modelId)) return { ok: false, reason: 'not-loaded' }
    await this.table.unload(modelId)
    return { ok: true, session: await this.load(modelId) }
  }

  shutdown(): Promise<void> {
    return this.table.shutdown()
  }

  private exists(path: string): boolean {
    return (this.options.exists ?? existsSync)(path)
  }
}

function runCheck(exe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ['--check'],
      { timeout: AVAILABILITY_CHECK_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        // The binary always exits 0; an error is a spawn failure or the timeout.
        if (error && !stdout)
          reject(new AtomicCoreError('IO_ERROR', 'An input/output error occurred.', error.message))
        else resolve(String(stdout))
      }
    )
  })
}
