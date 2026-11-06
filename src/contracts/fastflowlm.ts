/** Browser-safe FastFlowLM catalog and control contracts. The client owns the model files. */
import type { ManagedHostReceipt, ManagedHostStep, ManagedSystemChange, Sha256Digest } from './environment.js'

export interface FastFlowLmSource {
  id: string
  host?: 'huggingface' | 'github'
  repo: string
  revision: string
}

export interface FastFlowLmFile {
  source: string
  source_path: string
  path: string
  size: number
  sha256: string
}

export interface FastFlowLmRequirements {
  minimum_flm_version: string
  local_only_protocol: 1
  npu_generation: 'xdna2'
}

export interface FastFlowLmModelDescriptor extends FastFlowLmRequirements {
  model_id: string
  variant_id: string
  checkpoint: string
  context_length: number
  capabilities: { chat: true; tools: boolean; reasoning: boolean; structured_output: boolean }
  sources: FastFlowLmSource[]
  files: FastFlowLmFile[]
}

export interface FastFlowLmDefinition extends FastFlowLmModelDescriptor {
  name: string
  license: string
  gated: boolean
  components: Record<'weights' | 'tokenizer' | 'config' | 'chat_template' | 'kernels' | 'metadata', string[]>
  qualification: { status: 'candidate' | 'qualified'; evidence: string[] }
}

export interface ModelYmlFastFlowLm extends FastFlowLmModelDescriptor {
  schema_version: 1
  catalog_digest: string
  model_list_path: string
  model_info_path: string
}

export type FastFlowLmCheckRequest =
  { descriptor: FastFlowLmModelDescriptor } | { model_id: string } | { path: string }
export interface FastFlowLmCheckResult {
  verdict:
    | 'ok'
    | 'engine-not-installed'
    | 'environment-not-ready'
    | 'platform-unsupported'
    | 'requires-newer-engine'
    | 'invalid-installation'
  reason: string | null
  requirements: FastFlowLmRequirements | null
  metadata: ModelYmlFastFlowLm | null
}

export interface FastFlowLmNpu {
  pci_device_id: string
  /** Linux sysfs PCI revision in lowercase hex, when reported by this owner. */
  pci_revision?: string
  id: string
  bdf: string | null
  pnp_hardware_id: string | null
  generation: 'xdna1' | 'xdna2' | null
  driver: 'bound' | 'missing' | 'problem' | 'unknown'
  driver_version: string | null
  firmware: string | null
  node: string | null
  accessible: boolean | null
  xrt_visible: boolean | null
  ready: boolean
}

export interface FastFlowLmAccelerators {
  ready: boolean
  devices: FastFlowLmNpu[]
  reason: string | null
  blockers: string[]
  runtime_account: string | null
  runtime_mode: 'desktop' | 'interactive' | 'user-service' | 'system-service' | null
  runtime_service: string | null
  /** Effective soft RLIMIT_MEMLOCK, decimal bytes or "unlimited". */
  memlock_bytes: string | null
  engine_version: string | null
  required: { driver: string; firmware: string | null; memlock_bytes: string | null; xrt: string }
  automatic_repair_available: boolean
}

export interface FastFlowLmPreparationPlan {
  plan_digest: Sha256Digest
  /** A plan can lack a manifest on a ready host, or lack a matching recipe in a known manifest. */
  manifest_digest: Sha256Digest | null
  recipe_digest: Sha256Digest | null
  runtime_account: string
  runtime_mode: NonNullable<FastFlowLmAccelerators['runtime_mode']>
  /** Service identity when running as a service, otherwise null. */
  runtime_service: string | null
  /** Pinned package downloads displayed for consent. SHA-256 is the raw hex digest. */
  packages: { name: string; version: string; source: string; sha256: string }[]
  blockers: string[]
  changes: ManagedSystemChange[]
}

export interface FastFlowLmProbePlan extends Omit<
  FastFlowLmPreparationPlan,
  'runtime_account' | 'runtime_mode'
> {
  status: 'ready' | 'blocked' | 'action-required'
  runtime_account: FastFlowLmAccelerators['runtime_account']
  runtime_mode: FastFlowLmAccelerators['runtime_mode']
  manifest_id: string | null
  recipe_id: string | null
  recipe_revision: number | null
  engine_version: string | null
}

export const FASTFLOWLM_OPERATION_STATES = [
  'checking',
  'awaiting-consent',
  'preparing-host',
  'reboot-required',
  'relogin-required',
  'verifying',
  'ready',
  'failed',
  'cancelled',
] as const
/** The same receipt binding as the managed host protocol. */
type FlmHostParameters = Pick<
  FastFlowLmPreparationPlan,
  'runtime_account' | 'runtime_mode' | 'runtime_service'
> & {
  manifest_id: string
  manifest_digest: Sha256Digest
  recipe_revision: number
}
export type WindowsNpuStepParameters = FlmHostParameters & {
  device_instance_id: string
  environment_manifest: unknown
}
export type LinuxNpuStepParameters = WindowsNpuStepParameters & {
  package_names: string[]
  device_access: boolean
  memlock: boolean
}
export type FastFlowLmHostStep = Extract<
  ManagedHostStep,
  { action: 'linux.install-amd-npu' | 'windows.install-amd-npu' }
>
export interface FastFlowLmOperation {
  operation_id: string
  request_id: string
  revision: number
  state: (typeof FASTFLOWLM_OPERATION_STATES)[number]
  pending_host_step: FastFlowLmHostStep | null
  plan: Omit<FastFlowLmPreparationPlan, 'runtime_account' | 'runtime_mode'> &
    Pick<FastFlowLmProbePlan, 'runtime_account' | 'runtime_mode'>
  reason: string | null
}
export type FastFlowLmHostReceipt = Omit<ManagedHostReceipt, 'outcome'> & {
  outcome: ManagedHostReceipt['outcome'] | 'service-restart-required'
}
export interface FastFlowLmConsent {
  approved_plan_digest: Sha256Digest
  expected_revision: number
}
export interface FastFlowLmMaintenanceRequest {
  request_id: string
  model_id: string
  kind: 'replace' | 'remove'
}
export interface FastFlowLmMaintenanceResult {
  operation_id: string
  ready_to_mutate: boolean
}
export type FastFlowLmMaintenance = FastFlowLmMaintenanceRequest & { operation_id: string } & (
    { state: 'held'; ready_to_mutate: true } | { state: 'stopping' | 'completed'; ready_to_mutate: false }
  )
