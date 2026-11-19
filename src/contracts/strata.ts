/** Browser-safe Strata contracts. Acquisition belongs to clients; preparation belongs to core. */
export const STRATA_FAMILIES = ['qwen38', 'qwen36', 'deepseek41'] as const
export type StrataFamily = (typeof STRATA_FAMILIES)[number]
export type StrataBackend = 'cuda' | 'hip' | 'metal' | 'sycl'
export type StrataMemoryMode = 'auto' | 'ram' | 'ssd'
export interface StrataSource {
  id: string
  host: 'huggingface' | 'github'
  repo: string
  revision: string
}
export interface StrataFile {
  source: string
  source_path: string
  path: string
  size: number
  sha256: string
  role:
    | 'weights'
    | 'vision'
    | 'drafter'
    | 'drafter-config'
    | 'draft-vocab'
    | 'expert-profile'
    | 'engram'
    | 'engram-metadata'
    | 'pack'
    | 'ple'
    | 'embedding'
}
export interface StrataCapabilities {
  chat: true
  tools: boolean
  reasoning: boolean
  vision: boolean
  structured_output: boolean
}
export interface StrataInputs {
  weights: string[]
  tokenizer_from: string
  chat_template_from: string
  vision: string
  drafting: 'dflash2' | 'mtp-embedded' | 'dspark' | 'none'
  drafter?: string
  drafter_config?: string
  draft_vocab?: string
  expert_profile?: string
  drafter_embedded_in?: string
  engram?: string
  engram_metadata?: string
  ple?: string
  embedding?: string
  pack_files?: string[]
  experts_per_token?: 6
}
export interface StrataRequirements {
  download_bytes: number
  memory_accounting: 'separate-ram-vram-or-unified'
  resource_estimator: string
  disk_components: ['sources', 'derivatives', 'temporary', 'previous-installation']
  memory_components: ['ram', 'vram', 'unified-memory']
  memory_modes: StrataMemoryMode[]
  requires_core_check: true
}
export interface StrataModelDescriptor {
  family: StrataFamily
  variant_id: string
  /** Existing engine profile used by a separately installable catalog variant. */
  profile_id?: string
  name: string
  license: string
  gated: boolean
  context_length: number
  engine_release: string
  preparation_abi: 'strata-v1'
  preparation_recipe_id: 'strata-qwen38-v1' | 'strata-qwen36-v1' | 'strata-deepseek41-v1'
  sources: StrataSource[]
  files: StrataFile[]
  inputs: StrataInputs
  compatible_variants: string[]
  capabilities: StrataCapabilities
  capability_requirements: {
    vision: ['compatible-picture-reader']
    structured_output: ['full-json-schema-validator']
    drafting: ['verified-family-profile']
  }
  requirements: StrataRequirements
  qualification: { status: 'upstream-supported' | 'atomic-qualified'; evidence: string[] }
}
export interface ModelYmlStrata {
  schema_version: 1
  /** SHA-256 of the canonical descriptor. Never a claim that derivatives are ready. */
  source_digest: string
  descriptor: StrataModelDescriptor
}
export type StrataPreparationStatus =
  'files-ready' | 'preparing' | 'ready' | 'preparation-required' | 'failed'
export type StrataCheckRequest =
  | {
      descriptor: StrataModelDescriptor
      /** Reusable source bytes already occupying disk in the caller's staging directory. */
      staged_bytes?: number
    }
  | { model_id: string }
export interface StrataResourceEstimate {
  /** Remaining source bytes for this request, after any reported staging credit. */
  download_bytes: number
  derivative_bytes: number
  temporary_bytes: number
  previous_installation_bytes: number
  required_disk_bytes: number
  ram_bytes: number
  vram_bytes: number
  unified_memory_bytes: number
}
export interface StrataCheckResult {
  verdict:
    | 'ok'
    | 'engine-not-installed'
    | 'platform-unsupported'
    | 'requires-newer-engine'
    | 'invalid-installation'
    | 'insufficient-disk'
    | 'insufficient-memory'
    | 'unknown-hardware'
    | 'maintenance'
  reason: string | null
  requirements: StrataRequirements | null
  capabilities: StrataCapabilities | null
  preparation_status: StrataPreparationStatus | null
  estimates: StrataResourceEstimate | null
  compatible_devices: Array<{ gpu_id: string; backend: StrataBackend; variant_id: string }>
  warnings: string[]
  qualification: StrataModelDescriptor['qualification'] | null
}
export const STRATA_PREPARATION_STATES = [
  'queued',
  'preparing',
  'verifying',
  'ready',
  'failed',
  'cancelled',
  'interrupted',
] as const
export interface StrataPreparationRequest {
  request_id: string
  model_id: string
  source_digest: string
  maintenance_id?: string
}
export interface StrataPreparationOperation extends StrataPreparationRequest {
  operation_id: string
  revision: number
  state: (typeof STRATA_PREPARATION_STATES)[number]
  stage: string
  completed_bytes?: number
  total_bytes?: number
  error: { code: string; message: string } | null
}
export type StrataMaintenanceRequest = { request_id: string; model_id: string } & (
  { action: 'replace'; target_source_digest: string } | { action: 'remove'; target_source_digest?: never }
)
export type StrataMaintenance = StrataMaintenanceRequest & {
  operation_id: string
  revision: number
  state: 'stopping' | 'held' | 'completed'
  ready_to_mutate: boolean
}
