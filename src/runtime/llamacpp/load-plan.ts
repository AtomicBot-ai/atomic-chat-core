/**
 * The load plan: everything `performLoad()` in `extensions/llamacpp-upstream-extension/src/index.ts`
 * (lines 4735-5249) decides before it hands a config to the process spawner, as a pure orchestration
 * over injected facts. The 23 steps (PLAN.md §8.1) are numbered in comments.
 *
 * Owns: settings merge, `latest/` sentinel resolution, flash-attn clamp for old builds, AVX preflight,
 * model.yml → paths (first shard, mmproj), artifact validation, Llama 3 template override, MTP/DFlash
 * draft resolution and capability gates, `dflash_n_max`, mutual exclusion, ctx clamp, env, port and
 * API key. Does NOT spawn; `nextRetry()` encodes the two post-failure retries.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { LlamacppConfig, LocalProviderId } from '../../contracts/index.js'
import type { ModelYmlDocument } from '../../models/index.js'
import {
  effectiveCtxSize,
  firstGgufShardPath,
  ggufShardSetPaths,
  isMtpCapable,
  matchesMtpLoadFailure,
  parseGgufShard,
} from '../../models/index.js'
import { generateApiKey } from '../ports.js'
import { withLlamacppDefaults } from './args.js'
import type { LlamacppConfigInput } from './args.js'
import {
  BACKEND_NOT_CONFIGURED_MESSAGE,
  CPU_NO_AVX_ERROR_CODE,
  CPU_NO_AVX_MESSAGE,
  codedLoadError,
  formatLoadError,
  isCpuBackend,
  isUnsupportedNoAvxCpu,
  modelLoadReadyTimeoutSecs,
  parseBuildNumberStrict,
  parseEnvString,
  stripBom,
} from './policy.js'

/** Engine-level settings the extension reads beside `LlamacppConfig`. */
export interface LlamacppEngineSettings {
  /** Seconds; feeds `LLAMA_ARG_TIMEOUT` and the readiness wait. */
  timeout: number | string
  /** `KEY=VALUE;…` user environment. */
  llamacpp_env: string
  /** DFlash block size → `dflash_n_max = block - 1`. */
  dflash_block_size?: number | string
}

export interface LoadPlanInput {
  provider: LocalProviderId
  modelId: string
  /** The provider's settings (34 keys) already canonicalised, plus per-model defaults. */
  config: LlamacppConfigInput
  engine: LlamacppEngineSettings
  /** Per-model overrides (`settings` argument of `load()`), canonical keys. */
  overrides?: Partial<LlamacppConfig> | undefined
  /** Explicit CLI paths bypass the installed-model registry. */
  modelPath?: string | undefined
  mmprojPath?: string | undefined
  /** CLI `--timeout` is exact; provider loads keep the application readiness floor. */
  timeoutSecs?: number | undefined
  isEmbedding: boolean
  dataFolder: string
  /** Model ids that must never be auto-unloaded (the transcription companion). */
  transcriptionModelId?: string
}

export interface LoadPlanDeps {
  joinData: (relative: string) => string
  readModelYml: (modelId: string) => Promise<ModelYmlDocument>
  /** Resolve the `latest/<backend>` sentinel; `undefined` when offline with nothing installed. */
  resolveLatestBackend: (backend: string) => Promise<string | undefined>
  /** Download/install if needed; may return a different pair after a compatible-fallback. */
  ensureBackendReady: (
    backend: string,
    version: string
  ) => Promise<{ version: string; backend: string; exePath: string }>
  /** CPU facts for the AVX preflight; `undefined` when the probe failed. */
  cpuInfo: () => Promise<{ arch: string; extensions: string[] } | undefined>
  exists: (path: string) => Promise<boolean>
  fileSize: (path: string) => Promise<number | undefined>
  readGgufMetadata: (path: string) => Promise<Record<string, string> | undefined>
  randomPort: () => Promise<number>
  checkGemmaMtpSupport: (modelId: string) => boolean
  ensureGemmaMtpDraft: (modelId: string) => Promise<void>
  checkDflashSupport: (modelId: string) => boolean
  ensureDflashDraft: (modelId: string) => Promise<void>
  backendSupportsDflashSpec: (exePath: string, env: Record<string, string>) => Promise<boolean>
  resolveLlama3TemplateOverride: (modelId: string, embedded: string | undefined) => string | undefined
  strictSystemGuardSignature?: string
  apiSecret?: string
  warn?: (msg: string) => void
}

export interface LoadPlan {
  provider: LocalProviderId
  modelId: string
  version: string
  backend: string
  exePath: string
  config: LlamacppConfig
  port: number
  apiKey: string
  env: Record<string, string>
  modelPath: string
  mmprojPath: string | undefined
  isEmbedding: boolean
  timeoutSecs: number
  maxCtxTrain: number | undefined
  warnings: string[]
}

/** Which loaded text sessions to unload before loading `modelId` (auto-unload policy). */
export function autoUnloadTargets(
  sessions: Array<{ model_id: string; is_embedding: boolean }>,
  opts: {
    autoUnload: boolean
    isEmbedding: boolean
    bypassAutoUnload: boolean
    transcriptionModelId?: string
  }
): string[] {
  if (!opts.autoUnload || opts.isEmbedding || opts.bypassAutoUnload) return []
  return sessions
    .filter((s) => s.is_embedding === false && s.model_id !== opts.transcriptionModelId)
    .map((s) => s.model_id)
}

export async function planLlamaLoad(input: LoadPlanInput, deps: LoadPlanDeps): Promise<LoadPlan> {
  const warnings: string[] = []
  const warn = (m: string) => {
    warnings.push(m)
    deps.warn?.(m)
  }
  const { modelId } = input

  // 2. settings merge (per-model overrides win)
  const cfg = withLlamacppDefaults({ ...input.config, ...(input.overrides ?? {}) } as LlamacppConfigInput)
  const env: Record<string, string> = {}

  // 3. `latest/<backend>` sentinel
  if (stripBom(cfg.version_backend || '').startsWith('latest/')) {
    const sentinelBackend = stripBom(cfg.version_backend.split('/')[1] ?? '')
    const resolved = await deps.resolveLatestBackend(sentinelBackend)
    if (resolved) cfg.version_backend = resolved
    else
      warn(
        `Could not resolve latest sentinel for '${sentinelBackend}' (offline and no installed copy of the family).`
      )
  }

  // 4. split
  let [version, backend] = cfg.version_backend.split('/') as [string | undefined, string | undefined]
  if (!version || !backend) throw new AtomicCoreError('INVALID_ARGUMENT', BACKEND_NOT_CONFIGURED_MESSAGE)

  // 5. flash-attn compat for pre-b6325 builds
  if (cfg.flash_attn === 'auto' && !backend.startsWith('ik')) {
    const buildNum = parseBuildNumberStrict(version)
    if (buildNum !== null && buildNum < 6325) cfg.flash_attn = 'off'
  }

  // 6. AVX preflight (CPU backends only; a failed probe never blocks)
  if (isCpuBackend(backend)) {
    const cpu = await deps.cpuInfo().catch(() => undefined)
    if (isUnsupportedNoAvxCpu(cpu?.arch ?? '', backend, cpu?.extensions ?? null)) {
      throw codedLoadError(CPU_NO_AVX_ERROR_CODE, CPU_NO_AVX_MESSAGE)
    }
  }

  // 7. backend ready (may swap to a compatible installed pair)
  const ready = await deps.ensureBackendReady(backend, version)
  version = ready.version
  backend = ready.backend
  const exePath = ready.exePath

  // 8-9. model.yml, port, key, env
  const modelConfig: ModelYmlDocument = input.modelPath
    ? {
        model_path: input.modelPath,
        ...(input.mmprojPath ? { mmproj_path: input.mmprojPath } : {}),
        name: modelId,
        size_bytes: 0,
      }
    : await deps.readModelYml(modelId)
  const port = await deps.randomPort()
  const apiKey = generateApiKey(modelId, port, deps.apiSecret)
  const timeoutSecs = input.timeoutSecs ?? modelLoadReadyTimeoutSecs(input.engine.timeout)
  env['LLAMA_API_KEY'] = apiKey
  env['LLAMA_ARG_TIMEOUT'] = String(input.timeoutSecs ?? input.engine.timeout)
  if (input.engine.llamacpp_env) parseEnvString(input.engine.llamacpp_env, env)

  // 10. paths: first shard, mmproj
  const modelPath = await resolveShardedModelPath(deps.joinData(modelConfig.model_path), deps, warn)
  const configuredMmproj = input.mmprojPath ?? modelConfig.mmproj_path
  const mmprojPath = configuredMmproj ? deps.joinData(configuredMmproj) : undefined

  // 11. artifact validation
  await assertCompleteGguf(modelPath, modelConfig.model_size_bytes, deps)
  if (mmprojPath) await assertCompleteGguf(mmprojPath, modelConfig.mmproj_size_bytes, deps)

  // 12. Llama 3.x template override
  if (!cfg.chat_template?.trim()) {
    try {
      const embedded = (await deps.readGgufMetadata(modelPath))?.['tokenizer.chat_template']
      const override = deps.resolveLlama3TemplateOverride(modelId, embedded)
      if (override) {
        cfg.chat_template = override
        warn(
          `Overriding strict embedded chat_template for "${modelId}" with the canonical Meta Llama 3.x template.`
        )
      } else if (deps.strictSystemGuardSignature && embedded?.includes(deps.strictSystemGuardSignature)) {
        warn(
          `Model "${modelId}" has a strict system-message guard in its embedded chat_template but is not a recognized Llama 3.x format; leaving the template untouched.`
        )
      }
    } catch (e) {
      warn(`chat_template override probe failed for "${modelId}": ${formatLoadError(e)}`)
    }
  }

  // 13. Gemma MTP draft head
  let mtpDraftRel = modelConfig.mtp_draft_path
  if (cfg.mtp && !mtpDraftRel && deps.checkGemmaMtpSupport(modelId)) {
    try {
      await deps.ensureGemmaMtpDraft(modelId)
      mtpDraftRel = (await deps.readModelYml(modelId)).mtp_draft_path
    } catch (e) {
      warn(`Failed to ensure Gemma MTP draft head for ${modelId}; loading without MTP: ${formatLoadError(e)}`)
    }
  }
  cfg.mtp_draft_path = cfg.mtp && mtpDraftRel ? deps.joinData(mtpDraftRel) : ''
  if (cfg.mtp) {
    const meta = await deps.readGgufMetadata(modelPath).catch((e: unknown) => {
      warn(
        `Embedded MTP metadata probe failed for "${modelId}"; loading without built-in MTP: ${formatLoadError(e)}`
      )
      return undefined
    })
    if (!isMtpCapable(meta, cfg.mtp_draft_path)) {
      warn(`MTP is enabled but model "${modelId}" has no MTP layers and no draft head; loading without MTP.`)
      cfg.mtp = false
    }
  }

  // 14. DFlash binary probe
  cfg.dflash_spec_supported = cfg.dflash ? await deps.backendSupportsDflashSpec(exePath, env) : false
  if (cfg.dflash && !cfg.dflash_spec_supported) {
    warn(
      `DFlash is enabled but this Llama.cpp backend does not support draft-dflash; loading "${modelId}" without DFlash.`
    )
    cfg.dflash = false
  }

  // 15. DFlash draft
  let dflashDraftRel = modelConfig.dflash_draft_path
  if (cfg.dflash && !dflashDraftRel && deps.checkDflashSupport(modelId)) {
    try {
      await deps.ensureDflashDraft(modelId)
      dflashDraftRel = (await deps.readModelYml(modelId)).dflash_draft_path
    } catch (e) {
      warn(`Failed to ensure DFlash draft for ${modelId}; loading without DFlash: ${formatLoadError(e)}`)
    }
  }
  cfg.dflash_draft_path = cfg.dflash && dflashDraftRel ? deps.joinData(dflashDraftRel) : ''
  if (cfg.dflash && cfg.dflash_draft_path.length === 0) {
    warn(`DFlash is enabled but model "${modelId}" has no resolvable draft; loading without DFlash.`)
    cfg.dflash = false
  }

  // 16. dflash_n_max
  if (cfg.dflash) {
    const blockSize = Number(input.engine.dflash_block_size)
    cfg.dflash_n_max =
      Number.isFinite(blockSize) && blockSize > 1 ? Math.max(Math.floor(blockSize) - 1, 1) : 0
  } else cfg.dflash_n_max = 0

  // 17. mutual exclusion — DFlash wins
  if (cfg.dflash && cfg.mtp) {
    warn(`Both MTP and DFlash are enabled for "${modelId}"; applying DFlash only.`)
    cfg.mtp = false
    cfg.mtp_draft_path = ''
  }

  // 18. ctx clamp to the trained context
  const maxCtxTrain = await resolveModelMaxCtxTrain(modelPath, deps, warn)
  const clamped = effectiveCtxSize(cfg.ctx_size, maxCtxTrain)
  if (clamped !== undefined && clamped !== cfg.ctx_size) {
    warn(`Requested ctx_size ${cfg.ctx_size} exceeds the model's trained context; clamping to ${clamped}.`)
    cfg.ctx_size = clamped
  }

  // 19. legacy stringly `fit`
  if (typeof (cfg as { fit: unknown }).fit === 'string') cfg.fit = true

  return {
    provider: input.provider,
    modelId,
    version,
    backend,
    exePath,
    config: cfg,
    port,
    apiKey,
    env,
    modelPath,
    mmprojPath,
    isEmbedding: input.isEmbedding,
    timeoutSecs,
    maxCtxTrain,
    warnings,
  }
}

export type RetryPlan =
  | { kind: 'text-only'; plan: LoadPlan; notify: 'multimodal-disabled' }
  | { kind: 'without-mtp'; plan: LoadPlan }

/**
 * Steps 21-22: after a failed spawn, decide whether to retry once. A retried plan is never
 * retried again for the same reason (the caller passes the plan it just tried).
 */
export function nextRetry(
  error: unknown,
  plan: LoadPlan,
  transcriptionModelId?: string
): RetryPlan | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  if (
    plan.mmprojPath &&
    code === 'MULTIMODAL_PROJECTOR_LOAD_FAILED' &&
    plan.modelId !== transcriptionModelId
  ) {
    return { kind: 'text-only', plan: { ...plan, mmprojPath: undefined }, notify: 'multimodal-disabled' }
  }
  if (plan.config.mtp && matchesMtpLoadFailure(formatLoadError(error))) {
    return {
      kind: 'without-mtp',
      plan: { ...plan, config: { ...plan.config, mtp: false, mtp_draft_path: '' } },
    }
  }
  return undefined
}

async function resolveShardedModelPath(
  modelPath: string,
  deps: LoadPlanDeps,
  warn: (m: string) => void
): Promise<string> {
  const shard = parseGgufShard(modelPath)
  if (!shard) return modelPath
  const set = ggufShardSetPaths(modelPath)
  const missing: string[] = []
  for (const p of set) if (!(await deps.exists(p))) missing.push(p)
  if (missing.length) {
    throw codedLoadError(
      'MODEL_SHARDS_INCOMPLETE',
      `This model is split into ${shard.total} parts and ${missing.length} of them are missing on disk. Re-download the model to get the complete set.`
    )
  }
  const first = firstGgufShardPath(modelPath)
  if (first !== modelPath)
    warn(
      `Model is shard ${shard.index}/${shard.total}; loading the first shard so llama.cpp can assemble the set.`
    )
  return first
}

async function assertCompleteGguf(
  filePath: string,
  expectedSize: number | undefined,
  deps: LoadPlanDeps
): Promise<void> {
  const size = await deps.fileSize(filePath).catch(() => undefined)
  if (size === undefined) {
    throw codedLoadError(
      'MODEL_FILE_NOT_FOUND',
      `The specified model file does not exist or is not accessible: ${filePath}`
    )
  }
  if (typeof expectedSize === 'number' && expectedSize > 0 && size < expectedSize) {
    throw codedLoadError(
      'MODEL_FILE_CORRUPT',
      `The model file is incomplete (${size} of ${expectedSize} bytes), likely from an interrupted download: ${filePath}`
    )
  }
}

/** `{arch}.context_length` from the GGUF, or `undefined` (with a warning) when unreadable. */
export async function resolveModelMaxCtxTrain(
  modelPath: string,
  deps: Pick<LoadPlanDeps, 'readGgufMetadata'>,
  warn: (m: string) => void = () => {}
): Promise<number | undefined> {
  try {
    const meta = await deps.readGgufMetadata(modelPath)
    const arch = meta?.['general.architecture']
    if (typeof arch !== 'string' || !arch) return undefined
    const raw = meta?.[`${arch}.context_length`]
    const parsed = raw == null ? NaN : parseInt(String(raw), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  } catch (e) {
    warn(`Failed to resolve max ctx_train from GGUF at ${modelPath}: ${formatLoadError(e)}`)
    return undefined
  }
}
