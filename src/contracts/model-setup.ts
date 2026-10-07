/**
 * Model setup: one durable operation that makes a Hugging Face GGUF runnable — the engine it needs
 * (a PrismML pack for Bonsai), the model file, its vision projector — and registers it in the shared
 * `<data>/llamacpp/models` tree. Records live in `<data>/atomic-core/prism-setups/<setup id>.json`
 * (`docs/contracts.md`); credentials are never written there.
 *
 *   POST /atomic/v1/models/compatibility     ModelCompatibilityRequest → ModelCompatibilityResponse
 *   POST /atomic/v1/models/setup-plan        ModelSetupPlanRequest → ModelSetupPlan
 *   POST /atomic/v1/model-setups             ModelSetupStartRequest → ModelSetup
 *   GET  /atomic/v1/model-setups             → ModelSetupList
 *   GET  /atomic/v1/model-setups/:id         → ModelSetup
 *   POST /atomic/v1/model-setups/:id/cancel  → ModelSetup
 *   POST /atomic/v1/model-setups/:id/resume  → ModelSetup
 *
 * Every change of a record is the event `model-setup:changed`; download progress of each stage is
 * the ordinary `download:progress` under the stage's `task_ids` entry.
 */

import type { ProxyConfig } from './backend-advisor.js'
import type { ErrorBody } from './errors.js'
import type { CompatibilityVerdict, ModelCompatibilityResponse } from './model-compatibility.js'
import type { LocalProviderId } from './session.js'

export const MODEL_SETUP_STAGES = [
  'queued',
  'installing_engine',
  'downloading_model',
  'downloading_projector',
  'verifying',
  'registering',
  'ready',
  'failed',
  'cancelled',
  /** The core that ran it stopped mid-way; `resume` continues from the files already on disk. */
  'interrupted',
] as const
export type ModelSetupStage = (typeof MODEL_SETUP_STAGES)[number]

/** Stages a setup never leaves on its own. `interrupted` is not one: it waits for `resume`. */
export const MODEL_SETUP_FINAL_STAGES: readonly ModelSetupStage[] = ['ready', 'failed', 'cancelled']

/** One file of a setup, pinned to a revision. */
export interface ModelSetupArtifact {
  repo: string
  file: string
  revision: string
  /** From conf rules or the Hub's LFS metadata; the download is verified against it when present. */
  sha256?: string
  /** Bytes; `0` when the Hub did not say. */
  size: number
}

/** The PrismML pack a setup runs on. */
export interface ModelSetupEngine {
  provider: 'atomic-prism'
  version: string
  backend: string
  /** Already on disk: the setup only selects it. */
  installed: boolean
  /** Pack + companion bytes; `0` when installed. */
  download_size: number
}

export type ModelSetupBlockerCode =
  | 'unsupported'
  | 'legacy_artifact'
  /** The file needs PrismML and no offered build fits this machine and the file's needs. */
  | 'no_engine_build'
  | 'insufficient_disk_space'

export interface ModelSetupBlocker {
  code: ModelSetupBlockerCode
  message: string
  /** `legacy_artifact`: the file to set up instead. */
  replacement?: string
}

export interface ModelSetupPlanRequest {
  repo: string
  file: string
  /** Ignored for a file the conf rules pin; otherwise defaults to `main`. */
  revision?: string
  /** Defaults to `<owner>/<file name without .gguf>`. */
  model_id?: string
  /** Download the family's default vision projector, when the rules name one. Default `true`. */
  include_projector?: boolean
  /** The app's proxy policy for this request; never persisted. */
  proxy?: ProxyConfig | null
}

export interface ModelSetupPlan {
  /** Hash of everything that decides what the setup would do; `POST /model-setups` must match it. */
  digest: string
  model_id: string
  /** The engine the model is registered for: `atomic-prism`, or `llamacpp-upstream` for a stock file. */
  provider: LocalProviderId
  verdict: CompatibilityVerdict
  /** `null`: no PrismML pack is involved. */
  engine: ModelSetupEngine | null
  model: ModelSetupArtifact
  projector: ModelSetupArtifact | null
  total_download_bytes: number
  /** Free bytes on the models volume, `null` when unknown. Not part of `digest`. */
  free_bytes: number | null
  /** Empty when the setup can start. */
  blockers: ModelSetupBlocker[]
  defaults?: ModelCompatibilityResponse['defaults']
}

export interface ModelSetupStartRequest extends ModelSetupPlanRequest {
  /** Idempotency key: a retry with the same id and request returns the setup it started. */
  request_id: string
  /** `ModelSetupPlan.digest` the user saw; `MODEL_SETUP_PLAN_STALE` when the plan has changed since. */
  plan_digest: string
}

export interface ModelSetup {
  setup_id: string
  request_id: string
  /** Bumped by every write; a client keeps the record with the highest one. */
  revision: number
  stage: ModelSetupStage
  /** What was asked, without the proxy; `resume` plans again from it. */
  request: Omit<ModelSetupPlanRequest, 'proxy'>
  plan: ModelSetupPlan
  /** Download task ids per stage, for `download:progress`. */
  task_ids: { engine?: string; model: string; projector?: string }
  /** Where a failed, cancelled or interrupted setup stopped. */
  stopped_at?: ModelSetupStage
  error?: ErrorBody
  /** Epoch milliseconds. */
  created_at: number
  updated_at: number
}

export interface ModelSetupList {
  setups: ModelSetup[]
}
