/**
 * The `sglang` engine's `ManagedTextAdapter` (change `add-sglang-runtime`, task 2.2, design D3, D5;
 * spec `sglang-runtime`): how core runs `python3 -m sglang.launch_server` from the `lmsysorg/sglang`
 * image on the shared managed-text lifecycle. Everything here follows SGLang v0.5.21's source (the
 * rulings of task 2.2 in the change's `rulings/core.md` say where).
 *
 * - **argv**: `--model-path <model> --served-model-name <id> --host 0.0.0.0 --port 30000
 *   --context-length <ctx> --max-running-requests <n> --mem-fraction-static <f>`, then only what
 *   differs from SGLang's own: the KV cache limit, the prefill chunk, `--disable-radix-cache`,
 *   `--dtype`, `--random-seed`, the CUDA graph mode (D5), `--kv-cache-dtype fp8_e4m3` on compute
 *   capability 8.9 and newer, the family's parsers, and `--json-model-override-args
 *   {"language_model_only":true}` for a multimodal checkpoint. `f` is core's (`plan`, from the card's
 *   free memory right before the container, design D4); within it SGLang sizes the KV cache itself.
 *   Never `--trust-remote-code` (no code from a model repository runs), `--log-requests` (prompts would
 *   land in the logs core serves), `--api-key`/`--admin-api-key` (the session gateway checks the key)
 *   or `--enable-metrics`.
 * - **env**: Hugging Face offline (every file is already in the store), no tracking, the output limit
 *   for a request that names none (`SGLANG_MAX_NEW_TOKENS_LIMIT`), and every compile cache — SGLang's
 *   own and its JIT kernels', Triton's, inductor's, FlashInfer's, CUDA's, TileLang's — under the engine
 *   cache, so a second start of the same model reuses the first one's work.
 * - **readiness** `GET /health`, then the shared generation probe; **routes** chat completions,
 *   completions and the model list; requests capped at the output setting, given the sampling defaults
 *   they do not set, refused for tools without a parser, structured output the family does not declare,
 *   and images; SGLang's context overflow answered as OpenAI's `context_length_exceeded` with both
 *   numbers.
 *
 * Log lines, exit wording and error bodies follow SGLang v0.5.21's source
 * (`test/helpers/sglang-log-fixtures.ts`); the live run of task 4.1 confirms or replaces them.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelFamilySupport } from '../../contracts/index.js'
import { withGenerationDefaults } from '../managed-text/generation-defaults.js'
import {
  MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  ManagedRequestRefusal,
  asksForStructuredOutput,
  asksForTools,
  capRequestedOutput,
  carriesMedia,
  reasoningIntoContent,
  thinkingRequested,
  type ManagedEngineLaunch,
  type ManagedExitClassification,
  type ManagedLaunchContext,
  type ManagedRoute,
  type ManagedStageMarker,
  type ManagedTextAdapter,
  type ManagedTextCapabilities,
} from '../managed-text/index.js'
import { validateSglangSettings, type SglangSettings } from './settings.js'

const GiB = 1024 ** 3

/** The port `sglang.launch_server` listens on inside its container (SGLang's own default). */
export const SGLANG_CONTAINER_PORT = 30000

/** What core decides for a launch from the card as it stands right before the container (design D4). */
export interface SglangLaunchPlan {
  /**
   * `--mem-fraction-static`: the share of the memory SGLang finds free at start-up that it keeps for
   * weights and KV cache; the rest is its room for activations and CUDA graphs.
   */
  memFractionStatic: number
  /**
   * The checkpoint has a vision or audio part: SGLang is told it is a language model only, so it
   * reserves nothing for images and refuses them. A text-only model gets no override at all.
   */
  multimodal: boolean
}

function isPlan(value: unknown): value is SglangLaunchPlan {
  if (value === null || typeof value !== 'object') return false
  const plan = value as Record<string, unknown>
  return (
    typeof plan['memFractionStatic'] === 'number' &&
    plan['memFractionStatic'] > 0 &&
    plan['memFractionStatic'] < 1 &&
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

/**
 * Design D5 in SGLang v0.5.21's flags: `auto` captures decode graphs only up to the requests served at
 * once (`--cuda-graph-max-bs-decode`), so they cost little memory; `on` is SGLang's own range; `off`
 * disables both phases. `--disable-cuda-graph` is deprecated in v0.5.21 and never used.
 */
function cudaGraphArgs(settings: SglangSettings): string[] {
  switch (settings.cuda_graphs) {
    case 'auto':
      return ['--cuda-graph-max-bs-decode', String(settings.max_running_requests)]
    case 'on':
      return []
    case 'off':
      return ['--disable-decode-cuda-graph', '--disable-prefill-cuda-graph']
  }
}

/**
 * Every compile cache of the engine, under the engine cache (`ManagedLaunchContext.engineCachePath`).
 * SGLang points the third-party ones at `SGLANG_CACHE_DIR` itself only when nothing imported them yet,
 * and its JIT kernels at `~/.cache/sglang/jit` whatever that says, so each is set here.
 */
function cacheEnv(cache: string): Record<string, string> {
  return {
    SGLANG_CACHE_DIR: `${cache}/sglang`,
    SGLANG_JIT_CACHE_DIR: `${cache}/sglang/jit`,
    TRITON_CACHE_DIR: `${cache}/triton`,
    TORCHINDUCTOR_CACHE_DIR: `${cache}/inductor`,
    FLASHINFER_WORKSPACE_BASE: `${cache}/flashinfer`,
    CUDA_CACHE_PATH: `${cache}/nv`,
    TILELANG_CACHE_DIR: `${cache}/tilelang`,
  }
}

export function buildSglangLaunch(context: ManagedLaunchContext<SglangSettings>): ManagedEngineLaunch {
  if (!isPlan(context.plan)) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'An SGLang launch needs core’s memory plan (its static memory share), computed right before the container is created.'
    )
  }
  const { settings, family } = context
  const argv = [
    'python3',
    '-m',
    'sglang.launch_server',
    '--model-path',
    context.modelPath,
    '--served-model-name',
    context.modelId,
    '--host',
    '0.0.0.0',
    '--port',
    String(SGLANG_CONTAINER_PORT),
    '--context-length',
    String(settings.context_length),
    '--max-running-requests',
    String(settings.max_running_requests),
    '--mem-fraction-static',
    String(Number(context.plan.memFractionStatic.toFixed(4))),
  ]
  if (settings.max_total_tokens !== null) argv.push('--max-total-tokens', String(settings.max_total_tokens))
  if (settings.chunked_prefill_size !== null) {
    argv.push('--chunked-prefill-size', String(settings.chunked_prefill_size))
  }
  if (!settings.enable_prefix_caching) argv.push('--disable-radix-cache')
  if (settings.dtype !== 'auto') argv.push('--dtype', settings.dtype)
  if (settings.seed !== null) argv.push('--random-seed', String(settings.seed))
  argv.push(...cudaGraphArgs(settings))
  if (settings.kv_cache_dtype === 'fp8' && supportsFp8Kv(context.gpuComputeCapability)) {
    argv.push('--kv-cache-dtype', 'fp8_e4m3')
  }
  // The checkpoint's own "text only" declaration, which every class of the descriptor honours (no
  // multimodal reservation, media refused); SGLang's --language-model-only flag accepts only three
  // architectures, none of them ours.
  if (context.plan.multimodal) {
    argv.push('--json-model-override-args', JSON.stringify({ language_model_only: true }))
  }
  if (family?.tool_parser) argv.push('--tool-call-parser', family.tool_parser)
  if (family?.reasoning_parser) argv.push('--reasoning-parser', family.reasoning_parser)
  return {
    engine: { container_port: SGLANG_CONTAINER_PORT },
    argv,
    env: {
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      DO_NOT_TRACK: '1',
      // A request that names no output gets this, then whatever room the context has left: SGLang's
      // scheduler clips rather than refuses, so a long prompt is not refused for the cap's room.
      SGLANG_MAX_NEW_TOKENS_LIMIT: String(settings.max_output_tokens),
      ...cacheEnv(context.engineCachePath),
    },
  }
}

/** A base for engine start-up, the first kernel compilation and graph capture; more per GiB of weights. */
export const SGLANG_READINESS_BASE_MS = 10 * 60_000
export const SGLANG_READINESS_PER_GIB_MS = 20_000

export function sglangReadinessTimeoutMs(weightBytes: number, settings: SglangSettings): number {
  if (settings.load_timeout_seconds !== null) return settings.load_timeout_seconds * 1000
  return Math.ceil(SGLANG_READINESS_BASE_MS + (weightBytes / GiB) * SGLANG_READINESS_PER_GIB_MS)
}

// ---------------------------------------------------------------------------------------------
// Exit classification
// ---------------------------------------------------------------------------------------------

const OOM =
  /CUDA out of memory\. Tried to allocate ([\d.]+) ?(GiB|MiB|KiB).*?of which ([\d.]+) ?(GiB|MiB|KiB|bytes) is free/
/** `mem_cache/kv_cache_configurator.py`: the weights took all of the static share. */
const NO_KV_MEMORY =
  /Loaded weights leave no GPU memory for the KV cache under --mem-fraction-static=([\d.]+)\. Raise --mem-fraction-static above ([\d.]+)/
/** `model_executor/pool_configurator.py`: a KV pool of no tokens. */
const EMPTY_POOL =
  /Not enough memory\. Please try to increase --mem-fraction-static\.(?: Current value: mem_fraction_static=([\d.]+))?/
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

export function classifySglangExit(log: string, exitCode: number | null): ManagedExitClassification {
  const noKv = NO_KV_MEMORY.exec(log)
  if (noKv !== null) {
    return {
      kind: 'out-of-memory',
      message:
        `The model's weights left no GPU memory for the KV cache: SGLang kept a share of ${noKv[1]} of the ` +
        `free memory and needed more than ${noKv[2]}. Free GPU memory, or choose a smaller model.`,
      numbers: { mem_fraction_static: Number(noKv[1]), minimum_mem_fraction_static: Number(noKv[2]) },
      excerpt: noKv[0],
    }
  }
  const empty = EMPTY_POOL.exec(log)
  if (empty !== null) {
    return {
      kind: 'out-of-memory',
      message:
        `The KV cache got no room after the model's weights` +
        (empty[1] === undefined ? '' : ` within SGLang's memory share of ${empty[1]}`) +
        '. Free GPU memory, or choose a smaller model.',
      numbers: empty[1] === undefined ? {} : { mem_fraction_static: Number(empty[1]) },
      excerpt: empty[0],
    }
  }
  const oom = OOM.exec(log)
  if (oom !== null) {
    return {
      kind: 'out-of-memory',
      message: `The GPU ran out of memory: SGLang tried to allocate ${oom[1]} ${oom[2]} with ${oom[3]} ${oom[4]} free.`,
      numbers: {
        requested_gib: round(toGiB(Number(oom[1]), oom[2] as string)),
        free_gib: round(toGiB(Number(oom[3]), oom[4] as string)),
      },
      excerpt: oom[0],
    }
  }
  const arch = UNSUPPORTED_ARCHITECTURE.exec(log)
  if (arch !== null) {
    return {
      kind: 'unsupported-model',
      message: `This SGLang release cannot run the model's architecture: ${arch[1]?.replace(/'/g, '')}.`,
      excerpt: arch[0],
    }
  }
  if (ANY_OOM.test(log)) {
    return { kind: 'out-of-memory', message: 'The GPU ran out of memory while SGLang started.' }
  }
  return {
    kind: 'other',
    message: `SGLang exited${exitCode === null ? '' : ` with code ${exitCode}`} before it was ready.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Capabilities, routes, request and response rewrites
// ---------------------------------------------------------------------------------------------

export function sglangCapabilities(context: {
  settings: SglangSettings
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

/** Everything else SGLang serves — `/server_info`, `/flush_cache`, `/metrics`, embeddings… — is the gateway's 404. */
export const SGLANG_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/completions' },
  { method: 'GET', path: '/v1/models' },
]

export const SGLANG_REWRITABLE_ROUTES: readonly ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/completions' },
]

const REWRITABLE = new Set(SGLANG_REWRITABLE_ROUTES.map((route) => route.path))

/**
 * Caps the output a request asks for at `max_output_tokens` (one key, as the client sent it); a
 * request that asks for none is capped by `SGLANG_MAX_NEW_TOKENS_LIMIT` instead, within the room the
 * context has left. Writes the sampling defaults a request does not set: SGLang's OpenAI path fills
 * every sampling value before `--preferred-sampling-params` would apply. Refuses what the session
 * cannot do with `:1337`'s own wording and code: tools without a parser, structured output the family
 * does not declare, images.
 */
export function sglangRewriteRequestBody(
  route: string,
  body: unknown,
  settings: SglangSettings,
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
  return capRequestedOutput(
    route,
    withGenerationDefaults(client, settings.generation),
    settings.max_output_tokens
  )
}

/**
 * SGLang's 400 wording for a request over the context (`managers/tokenizer_manager.py`), with the
 * limit and the request: the input alone, and the input with the output it asked for.
 */
const OVERFLOW: readonly { pattern: RegExp; limit: number; requested: number }[] = [
  {
    pattern: /The input \((\d+) tokens\) is longer than the model's context length \((\d+) tokens\)/,
    limit: 2,
    requested: 1,
  },
  {
    pattern: /maximum context length of (\d+) tokens\. You requested a total of (\d+) tokens/,
    limit: 1,
    requested: 2,
  },
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

/** SGLang's context overflow as OpenAI's `context_length_exceeded`; anything else relayed as it is. */
export function mapSglangContextLengthError(status: number, body: string): object | null {
  if (status !== 400) return null
  const message = errorMessage(body)
  for (const { pattern, limit, requested } of OVERFLOW) {
    const match = pattern.exec(message)
    if (match === null) continue
    return {
      error: {
        message: `This model's maximum context length is ${match[limit]} tokens, but the request has ${match[requested]} tokens. Shorten the conversation or the requested output.`,
        type: 'invalid_request_error',
        param: 'messages',
        code: 'context_length_exceeded',
      },
    }
  }
  return null
}

/**
 * Reasoning parsers that may file a no-thinking reply under `reasoning_content` (design D3: the same
 * hook as vLLM's). SGLang's `qwen3` parser splits only on the tags it sees when the request turned
 * thinking off, so the hook is a no-op then; it moves what a model thought by its template's default.
 */
export const SGLANG_REASONING_AT_START_PARSERS: ReadonlySet<string> = new Set(['qwen3'])

export function sglangRewriteResponseFor(
  route: string,
  requestBody: unknown,
  family: ModelFamilySupport | null
): ((json: Record<string, unknown>) => Record<string, unknown>) | null {
  if (route !== '/v1/chat/completions') return null
  const parser = family?.reasoning_parser ?? null
  if (parser === null || !SGLANG_REASONING_AT_START_PARSERS.has(parser)) return null
  return thinkingRequested(requestBody) ? null : reasoningIntoContent
}

/**
 * `initializing-engine` from the first line that shows SGLang working on the model: reading weights,
 * sizing the KV pool, capturing CUDA graphs. Before them the load stays in `starting-container`
 * (Python, CUDA and the tokenizer and scheduler processes coming up).
 */
const STAGE_MARKERS: readonly ManagedStageMarker[] = [
  { stage: 'initializing-engine', pattern: /Load weight begin/ },
  { stage: 'initializing-engine', pattern: /Load weight end/ },
  { stage: 'initializing-engine', pattern: /Memory pool end/ },
  { stage: 'initializing-engine', pattern: /Capture .* begin/ },
  { stage: 'initializing-engine', pattern: /max_total_num_tokens=/ },
]

export const sglangAdapter: ManagedTextAdapter<SglangSettings> = {
  id: 'sglang',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/health', expectedStatus: 200 },
  routes: SGLANG_ROUTES,
  rewritableRoutes: SGLANG_REWRITABLE_ROUTES,
  stageMarkers: STAGE_MARKERS,
  validateSettings: (raw) => validateSglangSettings((raw ?? {}) as Record<string, unknown>),
  buildLaunch: buildSglangLaunch,
  readinessTimeoutMs: sglangReadinessTimeoutMs,
  classifyExit: classifySglangExit,
  capabilities: sglangCapabilities,
  rewriteRequestBody: sglangRewriteRequestBody,
  rewriteResponseFor: sglangRewriteResponseFor,
  mapErrorResponse: (_route, status, body) => mapSglangContextLengthError(status, body),
  // Everything SGLang is started with — the output limit too, an environment variable of its launch —
  // and the sampling defaults its gateway writes; only the load timeout is a load's alone.
  restartKey: (settings) => [
    settings.context_length,
    settings.max_output_tokens,
    settings.max_running_requests,
    settings.mem_fraction_static,
    settings.max_total_tokens,
    settings.cuda_graphs,
    settings.kv_cache_dtype,
    settings.enable_prefix_caching,
    settings.chunked_prefill_size,
    settings.dtype,
    settings.seed,
    JSON.stringify(settings.generation),
  ],
}
