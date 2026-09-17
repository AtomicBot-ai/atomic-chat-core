/**
 * The session table of a sidecar runtime — MLX and Foundation Models: engines the core starts as
 * one process per model and does not plan arguments for beyond a handful of flags.
 *
 * It holds what the llama.cpp runtime guarantees, in one place, so both sidecars keep it:
 *  - one load at a time for the provider, and a second request for a model already loading joins it
 *    (the MLX plugin's global load mutex; Foundation Models had none and could start two servers);
 *  - every spawned process is journalled before it can be forgotten, so a crashed owner leaves a
 *    trail the next owner can clean up and the app's reaper spares it;
 *  - a session exists only while its process does. Neither plugin watched its process: a crashed
 *    server stayed in the table until a chat request found the dead port. The table removes it on
 *    exit and emits `session:died`, which the app already listens for per provider.
 */

import type { WriteStream } from 'node:fs'
import { AtomicCoreError } from '../../contracts/index.js'
import type { CoreEvents, LocalProviderId, SessionInfo, UnloadResult } from '../../contracts/index.js'
import type { ChildProcessRecord, ProcessJournal } from '../../lock/index.js'
import { processStartId } from '../../lock/index.js'
import type { ExitInfo } from '../llamacpp/index.js'
import { closeLogStream } from './log-stream.js'
import type { ManagedProcess } from './process.js'

export type EmitFn = <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void

export interface SidecarSession<Extra = unknown> {
  info: SessionInfo
  process: ManagedProcess
  exe: string
  /** What the runtime needs to remember about a session (its context size, its drafter…). */
  extra: Extra
  logStream?: WriteStream | undefined
  journalled: boolean
}

export interface SidecarTableOptions {
  provider: LocalProviderId
  instanceId: string
  journal?: ProcessJournal | undefined
  emit: EmitFn
  /** Human wording of an unexpected exit, for `session:died`. */
  describeExit: (exit: ExitInfo, stderr: string, stdout: string) => string
  /** SIGTERM grace on unload (both plugins: 5 s). */
  unloadGraceMs: number
  /** SIGTERM grace when the owner shuts down (both plugins' exit cleanup: 2 s). */
  shutdownGraceMs: number
  /** Engine name for messages. */
  engine: string
}

export class SidecarTable<Extra = unknown> {
  private readonly sessions = new Map<string, SidecarSession<Extra>>()
  private readonly loading = new Map<string, Promise<SessionInfo>>()
  private readonly unloading = new Map<string, Promise<UnloadResult>>()
  private loadTail: Promise<void> = Promise.resolve()
  private closing = false
  private readonly shutdownController = new AbortController()

  constructor(private readonly options: SidecarTableOptions) {}

  /** Aborts a process that is still starting when the owner shuts down. */
  get signal(): AbortSignal {
    return this.shutdownController.signal
  }

  get isClosing(): boolean {
    return this.closing
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  get(modelId: string): SidecarSession<Extra> | undefined {
    return this.sessions.get(modelId)
  }

  findSession(modelId: string): SessionInfo | undefined {
    const session = this.sessions.get(modelId)
    return session ? { ...session.info } : undefined
  }

  getLoadedModels(): string[] {
    return [...this.sessions.keys()]
  }

  isLoading(modelId: string): boolean {
    return this.loading.has(modelId)
  }

  /** Ports sessions already hold, so a new load never picks one of them. */
  usedPorts(): number[] {
    return [...this.sessions.values()].map((s) => s.info.port)
  }

  /** In-flight loads other than this model's, which an auto-unload must wait for. */
  otherLoads(modelId: string): Promise<SessionInfo>[] {
    return [...this.loading].filter(([id]) => id !== modelId).map(([, load]) => load)
  }

  /**
   * Load through the provider's single queue, or join the load already in flight for this model.
   * An already-loaded model answers with its session without queueing.
   */
  load(modelId: string, operation: () => Promise<SessionInfo>): Promise<SessionInfo> {
    this.assertRunning()
    const unloading = this.unloading.get(modelId)
    if (unloading) return unloading.then(() => this.load(modelId, operation))
    const existing = this.sessions.get(modelId)
    if (existing) return Promise.resolve({ ...existing.info })
    const inFlight = this.loading.get(modelId)
    if (inFlight) return inFlight
    const run = this.loadTail.then(async () => {
      this.assertRunning()
      const loaded = this.sessions.get(modelId)
      return loaded ? { ...loaded.info } : operation()
    })
    this.loadTail = run.then(
      () => {},
      () => {}
    )
    const tracked = run.finally(() => this.loading.delete(modelId))
    this.loading.set(modelId, tracked)
    return tracked
  }

  /** Record a process that reported ready, and start watching it. Terminates it if that fails. */
  async adopt(session: Omit<SidecarSession<Extra>, 'journalled'>): Promise<SessionInfo> {
    const entry: SidecarSession<Extra> = { ...session, journalled: false }
    try {
      await this.journal(entry)
      this.assertRunning()
      this.sessions.set(entry.info.model_id, entry)
      this.watchExit(entry)
    } catch (error) {
      await entry.process.terminate(this.options.unloadGraceMs).catch(() => {})
      if (entry.journalled) await this.options.journal?.remove(entry.info.pid).catch(() => {})
      await closeLogStream(entry.logStream)
      throw error
    }
    this.options.emit('session:started', { ...entry.info, provider: this.options.provider })
    return { ...entry.info }
  }

  private async journal(session: SidecarSession<Extra>): Promise<void> {
    const journal = this.options.journal
    if (!journal) return
    const record: ChildProcessRecord = {
      instance_id: this.options.instanceId,
      pid: session.info.pid,
      process_start_id: (await processStartId(session.info.pid)) ?? null,
      exe: session.exe,
      provider: this.options.provider,
      model_id: session.info.model_id,
      port: session.info.port,
      started_at: new Date().toISOString(),
    }
    await journal.add(record)
    session.journalled = true
  }

  private watchExit(session: SidecarSession<Extra>): void {
    void session.process.exited.then(async (exit) => {
      if (this.sessions.get(session.info.model_id) !== session) return // unloaded or replaced
      this.sessions.delete(session.info.model_id)
      if (session.journalled) await this.options.journal?.remove(session.info.pid).catch(() => {})
      await closeLogStream(session.logStream)
      const { stderr, stdout } = session.process.output()
      this.options.emit('session:died', {
        provider: this.options.provider,
        pid: session.info.pid,
        model_id: session.info.model_id,
        exit_code: exit.code,
        signal: exit.signal === null ? null : String(exit.signal),
        message: this.options.describeExit(exit, stderr, stdout),
      })
    })
  }

  /** Stop one session. Unloading something that is not loaded is not an error. */
  async unload(modelId: string, graceMs = this.options.unloadGraceMs): Promise<UnloadResult> {
    const existing = this.unloading.get(modelId)
    if (existing) return existing
    const operation = this.unloadAfterLoading(modelId, graceMs)
    const tracked = operation.finally(() => {
      if (this.unloading.get(modelId) === tracked) this.unloading.delete(modelId)
    })
    this.unloading.set(modelId, tracked)
    return tracked
  }

  private async unloadAfterLoading(modelId: string, graceMs: number): Promise<UnloadResult> {
    // A load may still be choosing a port or starting the child. Wait for its
    // publication (or failure) before declaring the model absent.
    await this.loading.get(modelId)?.catch(() => {})
    const session = this.sessions.get(modelId)
    if (!session) return { success: true }
    this.sessions.delete(modelId)
    try {
      await session.process.terminate(graceMs)
      if (session.journalled) await this.options.journal?.remove(session.info.pid).catch(() => {})
      await closeLogStream(session.logStream)
      this.options.emit('session:unloaded', {
        provider: this.options.provider,
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

  async shutdown(): Promise<void> {
    this.closing = true
    this.shutdownController.abort()
    await this.loadTail
    // An earlier explicit unload may already have removed a session from the table while its
    // process is still terminating. It must finish before shutdown releases the owner's claims.
    await Promise.all([...this.unloading.values()])
    const results = await Promise.all(
      [...this.sessions.keys()].map((id) => this.unload(id, this.options.shutdownGraceMs))
    )
    const failure = results.find((result) => !result.success)
    if (failure)
      throw new AtomicCoreError(
        'INTERNAL_ERROR',
        `Could not stop every ${this.options.engine} session during shutdown.`,
        failure.error
      )
  }

  assertRunning(): void {
    if (this.closing)
      throw new AtomicCoreError(
        'CORE_NOT_RUNNING',
        `The ${this.options.engine} runtime is stopping or has stopped.`
      )
  }
}
