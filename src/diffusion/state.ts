/**
 * What the diffusion module remembers between calls. `DiffusionStateInner` in `state.rs` of
 * `tauri-plugin-atomic-diffusion` (app commit `767ff6350`): one resident session at most, the spec
 * that can bring it back, the model's state as the app sees it, a bounded job history, the idle
 * deadline. Plain data behind small methods; the locks live with the code that holds them.
 */

import type {
  DiffusionConfig,
  DiffusionErrorBody,
  DiffusionModelState,
  ImageJob,
  LoadedDiffusionModel,
  VideoJob,
} from '../contracts/index.js'
import type { DiffusionPaths } from '../config/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import { DEFAULT_IDLE_UNLOAD_SECS } from './types.js'
import type { ServerCapabilities, ServerSpec } from './types.js'

/** A running `sd-server`, as the session and the job runner see it; the real one wraps a child process. */
export interface ServerHandle {
  pid: number
  port: number
  exe: string
  capabilities: ServerCapabilities
  /** The last lines the server printed, oldest first. */
  tail(): string[]
  /** The job that is running gets every cleaned output line; one listener at a time. */
  setLineListener(listener: ((line: string) => void) | undefined): void
  /** Non-blocking liveness: the exit, once it has happened. */
  exitStatus(): ExitInfo | undefined
  exited: Promise<ExitInfo>
  /** SIGTERM, a grace period, then SIGKILL; resolves once the exit is confirmed. */
  terminate(graceMs?: number): Promise<ExitInfo>
}

export interface DiffusionSession {
  server: ServerHandle
  info: LoadedDiffusionModel
  spec: ServerSpec
  baseUrl: string
}

export interface CancelFlag {
  requested: boolean
}

export interface JobRecord {
  job: ImageJob
  cancel: CancelFlag
  /** The server-side job id once submitted. */
  serverJobId?: string
}

/** Jobs kept in memory for `getJob`; the gallery is the durable record. */
export const JOB_HISTORY = 50

export const TERMINAL_JOB_STATES = new Set<ImageJob['state']>(['completed', 'failed', 'cancelled'])
export const isTerminalJobState = (state: ImageJob['state']): boolean => TERMINAL_JOB_STATES.has(state)

export class DiffusionState {
  config: DiffusionConfig | undefined
  session: DiffusionSession | undefined
  /** The last spec that loaded; the respawn source after a cancel or a crash. Cleared only by an unload. */
  spec: ServerSpec | undefined
  modelState: DiffusionModelState = 'unloaded'
  modelError: DiffusionErrorBody | undefined
  activeJobId: string | undefined
  /** Set while the owner shuts down: nothing starts any more. */
  closing = false
  private readonly jobs = new Map<string, JobRecord>()
  private readonly jobOrder: string[] = []
  private idleDeadline: number | undefined

  constructor(
    readonly paths: DiffusionPaths,
    private readonly now: () => number = Date.now
  ) {}

  get configured(): boolean {
    return this.config !== undefined
  }

  outputDir(): string {
    const chosen = this.config?.outputDir?.trim()
    return chosen ? chosen : this.paths.defaultOutputDir
  }

  videoOutputDir(): string {
    const chosen = this.config?.videoOutputDir?.trim()
    return chosen ? chosen : this.paths.defaultVideoOutputDir
  }

  idleUnloadSecs(): number {
    return this.config?.idleUnloadSecs ?? DEFAULT_IDLE_UNLOAD_SECS
  }

  setModelState(state: DiffusionModelState, error?: DiffusionErrorBody): void {
    this.modelState = state
    this.modelError = error
  }

  /** Reset the idle-unload deadline; 0 seconds means never. */
  touchIdle(): void {
    const secs = this.idleUnloadSecs()
    this.idleDeadline = secs === 0 ? undefined : this.now() + secs * 1000
  }

  clearIdle(): void {
    this.idleDeadline = undefined
  }

  idleExpired(): boolean {
    return this.idleDeadline !== undefined && this.now() >= this.idleDeadline
  }

  job(id: string): ImageJob | undefined {
    const record = this.jobs.get(id)
    return record ? structuredClone(record.job) : undefined
  }

  record(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  /** The active job while it is queued or generating, for the status. */
  activeJob(): ImageJob | null {
    if (this.activeJobId === undefined) return null
    const job = this.job(this.activeJobId)
    return job && (job.state === 'queued' || job.state === 'generating') ? job : null
  }

  /** The video counterpart of `activeJob`; video records arrive with the job-kind seam. */
  activeVideoJob(): VideoJob | null {
    return null
  }

  insertJob(record: JobRecord): void {
    this.jobOrder.push(record.job.id)
    while (this.jobOrder.length > JOB_HISTORY) {
      const old = this.jobOrder.shift()
      if (old !== undefined) this.jobs.delete(old)
    }
    this.jobs.set(record.job.id, record)
  }

  updateJob(id: string, update: (record: JobRecord) => void): ImageJob | undefined {
    const record = this.jobs.get(id)
    if (!record) return undefined
    update(record)
    return structuredClone(record.job)
  }

  /** Every job id in memory, oldest first. */
  jobIds(): string[] {
    return [...this.jobOrder]
  }
}
