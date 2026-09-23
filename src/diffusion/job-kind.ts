/**
 * What differs between an image job and a video job, behind one interface, so `jobs.ts` runs both
 * with a single poll loop, cancel ladder, crash handling and CPU fallback. A kind owns everything
 * that names its request, its record, its engine route and its files; the runner owns the rest.
 */

import type {
  DiffusionErrorBody,
  DiffusionModality,
  ImageJobProgress,
  ImageJobState,
} from '../contracts/index.js'
import type { JobDeps } from './jobs.js'
import type { DiffusionEmitter } from './session.js'
import type { JobKindId } from './state.js'
import type { ResolvedInputs, ServerCapabilities, ServerSpec } from './types.js'
import type { ValidateDeps } from './validate.js'

/** The fields the runner reads and writes on any job record, whatever its kind. */
export interface JobCommon<Item, Progress> {
  id: string
  state: ImageJobState
  modelId: string
  createdAtMs: number
  startedAtMs?: number
  finishedAtMs?: number
  progress: Progress | null
  outputs: Item[]
  error?: DiffusionErrorBody
}

/** What `save` gets besides the decoded result. */
export interface SaveContext<Req> {
  id: string
  request: Req
  spec: ServerSpec
  /** The seed the job ran with (the batch seed for images). */
  seed: number
  startedAt: number
}

export type Emit = DiffusionEmitter

export interface JobKind<Req, Job extends JobCommon<Item, Progress>, Item, Progress, Decoded> {
  id: JobKindId
  /** The loaded model must be of this modality, or the job is refused before anything runs. */
  modality: DiffusionModality
  /** `/sdcpp/v1/img_gen` or `/sdcpp/v1/vid_gen`. */
  submitPath: string
  messages: {
    /** `JOB_BUSY` while another job of any kind runs. */
    busy: string
    /** `MODEL_INCOMPATIBLE` when the resident model is of the other modality. */
    wrongModel: string
  }
  validate(request: Req, spec: ServerSpec, deps: ValidateDeps): Promise<void>
  /** The record as it is inserted: inline bytes blanked, nothing started. */
  newJob(id: string, spec: ServerSpec, request: Req, now: number): Job
  resolveInputs(request: Req, deps: Pick<JobDeps, 'readSource'>): Promise<ResolvedInputs>
  buildBody(request: Req, spec: ServerSpec, seed: number, inputs: ResolvedInputs): Record<string, unknown>
  /** Steps and images the progress tracker counts. */
  trackerShape(request: Req): { steps: number; batch: number }
  /** The wire progress out of the tracker's snapshot. */
  progress(snapshot: ImageJobProgress): Progress
  emitJob(emit: Emit, job: Job): void
  emitProgress(emit: Emit, jobId: string, progress: Progress): void
  /** Whether the engine promised to interrupt a running generation of this kind. */
  cancelGenerating(capabilities: ServerCapabilities): boolean
  /** A refusal before submit, from what the engine advertised (a build without WebM, say). */
  preflight?(capabilities: ServerCapabilities | undefined): void
  decode(job: Record<string, unknown>): Decoded
  save(deps: JobDeps, ctx: SaveContext<Req>, decoded: Decoded): Promise<{ items: Item[]; bytes: Buffer[] }>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobKind = JobKind<any, any, any, any, any>
