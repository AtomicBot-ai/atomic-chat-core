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
 * `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`). The environment routes,
 * the durable operation and the Linux setup (task 2.6) produce the environment shapes.
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
  /**
   * Why `availability` is `prerequisite-blocked` (or `unsupported`), as of the last probe of this
   * host; empty when nothing blocks. Structured, so a client can show each reason with its own
   * instructions rather than one generic message (task 2.6).
   */
  blockers: ManagedBlocker[]
  /**
   * SELinux is enforcing for containers on this host (`docker info`), so the core labels its own
   * mounts `:z` (design D15). Null until a probe has answered.
   */
  selinux: boolean | null
  installations: RuntimeInstallation[]
  active_operation_id: string | null
  /**
   * `minimum_app_version` of the descriptor currently in effect for this environment: a pinned
   * installation's own cached descriptor where one exists, otherwise the latest descriptor this
   * core has ever accepted into its cache — resolved network-free, so this never blocks on a fetch
   * to answer — so a client can show "update the app" before the user hits a blocked install. `null`
   * when neither resolves (no installation, and nothing has ever been cached) (spec
   * `runtime-descriptor-catalog`, "Минимальные версии соблюдаются").
   */
  minimum_app_version: string | null
  /**
   * The WSL distribution this environment runs in (change `add-tensorrt-llm-windows`): on Windows,
   * once core has imported its own one; `null` before that and always on Linux, where the
   * environment is the host itself. Additive: a client that predates it ignores the key.
   */
  distribution: EnvironmentDistribution | null
  /**
   * Environment variables that move where this core reads its conf documents or keeps its managed
   * state (`ATOMIC_RUNTIME_DESCRIPTOR_URL`, `ATOMIC_ENVIRONMENT_MANIFEST_URL`,
   * `ATOMIC_CORE_MANAGED_ROOT`), as this process sees them; empty when none is set. A test machine
   * kept a commit-pinned descriptor URL and never saw the next descriptor (2026-10-06): a client
   * shows these so such a machine says so on screen. Additive: an older client ignores the key.
   */
  source_overrides: EnvironmentSourceOverride[]
}

/** One environment variable that overrides a managed-runtime source, and its value. */
export interface EnvironmentSourceOverride {
  variable: string
  value: string
}

/**
 * What `POST /environments/:environmentId/reset` did: the finished operations it moved out of the
 * operations directory (into `operations-archive/<time>/` beside it), so no finished setup or removal is shown
 * or resumed any more and the next setup starts from a fresh plan. Nothing installed — the
 * distribution, images, models, cached documents, installation records — is touched.
 */
export interface EnvironmentResetResult {
  environment_id: string
  archived_operation_ids: string[]
  /** Where they went, for a person who wants them back; null when nothing was archived. */
  archive_path: string | null
}

/**
 * `GET /environments/:environmentId/diagnostics`: what a person pastes into a support message — the
 * snapshot, which conf documents this core reads and from where, what it has cached, every operation
 * on disk and the managed-runtime code's recent warnings. Read-only.
 */
export interface EnvironmentDiagnostics {
  generated_at: string
  core_version: string
  platform: string
  arch: string
  environment: EnvironmentSnapshot | null
  sources: EnvironmentDocumentSource[]
  operations: EnvironmentOperationSummary[]
  /** The last warnings the managed-runtime code logged, newest last: document fallbacks, cache failures. */
  recent_warnings: string[]
  /**
   * What this core's move of TensorRT-LLM's models into the managed model store did at its start
   * (change `add-vllm-runtime`, design D5); null before it ran or where there is nothing to move.
   */
  store_migration?: ManagedStoreMigration | null
}

/** The move of TensorRT-LLM's models into the managed model store, as it went. */
export interface ManagedStoreMigration {
  from: string
  to: string
  /** Ids moved, in order. */
  moved: string[]
  /** Ids already in the store: neither folder was touched. */
  conflicts: { model_id: string; source: string; target: string }[]
}

/** One conf document a core reads: where from, whether that is overridden, and what it has cached. */
export interface EnvironmentDocumentSource {
  document: 'runtime-descriptor' | 'environment-manifest'
  /** A runtime descriptor's engine: each managed engine has its own source (change `add-vllm-runtime`). */
  engine_id?: string
  url: string
  default_url: string
  /** The variable that set `url`, or null when it is `default_url`. */
  overridden_by: string | null
  latest_cached_id: string | null
  cached_ids: string[]
}

/** An operation on disk, reduced to what explains it. */
export interface EnvironmentOperationSummary {
  operation_id: string
  kind: ManagedOperationKind
  target: ManagedOperationTarget
  phase: ManagedPhase
  checkpoint: string | null
  revision: number
  consented_descriptor_id: string | null
  plan_descriptor_id: string | null
  error: ErrorBody | null
}

/**
 * Atomic Chat's own WSL distribution as a client shows it: its registered `name`, the Windows
 * directory that holds its `ext4.vhdx` (`path`, under the user's `%LOCALAPPDATA%`), and how many
 * bytes that disk image takes on the Windows volume (`size_bytes`). The image grows and never shrinks
 * by itself, so this is the space removing the environment gives back. Null when it could not be
 * read — never a guessed 0.
 */
export interface EnvironmentDistribution {
  name: string
  path: string
  size_bytes: number | null
}

/**
 * The one privileged thing the core asks the app to do, per host recipe. The webview never chooses
 * a command: it forwards this step, and the trusted helper owns the arguments.
 */
export const MANAGED_HOST_ACTIONS = ['linux.install-container-runtime', 'windows.enable-wsl'] as const
export type ManagedHostAction = (typeof MANAGED_HOST_ACTIONS)[number]

/**
 * The validated values of a `linux.install-container-runtime` step (task 2.5's recipe): the account
 * to add to the `docker` group, the machine, and which missing components to install. The client
 * copies them verbatim into the host-step request file; the executor recomputes
 * `parameters_digest` from them and refuses the step if it does not match. Nothing else reaches the
 * privileged process.
 */
export interface ContainerRuntimeStepParameters {
  user: string
  arch: 'x86_64' | 'aarch64'
  family: 'apt' | 'dnf'
  distro_id: string
  version_id: string
  /**
   * Subset of `docker-engine`, `nvidia-container-toolkit`, `nvidia-runtime`, `nvidia-cdi` (task
   * 2.23: the NVIDIA CDI spec), `docker-restart`, `docker-service`, `docker-group`, in recipe order.
   */
  components: string[]
}

/**
 * The validated values of a `windows.enable-wsl` step (change `add-tensorrt-llm-windows`, design
 * D2): none. The elevated executor only ever runs `wsl --install`, so nothing a
 * client or a user could choose reaches it; the digest still binds the (empty) object, the same
 * check every action gets.
 */
export type EnableWslStepParameters = Record<string, never>

/**
 * The parameters of each privileged action, keyed by `ManagedHostStep.action`: one action, one
 * shape, so a client and the executor tell them apart by the action alone.
 */
export interface ManagedHostStepParameters {
  'linux.install-container-runtime': ContainerRuntimeStepParameters
  'windows.enable-wsl': EnableWslStepParameters
}

/**
 * The pending privileged step. `nonce` is single-use and `expected_operation_revision` pins it to
 * one state of one operation, so a receipt cannot be replayed into a later phase. The digests bind
 * it to the exact recipe and parameters the user approved; `parameters` are those parameters, which
 * the client writes into the host-step request file unchanged. A union by `action`: the parameters'
 * shape is the action's own (`ManagedHostStepParameters`).
 */
export type ManagedHostStep = {
  [A in ManagedHostAction]: {
    step_id: string
    action: A
    recipe_id: string
    recipe_digest: Sha256Digest
    parameters_digest: Sha256Digest
    parameters: ManagedHostStepParameters[A]
    nonce: string
    expected_operation_revision: number
  }
}[ManagedHostAction]

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
  /**
   * The privileged step's own `log_tail` from its result file (task 2.23, F-4), forwarded as read;
   * optional and additive. On a `failed` receipt it becomes the operation error's `details`, and a
   * cause the core recognises in it (Docker's address pools exhausted by the host's routes) is named
   * in the error's `message`. Never evidence of success: the core re-probes regardless. The core
   * keeps at most its last 16 KiB.
   */
  log_tail?: string
}

/**
 * A durable operation. It outlives the dialog, the app and the core: closing the UI does not cancel
 * it, and `cancellation_requested` is a request recorded during work that cannot be interrupted
 * safely, honored at the next safe boundary.
 *
 * `plan_digest` is what the core currently intends; `approved_plan_digest` is what the user agreed
 * to. They differ when the host changed under an operation awaiting consent, and privileged work
 * never starts while they differ. In every work phase (`preparing-host` through `activating`, and
 * `removing`) and in `ready`/`removed` they are equal: work only ever runs under the approval of
 * the plan it names. Before any consent they may differ in a phase that is not work — `checking`,
 * `awaiting-consent`, or `failed`/`relogin-required` straight from a probe (a blocked host, no
 * approval yet). After work began a waiting or failed phase keeps the consented digest in both,
 * unless the core re-asked: when the host changed beyond what the consent covers, `awaiting-consent`
 * offers the new plan in `plan_digest` while `approved_plan_digest` still names the old approval,
 * and a phase reached from there (a cancel, a failed or blocked probe) keeps them different. Work
 * never starts again until they are equal.
 *
 * `carried_plan_digest` is the plan the core continued under after work began, covered by the
 * consent's basis (the same descriptor, engine image digest and target the approved plan named):
 * after a sign-in or a restart the host looks different (packages installed, space used by the
 * pull), so a fresh probe yields a new digest, but it asks nothing the user did not approve. It is
 * reported here, apart, and never replaces `plan_digest` or `approved_plan_digest`. Null until the
 * core has continued that way, and again after a new approval.
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
  carried_plan_digest: Sha256Digest | null
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
 *
 * `approved_plan_digest` approves the plan on offer only in `awaiting-consent`. In any other phase it
 * may only restate the operation's current `plan_digest`; a different one is refused with
 * `MANAGED_PLAN_CHANGED` (409) and nothing changes — resume without it, and approve whatever plan the
 * re-probe then offers.
 */
export interface ResumeOperation {
  expected_revision: number
  approved_plan_digest?: Sha256Digest
}

/**
 * One change the plan makes to the machine, structured: `code` names the change for a client (and
 * for the plan digest) to key off, `params` carries its specifics (the packages, the user, the
 * number of running containers a Docker restart stops), and `text` is what a person reads before
 * the OS authorization prompt. A removal plan lists what it deletes the same way.
 */
export interface ManagedSystemChange {
  code: string
  text: string
  params?: Record<string, string>
}

/**
 * Something the plan's reader should know that does not block it and that the plan cannot fix
 * (task 2.23, F-4): shaped like `ManagedSystemChange`. `code` is stable for a client to key off
 * (`docker-address-pools-overlap-routes`: the host's routes cover every default Docker address pool,
 * so Docker would not start — `params.routes` names them), `text` says what to do. Not part of
 * `plan_digest`: a warning never asks for a new consent.
 */
export interface ManagedPlanWarning {
  code: string
  text: string
  params?: Record<string, string>
}

/**
 * The Windows causes of a blocker (`ManagedBlocker.reason`) or of a failure (`ErrorBody.details`) a
 * client switches on (change `add-tensorrt-llm-windows`, spec `wsl-runtime-environment`):
 * - `wsl-localhost-forwarding` — the engine answers inside the distribution but not on Windows'
 *   `127.0.0.1`: WSL's localhost forwarding is off or broken (`.wslconfig`);
 * - `wsl-stopped` — the distribution or the WSL VM stopped under a running session;
 * - `wsl-version` — the installed WSL is older than the manifest's `minimum_wsl_version`;
 * - `wsl1-distribution` — Atomic Chat's own distribution is registered as WSL 1;
 * - `virtualization-disabled` — virtualization is off in the firmware;
 * - `foreign-distribution` — a distribution with Atomic Chat's name exists that it did not import.
 */
export const WSL_REASONS = [
  'wsl-localhost-forwarding',
  'wsl-stopped',
  'wsl-version',
  'wsl1-distribution',
  'virtualization-disabled',
  'foreign-distribution',
] as const
export type WslReason = (typeof WSL_REASONS)[number]

/**
 * One reason the host cannot proceed. The `ErrorBody` part is what becomes the operation's `error`;
 * `reason` is a stable machine-readable cause (`driver-too-old`, `relogin-required`, ...), `params`
 * its specifics (required and actual versions, ...), and `commands` exact, copyable shell commands
 * where the fix is manual (Arch, a group-only host).
 */
export interface ManagedBlocker extends ErrorBody {
  reason?: string
  params?: Record<string, string>
  commands?: string[]
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
  /**
   * The runtime descriptor this plan installs (or, for a removal, the one being removed): the
   * cached descriptor the request named when this core has it, otherwise the newest one it can get.
   * Null when none is available. Part of what the consent covers (task 2.6).
   */
  descriptor_id: string | null
  /**
   * The environment manifest this plan judged the host against — which distributions the install
   * recipe is qualified for (`EnvironmentManifest.manifest_id`). Null when none is available: then
   * a host that needs an install is blocked, and a ready one is adopted all the same. Part of what
   * the consent covers, like the descriptor.
   */
  environment_manifest_id: string | null
  /**
   * The engine image this plan pulls (or, for a removal, removes), by digest for this host's
   * platform. Null when there is none (no descriptor, or an environment-only target). A consent
   * carries over to a later plan only when this, the descriptor and the target are unchanged.
   */
  image_digest: Sha256Digest | null
  adopts_existing_engine: boolean
  /** System changes, shown before the OS authorization prompt. Empty when nothing changes. */
  system_changes: ManagedSystemChange[]
  download_bytes: number | null
  required_disk_bytes: number | null
  /**
   * The path the core measured free space for when it computed this plan (task 2.22, owner ruling
   * R-core-6): `DockerRootDir` from `docker info` when the daemon answered, otherwise
   * `/var/lib/docker`, where Docker puts its images by default (on a clean host the space is read at
   * that path's nearest existing ancestor). A client shows it next to `free_disk_bytes` and
   * `required_disk_bytes`. If Docker is later set up with another root directory, the next probe
   * reports that one. Null together with `free_disk_bytes` whenever the core measured nothing: the
   * free-space read failed, or the plan never read the machine (a removal, or no descriptor).
   *
   * On Windows (change `add-tensorrt-llm-windows`, ruling core 2.1) the same two fields keep their
   * meaning — "the path the core measured, and what it found there" — over the one disk that
   * matters: the Windows directory of Atomic Chat's own distribution (`%LOCALAPPDATA%\AtomicChat\wsl\<name>`,
   * where its `ext4.vhdx` lives or will be imported to). `free_disk_bytes` is then the free space on
   * that directory's volume, and once the distribution exists the smaller of that and the free space
   * at `DockerRootDir` inside the guest: the image lands in the guest's disk, which can grow only as
   * far as the Windows volume lets it.
   */
  docker_root_dir: string | null
  /**
   * Free bytes at `docker_root_dir` as of this probe — the very number an `insufficient-disk`
   * blocker's `params.free` carries. Null when not measured (see `docker_root_dir`). Informational
   * only: the consent (`plan_digest`) covers whether the space suffices, never this number, which
   * moves on its own all the time.
   */
  free_disk_bytes: number | null
  requires_elevation: boolean
  may_require_relogin: boolean
  may_require_reboot: boolean
  blockers: ManagedBlocker[]
  /** Warnings shown next to the plan (task 2.23, F-4); empty when there are none. Outside `plan_digest`. */
  warnings: ManagedPlanWarning[]
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
 * Package-manager family a Linux distribution uses, read from `/etc/os-release` `ID`/`ID_LIKE`
 * (task 2.4). Arch and its derivatives (`pacman`) never check the install recipe's distribution
 * list — they only ever adopt a working host or get exact manual instructions (design D2).
 */
export const LINUX_PACKAGE_FAMILIES = ['apt', 'dnf', 'pacman', 'other'] as const
export type LinuxPackageFamily = (typeof LINUX_PACKAGE_FAMILIES)[number]

/**
 * How Docker Engine reached this machine, as far as a read-only probe can tell (task 2.4, design
 * D2). `docker-ce`/`docker.io`/`moby-engine` are alternative distro packages this integration can
 * adopt or complete; `snap`, `rootless`, `docker-desktop` and `podman-docker` describe an
 * installation it will never install over or adopt, because there is no safe way to layer
 * `docker-ce` on top of, or automatically replace, someone else's existing setup.
 */
export const LINUX_DOCKER_INSTALL_METHODS = [
  'docker-ce',
  'docker.io',
  'moby-engine',
  'snap',
  'rootless',
  'docker-desktop',
  'podman-docker',
] as const
export type LinuxDockerInstallMethod = (typeof LINUX_DOCKER_INSTALL_METHODS)[number]

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
 * The data about the foundation every managed engine runs on, kept apart from any engine's
 * descriptor (openspec change `extract-environment-manifest`). One document per platform,
 * `runtimes/environments/<platform>.json` in conf, and a core reads only its own platform's — a
 * union by `platform`. Immutable per `manifest_id` (`<platform>-r<N>`), like a descriptor per
 * `descriptor_id`. Data only: every recipe body and argv is compiled into core.
 */
export type EnvironmentManifest = LinuxEnvironmentManifest | WindowsEnvironmentManifest

/** The platforms an environment manifest is published for. */
export type EnvironmentPlatform = EnvironmentManifest['platform']

/**
 * Linux's manifest: which install recipes exist and on which distributions each is qualified. Shape
 * matches `atomic-chat-conf/runtimes/environments/linux.schema.json`.
 */
export interface LinuxEnvironmentManifest {
  schema_version: 1
  manifest_id: string
  platform: 'linux'
  minimum_core_version: string
  recipes: InstallRecipe[]
}

/**
 * The guest root filesystem Windows core imports as Atomic Chat's own WSL distribution: an HTTPS
 * `url`, the file's lowercase-hex `sha256` (checked before the file is used for anything) and what
 * the guest is, in a Linux manifest's terms.
 */
export interface WslRootfs {
  url: string
  sha256: string
  /** `aarch64` only in the Windows on Arm manifest (`windows-arm64.json`, id `windows-arm64-r<N>`). */
  distribution: { id: string; version_id: string; arch: 'x86_64' | 'aarch64' }
}

/**
 * Windows' manifest (change `add-tensorrt-llm-windows`, design D13): the lowest Windows build and
 * WSL package version core offers the environment on, the pinned rootfs, and the recipe compiled into
 * core that prepares the guest. Shape matches `atomic-chat-conf/runtimes/environments/windows.schema.json`.
 * `minimum_wsl_version` is `MAJOR.MINOR.PATCH`; `wsl --version`'s fourth part is ignored (conf ruling 1.1).
 */
export interface WindowsEnvironmentManifest {
  schema_version: 1
  manifest_id: string
  platform: 'windows'
  minimum_core_version: string
  minimum_windows_build: number
  minimum_wsl_version: string
  rootfs: WslRootfs
  guest_recipe_id: string
}

/**
 * Immutable metadata for one engine release: which image to run, what the host needs, and what it
 * can load. Fetched over HTTPS from the release catalog and pinned by digest. It carries data only:
 * a descriptor can never contain a command, a shell recipe or code to load, and never an install
 * recipe or a distribution list — those are the environment's (`EnvironmentManifest`). Shape matches
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
  download_bytes: number
  required_disk_bytes: number
  notices: string[]
  exclusions: string[]
}

/**
 * What `GET /atomic/v1/environments/descriptors/:descriptorId` answers (task 2.22, app gap G-app-2):
 * the part of one cached runtime descriptor a client shows the user — the NVIDIA terms and notices
 * before consent, the curated checkpoints and the architectures on the model screen. Copied from the
 * descriptor as published: `notices` verbatim and in order. The core answers from its own cache,
 * never the network, for the id an installation pins (`RuntimeInstallation.active_descriptor_id`) or
 * a plan names (`RequirementPlan.descriptor_id`).
 */
export interface RuntimeDescriptorSummary {
  descriptor_id: string
  engine_id: string
  notices: string[]
  curated_models: CuratedModel[]
  supported_architectures: string[]
}

/**
 * The verdict of `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`): what the
 * core found out about a checkpoint from its `config.json`/`hf_quant_config.json` and file listing,
 * without downloading a single weight or reaching the network. `architectures`, `quantization_format`
 * and `weight_bytes` describe the checkpoint as submitted; `checked_gpu_id` names the GPU the
 * verdict was computed against — the caller's `gpu_id`, or the one a load would pick when omitted.
 *
 * `quantization_format` is null when there is no recognised format to report: GGUF is always
 * rejected outright (spec `tensorrt-llm-models` — "for GGUF there is llama.cpp"), and a checkpoint
 * whose `config.json`/`hf_quant_config.json` the naming rule from the conf README does not
 * recognise is rejected the same way, unidentified rather than guessed at.
 *
 * `curated` is true when the repository and revision matched a `curated_models` entry of the
 * installed descriptor and its `inventory_digest` verified against the submitted file list.
 * `unified_memory` is true when `checked_gpu_id` reports no VRAM of its own (e.g. GB10/DGX Spark),
 * so the check compared weight bytes against host memory instead (design D13). `fits_other_gpus`
 * lists every other GPU on this host the checkpoint would fit on, populated whether or not
 * `checked_gpu_id` itself passed, so a caller can suggest a card switch instead of a dead end.
 *
 * `verdict` carries the pass/fail: `MODEL_INCOMPATIBLE` for an unsupported architecture, a
 * quantization format newer than the card (or on the format's exclusion list, or not recognised at
 * all, including GGUF), or weights that do not fit; `MANAGED_METADATA_INVALID` when a curated
 * match's `inventory_digest` does not verify.
 *
 * `kv_reserve_basis` says how the KV-cache memory reserve behind `verdict` was sized (task 2.16w
 * round 1, finding 6): `'config'` when `config.json` carried the architecture fields
 * (`num_hidden_layers`, `num_key_value_heads`/`num_attention_heads`, `head_dim`/`hidden_size`) the
 * real formula needs — `weights + KV_bytes / kv_cache_free_gpu_memory_fraction`, `KV_bytes` sized
 * from those fields, the context length and the KV dtype; `'weight_fraction'` when they were
 * missing and the reserve fell back to the older, cruder `weights × (1 − fraction)` rule. `undefined`
 * only when the verdict never reached the memory check at all (an earlier failure — GGUF, an
 * unrecognised format, an unsupported architecture, a curated digest mismatch).
 */
export interface ModelCompatibility {
  architectures: string[]
  /** Null when the checkpoint has no recognised quantization format (GGUF, or an unrecognised naming). */
  quantization_format: string | null
  weight_bytes: number
  checked_gpu_id: string
  curated: boolean
  unified_memory: boolean
  fits_other_gpus: string[]
  kv_reserve_basis?: 'config' | 'weight_fraction'
  verdict: { ok: true } | { ok: false; error: ErrorBody }
  /**
   * What the caller should know that does not refuse the model (change `add-tensorrt-llm-windows`,
   * design D11): `wsl-vm-memory` — on Windows the WSL VM has less memory than the weights
   * (`params.vm_memory_bytes`, `params.weight_bytes`, `params.wslconfig_memory` as `.wslconfig` sets it,
   * or `''` when unset), so loading streams and is slower. Absent when there is nothing to say;
   * additive, a client that predates it ignores the key.
   */
  warnings?: ModelCheckWarning[]
}

/** One `ModelCompatibility.warnings` entry: shaped like `ManagedPlanWarning`. */
export interface ModelCheckWarning {
  code: string
  message: string
  params?: Record<string, string>
}

/**
 * `DELETE /models/tensorrt-llm/:id` (task 2.24, design D12a, spec `tensorrt-llm-models` "Модель
 * удаляется через core"): what the deletion removed, once the model's container stop was confirmed.
 */
export interface ManagedModelDeletion {
  model_id: string
  /** Whether a session or a load of the model had to be stopped first. */
  was_loaded: boolean
  /** Bytes of the model folder and of every engine cache of the model, measured just before removal. */
  freed_bytes: number
  /** Engine cache folders removed: one per engine release (descriptor) the model was ever loaded with. */
  engine_caches_removed: number
}

/**
 * `GET /atomic/v1/models/tensorrt-llm/location` (change `add-tensorrt-llm-windows`, task 2.8, design
 * D6; spec `tensorrt-llm-models` "Core сообщает расположение моделей"): the one root a client downloads
 * `tensorrt-llm` models into, checks files under and writes `model.yml` in — as this machine opens it:
 * `<data>/tensorrt-llm/models` on Linux, `\\wsl.localhost\<distribution>\var\lib\atomic-chat\scopes\<key>\models\tensorrt-llm`
 * on Windows. `free_bytes` is the space left for new models there — on Windows the smaller of the
 * guest's and the Windows volume's that holds the distribution — or null when it could not be read.
 */
export interface ManagedModelLocation {
  root: string
  free_bytes: number | null
}
