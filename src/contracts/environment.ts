/**
 * Managed text runtimes on the wire: the container environment the core owns, the per-engine
 * runtime installations inside it, the durable operations that install, update and remove them,
 * and the verdict the core returns when asked whether a given checkpoint can run on this machine.
 *
 * Proposed contract only. Nothing produces or serves these shapes yet: the routes are T05b, the
 * state machine T04a, the descriptor parser T01b. Specified by the app repo's ADRs
 * `2026-09-22-specify-managed-runtime-coding-contracts` and
 * `2026-09-22-share-managed-text-runtime-infrastructure` (../Atomic-Chat/docs/decisions/).
 *
 * Browser-safe: types and string constants only, no `node:*`.
 *
 * Names here are prefixed where the ADR's short name would be ambiguous in this barrel, which
 * re-exports every contract module: `Phase` is already taken by `remote-access/status.ts`, and
 * `Progress`, `Availability`, `HostStep` and friends are too generic to own globally. The ADR's
 * `Failure` is this repository's existing `ErrorBody`; its `Id` alias is dropped, because IDs are
 * plain strings validated once at the boundary and an alias of `string` buys no safety.
 *
 * Field names are snake_case: this surface is emitted from the app's Rust fixtures (T01d) and has
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
 * (Blackwell); it decides which quantization formats a checkpoint may use.
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
 */
export interface QuantizationSupport {
  format: string
  min_compute_capability: string
}

/**
 * Immutable metadata for one engine release: which image to run, what the host needs, and what it
 * can load. Fetched over HTTPS from the release catalog and pinned by digest. It carries data only:
 * a descriptor can never contain a command, a shell recipe or code to load.
 */
export interface RuntimeDescriptor {
  schema_version: 1
  descriptor_id: string
  engine_id: string
  /** The compiled adapter that owns this engine's argv and readiness. Not loadable from metadata. */
  adapter_id: string
  adapter_contract_version: 1
  image: { repository: string; digest: Sha256Digest; platform: 'linux/amd64' }
  /** The container entrypoint script shipped with the app, verified before it is mounted. */
  entrypoint_digest: Sha256Digest
  minimum_core_version: string
  minimum_app_version: string
  minimum_compute_capability: string
  /** HF `config.json` architecture class names this release implements, e.g. `LlamaForCausalLM`. */
  supported_architectures: string[]
  quantization: QuantizationSupport[]
  recipes: { executor: ExecutorKind; recipe_id: string; digest: Sha256Digest }[]
  /** Checkpoints measured to work, offered as a shortcut. Never the limit of what may be loaded. */
  curated_models: {
    repository: string
    revision: string
    inventory_digest: Sha256Digest
    vram_tier_bytes: number
    note: string
  }[]
  download_bytes: number | null
  required_disk_bytes: number | null
  notices: string[]
  exclusions: string[]
}

/**
 * Where a model artifact's bytes actually are. Two storage domains never mix: a scope's own disk on
 * the host, and the filesystem inside a WSL distribution the core owns. A guest path is not a
 * Windows path and must never be opened as one, which is why the discriminant is explicit rather
 * than inferred from the string.
 *
 * `storage_domain` names the store the bytes live in, so two artifacts are only the same bytes when
 * their domain matches as well as their identity.
 */
export type ArtifactLocation =
  | { kind: 'native'; storage_domain: string; absolute_path: string }
  | { kind: 'guest'; storage_domain: string; environment_id: string; guest_path: string }

/** One file of a resolved checkpoint, as the repository lists it. */
export interface ResolvedModelFile {
  path: string
  bytes: number
}

/**
 * What the core found out about a checkpoint before downloading a single weight: what it is, and
 * whether this machine can run it. `compatibility` carries the reason when it cannot — an
 * unimplemented architecture, a quantization the card is too old for, or weights that do not fit —
 * so the app can say why instead of offering a download that would fail.
 */
export interface ModelResolution {
  repository: string
  revision: string
  architectures: string[]
  /** ModelOpt/HF quantization algorithm, or null for an unquantized checkpoint. */
  quantization: string | null
  weight_bytes: number
  files: ResolvedModelFile[]
  compatibility: { ok: true } | { ok: false; error: ErrorBody }
  /** The repository needs accepted terms or a token; the core holds the credential, not the UI. */
  gated: boolean
}
