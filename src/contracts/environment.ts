/**
 * Managed text runtimes on the wire: the container environment the core owns, the per-engine
 * runtime installations inside it, the durable operations that install, update and remove them,
 * the metadata that says what one engine release runs and supports, and the verdict the core
 * returns when asked whether a given checkpoint can run on this machine.
 *
 * Ported selectively from `origin/feat/tenzor-rt` @ `632b934` (openspec change
 * `add-tensorrt-llm-linux`, design D1; see `docs/decisions/` for the ADR). The descriptor shapes
 * below follow `atomic-chat-conf/runtimes/schema.json`, the source of truth for what a published
 * descriptor contains (design D7/D9/D12); `ModelCompatibility` is new, the verdict of the future
 * `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`). Nothing produces or
 * serves these shapes yet: the routes, the state machine and the descriptor parser are later tasks
 * of this change.
 *
 * Browser-safe: types and string constants only, no `node:*`.
 *
 * Field names are snake_case: this surface is emitted from a descriptor published as JSON and has
 * no older camelCase mirror to preserve.
 */

import type { ErrorBody } from './errors.js'

/** A content digest, always `sha256:` + lowercase hex. Verifies bytes, never publisher or fitness. */
export type Sha256Digest = `sha256:${string}`

/**
 * Which container engine an environment drives. One per host recipe: Docker on the Linux host
 * itself, or the Docker inside the WSL distribution the core owns on Windows.
 */
export const EXECUTOR_KINDS = ['linux-docker', 'wsl-docker'] as const
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number]

/** What a durable operation is for. Removal is its own kind, never an update to an empty target. */
export const MANAGED_OPERATION_KINDS = ['setup', 'update', 'remove'] as const
export type ManagedOperationKind = (typeof MANAGED_OPERATION_KINDS)[number]

/**
 * What an operation acts on. The shared environment is one target; a single engine's installation
 * is another. An operation on one installation never changes a sibling.
 */
export type ManagedOperationTarget =
  { kind: 'environment' } | { kind: 'runtime'; installation_id: string; engine_id: string }

/**
 * Where a durable operation stands. `ready` means the target is verified — for a runtime target
 * that is the installation, never the model, which has readiness of its own.
 *
 * `relogin-required` is Linux-only: adding the user to the `docker` group takes effect at their
 * next sign-in, so the operation waits there and re-probes when the app opens again.
 * `reboot-required` is the Windows equivalent after enabling the WSL features.
 */
export const MANAGED_PHASES = [
  'checking',
  'awaiting-consent',
  'preparing-host',
  'relogin-required',
  'reboot-required',
  'preparing-environment',
  'pulling-image',
  'verifying',
  'activating',
  'removing',
  'ready',
  'removed',
  'cancelling',
  'cancelled',
  'failed',
] as const
export type ManagedPhase = (typeof MANAGED_PHASES)[number]

/**
 * Whether this host can run the target at all. `prerequisite-blocked` is a fact about the machine
 * (no NVIDIA driver, an unqualified distribution); `setup-required` means it can, but has not.
 */
export const MANAGED_AVAILABILITY = [
  'supported',
  'setup-required',
  'prerequisite-blocked',
  'unsupported',
] as const
export type ManagedAvailability = (typeof MANAGED_AVAILABILITY)[number]

/** Lifecycle of one engine's installation inside an environment. */
export const RUNTIME_INSTALLATION_STATUSES = [
  'absent',
  'installing',
  'ready',
  'updating',
  'removing',
  'failed',
] as const
export type RuntimeInstallationStatus = (typeof RUNTIME_INSTALLATION_STATUSES)[number]

/**
 * Progress of the current phase. `completed`/`total` are null while the work has no measurable
 * size; a client renders that as indeterminate and never invents a percentage.
 */
export interface ManagedProgress {
  label: string
  completed: number | null
  total: number | null
  unit: 'bytes' | 'steps' | 'unknown'
}

/**
 * One GPU as the managed runtime sees it, derived from the hardware probe. Distinct from
 * `backend/types.ts`'s `GpuProbeInfo`, which is the raw probe slice the llama.cpp backend selectors
 * read: memory here is bytes rather than MiB and the fields a model check needs are required.
 * `compute_capability` is NVML's `"major.minor"` spelling, e.g. `"8.9"` (Ada) or `"12.0"`
 * (Blackwell); it decides which quantization formats a checkpoint may use. `total_vram_bytes` is
 * null for a unified-memory card (e.g. GB10/DGX Spark) that reports no VRAM of its own — the model
 * compatibility check then compares against host memory instead (design D13).
 */
export interface GpuFacts {
  gpu_id: string
  name: string
  compute_capability: string
  total_vram_bytes: number | null
  free_vram_bytes: number | null
  driver_version: string | null
}

/**
 * One engine installed into an environment. `active_descriptor_id` is what runs now;
 * `candidate_descriptor_id` is a staged update that has not been activated, kept separate so a
 * failed candidate never replaces a working runtime.
 */
export interface RuntimeInstallation {
  installation_id: string
  engine_id: string
  environment_id: string
  active_descriptor_id: string | null
  candidate_descriptor_id: string | null
  availability: ManagedAvailability
  status: RuntimeInstallationStatus
}

/**
 * Full state of one environment. Sent whole on `environment:changed`, so a client rebuilds from a
 * snapshot and then applies events. `instance_id` identifies the core that produced it and
 * `revision` orders it: apply only a strictly newer revision of the current instance.
 */
export interface EnvironmentSnapshot {
  schema_version: 1
  environment_id: string
  instance_id: string
  revision: number
  executor: ExecutorKind
  availability: ManagedAvailability
  gpus: GpuFacts[]
  installations: RuntimeInstallation[]
  active_operation_id: string | null
}

/**
 * The one privileged thing the core asks the app to do, per host recipe. The webview never chooses
 * a command: it forwards this step, and the trusted helper owns the arguments.
 */
export const MANAGED_HOST_ACTIONS = ['linux.install-container-runtime', 'windows.enable-wsl'] as const
export type ManagedHostAction = (typeof MANAGED_HOST_ACTIONS)[number]

/**
 * The pending privileged step. `nonce` is single-use and `expected_operation_revision` pins it to
 * one state of one operation, so a receipt cannot be replayed into a later phase. The digests bind
 * it to the exact recipe and parameters the user approved.
 */
export interface ManagedHostStep {
  step_id: string
  action: ManagedHostAction
  recipe_id: string
  recipe_digest: Sha256Digest
  parameters_digest: Sha256Digest
  nonce: string
  expected_operation_revision: number
}

/**
 * What the app reports back after the OS authorization prompt. It is an assertion, not proof: the
 * core re-probes the host before marking the step complete.
 */
export interface ManagedHostReceipt {
  step_id: string
  nonce: string
  expected_operation_revision: number
  recipe_digest: Sha256Digest
  parameters_digest: Sha256Digest
  outcome: 'completed' | 'declined' | 'relogin-required' | 'reboot-required' | 'failed'
  receipt_id: string
}

/**
 * A durable operation. It outlives the dialog, the app and the core: closing the UI does not cancel
 * it, and `cancellation_requested` is a request recorded during work that cannot be interrupted
 * safely, honored at the next safe boundary.
 *
 * `plan_digest` is what the core currently intends; `approved_plan_digest` is what the user agreed
 * to. They differ when the host changed under an operation awaiting consent, and privileged work
 * never starts while they differ.
 */
export interface EnvironmentOperation {
  schema_version: 1
  operation_id: string
  request_id: string
  environment_id: string
  target: ManagedOperationTarget
  kind: ManagedOperationKind
  instance_id: string
  revision: number
  phase: ManagedPhase
  plan_digest: Sha256Digest | null
  approved_plan_digest: Sha256Digest | null
  progress: ManagedProgress | null
  pending_host_step: ManagedHostStep | null
  completed_step_ids: string[]
  cancellation_requested: boolean
  error: ErrorBody | null
}

/**
 * Start an operation. `request_id` is the caller's idempotency key: the same ID with the same
 * fingerprint returns the existing operation, with a different one it is a conflict.
 */
export interface BeginOperation {
  request_id: string
  target: ManagedOperationTarget
  kind: ManagedOperationKind
  descriptor_id?: string
  retain_models?: boolean
  approved_plan_digest?: Sha256Digest
}

/**
 * Continue an operation that is awaiting consent, blocked on a sign-out or reboot, failed or
 * cancelled. Carrying the approval here rather than in a second `begin` is deliberate: a resume
 * re-probes first and can only continue the operation that already exists.
 */
export interface ResumeOperation {
  expected_revision: number
  approved_plan_digest?: Sha256Digest
}

/**
 * What setup would actually do, computed without touching the machine. `adopts_existing_engine`
 * says the host already has a working container engine, so there is no privileged step and no
 * system change at all. `blockers` being non-empty is a normal answer, not a transport error.
 */
export interface RequirementPlan {
  plan_digest: Sha256Digest
  environment_id: string
  target: ManagedOperationTarget
  availability: ManagedAvailability
  recipe_id: string
  recipe_digest: Sha256Digest
  adopts_existing_engine: boolean
  /** Human-readable system changes, shown before the OS authorization prompt. */
  system_changes: string[]
  download_bytes: number | null
  required_disk_bytes: number | null
  requires_elevation: boolean
  may_require_relogin: boolean
  may_require_reboot: boolean
  blockers: ErrorBody[]
}

/** Ask what setting this target up would involve. Probing never installs or pulls anything. */
export interface ProbeEnvironmentInput {
  descriptor_id: string
  environment_id?: string
  target: ManagedOperationTarget
}

/**
 * One quantization format and the compute capability it needs, as the pinned engine release
 * supports it. NVFP4 needs Blackwell; an Ampere card gets weight-only 4-bit and little else.
 * Filled from measurement on real cards, never from a vendor page alone.
 *
 * `excluded_compute_capabilities` (design D17) lists capabilities strictly above
 * `min_compute_capability` where the release does not actually support this format, because the
 * engine's hardware support matrix is not monotone in compute capability (e.g. `fp8_block_scales`
 * needs 9.0 but is unsupported again on 12.0/12.1). Empty when there is no such gap.
 */
export interface QuantizationSupport {
  format: string
  min_compute_capability: string
  excluded_compute_capabilities: string[]
}

/**
 * What this engine release does for one Hugging Face `config.json` architecture class: which
 * tool-call and reasoning parser names `trtllm-serve` should be started with, and whether it can
 * emit structured output for that family (design D9). Data, not code — the adapter passes these
 * names through at container start rather than guessing them the way the llama.cpp provider does.
 * An architecture with no entry gets no tool calls and no reasoning parsing.
 */
export interface ModelFamilySupport {
  tool_parser: string | null
  reasoning_parser: string | null
  structured_output: boolean
}

/** One reference image for one container platform, pinned by digest. */
export interface PlatformImage {
  repository: string
  digest: Sha256Digest
}

/** An image published for every platform this release supports. Both keys are always present. */
export interface PlatformImageMap {
  'linux/amd64': PlatformImage
  'linux/arm64': PlatformImage
}

/** One `os-release` distribution an install recipe has been qualified to run on. */
export interface RecipeDistribution {
  id: string
  version_id: string
  arch: 'x86_64' | 'aarch64'
}

/**
 * One install recipe as data: an id naming argv compiled into core, and the distributions it is
 * qualified for. Never a command, a shell script or code — the recipe body lives in core, not here.
 */
export interface InstallRecipe {
  recipe_id: string
  distributions: RecipeDistribution[]
}

/** One checkpoint this engine release has been qualified against, pinned to an exact revision. */
export interface CuratedModel {
  repository: string
  revision: string
  inventory_digest: Sha256Digest
  vram_tier_bytes: number
  note: string
}

/**
 * Immutable metadata for one engine release: which image to run, what the host needs, and what it
 * can load. Fetched over HTTPS from the release catalog and pinned by digest. It carries data only:
 * a descriptor can never contain a command, a shell recipe or code to load. Shape matches
 * `atomic-chat-conf/runtimes/schema.json`, the source of truth for what a published descriptor
 * contains.
 */
export interface RuntimeDescriptor {
  schema_version: 1
  descriptor_id: string
  engine_id: string
  /** The compiled adapter that owns this engine's argv and readiness. Not loadable from metadata. */
  adapter_id: string
  adapter_contract_version: 1
  image: PlatformImageMap
  /** Small CUDA base image used to verify GPU access before the much larger engine image is pulled. */
  probe_image: PlatformImageMap
  minimum_core_version: string
  minimum_app_version: string
  /** Lowest NVIDIA display driver version the engine image and `probe_image` run on (design D16). */
  minimum_driver_version: string
  minimum_compute_capability: string
  /** HF `config.json` architecture class names this release implements, e.g. `LlamaForCausalLM`. */
  supported_architectures: string[]
  quantization: QuantizationSupport[]
  /** Keyed by HF architecture class name; an architecture absent here gets no tool calls or reasoning. */
  model_families: Record<string, ModelFamilySupport>
  /** Checkpoints measured to work, offered as a shortcut. Never the limit of what may be loaded. */
  curated_models: CuratedModel[]
  recipes: InstallRecipe[]
  download_bytes: number
  required_disk_bytes: number
  notices: string[]
  exclusions: string[]
}

/**
 * The verdict of `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`): what the
 * core found out about a checkpoint from its `config.json`/`hf_quant_config.json` and file listing,
 * without downloading a single weight or reaching the network. `architectures`, `quantization_format`
 * and `weight_bytes` describe the checkpoint as submitted; `checked_gpu_id` names the GPU the
 * verdict was computed against — the caller's `gpu_id`, or the one a load would pick when omitted.
 *
 * `curated` is true when the repository and revision matched a `curated_models` entry of the
 * installed descriptor and its `inventory_digest` verified against the submitted file list.
 * `unified_memory` is true when `checked_gpu_id` reports no VRAM of its own (e.g. GB10/DGX Spark),
 * so the check compared weight bytes against host memory instead (design D13). `fits_other_gpus`
 * lists every other GPU on this host the checkpoint would fit on, populated whether or not
 * `checked_gpu_id` itself passed, so a caller can suggest a card switch instead of a dead end.
 *
 * `verdict` carries the pass/fail: `MODEL_INCOMPATIBLE` for an unsupported architecture, a
 * quantization format newer than the card (or on the format's exclusion list), or weights that do
 * not fit; `MANAGED_METADATA_INVALID` when a curated match's `inventory_digest` does not verify.
 */
export interface ModelCompatibility {
  architectures: string[]
  quantization_format: string
  weight_bytes: number
  checked_gpu_id: string
  curated: boolean
  unified_memory: boolean
  fits_other_gpus: string[]
  verdict: { ok: true } | { ok: false; error: ErrorBody }
}
