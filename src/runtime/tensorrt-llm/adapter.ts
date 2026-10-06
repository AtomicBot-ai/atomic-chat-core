/**
 * The `tensorrt-llm` `ManagedTextAdapter` (task 2.13, spec `tensorrt-llm-runtime`, design D8/D9):
 * settings validation, the `trtllm-serve` argv, readiness, log stage markers, the readiness
 * timeout, exit classification (OOM etc.), declared capabilities and routes, request-body
 * rewriting for the output-length setting, and the context-length-overflow error mapping. Plugs
 * into the engine-neutral load lifecycle (task 2.12, `../managed-text/`) through
 * `ManagedTextAdapter`; nothing here does I/O.
 *
 * Fix round 1 (`findings-2.13-r1.md`): the first pass sourced its CLI/error evidence from a mix of
 * the pytorch and legacy `tensorrt` backends without checking which one this descriptor actually
 * launches (`serve.py`'s `--backend` defaults to `pytorch`, and nothing here ever passes
 * `--backend`), and got `--max_num_tokens`'s meaning on that backend wrong.
 *
 * Fix round 2 (`findings-2.13-r2.md`): round 1's own ruling for enforcing the output-length setting
 * — write both `max_tokens` and `max_completion_tokens` on `/v1/chat/completions` — was itself
 * wrong: TRT-LLM 1.2.1's `ChatCompletionRequest` (`openai_protocol.py`, `extra="forbid"`) has a
 * *single* Python field, `max_completion_tokens`, whose `validation_alias` is `max_tokens`, so a
 * body carrying both as separate top-level keys makes pydantic reject the whole request with `400
 * extra_forbidden` — every chat request `tensorrtLlmRewriteRequestBody` touched would have failed.
 * The corrected rule (see `tensorrtLlmRewriteRequestBody` below) writes exactly one of the two keys.
 * This round also added the gateway-level route declaration/rewrite-route split
 * (`routes`/`rewritableRoutes` below) and moved the request-body-size cap to be enforced while the
 * body streams in rather than after it is fully buffered — both are `../managed-text/gateway.ts`
 * changes this file's `routes`/`rewritableRoutes`/`rewriteRequestBody` feed into, not changes to
 * this file's own logic beyond declaring the two route lists.
 *
 * Every source citation below was re-verified, read-only, against the pinned tag's actual sources
 * (`nvcr.io/nvidia/tensorrt-llm/release` `descriptor_id: tensorrt-llm-1.2.1-r1` builds from
 * `v1.2.1`, https://github.com/NVIDIA/TensorRT-LLM/tree/v1.2.1), specifically checking which backend
 * each path belongs to:
 * - `tensorrt_llm/commands/serve.py`: the flags this file builds argv from (`--host`, `--port`,
 *   `--max_seq_len`, `--max_num_tokens`, `--kv_cache_free_gpu_memory_fraction` — the long spelling
 *   of the `--free_gpu_memory_fraction` alias — `--tool_parser`, `--reasoning_parser`), and that
 *   `--backend` defaults to `pytorch` (`DefaultGroup` + `@click.command("serve")`). No
 *   `--cache_dir`/engine-cache flag exists on `serve` in this tag (the unifying `TRTLLM_CACHE_DIR`
 *   env var, NVIDIA/TensorRT-LLM#18897, was still an open PR as of this reading); the engine cache
 *   directory is instead wired through the individual upstream PyTorch/Triton/CUDA JIT-cache env
 *   vars `#18897` itself names as the caches it would unify (`TORCHINDUCTOR_CACHE_DIR`,
 *   `TRITON_CACHE_DIR`, `CUDA_CACHE_PATH`) — those already exist independently of that PR.
 * - `tensorrt_llm/serve/openai_protocol.py`: `OpenAIBaseModel`'s `model_config = ConfigDict(extra=
 *   "forbid", populate_by_name=True)` (lines 71-73); `ChatCompletionRequest.max_completion_tokens:
 *   Optional[int] = Field(default=None, validation_alias='max_tokens')` (lines 546-547) — the single
 *   field, two-name situation `tensorrtLlmRewriteRequestBody` writes around (reproduced failing with
 *   `pydantic` directly against this exact model in round 2's review).
 * - `tensorrt_llm/llmapi/llm.py`'s `_check_arguments`: on the pytorch backend, and only when
 *   `enable_chunked_prefill` is off (its own default — `llm_args.py`'s `enable_chunked_prefill: bool
 *   = Field(default=False, ...)`, and nothing here ever passes `--enable_chunked_prefill`) and the
 *   request is not gen-only, it compares `prompt_len/cp_size + query_len` against
 *   `args.max_num_tokens` alone — **never the output** — raising `RequestError(f"The sum of prompt
 *   length ({promptLen}), query length ({queryLen}) should not exceed max_num_tokens ({limit})")`.
 *   Since this check is unconditional by default, and `--max_num_tokens` now equals
 *   `context_length` (see `buildTensorrtLlmLaunch`), it catches *every* request whose prompt and
 *   query alone already exceed the context window — the common overflow case, not an edge case
 *   (`findings-2.13-r2.md` item 6 correcting round 1's "an extreme case" wording).
 *   `--max_num_tokens` therefore caps the *prompt*, not a reply's length; the ruling in
 *   `findings-2.13-r1.md` item 1 responds by pointing it at `context_length` (a correct, if generic,
 *   prompt-side guard) and enforcing the output setting elsewhere — see `rewriteRequestBody` below
 *   and `docs/decisions/2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway.md`. The
 *   `tensorrt`-backend branch of the same method (comparing prompt+query+`max_tokens` against
 *   `max_seq_len`) is real but unreachable from this adapter's launch, which never passes
 *   `--backend`; it is not implemented here (round 1 had a copy of it that could never fire).
 * - `tensorrt_llm/_torch/pyexecutor/base_worker.py`'s `_deduce_max_tokens`: the pytorch backend's
 *   *other* per-request overflow signal, now that `--max_num_tokens` no longer doubles as an output
 *   cap — `default_max_tokens = max_seq_len - splited_prompt_len - query_token_len`, and once that
 *   is `<= 0` it raises `ValueError(f"\`default_max_tokens\` ({default_max_tokens}) must be greater
 *   than 0, \`default_max_tokens\` ({default_max_tokens}) = max_seq_len ({max_seq_len}) -
 *   \`splited_prompt_len\` ({splited_prompt_len}) - \`query_token_len\` ({query_token_len})")`.
 *   Unlike `_check_arguments` above, this one is narrow: since `_check_arguments` already guarantees
 *   `prompt + query <= max_num_tokens == max_seq_len` before this ever runs, `default_max_tokens`
 *   can only be `<= 0` at the single boundary point where `prompt + query` lands *exactly* on
 *   `max_seq_len` (`findings-2.13-r2.md` item 6 — round 1's header called this "the case that
 *   actually fires now", which had the relative weight of the two checks backwards).
 *   `mapTensorrtLlmContextLengthError` matches this alongside the `_check_arguments` message above.
 * - `tensorrt_llm/serve/openai_server.py`: `GET /health` answers 200 only once
 *   `self.llm._check_health()` passes and 503 otherwise (not merely "the HTTP server is up"), and
 *   `create_error_response`/the generic `except Exception` handler wrap any exception raised while
 *   handling a request as
 *   `{"object":"error","message":<str(exc)>,"type":"BadRequestError","param":null,"code":400}`, a
 *   flat envelope with an HTTP-status `code`, not OpenAI's `context_length_exceeded` string (that
 *   OpenAI-style remap is NVIDIA/TensorRT-LLM#19457, also still open, so this tag needs its own).
 * - `tensorrt_llm/_torch/models/modeling_auto.py`'s `AutoModelForCausalLM.from_config` — the
 *   pytorch backend's model class lookup (`_torch/pyexecutor/model_loader.py` imports
 *   `AutoModelForCausalLM` from exactly this module) — raises `ValueError(f"Unknown architecture
 *   for AutoModelForCausalLM: {config.pretrained_config.architectures[0]}")` for an architecture it
 *   has no class for. `tensorrt_llm/models/automodel.py`'s `TopModelMixin.from_hugging_face`
 *   ("...is not supported in TRT-LLM yet", round 1's source, matching NVIDIA/TensorRT-LLM issue
 *   #2845's older report) belongs to the legacy `tensorrt`-backend model loader, not the pytorch one
 *   — dropped here for the same reason as the `max_seq_len` overflow branch above.
 * - `tensorrt_llm/_torch/modules/linear.py`: two real `quant_mode`/`quant mode` rejections —
 *   `raise NotImplementedError(f"Unsupported quant_mode: {module.quant_config.layer_quant_mode}")`
 *   (line 292, weight-only int4/int8 dispatch) and `raise ValueError(f'unsupported quant mode:
 *   {quant_config.quant_mode}')` (line 2066, the general per-layer quant-method dispatch). Round 1
 *   matched a *warning* string ("Unsupported quant algo") that these modules never raise as an
 *   exception at all.
 * - The CUDA/PyTorch out-of-memory wording ("CUDA out of memory. Tried to allocate X GiB. GPU 0 has
 *   a total capacity of Y GiB of which Z GiB/MiB/KiB/bytes is free.") is PyTorch's own allocator
 *   message, unrelated to any TensorRT-LLM release; quoted from real `trtllm-serve` crash reports in
 *   NVIDIA/TensorRT-LLM issues #7818 (mid-size allocation, `MiB`) and #8642 (`0 bytes` free, the KV
 *   cache size estimation case). `tensorrt_llm/_torch/pyexecutor/py_executor_creator.py`'s
 *   `_maybe_explain_if_oom` additionally treats any exception whose text contains the lowercase
 *   substring `"out of memory"` as OOM regardless of its own wording — covering the executor's own
 *   C++-side allocator failure, which this adapter matches as `CUDA runtime error in .*: out of
 *   memory` (the shape that class of error takes; no single tag-pinned verbatim capture of the full
 *   C++ message was found, so the fixture for it is labelled as a constructed line around that
 *   confirmed substring, not a captured console transcript — see
 *   `test/helpers/tensorrt-llm-log-fixtures.ts`).
 * - Startup log lines: `stageMarkers` now uses three lines read directly from the pinned tag's
 *   pytorch-backend source rather than search results —
 *   `tensorrt_llm/_torch/pyexecutor/weight_loader.py`'s `HfWeightLoader.load_weights` (tqdm
 *   descriptions `"Loading safetensors weights in parallel"`/`"Loading bin weights in parallel"`,
 *   and `logger.info(f"Prefetching {prefetch_size / (1024**3):.2f}GB checkpoint files.")` when
 *   prefetch is enabled) and `tensorrt_llm/_torch/pyexecutor/model_engine.py`'s
 *   `_capture_generation_cuda_graphs` (`logger.info(f"Creating CUDA graph instances for {n} batch
 *   sizes.")`). Round 1's two markers (`Loading checkpoint shards`, `Capturing CUDA graphs`) do not
 *   appear anywhere in this tag's pytorch-backend source; dropped.
 * - The readiness-timeout coefficients are explicitly placeholders (see the constants below):
 *   design D8's open question defers their real values to live test 2.19 on real hardware. The
 *   chosen numbers only have to satisfy the spec scenario headroom this file's own test checks
 *   ("Долгий первый старт": a 30 GB model starting in three minutes must not time out).
 */
import { AtomicCoreError } from '../../contracts/index.js'
import {
  readGenerationDefaults,
  withGenerationDefaults,
  type GenerationDefaults,
} from '../managed-text/generation-defaults.js'
import type { ModelFamilySupport } from '../../contracts/index.js'
import {
  MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  ManagedRequestRefusal,
  asksForStructuredOutput,
  asksForTools,
  reasoningIntoContent,
  thinkingRequested,
} from '../managed-text/index.js'
import { TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION, tensorrtLlmUnifiedKvMaxTokens } from './kv-cache.js'
import type {
  ManagedEngineLaunch,
  ManagedExitClassification,
  ManagedLaunchContext,
  ManagedRoute,
  ManagedTextAdapter,
  ManagedTextCapabilities,
} from '../managed-text/index.js'

const GiB = 1024 ** 3

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/** `nvidia-smi -L`'s two UUID spellings, mirroring `assertGpuUuid` in `../container/argv.ts` — this
 *  module cannot import that internal (cross-module imports go through `index.ts` only, and it is
 *  not exported there), so the same shape is asserted again here, for the settings value rather
 *  than the docker argv token it eventually becomes. */
const GPU_UUID_PATTERN = /^(GPU|MIG)-[0-9A-Fa-f-]+$/

export const TENSORRT_LLM_MIN_CONTEXT_LENGTH = 512
export const TENSORRT_LLM_MAX_CONTEXT_LENGTH = 1_048_576
export const TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH = 8192

export const TENSORRT_LLM_MIN_MAX_OUTPUT_TOKENS = 1
export const TENSORRT_LLM_MAX_MAX_OUTPUT_TOKENS = 1_048_576
export const TENSORRT_LLM_DEFAULT_MAX_OUTPUT_TOKENS = 4096

/** Same bounds `trtllm-serve`'s own `--kv_cache_free_gpu_memory_fraction` documents as sane: never
 *  the whole of free memory (nothing left for the engine's own workspace) and never a sliver. */
export const TENSORRT_LLM_MIN_KV_CACHE_FREE_FRACTION = 0.1
export const TENSORRT_LLM_MAX_KV_CACHE_FREE_FRACTION = 0.95

export const TENSORRT_LLM_MIN_LOAD_TIMEOUT_SECONDS = 1
export const TENSORRT_LLM_MAX_LOAD_TIMEOUT_SECONDS = 3600

/** The adapter's own validated settings shape (spec `tensorrt-llm-runtime`, "Выбор карты и настройки
 *  провайдера"). The JSON settings schema this validates against on the wire is task 2.14's. */
export interface TensorrtLlmSettings {
  /** `GPU-<uuid>`/`MIG-<uuid>`, or `null` to let the load pick the card with the most free memory. */
  gpu_id: string | null
  context_length: number
  max_output_tokens: number
  kv_cache_free_gpu_memory_fraction: number
  /** `--max_batch_size` (`TENSORRT_LLM_MAX_BATCH_SIZE` by default). */
  max_batch_size: number
  /** `kv_cache_config.max_tokens`; `null` sizes it as `context_length × max_batch_size`. */
  kv_cache_max_tokens: number | null
  cuda_graphs: 'auto' | 'on' | 'off'
  kv_cache_dtype: 'auto' | 'fp8'
  /** Seconds. `null` leaves `readinessTimeoutMs`'s own weight-based estimate in force. */
  load_timeout_seconds: number | null
  /** `kv_cache_config.enable_block_reuse` (the engine's own default: on). */
  enable_prefix_caching: boolean
  /** `false` writes `disable_overlap_scheduler: true` (the engine's own default: overlap on). */
  overlap_scheduler: boolean
  /** `scheduler_config.capacity_scheduler_policy`, written only when not the engine's default. */
  capacity_scheduler_policy: 'guaranteed_no_evict' | 'max_utilization'
  /** The LLM API `dtype` of unquantized weights; `auto` writes nothing. */
  dtype: 'auto' | 'float16' | 'bfloat16' | 'float32'
  /** Sampling defaults the session gateway writes into a request that sets none. */
  generation: GenerationDefaults
}

function invalid(message: string, value: unknown): never {
  throw new AtomicCoreError('INVALID_ARGUMENT', message, String(value))
}

function validateGpuId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !GPU_UUID_PATTERN.test(value)) {
    invalid('tensorrt-llm gpu_id must be a GPU-<uuid>/MIG-<uuid> value, or null.', value)
  }
  return value
}

function validateBoundedInt(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(`tensorrt-llm ${label} must be an integer between ${min} and ${max}.`, value)
  }
  return value
}

function validateFraction(value: unknown): number {
  if (value === undefined || value === null) return TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION
  const min = TENSORRT_LLM_MIN_KV_CACHE_FREE_FRACTION
  const max = TENSORRT_LLM_MAX_KV_CACHE_FREE_FRACTION
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`tensorrt-llm kv_cache_free_gpu_memory_fraction must be between ${min} and ${max}.`, value)
  }
  return value
}

function validateChoice<T extends string>(
  value: unknown,
  label: string,
  choices: readonly T[],
  fallback: T
): T {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) {
    invalid(`tensorrt-llm ${label} must be one of ${choices.join(', ')}.`, value)
  }
  return value as T
}

function validateFlag(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return invalid(`tensorrt-llm ${label} must be true or false.`, value)
}

function validateLoadTimeoutOverride(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const min = TENSORRT_LLM_MIN_LOAD_TIMEOUT_SECONDS
  const max = TENSORRT_LLM_MAX_LOAD_TIMEOUT_SECONDS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(`tensorrt-llm load_timeout_seconds must be an integer between ${min} and ${max}, or null.`, value)
  }
  return value
}

/** Throws `AtomicCoreError('INVALID_ARGUMENT', ...)` before any container exists (adapter contract). */
export function validateTensorrtLlmSettings(raw: unknown): TensorrtLlmSettings {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    invalid('tensorrt-llm settings must be an object.', raw)
  }
  const r = (raw ?? {}) as Record<string, unknown>
  const context_length = validateBoundedInt(
    r['context_length'],
    'context_length',
    TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH,
    TENSORRT_LLM_MIN_CONTEXT_LENGTH,
    TENSORRT_LLM_MAX_CONTEXT_LENGTH
  )
  const max_output_tokens = validateBoundedInt(
    r['max_output_tokens'],
    'max_output_tokens',
    TENSORRT_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
    TENSORRT_LLM_MIN_MAX_OUTPUT_TOKENS,
    TENSORRT_LLM_MAX_MAX_OUTPUT_TOKENS
  )
  // A setting that could never leave room for a prompt is rejected here, not discovered later as
  // every request failing the gateway's own clamp (findings-2.13-r1.md item 1's cross-field rule;
  // see docs/decisions/2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway.md).
  if (max_output_tokens >= context_length) {
    invalid(
      `tensorrt-llm max_output_tokens (${max_output_tokens}) must be less than context_length (${context_length}).`,
      max_output_tokens
    )
  }
  return {
    gpu_id: validateGpuId(r['gpu_id']),
    context_length,
    max_output_tokens,
    kv_cache_free_gpu_memory_fraction: validateFraction(r['kv_cache_free_gpu_memory_fraction']),
    max_batch_size: validateBoundedInt(
      r['max_batch_size'],
      'max_batch_size',
      TENSORRT_LLM_MAX_BATCH_SIZE,
      1,
      TENSORRT_LLM_MAX_MAX_BATCH_SIZE
    ),
    kv_cache_max_tokens:
      r['kv_cache_max_tokens'] === undefined || r['kv_cache_max_tokens'] === null
        ? null
        : validateBoundedInt(
            r['kv_cache_max_tokens'],
            'kv_cache_max_tokens',
            0,
            1,
            TENSORRT_LLM_MAX_KV_CACHE_MAX_TOKENS
          ),
    cuda_graphs: validateChoice(r['cuda_graphs'], 'cuda_graphs', ['auto', 'on', 'off'] as const, 'auto'),
    kv_cache_dtype: validateChoice(r['kv_cache_dtype'], 'kv_cache_dtype', ['auto', 'fp8'] as const, 'auto'),
    load_timeout_seconds: validateLoadTimeoutOverride(r['load_timeout_seconds']),
    enable_prefix_caching: validateFlag(r['enable_prefix_caching'], 'enable_prefix_caching', true),
    overlap_scheduler: validateFlag(r['overlap_scheduler'], 'overlap_scheduler', true),
    capacity_scheduler_policy: validateChoice(
      r['capacity_scheduler_policy'],
      'capacity_scheduler_policy',
      ['guaranteed_no_evict', 'max_utilization'] as const,
      'guaranteed_no_evict'
    ),
    dtype: validateChoice(r['dtype'], 'dtype', ['auto', 'float16', 'bfloat16', 'float32'] as const, 'auto'),
    generation: readGenerationDefaults('tensorrt-llm', r),
  }
}

// ---------------------------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------------------------

/** `trtllm-serve serve`'s own default `--port`. */
export const TENSORRT_LLM_CONTAINER_PORT = 8000

/**
 * The LLM API option file a launch passes to `trtllm-serve serve --extra_llm_api_options`
 * (`commands/serve.py` in v1.2.1: `--config`/`--extra_llm_api_options`, a YAML file whose keys
 * overwrite the LLM API arguments), written when either of two keys applies:
 *
 * - `guided_decoding_backend: xgrammar`, for a family that declares structured output
 *   (`llmapi/llm_args.py`'s `guided_decoding_backend: Optional[Literal["xgrammar", "llguidance"]]`,
 *   default `None`). Without it, `openai_protocol.py` still turns `response_format` into
 *   guided-decoding parameters, but no backend exists to enforce them. `xgrammar` is the backend both
 *   the PyTorch and TensorRT backends implement.
 * - `kv_cache_config: {max_tokens: N}`, on a unified-memory card (`tensorrtLlmUnifiedKvMaxTokens`,
 *   `kv-cache.ts`).
 *   `llm_args.py` `KvCacheConfig.max_tokens` (1.2.1, line 1636): "If both `max_tokens` and
 *   `free_gpu_memory_fraction` are specified, memory corresponding to the minimum will be used."
 *   The fraction the argv passes survives the YAML: `serve.py`'s `get_llm_args` builds
 *   `KvCacheConfig(free_gpu_memory_fraction=...)` (line 125), and `update_llm_args_with_extra_dict`
 *   (`llm_args.py` line 3312) deep-merges a YAML `kv_cache_config` over it
 *   (`model_dump(exclude_unset=True) | yaml`), so the fraction stays the upper bound.
 */
export const TENSORRT_LLM_API_OPTIONS_FILE = 'llm-api-options.yaml'
export const TENSORRT_LLM_GUIDED_DECODING_OPTIONS = 'guided_decoding_backend: xgrammar\n'

/**
 * The option file's text, or `null` when no key applies (no file, no flag). The settings' further
 * options are written only when they differ from the engine's own default, so a launch with the
 * defaults stays what it was (`llm_args.py`: `KvCacheConfig.enable_block_reuse` default `True`,
 * `TorchLlmArgs.disable_overlap_scheduler` default `False`, `SchedulerConfig.capacity_scheduler_policy`
 * default `GUARANTEED_NO_EVICT`, `dtype` default `"auto"`).
 */
function llmApiOptions(
  guided: boolean,
  kvMaxTokens: number | null,
  kvFp8 = false,
  cudaGraphsOff = false,
  settings?: Pick<
    TensorrtLlmSettings,
    'enable_prefix_caching' | 'overlap_scheduler' | 'capacity_scheduler_policy' | 'dtype'
  >
): string | null {
  const lines: string[] = []
  if (guided) lines.push(TENSORRT_LLM_GUIDED_DECODING_OPTIONS.trimEnd())
  const noBlockReuse = settings?.enable_prefix_caching === false
  if (kvMaxTokens !== null || kvFp8 || noBlockReuse) {
    lines.push('kv_cache_config:')
    if (kvMaxTokens !== null) lines.push(`  max_tokens: ${kvMaxTokens}`)
    if (kvFp8) lines.push('  dtype: fp8')
    if (noBlockReuse) lines.push('  enable_block_reuse: false')
  }
  // `null` turns CUDA graphs off on the PyTorch backend (`llm_args.py`, `cuda_graph_config`).
  if (cudaGraphsOff) lines.push('cuda_graph_config: null')
  if (settings?.overlap_scheduler === false) lines.push('disable_overlap_scheduler: true')
  if (settings?.capacity_scheduler_policy === 'max_utilization') {
    lines.push('scheduler_config:', '  capacity_scheduler_policy: MAX_UTILIZATION')
  }
  if (settings !== undefined && settings.dtype !== 'auto') lines.push(`dtype: ${settings.dtype}`)
  return lines.length === 0 ? null : `${lines.join('\n')}\n`
}

/** Below this much card memory `cuda_graphs: auto` leaves CUDA graphs off: they took about 2 GB on
 *  an 8 GB card in the Windows live acceptance (Qwen3.5-2B, "Memory used outside torch … 2.12 GiB").
 *  A card that reports no size of its own is a unified-memory one (GB10): it keeps them. */
export const TENSORRT_LLM_CUDA_GRAPHS_MIN_VRAM_BYTES = 12 * 1024 ** 3

/** FP8 KV cache needs compute capability 8.9 (Ada) or newer. */
function supportsFp8Kv(computeCapability: string | null | undefined): boolean {
  if (computeCapability === null || computeCapability === undefined) return false
  const [major, minor] = computeCapability.split('.').map((part) => Number(part))
  if (major === undefined || Number.isNaN(major)) return false
  return major > 8 || (major === 8 && (minor ?? 0) >= 9)
}

/**
 * `--max_batch_size`: how many sequences the engine serves at once. `trtllm-serve` defaults to 2048, a
 * server's number; a desktop runs a chat, an agent turn and a few API calls at most. For a model with
 * recurrent layers (Qwen3.5, hybrid Mamba) the engine reserves the recurrent state for every one of
 * those sequences up front: on an 8 GB card Qwen3.5-2B failed with "The V2 Mamba GPU cache quota is
 * too small … need at least 20696801280 bytes" (Windows live acceptance, 1.3.0rc29). Attention-only
 * models only lose queueing beyond this many concurrent requests. One by default (owner's decision,
 * change `add-vllm-runtime`): the KV cache is then sized for one full context, which is what fits a
 * desktop card; a person who runs agents in parallel raises it.
 */
export const TENSORRT_LLM_MAX_BATCH_SIZE = 1
export const TENSORRT_LLM_MAX_MAX_BATCH_SIZE = 256
export const TENSORRT_LLM_MAX_KV_CACHE_MAX_TOKENS = 16_777_216

/** The container binds every interface; only the host-side publication (design D1/D11) is
 *  loopback-restricted, by the executor, not by the engine's own bind address. */
const CONTAINER_BIND_HOST = '0.0.0.0'

/** Builds `trtllm-serve serve <model-dir> ...` (task 2.13; flags sourced from `serve.py`, see the
 *  file header). `serve` is named explicitly rather than relying on the CLI's default-command
 *  resolution (`DefaultGroup.resolve_command`, `commands/serve.py`) — that quirk keeps `trtllm-serve
 *  MODEL` working when a user types it by hand, but a generated argv should not depend on undocumented
 *  fallback dispatch. The tool/reasoning parser flags are appended only when the pinned descriptor's
 *  `model_families` entry for this model's architecture names them (spec "Возможности модели
 *  объявляются, а не угадываются", design D9); the descriptor's own regex already validated those
 *  names, so they are passed through verbatim.
 *
 *  `--max_num_tokens` is set to `context_length`, not `max_output_tokens` (findings-2.13-r1.md item
 *  1's ruling): on the pytorch backend this flag caps the *prompt* alone
 *  (`llmapi/llm.py`'s `_check_arguments`, file header), so pointing it at the output-length setting
 *  was wrong from the start — it silently shrank the usable prompt window to whatever the output
 *  setting happened to be. `max_output_tokens` is enforced per request instead, by
 *  `tensorrtLlmRewriteRequestBody` through the session gateway (below; see
 *  `docs/decisions/2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway.md`), because
 *  this engine release has no server-side flag that caps a reply's length at all. */
export function buildTensorrtLlmLaunch(
  context: ManagedLaunchContext<TensorrtLlmSettings>
): ManagedEngineLaunch {
  const { settings, modelPath, engineCachePath, generationFilesPath, family } = context
  const argv: string[] = [
    'trtllm-serve',
    'serve',
    modelPath,
    '--host',
    CONTAINER_BIND_HOST,
    '--port',
    String(TENSORRT_LLM_CONTAINER_PORT),
    '--max_seq_len',
    String(settings.context_length),
    '--max_num_tokens',
    String(settings.context_length),
    '--max_batch_size',
    String(settings.max_batch_size),
    '--kv_cache_free_gpu_memory_fraction',
    String(settings.kv_cache_free_gpu_memory_fraction),
  ]
  if (family?.tool_parser != null) argv.push('--tool_parser', family.tool_parser)
  if (family?.reasoning_parser != null) argv.push('--reasoning_parser', family.reasoning_parser)
  // Guided decoding is off in trtllm-serve unless an LLM API option turns it on (final review I-2):
  // `response_format` is otherwise ignored or refused, so a family that declares structured output
  // gets `guided_decoding_backend: xgrammar` through the option file, written read-only per generation.
  // On a unified-memory card the same file bounds the KV cache by tokens (`kv-cache.ts`).
  // The KV cache is always bounded in tokens too: a hybrid (Mamba) model on 1.3.0rc29 refuses to start
  // without it ("Quota not set. Check kv_cache_config.max_tokens or kv_cache_config.max_gpu_total_bytes",
  // Windows live acceptance with Qwen3.5-2B). Room for every sequence the batch admits at full context;
  // the engine takes the smaller of this and the free-memory fraction, so attention-only models keep
  // the memory they had. A unified-memory card keeps its own, tighter bound.
  const vram = context.gpuTotalVramBytes ?? null
  const cudaGraphsOff =
    settings.cuda_graphs === 'off' ||
    (settings.cuda_graphs === 'auto' && vram !== null && vram < TENSORRT_LLM_CUDA_GRAPHS_MIN_VRAM_BYTES)
  const kvFp8 = settings.kv_cache_dtype === 'fp8' && supportsFp8Kv(context.gpuComputeCapability)
  const options = llmApiOptions(
    family?.structured_output === true,
    settings.kv_cache_max_tokens ??
      (context.unifiedMemory
        ? tensorrtLlmUnifiedKvMaxTokens(settings.context_length)
        : settings.context_length * settings.max_batch_size),
    kvFp8,
    cudaGraphsOff,
    settings
  )
  if (options !== null) {
    argv.push('--extra_llm_api_options', `${generationFilesPath}/${TENSORRT_LLM_API_OPTIONS_FILE}`)
  }

  return {
    engine: { container_port: TENSORRT_LLM_CONTAINER_PORT },
    argv,
    ...(options !== null ? { files: { [TENSORRT_LLM_API_OPTIONS_FILE]: options } } : {}),
    // No `--cache_dir`/`TRTLLM_CACHE_DIR` in this pinned tag (file header) — these are the
    // individual upstream PyTorch/Triton/CUDA JIT caches whose warm state make a repeat start on
    // the same model faster, redirected onto the read-write engine cache mount (design D8) so they
    // survive past this container's lifetime instead of vanishing with it.
    env: {
      TORCHINDUCTOR_CACHE_DIR: `${engineCachePath}/inductor`,
      TRITON_CACHE_DIR: `${engineCachePath}/triton`,
      CUDA_CACHE_PATH: `${engineCachePath}/nvcc`,
      // From 1.3 `trtllm-serve` reports anonymous usage to NVIDIA by default; a local app does not.
      TRTLLM_NO_USAGE_STATS: '1',
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Readiness timeout
// ---------------------------------------------------------------------------------------------

/**
 * Placeholder coefficients (design D8's own open question: "Точные... коэффициенты таймаута
 * загрузки — измеряются в live-тесте core", i.e. live test 2.19 replaces these). Until then they
 * only have to clear the spec's own acceptance scenario ("Долгий первый старт": a 30 GB model
 * starting in three minutes must not time out) with real headroom, not cut it close.
 *
 * Raised from 60 s + 6 s/GiB (2026-10-06): on an NVIDIA RTX Spark (Windows on Arm, WSL) Qwen3.5-2B
 * spent 62 s in executor profiling alone and was still sizing its KV cache, with no error, when the
 * 128 s that formula gave ran out. A healthy slow start must not fail; a stuck one still ends.
 */
export const TENSORRT_LLM_READINESS_BASE_MS = 240_000
/** Budgeted per GiB of checkpoint weights, before the margin multiplier — to be measured in live test 2.19. */
export const TENSORRT_LLM_READINESS_PER_GIB_MS = 12_000
/** Applied to the whole base-plus-per-GiB estimate — to be measured in live test 2.19. */
export const TENSORRT_LLM_READINESS_MARGIN = 1.5

/** Base plus time-per-GiB-of-weights, with margin (spec "Этапы и таймаут загрузки", design D8) —
 *  unless `settings.load_timeout_seconds` is set, which wins outright (findings-2.13-r1.md item 4:
 *  round 1 validated this setting but never read it back, so it was accepted and then silently
 *  ignored). The lifecycle's own `resolveReadinessTimeoutMs` (`../managed-text/load-policy.ts`)
 *  still applies a *second*, load-request-level override on top of whatever this returns — that
 *  path exists for a caller that computes its own override outside the settings object entirely; a
 *  `tensorrt-llm` load never populates it, so this function's return value is what actually wins. */
export function tensorrtLlmReadinessTimeoutMs(weightBytes: number, settings: TensorrtLlmSettings): number {
  if (settings.load_timeout_seconds !== null) return settings.load_timeout_seconds * 1000
  const weightGiB = Math.max(weightBytes, 0) / GiB
  const estimate = TENSORRT_LLM_READINESS_BASE_MS + TENSORRT_LLM_READINESS_PER_GIB_MS * weightGiB
  return Math.ceil(estimate * TENSORRT_LLM_READINESS_MARGIN)
}

// ---------------------------------------------------------------------------------------------
// Exit classification
// ---------------------------------------------------------------------------------------------

/** `torch`'s own CUDA allocator wording (not TensorRT-LLM-specific), both the modern
 *  `torch.OutOfMemoryError` subclass and the plain `RuntimeError` older/lower call sites still
 *  raise, plus the executor's own C++-side allocator failure — `py_executor_creator.py`'s
 *  `_maybe_explain_if_oom` treats any exception whose text contains `"out of memory"` (lowercase)
 *  as OOM regardless of its own wording, which is why this also matches a generic `CUDA runtime
 *  error in ...: out of memory` shape rather than only `torch`'s own message (file header).
 *
 *  Added after the 2026-09-29 VM run (docs/decisions/2026-09-29-tensorrt-llm-kv-cache-fraction-0-8-
 *  and-oom-read-from-the-whole-log.md), whose log carried these alongside `CUDA out of memory`:
 *  `torch.AcceleratorError: CUDA error: out of memory` (a CUDA call's own error string, raised
 *  through torch's CUDA check rather than its allocator); `_maybe_explain_if_oom`'s own "Executor
 *  creation failed due to insufficient GPU memory." (v1.2.1 `py_executor_creator.py`); and "The GPU
 *  ran out of memory", as the run reported it, source not pinned. */
const OOM_MARKER = new RegExp(
  [
    /torch\.(?:cuda\.)?OutOfMemoryError/.source,
    /CUDA out of memory/.source,
    /CUDA runtime error in .*: out of memory/.source,
    /CUDA error: out of memory/.source,
    /Executor creation failed due to insufficient GPU memory/.source,
    /The GPU ran out of memory/.source,
  ].join('|')
)
/** How much of the log an out-of-memory classification carries as its `excerpt`. */
const OOM_EXCERPT_MAX_LINES = 8
const OOM_EXCERPT_MAX_LINE_CHARS = 500
const OOM_TRIED_TO_ALLOCATE = /Tried to allocate ([\d.]+)\s*(GiB|MiB|KiB)/
const OOM_FREE = /of which ([\d.]+)\s*(GiB|MiB|KiB|bytes) is free/

/**
 * The numbers of one allocation failure, never mixed across two: `torch`'s message carries "Tried to
 * allocate X" and "of which Y is free" on one line. The last line that reports both wins — the most
 * recent complete account of a failure; failing that, the last request alone (no free figure borrowed
 * from another failure); failing that, the last free figure alone.
 */
function oomNumbers(log: string): { tried: RegExpExecArray | null; free: RegExpExecArray | null } {
  let complete: { tried: RegExpExecArray; free: RegExpExecArray } | null = null
  let lastTried: RegExpExecArray | null = null
  let lastFree: RegExpExecArray | null = null
  for (const line of log.split('\n')) {
    const tried = OOM_TRIED_TO_ALLOCATE.exec(line)
    const free = OOM_FREE.exec(line)
    if (tried && free) complete = { tried, free }
    if (tried) lastTried = tried
    if (free) lastFree = free
  }
  if (complete !== null) return complete
  return lastTried !== null ? { tried: lastTried, free: null } : { tried: null, free: lastFree }
}

/** `tensorrt_llm/_torch/models/modeling_auto.py`'s `AutoModelForCausalLM.from_config` — the
 *  pytorch backend's model class lookup (file header); not the legacy `tensorrt`-backend loader's
 *  wording, which this adapter's launch never reaches. */
const UNSUPPORTED_ARCHITECTURE = /Unknown architecture for AutoModelForCausalLM: (\S+)/
/** `tensorrt_llm/_torch/modules/linear.py`'s two real `quant_mode`/`quant mode` rejections (file
 *  header, lines 292 and 2066); deliberately not the `"Unsupported quant algo"` *warning* those
 *  modules also log, which is never raised as an exception. */
const UNSUPPORTED_QUANTIZATION = /unsupported quant[_ ]mode:/i

function toGiB(amount: number, unit: string): number {
  if (unit === 'GiB') return amount
  if (unit === 'MiB') return amount / 1024
  if (unit === 'KiB') return amount / (1024 * 1024)
  return amount / GiB // 'bytes'
}

/** Every line naming the out-of-memory failure, once each, in log order, bounded in count and width
 *  (a tqdm progress line can run to kilobytes): the lines a user needs, kept even after a long
 *  traceback has pushed them out of the log tail the error details otherwise show. */
function oomExcerpt(log: string): string {
  const lines: string[] = []
  for (const raw of log.split('\n')) {
    if (!OOM_MARKER.test(raw)) continue
    const trimmed = raw.trim()
    const line =
      trimmed.length > OOM_EXCERPT_MAX_LINE_CHARS
        ? `${trimmed.slice(0, OOM_EXCERPT_MAX_LINE_CHARS - 1)}…`
        : trimmed
    if (lines.includes(line)) continue
    lines.push(line)
    if (lines.length === OOM_EXCERPT_MAX_LINES) break
  }
  return lines.join('\n')
}

function classifyOom(log: string): ManagedExitClassification | null {
  if (!OOM_MARKER.test(log)) return null
  // One failure's numbers, the last complete one: with the whole log in play the first match could be
  // an earlier, handled failure, and two independent last matches could mix two failures.
  const { tried, free } = oomNumbers(log)
  const numbers: Record<string, number> = {}
  let requestedText = 'an unknown amount of'
  let freeText = ''
  if (tried) {
    const requestedGiB = toGiB(Number(tried[1]), tried[2] as string)
    numbers['requested_gib'] = requestedGiB
    requestedText = `${requestedGiB} GiB`
  }
  if (free) {
    const freeGiB = toGiB(Number(free[1]), free[2] as string)
    numbers['free_gib'] = freeGiB
    freeText = ` (${freeGiB} GiB free)`
  }
  return {
    kind: 'out-of-memory',
    message: `The GPU ran out of memory: trtllm-serve tried to allocate ${requestedText} memory${freeText}.`,
    ...(Object.keys(numbers).length > 0 ? { numbers } : {}),
    excerpt: oomExcerpt(log),
  }
}

function classifyUnsupportedArchitecture(log: string): ManagedExitClassification | null {
  const arch = UNSUPPORTED_ARCHITECTURE.exec(log)
  return arch
    ? {
        kind: 'unsupported-model',
        message: `The model architecture ${arch[1]} is not supported by this TensorRT-LLM release.`,
      }
    : null
}

function classifyUnsupportedQuantization(log: string): ManagedExitClassification | null {
  return UNSUPPORTED_QUANTIZATION.test(log)
    ? {
        kind: 'unsupported-model',
        message: 'This model is quantized in a format this TensorRT-LLM release does not load.',
      }
    : null
}

/** Reads a container's log and exit code into why it exited (spec "Этапы и таймаут загрузки": a
 *  container that exits before readiness fails the load immediately with this classification and
 *  the log tail, instead of waiting out the full timeout). Before readiness the lifecycle hands over
 *  the container's whole log, not its tail, and every line of it is searched: the out-of-memory line
 *  can sit above a worker traceback longer than the tail, ending in "RuntimeError: Executor worker
 *  returned error" (2026-09-29 VM run). Checked in order: an unsupported architecture first — the
 *  model class lookup raises it before anything is allocated, so it is decisive even when a handled
 *  out-of-memory line appears earlier in the whole log — then an out-of-memory message, with the
 *  lines that said so as `excerpt` and the numbers of the last allocation failure, then an
 *  unsupported quantization, otherwise `other`. */
/** The KV-cache manager's own capacity line: `[batchmgr][RANK 0] Max KV cache blocks per sequence: … max sequence length=224`. */
const KV_CAPACITY_LINE = /^.*\bmax sequence length=(\d+).*$/gm

/**
 * Whether a `trtllm-serve` that answered `/health` can hold one sequence of the context it was
 * launched with: the KV-cache manager logs how long a sequence it can keep (the last line wins — the
 * engine logs one for its memory-profiling pass and one for the final allocation). Shorter than the
 * context length is an out-of-memory refusal with both numbers — Ministral-3b bf16 on an RTX 4070
 * Laptop started with room for 224 tokens of a 4096-token context and answered every request with an
 * empty, failed stream. No such line (another engine build) is not a refusal.
 */
export function classifyTensorrtLlmReady(
  log: string,
  settings: TensorrtLlmSettings
): ManagedExitClassification | null {
  const lines = [...log.matchAll(KV_CAPACITY_LINE)]
  const last = lines.at(-1)
  if (last === undefined) return null
  const capacity = Number.parseInt(last[1] as string, 10)
  const context = settings.context_length
  if (!Number.isFinite(capacity) || capacity >= context) return null
  return {
    kind: 'out-of-memory',
    message:
      `The model loaded, but this GPU has room for a KV cache of only ${capacity} tokens, less than the ` +
      `context length of ${context}. Lower the context length in the TensorRT-LLM settings, or use a ` +
      `smaller or quantized model.`,
    numbers: { kv_capacity_tokens: capacity, context_length: context },
    excerpt: last[0].trim(),
  }
}

/** `tensorrt_llm.executor.utils.RequestError: KV_CACHE_MANAGER requires 67 KV cache blocks …` and the like. */
const REQUEST_ERROR_LINE = /^.*\bRequestError:\s*(.+?)\s*$/gm

/**
 * The engine's own words for the request it failed mid-stream: the last `RequestError` in the log
 * tail. `trtllm-serve` raises it inside the streaming generator after `200 OK` and only logs it, so
 * the client otherwise saw an empty answer (Ministral-3b on an 8 GB card: "KV_CACHE_MANAGER requires
 * 67 KV cache blocks to complete the request, which exceeds its GPU-primary capacity of 7 blocks").
 */
export function describeTensorrtLlmStreamFailure(logTail: string): string | null {
  const last = [...logTail.matchAll(REQUEST_ERROR_LINE)].at(-1)
  return last === undefined ? null : `TensorRT-LLM failed the request: ${last[1] as string}`
}

export function classifyTensorrtLlmExit(log: string, exitCode: number | null): ManagedExitClassification {
  const classification =
    classifyUnsupportedArchitecture(log) ?? classifyOom(log) ?? classifyUnsupportedQuantization(log)
  if (classification) return classification
  const codeText = exitCode === null ? 'with no exit code' : `with exit code ${exitCode}`
  return { kind: 'other', message: `trtllm-serve exited unexpectedly ${codeText} before it became ready.` }
}

// ---------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------

/** What a loaded model can do (spec "Возможности модели объявляются, а не угадываются", design D9):
 *  tool calling and reasoning only when the pinned descriptor's `model_families` entry for this
 *  model's architecture names the parser the launch was actually started with; structured output
 *  only when that same entry declares it; vision, embeddings and the Responses API are unsupported
 *  in this slice regardless of family. `settings` plays no part in this — capabilities are read
 *  entirely off the descriptor, never guessed the way the llama.cpp provider does — but the
 *  parameter stays because `ManagedTextAdapter.capabilities` always hands both through. */
export function tensorrtLlmCapabilities(context: {
  settings: TensorrtLlmSettings
  family: ModelFamilySupport | null
}): ManagedTextCapabilities {
  const { family } = context
  return {
    tools: family?.tool_parser != null,
    reasoning: family?.reasoning_parser != null,
    structured_output: family?.structured_output ?? false,
    vision: false,
    embeddings: false,
    responses: false,
  }
}

// ---------------------------------------------------------------------------------------------
// Declared routes
// ---------------------------------------------------------------------------------------------

/** The OpenAI method+path routes this adapter's engine actually serves (`openai_server.py`
 *  registers exactly these three for text; task 2.14 refuses any other public route for a
 *  `tensorrt-llm` model — spec: "Публичный сервер MUST отвечать понятной ошибкой на маршрут,
 *  который провайдер не объявил"). Also `ManagedTextAdapter.routes` below: the session gateway
 *  404s a path not listed here at all, and 405s a listed path used with a method not listed for
 *  it (findings-2.13-r3.md item 1) — either way before it ever reaches the container. This closes
 *  off `trtllm-serve`'s own undeclared routes — its `/health` (probed directly by the lifecycle,
 *  never through the gateway), its administrative routes this adapter never wanted reachable at
 *  all (`/update_weights`, `/release_memory`, `/resume_memory`, `/kv_cache_events`,
 *  `/steady_clock_offset`), `/v1/responses` (real in `openai_server.py`, unsupported in this
 *  slice) — and a wrong method on a route that is otherwise real, e.g. `GET
 *  /v1/chat/completions` or `POST /v1/models` (findings-2.13-r2.md item 3, keyed on method+path
 *  since findings-2.13-r3.md item 1). No route here declares `HEAD`; a `HEAD /v1/models` request
 *  gets the same `405` as any other undeclared method for a declared path — this engine's `GET
 *  /v1/models` has no dedicated `HEAD` handler to serve it from. */
export const TENSORRT_LLM_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/completions' },
  { method: 'GET', path: '/v1/models' },
]

/** The subset of `TENSORRT_LLM_ROUTES` `tensorrtLlmRewriteRequestBody` may rewrite: both POST
 *  routes, never `GET /v1/models` (no request body to rewrite in the first place). */
export const TENSORRT_LLM_REWRITABLE_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/completions' },
]

// ---------------------------------------------------------------------------------------------
// Context-length-overflow error mapping
// ---------------------------------------------------------------------------------------------

/** An OpenAI-compatible error body: `{"error": {...}}`, the shape every OpenAI-compatible client
 *  already expects (matches `server/public/errors.ts`'s `structureBackendErrorBody`'s envelope
 *  shape for the llama.cpp/MLX providers, so a caller does not need a second error shape to
 *  handle). */
export interface TensorrtLlmOpenAIError {
  error: {
    message: string
    type: string
    param: string | null
    code: string
  }
}

const NUM = '(-?[\\d.]+)'
/** pytorch backend `_check_arguments` (`llmapi/llm.py`, file header): fires unconditionally by
 *  default (chunked prefill is off unless explicitly enabled, which this adapter never does) for
 *  *every* prompt whose length alone (now that `--max_num_tokens` == `context_length`, see
 *  `buildTensorrtLlmLaunch`) exceeds the context — the common overflow case, not an edge case
 *  (findings-2.13-r2.md item 6). */
const OVERFLOW_VS_MAX_NUM_TOKENS = new RegExp(
  `sum of prompt length \\(${NUM}\\), query length \\(${NUM}\\) should not exceed max_num_tokens \\(${NUM}\\)`
)
/** The same check in 1.3.0rc29 (`llmapi/llm.py:1578`): the query length is gone from the message. */
const OVERFLOW_PROMPT_VS_MAX_NUM_TOKENS = new RegExp(
  `The prompt length \\(${NUM}\\) should not exceed max_num_tokens \\(${NUM}\\)`
)
/** pytorch backend `_deduce_max_tokens` (`base_worker.py`, file header): a narrow boundary case, not
 *  the common one — since `_check_arguments` above already guarantees `prompt + query <=
 *  max_seq_len` before this ever runs, this only fires when `prompt + query` lands *exactly* on
 *  `max_seq_len`, leaving zero room for any output (findings-2.13-r2.md item 6 corrects round 1's
 *  claim that this was "the case that actually fires now"). `default_max_tokens` itself repeats in
 *  the message (`(-?[\\d.]+)` because it is the quantity that is `<= 0`); only the second copy is
 *  used, for clarity, in `mapTensorrtLlmContextLengthError`. */
const OVERFLOW_VIA_DEDUCE_MAX_TOKENS = new RegExp(
  '`default_max_tokens` \\(' +
    NUM +
    '\\) must be greater than 0, `default_max_tokens` \\(' +
    NUM +
    '\\) = max_seq_len \\(' +
    NUM +
    '\\) - `splited_prompt_len` \\(' +
    NUM +
    '\\) - `query_token_len` \\(' +
    NUM +
    '\\)'
)
/** The same boundary case in 1.3.0rc29 (`base_worker.py:456-458`): no `query_token_len` term. */
const OVERFLOW_VIA_DEDUCE_MAX_TOKENS_NO_QUERY = new RegExp(
  '`default_max_tokens` \\(' +
    NUM +
    '\\) must be greater than 0, `default_max_tokens` \\(' +
    NUM +
    '\\) = max_seq_len \\(' +
    NUM +
    '\\) - `splited_prompt_len` \\(' +
    NUM +
    '\\)'
)

/** `trtllm-serve`'s own `ErrorResponse` (`openai_server.py`'s `create_error_response`) is
 *  `{"object":"error","message":...,"type":...,"param":...,"code":<http status int>}` — this reads
 *  its `message` field when the body parses as that shape, and falls back to the raw body text
 *  otherwise, so an already-unwrapped message (e.g. a caller that stripped the envelope) still
 *  matches. */
function messageOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { message?: unknown }).message === 'string'
    ) {
      return (parsed as { message: string }).message
    }
  } catch {
    // Not JSON at all: fall through and match against the raw body text.
  }
  return body
}

function contextLengthExceeded(requestedTokens: number, maxTokens: number): TensorrtLlmOpenAIError {
  const requested = Math.round(requestedTokens)
  const limit = Math.round(maxTokens)
  return {
    error: {
      message:
        `This model's maximum context length is ${limit} tokens. However, your messages resulted in ` +
        `${requested} tokens. Please reduce the length of the messages.`,
      type: 'invalid_request_error',
      param: null,
      code: 'context_length_exceeded',
    },
  }
}

/**
 * Maps `trtllm-serve` 1.2.1's context-overflow errors — the pytorch backend's two real, reachable
 * shapes, see the file header — to an OpenAI-compatible `context_length_exceeded` envelope with
 * both numbers. `null` for any other `400` (a different validation failure, e.g. a bad sampling
 * parameter) or any other status — 2.14 falls back to its own generic error wrapping for those, the
 * same way `server/public/errors.ts` already does for llama.cpp/MLX. This is a pure text mapping;
 * wiring it into the public `/v1/*` route handler is task 2.14's.
 */
export function mapTensorrtLlmContextLengthError(
  status: number,
  body: string
): TensorrtLlmOpenAIError | null {
  if (status !== 400) return null
  const message = messageOf(body)

  const viaMaxNumTokens = OVERFLOW_VS_MAX_NUM_TOKENS.exec(message)
  if (viaMaxNumTokens) {
    const [, promptLen, queryLen, limit] = viaMaxNumTokens as unknown as [string, string, string, string]
    return contextLengthExceeded(Number(promptLen) + Number(queryLen), Number(limit))
  }

  const viaDeduceMaxTokens = OVERFLOW_VIA_DEDUCE_MAX_TOKENS.exec(message)
  if (viaDeduceMaxTokens) {
    const [, , , maxSeqLen, splitedPromptLen, queryTokenLen] = viaDeduceMaxTokens as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    return contextLengthExceeded(Number(splitedPromptLen) + Number(queryTokenLen), Number(maxSeqLen))
  }

  const viaPromptVsMaxNumTokens = OVERFLOW_PROMPT_VS_MAX_NUM_TOKENS.exec(message)
  if (viaPromptVsMaxNumTokens) {
    const [, promptLen, limit] = viaPromptVsMaxNumTokens as unknown as [string, string, string]
    return contextLengthExceeded(Number(promptLen), Number(limit))
  }

  const viaDeduceNoQuery = OVERFLOW_VIA_DEDUCE_MAX_TOKENS_NO_QUERY.exec(message)
  if (viaDeduceNoQuery) {
    const [, , , maxSeqLen, splitedPromptLen] = viaDeduceNoQuery as unknown as [
      string,
      string,
      string,
      string,
      string,
    ]
    return contextLengthExceeded(Number(splitedPromptLen), Number(maxSeqLen))
  }

  return null
}

// ---------------------------------------------------------------------------------------------
// Output-length enforcement (session gateway request rewrite)
// ---------------------------------------------------------------------------------------------

/** The paths whose request body `tensorrtLlmRewriteRequestBody` touches — both are POST-only in
 *  `TENSORRT_LLM_REWRITABLE_ROUTES`, and `route` here is always a path the gateway already matched
 *  by method too, so path alone is enough to key this `Set` on. Every other route (including the
 *  third declared one, `GET /v1/models`, which has no body at all) passes its body through
 *  completely unchanged. */
const OUTPUT_CAP_ROUTES = new Set(TENSORRT_LLM_REWRITABLE_ROUTES.map((r) => r.path))

/** One candidate `max_tokens`/`max_completion_tokens` field as the client actually sent it. `null`
 *  counts as not sent at all (matching how an OpenAI client omits a field, findings-2.13-r2.md item
 *  1's ruling); anything else present that is not a positive integer is `valid: false` — this never
 *  substitutes a value for garbage input, only reports what was found, so the caller can throw a
 *  real `400` instead of silently guessing. */
interface CandidateField {
  present: boolean
  valid: boolean
  value: number
}

function readCandidateField(body: Record<string, unknown>, key: string): CandidateField {
  if (!(key in body) || body[key] === null) return { present: false, valid: false, value: 0 }
  const value = body[key]
  const valid = typeof value === 'number' && Number.isInteger(value) && value > 0
  return { present: true, valid, value: valid ? (value as number) : 0 }
}

/**
 * Refuses, on the session gateway itself, what this session cannot do (findings-2.14-r1.md item 1;
 * spec "запрос с `tools` к этой модели получает ошибку о неподдерживаемой возможности, а не молча
 * игнорируется"): tool calls without a tool-call parser, JSON output without structured-output support
 * for the family. `trtllm-serve` would otherwise accept the request and answer without honouring it.
 * The wording and code are `:1337`'s own (`server/public/policy.ts`), so a client sees one error
 * whichever port it talks to.
 */
function refuseUnsupported(body: Record<string, unknown>, capabilities: ManagedTextCapabilities): void {
  const model = typeof body['model'] === 'string' ? `The model '${body['model']}'` : 'This model'
  if (!capabilities.tools && asksForTools(body)) {
    throw new ManagedRequestRefusal(`${model} does not support tool calling.`, 'unsupported_capability')
  }
  if (!capabilities.structured_output && asksForStructuredOutput(body)) {
    throw new ManagedRequestRefusal(`${model} does not support structured output.`, 'unsupported_capability')
  }
}

/** `AtomicCoreError('INVALID_ARGUMENT', ...)`, not a plain `Error`: the gateway
 *  (`../managed-text/gateway.ts`) only surfaces a rewrite-time throw's own message to the client
 *  when it is this exact shape — proof the message was actually written to reject something the
 *  client itself sent, not an arbitrary internal error message (findings-2.13-r3.md item 3). */
function invalidMaxTokens(field: string): never {
  throw new AtomicCoreError('INVALID_ARGUMENT', `${field} must be a positive integer.`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Same shape and reason as `invalidMaxTokens`: the gateway surfaces this message as a `400`. */
function invalidJsonSchema(): never {
  throw new AtomicCoreError(
    'INVALID_ARGUMENT',
    "response_format.json_schema must be an object when response_format.type is 'json_schema'."
  )
}

/** A wrapper (`name`/`strict`) with no object `schema`: OpenAI refuses it too, and so must we. */
function invalidJsonSchemaWrapper(): never {
  throw new AtomicCoreError(
    'INVALID_ARGUMENT',
    'response_format.json_schema.schema must be an object when response_format.json_schema carries name or strict.'
  )
}

/**
 * Translates OpenAI's `json_schema` wrapper into what `trtllm-serve` 1.2.1 actually reads (ADR
 * `docs/decisions/2026-09-29-tensorrt-llm-json-schema-wrapper-unwrapped-by-the-session-gateway.md`).
 * `openai_protocol.py`'s `_response_format_to_guided_decoding_params` hands the WHOLE `json_schema`
 * field to `GuidedDecodingParams(json=...)` as the schema, so an OpenAI client's
 * `{"name", "strict", "schema": S}` becomes a grammar for a schema with no real constraint, and the
 * model answers with any JSON value (a bare string, on the live run). Here `json_schema` becomes the
 * inner `S`, dropping `name`/`strict`/`description`. A `json_schema` that looks like the wrapper (it
 * has `name` or `strict`, which are not JSON Schema keywords) but has no object `schema` is refused,
 * as OpenAI does; one without those keys and without an object `schema` is taken to be the bare
 * schema already and passes unchanged. One that is missing or not an object is refused too (the
 * engine would answer a `400` or a `500` of its own). Every other format type passes unchanged. Returns `format` itself when nothing changes.
 */
function unwrapJsonSchemaFormat(format: unknown): unknown {
  if (!isPlainObject(format) || format['type'] !== 'json_schema') return format
  const wrapper = format['json_schema']
  if (!isPlainObject(wrapper)) invalidJsonSchema()
  const inner = wrapper['schema']
  if (!isPlainObject(inner)) {
    if ('name' in wrapper || 'strict' in wrapper) invalidJsonSchemaWrapper()
    return format
  }
  return { ...format, json_schema: inner }
}

/**
 * Reasoning parsers that assume every reply starts inside the reasoning, because the chat template
 * opens `<think>` in the prompt when thinking is on. `qwen3_5` (Qwen3.5, 1.3.0rc29) is one: with
 * thinking off the template closes an empty `<think></think>` in the prompt instead, the model
 * answers with no tags at all, and the parser still files the whole answer under
 * `reasoning_content`, leaving `content` empty (Windows live acceptance, Qwen3.5-2B). The parser is
 * fixed per container; only the request says whether thinking was on.
 */
export const TENSORRT_LLM_REASONING_AT_START_PARSERS: ReadonlySet<string> = new Set(['qwen3_5'])

/** Moves a no-thinking reply filed as reasoning back into `content` (the shared rule, `request-rules.ts`). */
export const tensorrtLlmReasoningIntoContent = reasoningIntoContent

/** The response rewrite for a chat request with thinking off on a reasoning-at-start parser. */
export function tensorrtLlmRewriteResponseFor(
  route: string,
  requestBody: unknown,
  family: ModelFamilySupport | null
): ((json: Record<string, unknown>) => Record<string, unknown>) | null {
  if (route !== '/v1/chat/completions') return null
  const parser = family?.reasoning_parser ?? null
  if (parser === null || !TENSORRT_LLM_REASONING_AT_START_PARSERS.has(parser)) return null
  return thinkingRequested(requestBody) ? null : reasoningIntoContent
}

/**
 * Enforces `settings.max_output_tokens` per request, since `trtllm-serve` 1.2.1 has no server-side
 * flag that does it (`buildTensorrtLlmLaunch`'s doc comment; ADR
 * `docs/decisions/2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway.md`). Only
 * `TENSORRT_LLM_REWRITABLE_ROUTES` are touched; every other route's body returns unchanged, as does
 * a body that is not a plain JSON object (an array, a primitive, `null`) — the gateway's own JSON
 * parse already rejected anything that is not valid JSON at all before this ever runs.
 *
 * `/v1/completions` only ever had `max_tokens`: a present value is clamped to
 * `min(value, settings.max_output_tokens)`; absent, the setting is written outright.
 *
 * `/v1/chat/completions` writes exactly ONE of `max_tokens`/`max_completion_tokens` — never both —
 * because TRT-LLM 1.2.1's `ChatCompletionRequest` (`openai_protocol.py`, `extra="forbid"`) has a
 * single Python field, `max_completion_tokens`, whose `validation_alias` is `max_tokens`; sending
 * both as separate top-level keys makes pydantic reject the whole request with `400
 * extra_forbidden` (findings-2.13-r2.md item 1, reproduced by the reviewer with `pydantic` against
 * this exact model — round 1's own ruling did exactly this and broke every chat request). If the
 * client sent `max_completion_tokens`, the rewritten body keeps that key; else if it sent
 * `max_tokens`, that key; else `max_tokens` (this route's own default when nothing was sent at
 * all). If the client sent both, the lower of the two (each still capped) wins, under the
 * `max_completion_tokens` key.
 *
 * A present value that is not a positive integer (a string, `0`, a negative number — `null` counts
 * as not sent, matching how OpenAI clients omit a field) throws rather than silently substituting
 * the setting, so the client sees why its request was refused instead of one that silently used a
 * different limit than it asked for. The gateway (`../managed-text/gateway.ts`) turns that throw
 * into an OpenAI-shaped `400` using this function's own `Error.message`.
 *
 * `n` (multiple choices) is untouched: the cap is a per-choice output limit — the same as
 * `max_output_tokens` is documented to mean — not a budget shared across `n` completions.
 *
 * With the session's `capabilities` (the lifecycle always passes them; task 2.14 fix round 1), a
 * request asking for what the model cannot do — tool calls without a parser, JSON output without
 * structured-output support — is refused first (`refuseUnsupported`), before anything is rewritten.
 *
 * On both routes (`CompletionRequest` and `ChatCompletionRequest` share one `ResponseFormat` in
 * 1.2.1), an OpenAI `json_schema` wrapper in `response_format` is unwrapped to the bare schema the
 * engine reads (`unwrapJsonSchemaFormat`).
 */
export function tensorrtLlmRewriteRequestBody(
  route: string,
  body: unknown,
  settings: TensorrtLlmSettings,
  capabilities?: ManagedTextCapabilities
): unknown {
  if (!OUTPUT_CAP_ROUTES.has(route)) return body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  const client = body as Record<string, unknown>
  if (capabilities !== undefined) refuseUnsupported(client, capabilities)
  let obj =
    'response_format' in client
      ? { ...client, response_format: unwrapJsonSchemaFormat(client['response_format']) }
      : client
  const cap = settings.max_output_tokens
  // trtllm-serve has no launch option for sampling defaults; a request that sets none gets them here.
  obj = withGenerationDefaults(obj, settings.generation)

  if (route === '/v1/completions') {
    const field = readCandidateField(obj, 'max_tokens')
    if (field.present && !field.valid) invalidMaxTokens('max_tokens')
    return { ...obj, max_tokens: field.present ? Math.min(field.value, cap) : cap }
  }

  // /v1/chat/completions
  const legacy = readCandidateField(obj, 'max_tokens')
  const modern = readCandidateField(obj, 'max_completion_tokens')
  if ((legacy.present && !legacy.valid) || (modern.present && !modern.valid)) {
    invalidMaxTokens('max_tokens/max_completion_tokens')
  }
  const values: number[] = []
  if (legacy.valid) values.push(legacy.value)
  if (modern.valid) values.push(modern.value)
  const value = values.length > 0 ? Math.min(cap, ...values) : cap
  const outKey = modern.present ? 'max_completion_tokens' : 'max_tokens'
  const rest: Record<string, unknown> = { ...obj }
  delete rest['max_tokens']
  delete rest['max_completion_tokens']
  rest[outKey] = value
  return rest
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/**
 * Stage markers refining `initializing-engine` (spec "Этапы и таймаут загрузки": "уточняется по
 * маркерам логов адаптера, если они есть"). With no markers the lifecycle would move straight from
 * `starting-container` to `initializing-engine` the instant the container starts; these keep a load
 * in `starting-container` — Python/CUDA-context bring-up, not yet touching the checkpoint — until
 * one of them shows the engine is actually reading weights or building itself. All three are read
 * directly from the pinned tag's pytorch-backend source (file header: `weight_loader.py`,
 * `model_engine.py`), not search results. Live test 2.19 is expected to add to or replace this set
 * from a real container.
 */
const STAGE_MARKERS = [
  { stage: 'initializing-engine' as const, pattern: /Loading (?:safetensors|bin) weights in parallel/ },
  { stage: 'initializing-engine' as const, pattern: /Prefetching [\d.]+GB checkpoint files/ },
  { stage: 'initializing-engine' as const, pattern: /Creating CUDA graph instances/ },
  // 1.3.0rc29 (`model_engine.py:2709`) logs the capture as "Running CUDA graph capture|warmup for N batch sizes."
  {
    stage: 'initializing-engine' as const,
    pattern: /Running CUDA graph (?:capture|warmup) for \d+ batch sizes/,
  },
]

/** The `tensorrt-llm` engine's `ManagedTextAdapter` (task 2.13). Registered against the pinned
 *  descriptor's `adapter_id`/`adapter_contract_version` by whatever wires the registry up (task 2.14). */
export const tensorrtLlmAdapter: ManagedTextAdapter<TensorrtLlmSettings> = {
  id: 'tensorrt-llm',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/health', expectedStatus: 200 },
  routes: TENSORRT_LLM_ROUTES,
  rewritableRoutes: TENSORRT_LLM_REWRITABLE_ROUTES,
  stageMarkers: STAGE_MARKERS,
  validateSettings: validateTensorrtLlmSettings,
  buildLaunch: buildTensorrtLlmLaunch,
  readinessTimeoutMs: tensorrtLlmReadinessTimeoutMs,
  classifyExit: classifyTensorrtLlmExit,
  classifyReady: classifyTensorrtLlmReady,
  describeStreamFailure: describeTensorrtLlmStreamFailure,
  capabilities: tensorrtLlmCapabilities,
  rewriteRequestBody: tensorrtLlmRewriteRequestBody,
  rewriteResponseFor: tensorrtLlmRewriteResponseFor,
  // The session port answers `trtllm-serve`'s context overflow the way `:1337` does
  // (findings-2.14-r1.md item 1): OpenAI's `context_length_exceeded`, with both numbers.
  mapErrorResponse: (_route, status, body) => mapTensorrtLlmContextLengthError(status, body),
  // Only these are `trtllm-serve` flags; the output cap is the gateway's and the load timeout only a
  // load's, so changing either never restarts a container (findings-2.14-r1.md item 3). The card is
  // part of the lifecycle's own key already, as the one the load actually picked.
  restartKey: (settings) => [
    settings.context_length,
    settings.kv_cache_free_gpu_memory_fraction,
    settings.max_batch_size,
    settings.kv_cache_max_tokens,
    settings.cuda_graphs,
    settings.kv_cache_dtype,
    settings.enable_prefix_caching,
    settings.overlap_scheduler,
    settings.capacity_scheduler_policy,
    settings.dtype,
  ],
}
