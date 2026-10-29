/**
 * What the audio module remembers between calls: one resident server at most, the spec that can bring
 * it back, the model's state as the client sees it, a bounded job history and the idle deadline.
 * Plain data behind small methods; the locks live with the code that holds them.
 */

import type { AudioPaths } from '../config/index.js'
import type {
  AudioCapabilities,
  AudioErrorBody,
  AudioJob,
  AudioJobState,
  AudioModelState,
  LoadedAudioModel,
} from '../contracts/index.js'
import { DEFAULT_IDLE_UNLOAD_SECS } from './types.js'
import type { AudioServerHandle, AudioServerSpec } from './types.js'

export interface AudioSession {
  server: AudioServerHandle
  info: LoadedAudioModel
  spec: AudioServerSpec
  baseUrl: string
}

export interface AudioJobRecord {
  job: AudioJob
  cancel: {
    requested: boolean
    /** Aborts the job's request to the engine, or its wait for the server to come back. */
    abort: AbortController
  }
  /** Settles when the runner is done with the job. */
  done?: Promise<unknown>
}

/** Jobs kept in memory for `getJob`; the gallery is the durable record. */
export const JOB_HISTORY = 50

const TERMINAL: ReadonlySet<AudioJobState> = new Set(['completed', 'failed', 'cancelled'])
export const isTerminalAudioJobState = (state: AudioJobState): boolean => TERMINAL.has(state)

export class AudioState {
  /** `null` restores the default folder. */
  outputDirOverride: string | null = null
  idleUnloadSecs = DEFAULT_IDLE_UNLOAD_SECS
  session: AudioSession | undefined
  /** The last spec that loaded; the respawn source after a cancel or a crash. Cleared only by an unload. */
  spec: AudioServerSpec | undefined
  /** What the server declared for `spec` when it last came up; cleared with it. */
  capabilities: AudioCapabilities | undefined
  /** A server whose GPU claim succeeded and that is starting: it holds the GPU before it is a session. */
  starting: AudioServerSpec | undefined
  /** A server being taken down whose exit is not confirmed yet: no longer the session, still on the GPU. */
  stopping: { spec: AudioServerSpec; done: Promise<void> } | undefined
  modelState: AudioModelState = 'unloaded'
  modelError: AudioErrorBody | undefined
  activeJobId: string | undefined
  /** Set while the owner shuts down: nothing starts any more. */
  closing = false
  private readonly jobs = new Map<string, AudioJobRecord>()
  private readonly jobOrder: string[] = []
  private idleDeadline: number | undefined

  constructor(
    readonly paths: AudioPaths,
    private readonly now: () => number = Date.now
  ) {}

  outputDir(): string {
    const chosen = this.outputDirOverride?.trim()
    return chosen ? chosen : this.paths.defaultOutputDir
  }

  setModelState(state: AudioModelState, error?: AudioErrorBody): void {
    this.modelState = state
    this.modelError = error
  }

  /** Reset the idle-unload deadline; 0 seconds means never. */
  touchIdle(): void {
    this.idleDeadline = this.idleUnloadSecs === 0 ? undefined : this.now() + this.idleUnloadSecs * 1000
  }

  clearIdle(): void {
    this.idleDeadline = undefined
  }

  idleExpired(): boolean {
    return this.idleDeadline !== undefined && this.now() >= this.idleDeadline
  }

  /** A job's copy. */
  job(id: string): AudioJob | undefined {
    const record = this.jobs.get(id)
    return record ? structuredClone(record.job) : undefined
  }

  record(id: string): AudioJobRecord | undefined {
    return this.jobs.get(id)
  }

  /** The active job while it is not over, for the status. */
  activeJob(): AudioJob | null {
    if (this.activeJobId === undefined) return null
    const job = this.job(this.activeJobId)
    return job && !isTerminalAudioJobState(job.state) ? job : null
  }

  insertJob(record: AudioJobRecord): void {
    this.jobOrder.push(record.job.id)
    while (this.jobOrder.length > JOB_HISTORY) {
      const old = this.jobOrder.shift()
      if (old !== undefined) this.jobs.delete(old)
    }
    this.jobs.set(record.job.id, record)
  }

  updateJob(id: string, update: (job: AudioJob) => void): AudioJob | undefined {
    const record = this.jobs.get(id)
    if (!record) return undefined
    update(record.job)
    return structuredClone(record.job)
  }
}
