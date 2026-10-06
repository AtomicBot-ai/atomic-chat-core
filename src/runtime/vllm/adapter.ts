/**
 * The `vllm` engine's `ManagedTextAdapter` (change `add-vllm-runtime`, task 3.2, design D8; spec
 * `vllm-runtime`): how core runs `vllm serve` from the `vllm/vllm-openai` image on the shared
 * managed-text lifecycle.
 *
 * - **argv**: `vllm serve <model> --served-model-name <id> --host 0.0.0.0 --port 8000
 *   --max-model-len <ctx> --max-num-seqs <n> --kv-cache-memory-bytes <B> --gpu-memory-utilization <U>
 *   --override-generation-config {"max_new_tokens":<cap>}`, `--limit-mm-per-prompt {"image":0,"video":0}`
 *   for a multimodal checkpoint, plus `--enforce-eager` when CUDA graphs are off,
 *   `--kv-cache-dtype fp8` on compute capability 8.9 and newer, and the family's tool-call and
 *   reasoning parsers. `B` and `U` are core's (`plan`, computed by the vLLM memory model from the card
 *   as it stands right before the container is created, design D9): vLLM itself would size its cache
 *   as a share of the card's *total* memory and refuse to start on any desktop whose card is partly
 *   taken. Never `--trust-remote-code` (no code from a model repository runs), `--enable-log-requests`
 *   (prompts would land in the logs core serves) or `--api-key` (the session gateway checks the key).
 * - **env**: usage stats off (`VLLM_NO_USAGE_STATS`, `DO_NOT_TRACK`), Hugging Face offline (every file
 *   is already in the store), and every compile cache — vLLM's own, Triton's, inductor's, FlashInfer's
 *   — under the engine cache, so a second start of the same model reuses the first one's work.
 * - **readiness** `GET /health`; **routes** chat completions, completions and the model list;
 *   requests capped at the output setting, refused for tools without a parser, structured output the
 *   family does not declare, and images (a cap the client did not ask for comes from the launch's
 *   default, so a long prompt is not refused for the room a written cap would take); vLLM's context overflow answered as OpenAI's
 *   `context_length_exceeded` with both numbers.
 *
 * Log lines, exit wording and error bodies follow vLLM 0.31's source (`test/helpers/vllm-log-fixtures.ts`);
 * the live run of task 6.1 confirms or replaces them.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelFamilySupport } from '../../contracts/index.js'
import {
  MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  ManagedRequestRefusal,
  asksForStructuredOutput,
  asksForTools,
  reasoningIntoContent,
  thinkingRequested,
  type ManagedExitClassification,
  type ManagedLaunchContext,
  type ManagedEngineLaunch,
  type ManagedRoute,
  type ManagedStageMarker,
  type ManagedTextAdapter,
  type ManagedTextCapabilities,
} from '../managed-text/index.js'
import { validateVllmSettings, type VllmSettings } from './settings.js'

const GiB = 1024 ** 3

/** The port `vllm serve` listens on inside its container. */
export const VLLM_CONTAINER_PORT = 8000

/** Below this much card memory, `cuda_graphs: auto` runs eager: graphs cost memory a small card needs. */
export const VLLM_CUDA_GRAPHS_MIN_VRAM_BYTES = 12 * GiB

/** What core decides for a launch from the card as it stands right before the container (design D9). */
export interface VllmLaunchPlan {
  /** `--kv-cache-memory-bytes`. */
  kvCacheMemoryBytes: number
  /** `--gpu-memory-utilization`: what vLLM's start-up check compares the card's free memory against. */
  gpuMemoryUtilization: number
  /**
   * The checkpoint has a vision or audio part: `--limit-mm-per-prompt` then reserves nothing for it.
   * A text-only model gets no multimodal flag at all.
   */
  multimodal: boolean
}

function isPlan(value: unknown): value is VllmLaunchPlan {
  if (value === null || typeof value !== 'object') return false
  const plan = value as Record<string, unknown>
  return (
    typeof plan['kvCacheMemoryBytes'] === 'number' &&
    Number.isInteger(plan['kvCacheMemoryBytes']) &&
    plan['kvCacheMemoryBytes'] > 0 &&
    typeof plan['gpuMemoryUtilization'] === 'number' &&
    plan['gpuMemoryUtilization'] > 0 &&
    plan['gpuMemoryUtilization'] <= 1 &&
    typeof plan['multimodal'] === 'boolean'
  )
}

/** Compute capability 8.9 (Ada) and newer: FP8 KV cache. Unknown or older: the model's own precision. */
function supportsFp8Kv(computeCapability: string | null | undefined): boolean {
  if (computeCapability === null || computeCapability === undefined) return false
  const [major, minor] = computeCapability.split('.').map((part) => Number.parseInt(part, 10))
  if (major === undefined || Number.isNaN(major)) return false
  return major > 8 || (major === 8 && (minor ?? 0) >= 9)
}

function eager(context: ManagedLaunchContext<VllmSettings>): boolean {
  const mode = context.settings.cuda_graphs
  if (mode === 'on') return false
  if (mode === 'off') return true
  // A unified-memory card has the host's memory: never the small-card case.
  if (context.unifiedMemory) return false
  const total = context.gpuTotalVramBytes ?? null
  return total === null || total < VLLM_CUDA_GRAPHS_MIN_VRAM_BYTES
}

/** Every compile cache of the engine, under the engine cache (`ManagedLaunchContext.engineCachePath`). */
function cacheEnv(cache: string): Record<string, string> {
  return {
    VLLM_CACHE_ROOT: `${cache}/vllm`,
    TRITON_CACHE_DIR: `${cache}/triton`,
    TORCHINDUCTOR_CACHE_DIR: `${cache}/inductor`,
    FLASHINFER_WORKSPACE_BASE: `${cache}/flashinfer`,
  }
}

export function buildVllmLaunch(context: ManagedLaunchContext<VllmSettings>): ManagedEngineLaunch {
  if (!isPlan(context.plan)) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'A vLLM launch needs core’s memory plan (KV cache bytes and memory share), computed right before the container is created.'
    )
  }
  const { settings, family } = context
  const argv = [
    'vllm',
    'serve',
    context.modelPath,
    '--served-model-name',
    context.modelId,
    '--host',
    '0.0.0.0',
    '--port',
    String(VLLM_CONTAINER_PORT),
    '--max-model-len',
    String(settings.context_length),
    '--max-num-seqs',
    String(settings.max_num_seqs),
    '--kv-cache-memory-bytes',
    String(context.plan.kvCacheMemoryBytes),
    '--gpu-memory-utilization',
    String(Number(context.plan.gpuMemoryUtilization.toFixed(4))),
    // The output cap for a request that names none: vLLM's own default, so a long prompt keeps the
    // room it has (a cap written into every request would make vLLM refuse input + cap > context).
    '--override-generation-config',
    JSON.stringify({ max_new_tokens: settings.max_output_tokens }),
  ]
  if (context.plan.multimodal) argv.push('--limit-mm-per-prompt', JSON.stringify({ image: 0, video: 0 }))
  if (eager(context)) argv.push('--enforce-eager')
  if (settings.kv_cache_dtype === 'fp8' && supportsFp8Kv(context.gpuComputeCapability)) {
    argv.push('--kv-cache-dtype', 'fp8')
  }
  if (family?.tool_parser) argv.push('--enable-auto-tool-choice', '--tool-call-parser', family.tool_parser)
  if (family?.reasoning_parser) argv.push('--reasoning-parser', family.reasoning_parser)
  return {
    engine: { container_port: VLLM_CONTAINER_PORT },
    argv,
    env: {
      VLLM_NO_USAGE_STATS: '1',
      DO_NOT_TRACK: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      ...cacheEnv(context.engineCachePath),
    },
  }
}

/** A base for engine start-up, imports and the first graph compilation; more per GiB of weights. */
export const VLLM_READINESS_BASE_MS = 10 * 60_000
export const VLLM_READINESS_PER_GIB_MS = 20_000

export function vllmReadinessTimeoutMs(weightBytes: number, settings: VllmSettings): number {
  if (settings.load_timeout_seconds !== null) return settings.load_timeout_seconds * 1000
  return Math.ceil(VLLM_READINESS_BASE_MS + (weightBytes / GiB) * VLLM_READINESS_PER_GIB_MS)
}

// ---------------------------------------------------------------------------------------------
// Exit classification
// ---------------------------------------------------------------------------------------------

const OOM =
  /CUDA out of memory\. Tried to allocate ([\d.]+) ?(GiB|MiB|KiB).*?of which ([\d.]+) ?(GiB|MiB|KiB|bytes) is free/
const FREE_BELOW_SHARE =
  /Free memory on device \(([\d.]+)\/([\d.]+) GiB\) on startup is less than desired GPU memory utilization \(([\d.]+), ([\d.]+) GiB\)/
const KV_TOO_SMALL =
  /max seq len \((\d+)\).*?\(([\d.]+) GiB KV cache is needed, which is larger than the available KV cache memory \(([\d.]+) GiB\)\.(?: Based on the available memory, the estimated maximum model length is (\d+)\.)?/
const UNSUPPORTED_ARCHITECTURE = /Model architectures \[([^\]]*)\] are not supported for now/
const ANY_OOM = /out of memory/i

const toGiB = (amount: number, unit: string): number =>
  unit === 'GiB'
    ? amount
    : unit === 'MiB'
      ? amount / 1024
      : unit === 'KiB'
        ? amount / 1024 ** 2
        : amount / GiB
const round = (value: number) => Math.round(value * 100) / 100

export function classifyVllmExit(log: string, exitCode: number | null): ManagedExitClassification {
  const kv = KV_TOO_SMALL.exec(log)
  if (kv !== null) {
    const maxModelLen = Number(kv[1])
    const fits = kv[4] === undefined ? null : Number(kv[4])
    return {
      kind: 'out-of-memory',
      message:
        `The context length ${maxModelLen} does not fit the KV cache: it needs ${kv[2]} GiB, ${kv[3]} GiB is available` +
        (fits === null ? '.' : `, which holds ${fits} tokens. Lower the context length or free GPU memory.`),
      numbers: {
        max_model_len: maxModelLen,
        kv_needed_gib: Number(kv[2]),
        kv_available_gib: Number(kv[3]),
        ...(fits === null ? {} : { kv_cache_tokens: fits }),
      },
      excerpt: kv[0],
    }
  }
  const free = FREE_BELOW_SHARE.exec(log)
  if (free !== null) {
    return {
      kind: 'out-of-memory',
      message: `The GPU had ${free[1]} GiB of ${free[2]} GiB free when vLLM started, less than the ${free[4]} GiB it was given.`,
      numbers: {
        free_gib: Number(free[1]),
        total_gib: Number(free[2]),
        utilization: Number(free[3]),
        requested_gib: Number(free[4]),
      },
      excerpt: free[0],
    }
  }
  const oom = OOM.exec(log)
  if (oom !== null) {
    const tried = round(toGiB(Number(oom[1]), oom[2] as string))
    const left = round(toGiB(Number(oom[3]), oom[4] as string))
    return {
      kind: 'out-of-memory',
      message: `The GPU ran out of memory: vLLM tried to allocate ${oom[1]} ${oom[2]} with ${oom[3]} ${oom[4]} free.`,
      numbers: { requested_gib: tried, free_gib: left },
      excerpt: oom[0],
    }
  }
  const arch = UNSUPPORTED_ARCHITECTURE.exec(log)
  if (arch !== null) {
    return {
      kind: 'unsupported-model',
      message: `This vLLM release cannot run the model's architecture: ${arch[1]?.replace(/'/g, '')}.`,
      excerpt: arch[0],
    }
  }
  if (ANY_OOM.test(log)) {
    return { kind: 'out-of-memory', message: 'The GPU ran out of memory while vLLM started.' }
  }
  return {
    kind: 'other',
    message: `vLLM exited${exitCode === null ? '' : ` with code ${exitCode}`} before it was ready.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Capabilities, routes, request and response rewrites
// ---------------------------------------------------------------------------------------------

export function vllmCapabilities(context: {
  settings: VllmSettings
  family: ModelFamilySupport | null
}): ManagedTextCapabilities {
  const family = context.family
  return {
    tools: Boolean(family?.tool_parser),
    reasoning: Boolean(family?.reasoning_parser),
    structured_output: family?.structured_output === true,
    vision: false,
    embeddings: false,
    responses: false,
  }
}

export const VLLM_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/completions' },
  { method: 'GET', path: '/v1/models' },
]

export const VLLM_REWRITABLE_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/completions' },
]

const REWRITABLE = new Set(VLLM_REWRITABLE_ROUTES.map((route) => route.path))

function positive(body: Record<string, unknown>, key: string): { present: boolean; value: number } {
  if (!(key in body) || body[key] === null) return { present: false, value: 0 }
  const value = body[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `${key} must be a positive integer.`)
  }
  return { present: true, value }
}

/** Any message part that is not text: an image, a video, audio — none of which this engine accepts here. */
const MEDIA_PART = new Set([
  'image_url',
  'input_image',
  'image',
  'video_url',
  'video',
  'input_audio',
  'audio_url',
])

function carriesMedia(body: Record<string, unknown>): boolean {
  const messages = body['messages']
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    const content =
      message !== null && typeof message === 'object' ? (message as { content?: unknown }).content : null
    return (
      Array.isArray(content) &&
      content.some(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          MEDIA_PART.has(String((part as { type?: unknown }).type))
      )
    )
  })
}

/**
 * Caps the output a request asks for at `max_output_tokens` (one key, as the client sent it); a
 * request that asks for none is capped by vLLM's launch default instead. Refuses what the session cannot do with `:1337`'s own wording
 * and code: tools without a parser, structured output the family does not declare, images.
 */
export function vllmRewriteRequestBody(
  route: string,
  body: unknown,
  settings: VllmSettings,
  capabilities?: ManagedTextCapabilities
): unknown {
  if (!REWRITABLE.has(route)) return body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  const client = body as Record<string, unknown>
  const model = typeof client['model'] === 'string' ? `The model '${client['model']}'` : 'This model'
  if (carriesMedia(client)) {
    throw new ManagedRequestRefusal(`${model} does not support images.`, 'unsupported_capability')
  }
  if (capabilities !== undefined) {
    if (!capabilities.tools && asksForTools(client)) {
      throw new ManagedRequestRefusal(`${model} does not support tool calling.`, 'unsupported_capability')
    }
    if (!capabilities.structured_output && asksForStructuredOutput(client)) {
      throw new ManagedRequestRefusal(
        `${model} does not support structured output.`,
        'unsupported_capability'
      )
    }
  }
  const cap = settings.max_output_tokens
  if (route === '/v1/completions') {
    const field = positive(client, 'max_tokens')
    return field.present ? { ...client, max_tokens: Math.min(field.value, cap) } : client
  }
  const legacy = positive(client, 'max_tokens')
  const modern = positive(client, 'max_completion_tokens')
  const asked = [legacy, modern].filter((field) => field.present).map((field) => field.value)
  // Nothing asked: vLLM's launch default (`--override-generation-config`) caps it, within the room left.
  if (asked.length === 0) return client
  const rest: Record<string, unknown> = { ...client }
  delete rest['max_tokens']
  delete rest['max_completion_tokens']
  rest[modern.present ? 'max_completion_tokens' : 'max_tokens'] = Math.min(cap, ...asked)
  return rest
}

/** vLLM's 400 wording for a request over the context, current and older, with the limit and the request. */
const OVERFLOW = [
  /maximum context length is (\d+) tokens\. However, your request has (\d+) input tokens/,
  /maximum context length is (\d+) tokens\. However, you requested (\d+) tokens/,
  /maximum context length is (\d+) tokens and your request has (\d+) input tokens/,
]

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: { message?: unknown } }
    const message = parsed.error?.message ?? parsed.message
    return typeof message === 'string' ? message : ''
  } catch {
    return ''
  }
}

/** vLLM's context overflow as OpenAI's `context_length_exceeded`; anything else relayed as it is. */
export function mapVllmContextLengthError(status: number, body: string): object | null {
  if (status !== 400) return null
  const message = errorMessage(body)
  for (const pattern of OVERFLOW) {
    const match = pattern.exec(message)
    if (match === null) continue
    const limit = Number(match[1])
    const requested = Number(match[2])
    return {
      error: {
        message: `This model's maximum context length is ${limit} tokens, but the request has ${requested} tokens. Shorten the conversation or the requested output.`,
        type: 'invalid_request_error',
        param: 'messages',
        code: 'context_length_exceeded',
      },
    }
  }
  return null
}

/**
 * Reasoning parsers that may file a no-thinking reply under `reasoning_content` (design D8: the same
 * hook as TensorRT-LLM's; the live run of task 6.1 confirms which of vLLM 0.31's do).
 */
export const VLLM_REASONING_AT_START_PARSERS: ReadonlySet<string> = new Set(['qwen3'])

export function vllmRewriteResponseFor(
  route: string,
  requestBody: unknown,
  family: ModelFamilySupport | null
): ((json: Record<string, unknown>) => Record<string, unknown>) | null {
  if (route !== '/v1/chat/completions') return null
  const parser = family?.reasoning_parser ?? null
  if (parser === null || !VLLM_REASONING_AT_START_PARSERS.has(parser)) return null
  return thinkingRequested(requestBody) ? null : reasoningIntoContent
}

/**
 * `initializing-engine` from the first line that shows vLLM working on the model: reading weights,
 * profiling memory, compiling, capturing CUDA graphs. Before them the load stays in
 * `starting-container` (Python, CUDA and the API server coming up).
 */
const STAGE_MARKERS: readonly ManagedStageMarker[] = [
  { stage: 'initializing-engine', pattern: /Starting to load model/ },
  { stage: 'initializing-engine', pattern: /Loading safetensors checkpoint shards/ },
  { stage: 'initializing-engine', pattern: /Model loading took/ },
  { stage: 'initializing-engine', pattern: /Compiling a graph for dynamic shape/ },
  { stage: 'initializing-engine', pattern: /Available KV cache memory/ },
  { stage: 'initializing-engine', pattern: /Capturing CUDA graphs/ },
]

export const vllmAdapter: ManagedTextAdapter<VllmSettings> = {
  id: 'vllm',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/health', expectedStatus: 200 },
  routes: VLLM_ROUTES,
  rewritableRoutes: VLLM_REWRITABLE_ROUTES,
  stageMarkers: STAGE_MARKERS,
  validateSettings: (raw) => validateVllmSettings((raw ?? {}) as Record<string, unknown>),
  buildLaunch: buildVllmLaunch,
  readinessTimeoutMs: vllmReadinessTimeoutMs,
  classifyExit: classifyVllmExit,
  capabilities: vllmCapabilities,
  rewriteRequestBody: vllmRewriteRequestBody,
  rewriteResponseFor: vllmRewriteResponseFor,
  mapErrorResponse: (_route, status, body) => mapVllmContextLengthError(status, body),
  // Everything vLLM is started with — the output cap too, its default for a request that names none;
  // only the load timeout is a load's alone.
  restartKey: (settings) => [
    settings.context_length,
    settings.max_output_tokens,
    settings.max_num_seqs,
    settings.kv_cache_max_tokens,
    settings.cuda_graphs,
    settings.kv_cache_dtype,
  ],
}
