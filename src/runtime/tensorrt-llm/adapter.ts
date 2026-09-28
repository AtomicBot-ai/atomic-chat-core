/**
 * The `tensorrt-llm` `ManagedTextAdapter` (task 2.13, spec `tensorrt-llm-runtime`, design D8/D9):
 * settings validation, the `trtllm-serve` argv, readiness, log stage markers, the readiness
 * timeout, exit classification (OOM etc.), declared capabilities and routes, and the
 * context-length-overflow error mapping. Plugs into the engine-neutral load lifecycle (task 2.12,
 * `../managed-text/`) through `ManagedTextAdapter`; nothing here does I/O.
 *
 * `trtllm-serve`'s CLI surface and error wording below is read from the pinned tag
 * `nvcr.io/nvidia/tensorrt-llm/release` `descriptor_id: tensorrt-llm-1.2.1-r1` builds from
 * (`v1.2.1`, https://github.com/NVIDIA/TensorRT-LLM/tree/v1.2.1), fetched read-only while writing
 * this file:
 * - `tensorrt_llm/commands/serve.py` (`DefaultGroup` + `@click.command("serve")`): the flags this
 *   file builds argv from (`--host`, `--port`, `--max_seq_len`, `--max_num_tokens`,
 *   `--kv_cache_free_gpu_memory_fraction` — the long spelling of the `--free_gpu_memory_fraction`
 *   alias — `--tool_parser`, `--reasoning_parser`). No `--cache_dir`/engine-cache flag exists on
 *   `serve` in this tag (the unifying `TRTLLM_CACHE_DIR` env var, NVIDIA/TensorRT-LLM#18897, was
 *   still an open PR as of this reading, so it is not in `v1.2.1`); the engine cache directory is
 *   instead wired through the individual upstream PyTorch/Triton/CUDA JIT-cache env vars that
 *   `#18897` itself names as the caches it would unify (`TORCHINDUCTOR_CACHE_DIR`,
 *   `TRITON_CACHE_DIR`, `CUDA_CACHE_PATH`) — those already exist independently of that PR.
 * - `tensorrt_llm/serve/openai_server.py`: `GET /health` answers 200 only once
 *   `self.llm._check_health()` passes and 503 otherwise (not merely "the HTTP server is up"), and
 *   `create_error_response`/the generic `except Exception` handler wrap any exception raised while
 *   handling a request — including the context-overflow `ValueError` below — as
 *   `{"object":"error","message":<str(exc)>,"type":"BadRequestError","param":null,"code":400}`, a
 *   flat envelope with an HTTP-status `code`, not OpenAI's `context_length_exceeded` string (that
 *   OpenAI-style remap is NVIDIA/TensorRT-LLM#19457, also still open, so this tag needs its own).
 * - `tensorrt_llm/llmapi/llm.py`'s `_check_arguments`: the two request-time `ValueError` messages a
 *   too-long prompt raises, one per backend — pytorch (this descriptor's default backend, per
 *   `serve.py`): "The sum of prompt length ({promptLen}), query length ({queryLen}) should not
 *   exceed max_num_tokens ({limit})"; tensorrt: "The sum of prompt length ({promptLen}) and query
 *   length ({queryLen}) max_tokens ({maxTokens}) should not exceed max_seq_len ({limit})".
 * - `tensorrt_llm/models/automodel.py`'s `TopModelMixin.from_hugging_face`: an architecture with no
 *   TRT-LLM implementation raises `NotImplementedError("The given huggingface model architecture
 *   {arch} is not supported in TRT-LLM yet")` (matches NVIDIA/TensorRT-LLM issue #2845's report for
 *   `DeepseekV3ForCausalLM` on an older tag before it gained support).
 * - The CUDA/PyTorch out-of-memory wording ("CUDA out of memory. Tried to allocate X GiB. GPU 0 has
 *   a total capacity of Y GiB of which Z GiB/bytes is free.") is PyTorch's own allocator message,
 *   unrelated to any TensorRT-LLM release; quoted from real `trtllm-serve` crash reports in
 *   NVIDIA/TensorRT-LLM issues #7818 (mid-size allocation, `MiB`) and #8642 (`0 bytes` free, the KV
 *   cache size estimation case).
 * - Startup log lines were harder to source verbatim for this exact tag (no full console capture
 *   found for `v1.2.1` specifically): `stageMarkers` uses the one line confirmed both by search and
 *   by this repo's own fake-adapter test fixture (`../managed-text/lifecycle.test.ts`) as realistic
 *   for a Hugging-Face-checkpoint-loading Python inference server, `Loading checkpoint shards:` (the
 *   `transformers`/`huggingface_hub` progress bar `trtllm-serve`'s pytorch backend goes through to
 *   read a safetensors checkpoint), plus the CUDA-graph-capture progress line the pytorch backend
 *   logs while warming up before it is ready. Live test 2.19 replaces this with a maker set actually
 *   observed against a live container, per the design's own open question on this point.
 * - The readiness-timeout coefficients are explicitly placeholders (see the constants below):
 *   design D8's open question defers their real values to live test 2.19 on real hardware. The
 *   chosen numbers only have to satisfy the spec scenario headroom this file's own test checks
 *   ("Долгий первый старт": a 30 GB model starting in three minutes must not time out).
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelFamilySupport } from '../../contracts/index.js'
import { MANAGED_TEXT_ADAPTER_CONTRACT_VERSION } from '../managed-text/index.js'
import type {
  ManagedEngineLaunch,
  ManagedExitClassification,
  ManagedLaunchContext,
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
/** `trtllm-serve serve --kv_cache_free_gpu_memory_fraction`'s own default. */
export const TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION = 0.9

export const TENSORRT_LLM_MIN_LOAD_TIMEOUT_SECONDS = 1
export const TENSORRT_LLM_MAX_LOAD_TIMEOUT_SECONDS = 3600

/** The adapter's own validated settings shape (spec `tensorrt-llm-runtime`, "Выбор карты и настройки
 *  провайдера"). The JSON settings schema this validates against on the wire is task 2.14's. */
export interface TensorrtLlmSettings {
  /** `GPU-<uuid>`/`MIG-<uuid>`, or `null` to let the load pick the card with the most memory. */
  gpu_id: string | null
  context_length: number
  max_output_tokens: number
  kv_cache_free_gpu_memory_fraction: number
  /** Seconds. `null` leaves `readinessTimeoutMs`'s own weight-based estimate in force. */
  load_timeout_seconds: number | null
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
  return {
    gpu_id: validateGpuId(r['gpu_id']),
    context_length: validateBoundedInt(
      r['context_length'],
      'context_length',
      TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH,
      TENSORRT_LLM_MIN_CONTEXT_LENGTH,
      TENSORRT_LLM_MAX_CONTEXT_LENGTH
    ),
    max_output_tokens: validateBoundedInt(
      r['max_output_tokens'],
      'max_output_tokens',
      TENSORRT_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
      TENSORRT_LLM_MIN_MAX_OUTPUT_TOKENS,
      TENSORRT_LLM_MAX_MAX_OUTPUT_TOKENS
    ),
    kv_cache_free_gpu_memory_fraction: validateFraction(r['kv_cache_free_gpu_memory_fraction']),
    load_timeout_seconds: validateLoadTimeoutOverride(r['load_timeout_seconds']),
  }
}

// ---------------------------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------------------------

/** `trtllm-serve serve`'s own default `--port`. */
export const TENSORRT_LLM_CONTAINER_PORT = 8000

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
 *  names, so they are passed through verbatim. */
export function buildTensorrtLlmLaunch(
  context: ManagedLaunchContext<TensorrtLlmSettings>
): ManagedEngineLaunch {
  const { settings, modelPath, engineCachePath, family } = context
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
    String(settings.max_output_tokens),
    '--kv_cache_free_gpu_memory_fraction',
    String(settings.kv_cache_free_gpu_memory_fraction),
  ]
  if (family?.tool_parser != null) argv.push('--tool_parser', family.tool_parser)
  if (family?.reasoning_parser != null) argv.push('--reasoning_parser', family.reasoning_parser)

  return {
    engine: { container_port: TENSORRT_LLM_CONTAINER_PORT },
    argv,
    // No `--cache_dir`/`TRTLLM_CACHE_DIR` in this pinned tag (file header) — these are the
    // individual upstream PyTorch/Triton/CUDA JIT caches whose warm state make a repeat start on
    // the same model faster, redirected onto the read-write engine cache mount (design D8) so they
    // survive past this container's lifetime instead of vanishing with it.
    env: {
      TORCHINDUCTOR_CACHE_DIR: `${engineCachePath}/inductor`,
      TRITON_CACHE_DIR: `${engineCachePath}/triton`,
      CUDA_CACHE_PATH: `${engineCachePath}/nvcc`,
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
 */
export const TENSORRT_LLM_READINESS_BASE_MS = 60_000
/** Budgeted per GiB of checkpoint weights, before the margin multiplier — to be measured in live test 2.19. */
export const TENSORRT_LLM_READINESS_PER_GIB_MS = 6_000
/** Applied to the whole base-plus-per-GiB estimate — to be measured in live test 2.19. */
export const TENSORRT_LLM_READINESS_MARGIN = 1.5

/** Base plus time-per-GiB-of-weights, with margin (spec "Этапы и таймаут загрузки", design D8). A
 *  provider setting overriding this happens above the adapter, in the lifecycle's own
 *  `resolveReadinessTimeoutMs` (`../managed-text/load-policy.ts`) — this function's job is only the
 *  adapter's own weight-based estimate, which the lifecycle uses when no override is given. */
export function tensorrtLlmReadinessTimeoutMs(weightBytes: number): number {
  const weightGiB = Math.max(weightBytes, 0) / GiB
  const estimate = TENSORRT_LLM_READINESS_BASE_MS + TENSORRT_LLM_READINESS_PER_GIB_MS * weightGiB
  return Math.ceil(estimate * TENSORRT_LLM_READINESS_MARGIN)
}

// ---------------------------------------------------------------------------------------------
// Exit classification
// ---------------------------------------------------------------------------------------------

/** `torch`'s own CUDA allocator wording (not TensorRT-LLM-specific), both the modern
 *  `torch.OutOfMemoryError` subclass and the plain `RuntimeError` older/lower call sites still
 *  raise (`_create_kv_cache_manager`'s KV-cache sizing step, `resource_manager.py`, does the latter). */
const OOM_MARKER = /torch\.(?:cuda\.)?OutOfMemoryError|CUDA out of memory/
const OOM_TRIED_TO_ALLOCATE = /Tried to allocate ([\d.]+)\s*(GiB|MiB)/
const OOM_FREE = /of which ([\d.]+)\s*(GiB|MiB|bytes) is free/

/** `tensorrt_llm/models/automodel.py`'s `TopModelMixin.from_hugging_face`. */
const UNSUPPORTED_ARCHITECTURE = /is not supported in TRT-LLM yet/
/** No single verbatim source string found for this tag's quantization-rejection wording (unlike the
 *  architecture one); matches the shape used across `NotImplementedError`s this engine's linear/
 *  quantization modules raise for a `quant_method`/`quantization_config` this release does not load. */
const UNSUPPORTED_QUANTIZATION = /unsupported quant(?:ization(?:_config)?)?/i

function toGiB(amount: number, unit: string): number {
  if (unit === 'GiB') return amount
  if (unit === 'MiB') return amount / 1024
  return amount / GiB // 'bytes'
}

function classifyOom(logTail: string): ManagedExitClassification | null {
  if (!OOM_MARKER.test(logTail)) return null
  const tried = OOM_TRIED_TO_ALLOCATE.exec(logTail)
  const free = OOM_FREE.exec(logTail)
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
  }
}

function classifyUnsupported(logTail: string): ManagedExitClassification | null {
  const archMatch = UNSUPPORTED_ARCHITECTURE.test(logTail)
  if (archMatch) {
    const named = /architecture (\S+) is not supported in TRT-LLM yet/.exec(logTail)
    return {
      kind: 'unsupported-model',
      message: named
        ? `The model architecture ${named[1]} is not supported by this TensorRT-LLM release.`
        : 'This model architecture is not supported by this TensorRT-LLM release.',
    }
  }
  if (UNSUPPORTED_QUANTIZATION.test(logTail)) {
    return {
      kind: 'unsupported-model',
      message: 'This model is quantized in a format this TensorRT-LLM release does not load.',
    }
  }
  return null
}

/** Reads a container's log tail and exit code into why it exited (spec "Этапы и таймаут загрузки":
 *  a container that exits before readiness fails the load immediately with this classification and
 *  the log tail, instead of waiting out the full timeout). Checked in order: an out-of-memory
 *  allocator message first (it can appear alongside an unrelated traceback line further up the same
 *  tail), then an unsupported-architecture/quantization message, otherwise `other`. */
export function classifyTensorrtLlmExit(logTail: string, exitCode: number | null): ManagedExitClassification {
  const oom = classifyOom(logTail)
  if (oom) return oom
  const unsupported = classifyUnsupported(logTail)
  if (unsupported) return unsupported
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

/** The OpenAI routes this adapter's engine actually serves (`openai_server.py` registers exactly
 *  these three for text; task 2.14 refuses any other public route for a `tensorrt-llm` model —
 *  spec: "Публичный сервер MUST отвечать понятной ошибкой на маршрут, который провайдер не
 *  объявил"). */
export const TENSORRT_LLM_ROUTES = ['/v1/chat/completions', '/v1/completions', '/v1/models'] as const

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

const NUM = '([\\d.]+)'
/** pytorch backend (this descriptor's default, `serve.py`'s `--backend` default): `_check_arguments`
 *  in `llmapi/llm.py` compares the prompt against `max_num_tokens`. */
const OVERFLOW_VS_MAX_NUM_TOKENS = new RegExp(
  `sum of prompt length \\(${NUM}\\), query length \\(${NUM}\\) should not exceed max_num_tokens \\(${NUM}\\)`
)
/** tensorrt backend: the same check instead compares prompt + query + the reserved output budget
 *  (`max_tokens`) against `max_seq_len`. */
const OVERFLOW_VS_MAX_SEQ_LEN = new RegExp(
  `sum of prompt length \\(${NUM}\\) and query length \\(${NUM}\\) max_tokens \\(${NUM}\\) should not exceed max_seq_len \\(${NUM}\\)`
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
 * Maps `trtllm-serve` 1.2.1's context-overflow error (a `400` whose message compares prompt length
 * against `max_num_tokens`/`max_seq_len`, see the file header) to an OpenAI-compatible
 * `context_length_exceeded` envelope with both numbers. `null` for any other `400` (a different
 * validation failure, e.g. a bad sampling parameter) or any other status — 2.14 falls back to its
 * own generic error wrapping for those, the same way `server/public/errors.ts` already does for
 * llama.cpp/MLX. This is a pure text mapping; wiring it into the public `/v1/*` route handler is
 * task 2.14's.
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

  const viaMaxSeqLen = OVERFLOW_VS_MAX_SEQ_LEN.exec(message)
  if (viaMaxSeqLen) {
    const [, promptLen, queryLen, maxTokens, limit] = viaMaxSeqLen as unknown as [
      string,
      string,
      string,
      string,
      string,
    ]
    return contextLengthExceeded(Number(promptLen) + Number(queryLen) + Number(maxTokens), Number(limit))
  }

  return null
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/**
 * Stage markers refining `initializing-engine` (spec "Этапы и таймаут загрузки": "уточняется по
 * маркерам логов адаптера, если они есть"). With no markers the lifecycle would move straight from
 * `starting-container` to `initializing-engine` the instant the container starts; these keep a load
 * in `starting-container` — Python/CUDA-context bring-up, not yet touching the checkpoint — until
 * one of them shows the engine is actually reading weights or building itself. See the file header
 * for sourcing; live test 2.19 is expected to add to or replace this set from a real container.
 */
const STAGE_MARKERS = [
  { stage: 'initializing-engine' as const, pattern: /Loading checkpoint shards/ },
  { stage: 'initializing-engine' as const, pattern: /Capturing CUDA graphs/ },
]

/** The `tensorrt-llm` engine's `ManagedTextAdapter` (task 2.13). Registered against the pinned
 *  descriptor's `adapter_id`/`adapter_contract_version` by whatever wires the registry up (task 2.14). */
export const tensorrtLlmAdapter: ManagedTextAdapter<TensorrtLlmSettings> = {
  id: 'tensorrt-llm',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/health', expectedStatus: 200 },
  stageMarkers: STAGE_MARKERS,
  validateSettings: validateTensorrtLlmSettings,
  buildLaunch: buildTensorrtLlmLaunch,
  readinessTimeoutMs: (weightBytes) => tensorrtLlmReadinessTimeoutMs(weightBytes),
  classifyExit: classifyTensorrtLlmExit,
  capabilities: tensorrtLlmCapabilities,
}
