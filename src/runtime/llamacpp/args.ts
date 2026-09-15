/**
 * llama-server argv builder. Port of
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs` (ArgumentBuilder).
 *
 * Pure: takes a full `LlamacppConfig` and load inputs, returns argv + warnings. Emission order and
 * every gate are pinned by `test/contract/args.test.ts` against fixtures emitted from the Rust
 * implementation (comparator `argv-exact`).
 *
 * Provider dependence (PLAN.md §8.2 "Divergences"): only the cache-type whitelist differs —
 * `llamacpp-upstream` never emits fork-only `turbo*` types, `llamacpp` (TurboQuant) allows them when
 * the installed version is a fork tag. Everything else is shared.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { LlamacppConfig, LocalProviderId } from '../../contracts/index.js'
import { f32Differs, formatRustF32 } from '../../util/index.js'

export { f32Differs, formatRustF32 }

/** Minimum llama.cpp build that turned `--flash-attn` into a string argument (auto|on|off). */
export const FLASH_ATTN_STRING_ARG_MIN_BUILD = 6325
/** First upstream release containing Qwen built-in MTP (`--spec-type draft-mtp`). */
export const MTP_MIN_BUILD = 9180
/** First upstream release containing the Gemma 4 separate-draft MTP merge. */
export const GEMMA_MTP_MIN_BUILD = 9553
/** First upstream release containing `--reasoning-preserve`. */
export const REASONING_PRESERVE_MIN_BUILD = 9837
/** First upstream release where reasoning preservation is on by default (silence means "on"). */
export const REASONING_PRESERVE_DEFAULT_ON_MIN_BUILD = 10762

/** Cache types supported by stock ggml-org builds. */
export const STANDARD_CACHE_TYPES: readonly string[] = [
  'f32',
  'f16',
  'bf16',
  'q8_0',
  'q4_0',
  'q4_1',
  'iq4_nl',
  'q5_0',
  'q5_1',
]

/** Fields with `#[serde(default)]` in Rust; every other `LlamacppConfig` field is required. */
/**
 * Fields Rust deserialisation fills in when the app leaves them out. The two string fields are not
 * engine settings — the extension carries them per model — so a core that loads a model the app has
 * never configured must supply `String::default()` itself, or the builder emits a flag with no value.
 */
export const LLAMACPP_CONFIG_SERDE_DEFAULTS = {
  chat_template: '',
  override_tensor_buffer_t: '',
  parallel: 1,
  concurrent_mode: false,
  concurrent_slots: 8,
  expose_metrics: false,
  mtp: false,
  mtp_draft_path: '',
  dflash: false,
  dflash_spec_supported: false,
  dflash_draft_path: '',
  dflash_n_max: 0,
  reasoning_preserve: false,
  extra_args: '',
} as const satisfies Partial<LlamacppConfig>

export type LlamacppConfigInput = Omit<LlamacppConfig, keyof typeof LLAMACPP_CONFIG_SERDE_DEFAULTS> &
  Partial<Pick<LlamacppConfig, keyof typeof LLAMACPP_CONFIG_SERDE_DEFAULTS>>

/**
 * Fill the serde-default fields the way Rust deserialisation would. A key present with the value
 * `undefined` counts as absent — in JSON it would simply not be there, and letting it through would
 * overwrite a default with nothing.
 */
export function withLlamacppDefaults(input: LlamacppConfigInput): LlamacppConfig {
  const provided = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))
  return { ...LLAMACPP_CONFIG_SERDE_DEFAULTS, ...provided } as LlamacppConfig
}

export interface LlamaArgsInput {
  provider: LocalProviderId
  isEmbedding: boolean
  modelId: string
  modelPath: string
  port: number
  mmprojPath?: string | null
}

export interface LlamaArgsPlan {
  argv: string[]
  /** Human-readable notes the Rust builder would have logged (skipped gates, sanitised values). */
  warnings: string[]
  version: string
  backend: string
}

/** `"<version>/<backend>"` → parts. BOM stripped, both sides trimmed. Throws on a missing `/`. */
export function parseVersionBackend(versionBackend: string): { version: string; backend: string } {
  const cleaned = versionBackend.replaceAll('﻿', '')
  const slash = cleaned.indexOf('/')
  if (slash < 0) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Invalid configuration argument provided.',
      'Invalid version_backend format'
    )
  }
  return { version: cleaned.slice(0, slash).trim(), backend: cleaned.slice(slash + 1).trim() }
}

/** `"b6325"` → 6325, `"b10018-1.3.0"` → 10018, `"v1.0"` → undefined. */
export function parseBuildNumber(version: string): number | undefined {
  if (!version.startsWith('b')) return undefined
  const build = version.slice(1).split('-')[0] ?? ''
  if (!/^\d+$/.test(build)) return undefined
  const n = Number(build)
  return n <= 0xffff_ffff ? n : undefined
}

/** TurboQuant release train: `turboquant-*` or the unified `b<build>-<x>.<y>.<z>` tag. */
export function isTurboquantVersion(version: string): boolean {
  if (version.startsWith('turboquant-')) return true
  if (!version.startsWith('b')) return false
  const rest = version.slice(1)
  const dash = rest.indexOf('-')
  if (dash < 0) return false
  const build = rest.slice(0, dash)
  const semver = rest.slice(dash + 1)
  const isNumber = (s: string) => /^\d+$/.test(s)
  if (!isNumber(build)) return false
  const parts = semver.split('.')
  return parts.length === 3 && parts.every(isNumber)
}

/**
 * POSIX-ish splitter for user-supplied extra arguments. Quotes group; backslash escapes the active
 * quote or a backslash inside quotes, and whitespace/quotes/backslash outside. An unterminated quote
 * is an error (the caller drops the whole string).
 */
export function parseExtraArgs(value: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false
  const chars = Array.from(value)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    const next = chars[i + 1]
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && (next === quote || next === '\\')) {
        current += next
        i++
      } else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (
      ch === '\\' &&
      next !== undefined &&
      (/\s/.test(next) || next === "'" || next === '"' || next === '\\')
    ) {
      current += next
      i++
      started = true
    } else if (/\s/.test(ch)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += ch
      started = true
    }
  }
  if (quote !== null) throw new Error(`unterminated ${quote} quote`)
  if (started) args.push(current)
  return args
}

/** Build the plan (argv + warnings). Throws `INVALID_ARGUMENT` for a malformed `version_backend`. */
export function planLlamaArgs(config: LlamacppConfig, input: LlamaArgsInput): LlamaArgsPlan {
  const { version, backend } = parseVersionBackend(config.version_backend)
  const cfg: LlamacppConfig = { ...config }
  const argv: string[] = []
  const warnings: string[] = []
  const build = parseBuildNumber(version)
  const turboquant = isTurboquantVersion(version)
  const ik = backend.startsWith('ik')
  const push = (...items: string[]) => argv.push(...items)

  // Pre-pass: concurrent mode, then Vulkan safety override.
  if (cfg.concurrent_mode) {
    cfg.parallel = Math.max(cfg.concurrent_slots, 2)
    cfg.cont_batching = true
    cfg.expose_metrics = true
  }
  if (backend.includes('vulkan') && cfg.flash_attn === 'auto') {
    warnings.push(`Vulkan backend (${backend}): overriding flash_attn auto→off for stability (ATO-244)`)
    cfg.flash_attn = 'off'
  }

  const sanitizeCacheType = (value: string): string => {
    if (STANDARD_CACHE_TYPES.includes(value)) return value
    if (input.provider === 'llamacpp' && turboquant) return value
    warnings.push(
      `Cache type '${value}' is not supported by non-turboquant backend ${version}/${backend}; falling back to q8_0`
    )
    return 'q8_0'
  }

  if (!ik) push('--no-webui')
  push('--jinja')
  push('-m', input.modelPath)

  if (cfg.cpu_moe) push('--cpu-moe')
  if (cfg.n_cpu_moe > 0) push('--n-cpu-moe', String(cfg.n_cpu_moe))
  if (cfg.override_tensor_buffer_t) push('--override-tensor', cfg.override_tensor_buffer_t)

  if (input.mmprojPath) {
    push('--mmproj', input.mmprojPath)
    if (!cfg.offload_mmproj) push('--no-mmproj-offload')
  }

  push('-a', input.modelId)
  push('--port', String(input.port))

  if (cfg.chat_template) push('--chat-template', cfg.chat_template)

  const ngl = cfg.n_gpu_layers >= 0 && cfg.n_gpu_layers !== 100 ? cfg.n_gpu_layers : -1
  push('-ngl', String(ngl))

  if (cfg.threads > 0) push('--threads', String(cfg.threads))
  if (cfg.threads_batch > 0) push('--threads-batch', String(cfg.threads_batch))

  if (cfg.batch_size > 0 && cfg.batch_size !== 2048) push('--batch-size', String(cfg.batch_size))
  if (cfg.ubatch_size > 0 && cfg.ubatch_size !== 512) push('--ubatch-size', String(cfg.ubatch_size))

  if (cfg.device !== '') push('--device', cfg.device)
  if (cfg.split_mode !== '' && cfg.split_mode !== 'layer') push('--split-mode', cfg.split_mode)
  if (cfg.main_gpu !== 0) push('--main-gpu', String(cfg.main_gpu))

  // Flash attention.
  if (ik) {
    if (cfg.flash_attn === 'on') push('-fa')
  } else {
    const stringArg = turboquant || (build !== undefined && build >= FLASH_ATTN_STRING_ARG_MIN_BUILD)
    if (stringArg) {
      if (cfg.flash_attn === 'auto' || cfg.flash_attn === 'on' || cfg.flash_attn === 'off') {
        push('--flash-attn', cfg.flash_attn)
      }
    } else if (cfg.flash_attn === 'on') {
      push('--flash-attn')
    }
  }

  if (cfg.ctx_shift) push('--context-shift')
  if (cfg.cont_batching) push('--cont-batching')
  if (cfg.no_mmap) push('--no-mmap')
  if (cfg.mlock) push('--mlock')
  if (cfg.no_kv_offload) push('--no-kv-offload')

  if (cfg.parallel > 0) {
    push('--parallel', String(cfg.parallel))
    if (cfg.parallel === 1) push('-kvu') // ggml-org/llama.cpp#17450
  }

  // Speculative decoding: DFlash wins when both are set.
  const addMtp = () => {
    if (!cfg.mtp || input.isEmbedding) return
    if (cfg.mtp_draft_path !== '') {
      if (!(build !== undefined && build >= GEMMA_MTP_MIN_BUILD)) {
        warnings.push(
          `Gemma 4 MTP requested but backend build ${version}/${backend} predates the Gemma MTP merge (b${GEMMA_MTP_MIN_BUILD}); skipping`
        )
        return
      }
      const k = cfg.cache_type_k
      const v = cfg.cache_type_v
      if ((k !== '' && k !== 'f16') || (v !== '' && v !== 'f16')) {
        warnings.push(
          `Gemma 4 MTP is enabled with quantized KV cache (k=${k || 'f16'}, v=${v || 'f16'}); draft acceptance may drop`
        )
      }
      push('--model-draft', cfg.mtp_draft_path, '--spec-type', 'draft-mtp', '--spec-draft-n-max', '4')
      return
    }
    if (!(build !== undefined && build >= MTP_MIN_BUILD)) {
      warnings.push(
        `MTP requested but backend build ${version}/${backend} predates upstream MTP merge (b${MTP_MIN_BUILD}); skipping`
      )
      return
    }
    push('--spec-type', 'draft-mtp', '--spec-draft-n-max', '2')
  }
  const addDflash = () => {
    if (!cfg.dflash || input.isEmbedding) return
    if (cfg.dflash_draft_path === '') {
      warnings.push('DFlash requested but no draft GGUF path is set; skipping')
      return
    }
    if (!cfg.dflash_spec_supported) {
      warnings.push(
        `DFlash requested for backend ${version}/${backend} but this llama.cpp build does not advertise --spec-type draft-dflash; loading without DFlash`
      )
      return
    }
    push(
      '--model-draft',
      cfg.dflash_draft_path,
      '--spec-type',
      'draft-dflash',
      '--spec-draft-n-max',
      String(cfg.dflash_n_max > 0 ? cfg.dflash_n_max : 15)
    )
  }
  if (cfg.dflash && cfg.mtp) {
    warnings.push('Both MTP and DFlash are enabled; applying DFlash only')
    addDflash()
  } else {
    addMtp()
    addDflash()
  }

  if (cfg.expose_metrics) push('--metrics')

  // Reasoning preservation.
  if (!input.isEmbedding) {
    if (!cfg.reasoning_preserve) {
      if (build !== undefined && build >= REASONING_PRESERVE_DEFAULT_ON_MIN_BUILD)
        push('--no-reasoning-preserve')
    } else if (build !== undefined && build >= REASONING_PRESERVE_MIN_BUILD) {
      push('--reasoning-preserve')
    } else {
      warnings.push(
        `Reasoning preservation requested but backend build ${version}/${backend} predates upstream support (b${REASONING_PRESERVE_MIN_BUILD}); skipping`
      )
    }
  }

  if (input.isEmbedding) {
    push('--embedding', '--pooling', 'mean')
  } else {
    if (cfg.ctx_size > 0 && !cfg.fit) push('--ctx-size', String(cfg.ctx_size))
    if (cfg.n_predict > 0) push('--n-predict', String(cfg.n_predict))
    if (cfg.cache_type_k !== '' && cfg.cache_type_k !== 'f16') {
      const safeK = sanitizeCacheType(cfg.cache_type_k)
      if (safeK !== 'f16') push('--cache-type-k', safeK)
    }
    if (
      cfg.flash_attn !== 'off' &&
      cfg.cache_type_v !== '' &&
      cfg.cache_type_v !== 'f16' &&
      cfg.cache_type_v !== 'f32'
    ) {
      const safeV = sanitizeCacheType(cfg.cache_type_v)
      if (safeV !== 'f16' && safeV !== 'f32') push('--cache-type-v', safeV)
    }
    if (f32Differs(cfg.defrag_thold, 0.1)) push('--defrag-thold', formatRustF32(cfg.defrag_thold))
    if (cfg.rope_scaling !== '' && cfg.rope_scaling !== 'none') push('--rope-scaling', cfg.rope_scaling)
    if (f32Differs(cfg.rope_scale, 1.0)) push('--rope-scale', formatRustF32(cfg.rope_scale))
    if (Math.fround(cfg.rope_freq_base) !== 0) push('--rope-freq-base', formatRustF32(cfg.rope_freq_base))
    if (f32Differs(cfg.rope_freq_scale, 1.0)) push('--rope-freq-scale', formatRustF32(cfg.rope_freq_scale))
  }

  if (!ik) {
    push('--fit', cfg.fit ? 'on' : 'off')
    if (cfg.fit) {
      if (cfg.fit_ctx !== '' && cfg.fit_ctx !== '4096') push('--fit-ctx', cfg.fit_ctx)
      if (cfg.fit_target !== '' && cfg.fit_target !== '1024') push('--fit-target', cfg.fit_target)
    }
  }

  try {
    push(...parseExtraArgs(cfg.extra_args))
  } catch (error) {
    warnings.push(`Ignoring invalid extra llama-server arguments: ${(error as Error).message}`)
  }

  // A config field that arrives as null/undefined would otherwise reach the process as the string
  // "null"; Rust's types made that impossible, so the port checks it explicitly.
  const bad = argv.findIndex((a) => typeof a !== 'string')
  if (bad >= 0) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Invalid configuration argument provided.',
      `argument ${bad} after "${argv[bad - 1] ?? ''}" is ${String(argv[bad])}`
    )
  }

  return { argv, warnings, version, backend }
}

/** Convenience: argv only. */
export function buildLlamaArgs(config: LlamacppConfig, input: LlamaArgsInput): string[] {
  return planLlamaArgs(config, input).argv
}
