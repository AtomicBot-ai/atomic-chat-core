/**
 * The load plan: everything `performLoad()` in `extensions/llamacpp-upstream-extension/src/index.ts`
 * (lines 4735-5249) decides before it hands a config to the process spawner, as a pure orchestration
 * over injected facts. The 23 steps (PLAN.md §8.1) are numbered in comments.
 *
 * Owns: settings merge, `latest/` sentinel resolution, flash-attn clamp for old builds, AVX preflight,
 * model.yml → paths (first shard, mmproj), artifact validation, Llama 3 template override, MTP/DFlash
 * draft resolution and capability gates, `dflash_n_max`, mutual exclusion, ctx clamp, env, port and
 * API key; beyond the extension, the default window with fit off, the answer cap (`n_predict` 0 is
 * automatic) and the host prompt cache on a small machine. Does NOT spawn; `nextRetry()` encodes the
 * two post-failure retries.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { DeviceInfo, LlamacppConfig, LocalProviderId } from '../../contracts/index.js'
import type { ModelYmlDocument } from '../../models/index.js'
import {
  effectiveCtxSize,
  estimateKvCache,
  firstGgufShardPath,
  ggufShardSetPaths,
  isMtpCapable,
  matchesMtpLoadFailure,
  parseGgufShard,
} from '../../models/index.js'
import { generateApiKey } from '../shared/index.js'
import type { GpuCards } from '../shared/index.js'
import { resolveFitCtx, withLlamacppDefaults } from './args.js'
import type { LlamacppConfigInput } from './args.js'
import { DEFAULT_CTX_LEN } from './ctx-ladder.js'
import { validateDeviceList } from './devices.js'
import {
  DEFAULT_FIT_CTX,
  DEFAULT_FIT_TARGET_MIB,
  metalDevice,
  smallMemoryDefaultCtx,
  smallUnifiedMemoryCtxCeiling,
  unifiedMemoryFitTargetMiB,
} from './fit-margin.js'
import { promptCacheRamMiB, resolveNPredict } from './generation-limits.js'
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
  /**
   * RAM the GPU shares with the system — Apple silicon only. `undefined` elsewhere: a discrete
   * GPU's own memory is llama.cpp's to fill, and fit keeps its default margin there.
   */
  unifiedMemory?: () => Promise<{ totalMemoryBytes: number } | undefined>
  /**
   * The machine's physical RAM on any platform, for the host prompt cache (`--cache-ram`); absent or
   * `undefined`, llama.cpp keeps its own cache size.
   */
  systemMemory?: () => Promise<{ totalMemoryBytes: number } | undefined>
  /** `<exe> --list-devices`: what fit will measure as free on each device. */
  listDevices?: (exePath: string) => Promise<DeviceInfo[]>
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
  /**
   * Under fit on a unified-memory Mac below 16 GiB: the window the core caps llama.cpp at, in tokens
   * of the one KV pool every slot shares (`--ctx-size` with `-kvu`; fit still places the layers).
   * Absent: llama.cpp picks the window.
   */
  fitCtxCeiling?: number
  /** `--cache-ram` (MiB) on a machine with at most 16 GiB of RAM; absent: llama.cpp's 8192 MiB. */
  cacheRamMiB?: number
  /**
   * Set by the runtime on the plan of a backend fallback: the `version_backend` the settings asked for,
   * which `config.version_backend` (the build that runs) no longer is.
   */
  configuredVersionBackend?: string
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

/** A GPU API in the backend's id: CUDA, Vulkan, ROCm/HIP, SYCL, Metal, OpenCL, MUSA, CANN. */
const GPU_BACKEND = /cuda|vulkan|rocm|hip|sycl|metal|opencl|musa|cann/i
/** What only a CPU build says: `-cpu`, an instruction-set tier, or a bare `<os>-<arch>` build. */
const CPU_BACKEND =
  /(^|-)cpu(-|$)|(^|-)(no)?avx(2|512)?(-|$)|common_cpus|^(linux|win)-(x64|x86_64|arm64|aarch64)$/i

/**
 * Which GPUs a llama.cpp session holds, for core's residency rule (spec `gpu-residency`, design D10):
 * a GPU build spreads the model over every card, so it holds all of them; only a build whose id says
 * it is CPU-only holds none. macOS builds use Metal. Anything else — an executable the CLI was
 * pointed at — is treated as holding the GPUs: calling a GPU session CPU-only would let a second
 * engine onto a card that is not free. Embeddings and the transcription companion are auxiliary,
 * with the same exemption `autoUnloadTargets` gives them.
 */
export function llamaGpuFootprint(
  plan: Pick<LoadPlan, 'backend' | 'isEmbedding' | 'modelId'>,
  transcriptionModelId?: string
): { cards: GpuCards; auxiliary: boolean } {
  const backend = stripBom(plan.backend)
  const cpuOnly = !GPU_BACKEND.test(backend) && !backend.startsWith('macos-') && CPU_BACKEND.test(backend)
  return {
    cards: cpuOnly ? [] : 'all',
    auxiliary: plan.isEmbedding || plan.modelId === transcriptionModelId,
  }
}

/**
 * The same plan on another port. The session key is derived from the port, so it moves with it.
 * For a start whose port was taken between `randomFreePort`'s probe and the engine's own bind.
 */
export function withPort(plan: LoadPlan, port: number, apiSecret?: string): LoadPlan {
  const apiKey = generateApiKey(plan.modelId, port, apiSecret)
  return { ...plan, port, apiKey, env: { ...plan.env, LLAMA_API_KEY: apiKey } }
}

export async function planLlamaLoad(input: LoadPlanInput, deps: LoadPlanDeps): Promise<LoadPlan> {
  const warnings: string[] = []
  const warn = (m: string) => {
    warnings.push(m)
    deps.warn?.(m)
  }
  const { modelId } = input

  // 2. settings merge (per-model overrides win; a model's `fit_ctx` only when it names a window)
  const cfg = withLlamacppDefaults({ ...input.config, ...(input.overrides ?? {}) } as LlamacppConfigInput)
  cfg.fit_ctx = resolveFitCtx(input.config.fit_ctx, input.overrides?.fit_ctx)
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
  // One `--list-devices` per executable and plan: the device check below and fit's Metal margin
  // read the same list.
  if (deps.listDevices) {
    const listDevices = deps.listDevices
    const lists = new Map<string, Promise<DeviceInfo[]>>()
    deps = {
      ...deps,
      listDevices: (path) => {
        const listed = lists.get(path) ?? listDevices(path)
        lists.set(path, listed)
        return listed
      },
    }
  }

  // 7b. a `--device` this build does not have would make llama-server exit; it is dropped instead.
  // A device list that cannot be read changes nothing.
  if (String(cfg.device ?? '').trim() !== '' && deps.listDevices) {
    const devices = await deps.listDevices(exePath).catch(() => undefined)
    if (devices) {
      const checked = validateDeviceList(cfg.device, devices)
      if (checked.dropped.length > 0) {
        const listedIds = devices.map((d) => d.id).join(', ') || 'none'
        warn(
          `Ignoring device ${checked.dropped.join(', ')} for "${modelId}": ${version}/${backend} does not have it (it lists ${listedIds}).`
        )
        cfg.device = checked.device
      }
    }
  }

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

  // TurboQuant has no speculative decoding: a value imported from an upstream copy of the settings
  // must not make its load look for, or download, a draft model.
  if (input.provider === 'llamacpp') {
    cfg.mtp = false
    cfg.dflash = false
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

  // 19b. fit margin on unified memory, and the window ceiling below 16 GiB (a margin the user set stands)
  let fitCtxCeiling: number | undefined
  if (cfg.fit && !input.isEmbedding && isDefaultFitTarget(cfg.fit_target)) {
    const fit = await unifiedMemoryFit(exePath, modelPath, cfg, maxCtxTrain, deps)
    if (fit?.marginMiB !== undefined) {
      cfg.fit_target = String(fit.marginMiB)
      warn(
        `Unified memory: fitting "${modelId}" with a ${fit.marginMiB} MiB margin so llama.cpp leaves half of RAM to the system.`
      )
    }
    if (fit?.ctxCeiling !== undefined) {
      // Never below the floor fit is given (`fit_ctx`, which the app raises to grow the window).
      fitCtxCeiling = Math.max(fit.ctxCeiling, fitMinCtx(cfg))
      warn(
        `Unified memory below 16 GiB: capping the window fit may pick for "${modelId}" at ${fitCtxCeiling} tokens.`
      )
    }
  }

  // 19c. fit off with no window chosen: llama.cpp would take the whole trained context (`n_ctx = 0`,
  // `common/common.h:459`) — 256K on a current coder model. Core picks DEFAULT_CTX_LEN instead, the
  // trained context when smaller, narrowed on a small unified-memory Mac like fit's ceiling.
  if (!cfg.fit && !input.isEmbedding && !(cfg.ctx_size > 0)) {
    cfg.ctx_size = await defaultFitOffCtx(modelPath, cfg, maxCtxTrain, deps)
    warn(`No context size is set with fit off; loading "${modelId}" with ${cfg.ctx_size} tokens.`)
  }

  // 19d. the answer cap: `n_predict` 0 is automatic, never above the window core knows the load runs
  // with (fit off: the window; fit on: the ceiling, else at most the trained context).
  if (!input.isEmbedding) {
    const window = !cfg.fit ? cfg.ctx_size : (fitCtxCeiling ?? maxCtxTrain)
    cfg.n_predict = resolveNPredict(cfg.n_predict, window)
  }

  // 19e. the host prompt cache on a machine with at most 16 GiB of RAM (generation-limits.ts).
  const cacheRamMiB = input.isEmbedding
    ? undefined
    : promptCacheRamMiB((await deps.systemMemory?.().catch(() => undefined))?.totalMemoryBytes)

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
    ...(fitCtxCeiling !== undefined ? { fitCtxCeiling } : {}),
    ...(cacheRamMiB !== undefined ? { cacheRamMiB } : {}),
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

/**
 * Fit on a unified-memory Mac: the widened `--fit-target` (`undefined` keeps llama.cpp's default) and,
 * below 16 GiB of RAM, the window ceiling in tokens of the KV pool the slots share. `undefined`
 * altogether off Apple silicon, on a device the user pinned elsewhere, or when the backend lists no
 * Metal device.
 */
async function unifiedMemoryFit(
  exePath: string,
  modelPath: string,
  cfg: LlamacppConfig,
  maxCtxTrain: number | undefined,
  deps: LoadPlanDeps
): Promise<{ marginMiB: number | undefined; ctxCeiling: number | undefined } | undefined> {
  if (!deps.unifiedMemory || !deps.listDevices) return undefined
  const memory = await deps.unifiedMemory().catch(() => undefined)
  if (!memory) return undefined
  const gpu = metalDevice(await deps.listDevices(exePath).catch(() => []))
  if (!gpu || (cfg.device !== '' && cfg.device !== gpu.id)) return undefined
  const gpuFreeBytes = gpu.free * 2 ** 20
  const weightsBytes = await gpuWeightsBytes(modelPath, cfg, deps)
  const minCtx = fitMinCtx(cfg)
  const kvBytesAt = await kvCacheEstimator(modelPath, cfg, deps)
  const marginMiB = unifiedMemoryFitTargetMiB({
    totalMemoryBytes: memory.totalMemoryBytes,
    gpuFreeBytes,
    weightsBytes,
    minContextKvBytes: kvBytesAt(minCtx) ?? 0,
  })
  // The ceiling is the pool itself: under `-kvu` every slot draws from one cache of `n_ctx` cells
  // (`src/llama-context.cpp:389-390`: `n_ctx_seq = n_ctx`), so it is not multiplied by the slots.
  const ctxCeiling = smallUnifiedMemoryCtxCeiling({
    totalMemoryBytes: memory.totalMemoryBytes,
    budgetBytes: gpuFreeBytes - (marginMiB ?? DEFAULT_FIT_TARGET_MIB) * 2 ** 20,
    weightsBytes,
    trainedCtx: maxCtxTrain,
    minCtx,
    kvBytesAt,
  })
  return { marginMiB, ctxCeiling }
}

/**
 * The window a fit-off load without one gets: DEFAULT_CTX_LEN, or the trained context when smaller;
 * on a unified-memory Mac below 16 GiB narrowed toward the previous 16K default until the weights
 * and the KV cache fit half of RAM (`smallMemoryDefaultCtx`).
 */
async function defaultFitOffCtx(
  modelPath: string,
  cfg: LlamacppConfig,
  maxCtxTrain: number | undefined,
  deps: LoadPlanDeps
): Promise<number> {
  const ctx =
    maxCtxTrain !== undefined && maxCtxTrain > 0 ? Math.min(maxCtxTrain, DEFAULT_CTX_LEN) : DEFAULT_CTX_LEN
  const memory = await deps.unifiedMemory?.().catch(() => undefined)
  if (!memory) return ctx
  return (
    smallMemoryDefaultCtx({
      totalMemoryBytes: memory.totalMemoryBytes,
      weightsBytes: await gpuWeightsBytes(modelPath, cfg, deps),
      defaultCtx: ctx,
      kvBytesAt: await kvCacheEstimator(modelPath, cfg, deps),
    }) ?? ctx
  )
}

/** No margin of the user's own: the key is empty or holds llama.cpp's default. */
function isDefaultFitTarget(value: string): boolean {
  const text = String(value).trim()
  return text === '' || text === String(DEFAULT_FIT_TARGET_MIB)
}

/** Every shard of the model plus any draft model: what fit measures as weights on the GPU. */
async function gpuWeightsBytes(modelPath: string, cfg: LlamacppConfig, deps: LoadPlanDeps): Promise<number> {
  const files = parseGgufShard(modelPath) ? ggufShardSetPaths(modelPath) : [modelPath]
  if (cfg.mtp_draft_path) files.push(cfg.mtp_draft_path)
  if (cfg.dflash_draft_path) files.push(cfg.dflash_draft_path)
  let total = 0
  for (const file of files) total += (await deps.fileSize(file).catch(() => undefined)) ?? 0
  return total
}

/**
 * The sequences llama.cpp sizes the cache for: concurrent mode's slots, else `--parallel` (0 leaves
 * it to llama.cpp, whose auto is 4 slots, `tools/server/server.cpp:126-130`). With one unified pool
 * they no longer multiply the cache; only each sliding-window layer keeps a window per sequence.
 */
function fitSlots(cfg: LlamacppConfig): number {
  if (cfg.concurrent_mode) return Math.max(cfg.concurrent_slots, 2)
  return cfg.parallel > 0 ? cfg.parallel : 4
}

/** `--fit-ctx`, the smallest window fit may settle on, or llama.cpp's default. */
function fitMinCtx(cfg: LlamacppConfig): number {
  const fitCtx = parseInt(String(cfg.fit_ctx).trim(), 10)
  return Number.isFinite(fitCtx) && fitCtx > 0 ? fitCtx : DEFAULT_FIT_CTX
}

/**
 * The unified KV cache at a pool of `ctx` cells, every slot included (`-kvu` is always sent, see
 * args.ts); `undefined` when the GGUF cannot tell.
 */
async function kvCacheEstimator(
  modelPath: string,
  cfg: LlamacppConfig,
  deps: LoadPlanDeps
): Promise<(ctx: number) => number | undefined> {
  const layout = { nSeq: fitSlots(cfg), ...(cfg.ubatch_size > 0 ? { nUbatch: cfg.ubatch_size } : {}) }
  let meta: Record<string, string> | undefined
  try {
    meta = await deps.readGgufMetadata(modelPath)
  } catch {
    meta = undefined
  }
  return (ctx) => {
    if (!meta) return undefined
    try {
      return estimateKvCache(meta, ctx, cfg.cache_type_k, cfg.cache_type_v, layout).size
    } catch {
      return undefined
    }
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
