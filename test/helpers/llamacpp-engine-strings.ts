/**
 * The text and HTTP surface of upstream llama.cpp that core reads, besides the argv: the log lines it
 * matches (readiness, devices, the failure cascade, MTP rejections), the bodies it matches (context
 * overflow, compute errors, the SSE end), the routes it calls and the response fields it reads. Curated
 * here and pinned into `engine-contract.json` (`strings`, `routes`) by
 * `test/contract/llamacpp-engine-contract.test.ts`, which also checks that every entry's `source` file
 * really holds its `text`, and that every marker in those files has an entry: editing a literal means
 * editing the contract. `test/live/llamacpp-contract.test.ts` checks each entry against a real build.
 *
 * `live_expectation` is what that probe sees on a stock build with its tiny model:
 *  - `observed`: seen on every host; losing it is a `severity_if_lost` finding.
 *  - `not-observed`: known drift, the probe expects not to see it (the `note` says why). A fix that
 *    makes core match what upstream prints moves the entry to `observed`.
 *  - `conditional`: depends on the host or the model (a CUDA build, a reasoning model); recorded only.
 *  - `unobservable`: the probe cannot provoke it (out of memory, a missing macOS symbol).
 */
import { LLAMA_READY_MARKERS } from '../../src/runtime/shared/process.js'
import { DEVICES_HEADER } from '../../src/runtime/llamacpp/devices.js'
import { EMBEDDINGS_PATH, PROPS_PATH } from '../../src/embedding/readiness.js'
import { MODELS_PATH } from '../../src/decision/readiness.js'
import { SYSTEMONE_PATH } from '../../src/decision/service.js'
import { UPSTREAM_DECISION_MIN_BUILD } from '../../src/decision/upstream-version.js'

export type Severity = 'break' | 'warn' | 'info'
export type LiveExpectation = 'observed' | 'not-observed' | 'conditional' | 'unobservable'

export interface ContractString {
  id: string
  text: string
  /** `substring-ci`: anywhere in a line or body, any case. `regex`: a JavaScript pattern, matched with `i`. */
  match: 'substring-ci' | 'regex'
  /** `log`: what `llama-server` prints while it starts and runs; `http`: a response body; `list-devices`: its stdout. */
  channel: 'log' | 'http' | 'list-devices'
  /** The core file that holds `text` literally; `null` when core does not match it yet. */
  source: string | null
  /**
   * What to look for in upstream's source tree when a format string splits `text` (`%s: loaded %s
   * backend`); `null` when the line is not llama.cpp's own (the dynamic loader's, the OS's). Absent:
   * search for `text` itself.
   */
  upstream_text?: string | null
  severity_if_lost: Severity
  live_expectation: LiveExpectation
  note?: string
}

export interface ContractField {
  /** A JSON path: `.` between keys, `[]` for any element of an array. */
  path: string
  /** Which answer of the route carries it: the plain one by default. */
  when?: 'stream' | 'context-overflow'
  /** First build that has it; older builds are not judged. */
  min_build?: number
  source: string | null
  severity_if_lost: Severity
  live_expectation: LiveExpectation
  note?: string
}

export interface ContractRoute {
  id: string
  method: 'GET' | 'POST'
  path: string
  source: string
  /** The literal in `source` when it is not `path`: the public server forwards `/x` to the session's `/v1/x`. */
  source_text?: string
  /** What the session must be started with for the route to answer. */
  requires?: string[]
  min_build?: number
  severity_if_lost: Severity
  live_expectation: LiveExpectation
  fields?: ContractField[]
  note?: string
}

const PROCESS = 'src/runtime/shared/process.ts'
const DEVICE = 'src/runtime/llamacpp/runtime-device.ts'
const CASCADE = 'src/runtime/llamacpp/errors.ts'
const MTP = 'src/models/gguf/classify.ts'
const PUBLIC_ERRORS = 'src/server/public/errors.ts'
const TELEMETRY = 'src/server/public/telemetry.ts'

/** Every readiness marker, keyed by its text: a new one in `LLAMA_READY_MARKERS` fails the sync test. */
const READY: Record<string, Omit<ContractString, 'id' | 'text' | 'match' | 'channel' | 'source'>> = {
  'listening on': {
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: '`llama_server: listening on http://…` (tools/server/server.cpp). Readiness also polls /health every 200 ms, so losing it only delays the ready signal.',
  },
  'all slots are idle': {
    severity_if_lost: 'info',
    live_expectation: 'not-observed',
    note: 'Trace level upstream (SRV_TRC in server-context.cpp): printed only with `-lv 4` or more. Kept for older builds and forks.',
  },
  'starting the main loop': {
    severity_if_lost: 'info',
    live_expectation: 'not-observed',
    note: 'No upstream source prints it any more (only tools/server/tests/README.md mentions it). Kept for older builds.',
  },
  'http server listening': {
    severity_if_lost: 'info',
    live_expectation: 'not-observed',
    note: 'Neither upstream nor the TurboQuant fork prints it.',
  },
}

export function readinessStrings(): ContractString[] {
  return LLAMA_READY_MARKERS.map((text) => {
    const meta = READY[text]
    if (meta === undefined) throw new Error(`readiness marker '${text}' has no contract entry`)
    return {
      id: `ready.${text.replaceAll(' ', '-')}`,
      text,
      match: 'substring-ci' as const,
      channel: 'log' as const,
      source: PROCESS,
      ...meta,
    }
  })
}

const log = (
  id: string,
  text: string,
  source: string | null,
  rest: Omit<ContractString, 'id' | 'text' | 'match' | 'channel' | 'source'>
): ContractString => ({ id, text, match: 'substring-ci', channel: 'log', source, ...rest })

const VERBOSITY_NOTE =
  'A llama library INFO line, hidden at llama-server’s default verbosity (3) on b11642: printed only with `-lv 4`. Until core asks for it, the runtime device report is inconclusive.'

export const CONTRACT_STRINGS: ContractString[] = [
  ...readinessStrings(),

  // Which device the model runs on (runtime-device.ts), and why a GPU build fell back to the CPU.
  log('device.init-error.cuda', 'failed to initialize CUDA', DEVICE, {
    upstream_text: 'failed to initialize " GGML_CUDA_NAME',
    severity_if_lost: 'warn',
    live_expectation: 'conditional',
    note: '`ggml_cuda_init: failed to initialize CUDA: <reason>` on a CUDA build without a usable device (`no CUDA-capable device is detected`).',
  }),
  log('device.init-error.shared-libraries', 'error while loading shared libraries', DEVICE, {
    upstream_text: null,
    severity_if_lost: 'warn',
    live_expectation: 'conditional',
    note: 'The Linux dynamic loader, when a backend library’s dependency (libcudart, libvulkan) is missing.',
  }),
  log('device.init-error.load-backend-failed', 'load_backend: failed to load ', DEVICE, {
    upstream_text: '%s: failed to load %s: %s',
    severity_if_lost: 'info',
    live_expectation: 'unobservable',
    note: 'ggml-backend-reg.cpp, for a backend library that does not load (libcudart missing). Release builds load their backends silently (NDEBUG), so only a debug build or GGML_BACKEND_PATH prints it; the CUDA path probe covers the missing runtime instead.',
  }),
  log('device.init-error.vulkan-no-devices', 'ggml_vulkan: No devices found', DEVICE, {
    severity_if_lost: 'warn',
    live_expectation: 'conditional',
    note: 'A Vulkan build on a host without a Vulkan device.',
  }),
  log('device.init-error.no-usable-gpu', 'no usable GPU found', DEVICE, {
    severity_if_lost: 'warn',
    live_expectation: 'conditional',
    note: 'common/arg.cpp, when `-ngl` is given to a build without GPU offload (the Linux and Windows CPU builds).',
  }),
  log('device.loaded-backend', 'load_backend: loaded ', DEVICE, {
    upstream_text: '%s: loaded %s backend from %s',
    severity_if_lost: 'warn',
    live_expectation: 'conditional',
    note: 'Only builds that load their backends as libraries (Linux, Windows); macOS links Metal in.',
  }),
  log('device.offloaded-layers', 'layers to GPU', DEVICE, {
    upstream_text: 'offloaded %d/%d layers to GPU',
    severity_if_lost: 'warn',
    live_expectation: 'not-observed',
    note: VERBOSITY_NOTE,
  }),
  log('device.repeating-layers', 'repeating layers to GPU', DEVICE, {
    severity_if_lost: 'info',
    live_expectation: 'not-observed',
    note: `A fallback for builds without the \`offloaded N/M\` line. ${VERBOSITY_NOTE}`,
  }),
  log('device.model-buffer', ' model buffer size =', DEVICE, {
    severity_if_lost: 'warn',
    live_expectation: 'not-observed',
    note: VERBOSITY_NOTE,
  }),

  // `classifyStderr`: the ordered cascade that turns a failed start into the app's error codes.
  log('error.os-version.dyld', 'dyld', CASCADE, {
    upstream_text: null,
    severity_if_lost: 'warn',
    live_expectation: 'unobservable',
    note: 'macOS’s loader; with `symbol not found` it means OS_VERSION_UNSUPPORTED.',
  }),
  log('error.os-version.symbol-not-found', 'symbol not found', CASCADE, {
    upstream_text: null,
    severity_if_lost: 'warn',
    live_expectation: 'unobservable',
  }),
  ...(
    [
      ['out of memory', undefined],
      ['failed to allocate', undefined],
      ['insufficient memory', undefined],
      ['erroroutofdevicememory', null],
      ['kiogpucommandbuffercallbackerroroutofmemory', null],
      ['cuda_error_out_of_memory', null],
    ] as const
  ).map(([text, upstream]) =>
    log(`error.oom.${text.replaceAll(' ', '-')}`, text, CASCADE, {
      ...(upstream === null ? { upstream_text: null } : {}),
      severity_if_lost: 'warn',
      live_expectation: 'unobservable',
      note:
        upstream === null
          ? 'The GPU API’s own error name (Vulkan, Metal, CUDA), not a llama.cpp string. OUT_OF_MEMORY.'
          : 'OUT_OF_MEMORY.',
    })
  ),
  log('error.arch.loading-architecture', 'error loading model architecture', CASCADE, {
    severity_if_lost: 'info',
    live_expectation: 'not-observed',
    note: "Gone upstream: an unknown architecture now says only `unknown model architecture: '<name>'`. MODEL_ARCH_NOT_SUPPORTED.",
  }),
  log('error.arch.unknown-architecture', 'unknown model architecture', CASCADE, {
    severity_if_lost: 'break',
    live_expectation: 'observed',
    note: 'MODEL_ARCH_NOT_SUPPORTED: a GGUF whose architecture this build does not know (a newer model).',
  }),
  log('error.arch.loading-hyperparameters', 'error loading model hyperparameters', CASCADE, {
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'MODEL_ARCH_NOT_SUPPORTED: a known architecture missing a key this build requires.',
  }),
  log('error.arch.key-not-found', 'key not found in model', CASCADE, {
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'MODEL_ARCH_NOT_SUPPORTED.',
  }),
  log('error.projector.unknown-type', 'unknown projector type', CASCADE, {
    severity_if_lost: 'warn',
    live_expectation: 'unobservable',
    note: 'MULTIMODAL_PROJECTOR_LOAD_FAILED: a projector this build does not know (tools/mtmd/clip.cpp).',
  }),
  log('error.corrupt.incomplete', 'corrupted or incomplete', CASCADE, {
    severity_if_lost: 'break',
    live_expectation: 'observed',
    note: 'MODEL_FILE_CORRUPT: `tensor … data is not within the file bounds, model is corrupted or incomplete` (an interrupted download).',
  }),
  log('error.corrupt.invalid-magic', 'invalid magic', CASCADE, {
    severity_if_lost: 'break',
    live_expectation: 'observed',
    note: 'MODEL_FILE_CORRUPT: `gguf_init_from_file_impl: invalid magic characters` (not a GGUF at all).',
  }),
  log('error.corrupt.end-of-file', 'unexpectedly reached end of file', CASCADE, {
    severity_if_lost: 'warn',
    live_expectation: 'conditional',
    note: 'MODEL_FILE_CORRUPT: a short read without mmap (src/llama-mmap.cpp); with mmap the bounds check fires first.',
  }),
  log('error.corrupt.read-tensor', 'failed to read tensor', CASCADE, {
    severity_if_lost: 'warn',
    live_expectation: 'conditional',
    note: 'MODEL_FILE_CORRUPT: a file cut inside the tensor table (ggml/src/gguf.cpp).',
  }),
  log('error.corrupt.tensor-count', 'wrong number of tensors', CASCADE, {
    severity_if_lost: 'warn',
    live_expectation: 'conditional',
    note: 'MODEL_FILE_CORRUPT upstream; MODEL_ARCH_NOT_SUPPORTED on the TurboQuant fork, whose tensor layout can differ.',
  }),

  log('error.argument.unknown', 'error: invalid argument: ', CASCADE, {
    upstream_text: 'error: invalid argument: %s',
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'A flag the build does not know (common/arg.cpp): the process error, with words that say so.',
  }),
  log('error.argument.bad-value', 'error while handling argument', CASCADE, {
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'A value the build refuses, e.g. `--flash-attn bogus` (common/arg.cpp).',
  }),

  // MTP rejections (classify.ts): llama.cpp has no code for them, so the text is the contract.
  ...(
    [
      ['mtp.create-context', 'failed to create MTP context', undefined],
      ['mtp.context-type', 'context type MTP requested', undefined],
      ['mtp.no-layers', "doesn'?t contain MTP layers", 'contain MTP layers'],
    ] as const
  ).map(([id, text, upstream]): ContractString => ({
    id,
    text,
    match: 'regex',
    channel: 'log',
    source: MTP,
    ...(upstream === undefined ? {} : { upstream_text: upstream }),
    severity_if_lost: 'warn',
    live_expectation: 'unobservable',
    note: 'Needs a model with an MTP head and a draft; the load is retried without MTP.',
  })),

  {
    id: 'list-devices.header',
    text: DEVICES_HEADER,
    match: 'substring-ci',
    channel: 'list-devices',
    source: 'src/runtime/llamacpp/devices.ts',
    severity_if_lost: 'break',
    live_expectation: 'observed',
    note: 'Without it `parseDeviceOutput` throws DEVICE_LIST_PARSE_FAILED and no device is offered.',
  },

  // Bodies the public server reads before it answers the client.
  {
    id: 'http.context-overflow.upstream',
    text: 'request \\(\\d+ tokens\\) exceeds the available context size',
    match: 'regex',
    channel: 'http',
    source: PUBLIC_ERRORS,
    upstream_text: 'exceeds the available context size',
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'The 400 upstream, TurboQuant and Prism answer when a prompt does not fit: core reloads with a larger context.',
  },
  {
    id: 'http.context-overflow.type',
    text: 'exceed_context_size_error',
    match: 'substring-ci',
    channel: 'http',
    source: PUBLIC_ERRORS,
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'The `error.type` of that 400, also sent for `input (N tokens) is larger than the max context size`.',
  },
  {
    id: 'http.context-overflow.literal',
    text: 'the request exceeds the available context size',
    match: 'substring-ci',
    channel: 'http',
    source: PUBLIC_ERRORS,
    severity_if_lost: 'info',
    live_expectation: 'not-observed',
    note: 'Older builds’ wording: neither upstream nor TurboQuant nor Prism prints it today. Kept for those builds.',
  },
  ...[
    'compute error',
    'failed to decode',
    'failed to compute graph',
    'backend is in error state',
    'ggml_backend_sched_graph_compute',
  ].map((text): ContractString => ({
    id: `http.compute-error.${text.replaceAll(' ', '-')}`,
    text,
    match: 'substring-ci',
    channel: 'http',
    source: PUBLIC_ERRORS,
    severity_if_lost: 'warn',
    live_expectation: 'unobservable',
    note: 'A 500 after which the ggml backend is unusable: core restarts the session.',
  })),
  {
    id: 'http.sse.done',
    text: '[DONE]',
    match: 'substring-ci',
    channel: 'http',
    source: 'src/server/public/sse.ts',
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'The last event of a streamed chat; without it core closes the answer when the upstream body ends.',
  },
]

const field = (
  path: string,
  source: string | null,
  severity_if_lost: Severity,
  live_expectation: LiveExpectation,
  extra: Partial<Pick<ContractField, 'when' | 'min_build' | 'note'>> = {}
): ContractField => ({
  path,
  ...(extra.when ? { when: extra.when } : {}),
  ...(extra.min_build ? { min_build: extra.min_build } : {}),
  source,
  severity_if_lost,
  live_expectation,
  ...(extra.note ? { note: extra.note } : {}),
})

export const CONTRACT_ROUTES: ContractRoute[] = [
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    source: 'src/runtime/llamacpp/runtime.ts',
    severity_if_lost: 'break',
    live_expectation: 'observed',
    note: 'The readiness poll; 503 while the model loads.',
  },
  {
    id: 'props',
    method: 'GET',
    path: PROPS_PATH,
    source: 'src/embedding/readiness.ts',
    severity_if_lost: 'break',
    live_expectation: 'observed',
    fields: [
      field('modalities', 'src/embedding/readiness.ts', 'warn', 'observed', {
        note: 'What an embedding input may hold (`vision`, `audio`, `video`).',
      }),
      field('default_generation_settings.n_ctx', null, 'info', 'observed', {
        note: 'The context window the server actually runs with; core reads the configured one instead.',
      }),
    ],
  },
  {
    id: 'models',
    method: 'GET',
    path: MODELS_PATH,
    source: 'src/decision/readiness.ts',
    severity_if_lost: 'break',
    live_expectation: 'observed',
    note: 'Behind the API key like every route but /health.',
    fields: [
      field('data[].id', 'src/decision/readiness.ts', 'warn', 'observed'),
      field('data[].architecture.output_modalities', 'src/decision/readiness.ts', 'break', 'observed', {
        min_build: UPSTREAM_DECISION_MIN_BUILD,
        note: '`["decisions"]` is how an upstream decision process says it is ready (b11370 on).',
      }),
      field('data[].architecture.input_modalities', 'src/decision/readiness.ts', 'warn', 'observed', {
        min_build: UPSTREAM_DECISION_MIN_BUILD,
      }),
      field('models[].capabilities', 'src/decision/readiness.ts', 'info', 'observed', {
        note: 'Read for the TurboQuant `decision` capability; upstream lists `completion`.',
      }),
      field('data[].meta.n_ctx', null, 'info', 'observed'),
    ],
  },
  {
    id: 'chat-completions',
    method: 'POST',
    path: '/v1/chat/completions',
    source: 'src/server/public/index.ts',
    source_text: '/chat/completions',
    severity_if_lost: 'break',
    live_expectation: 'observed',
    fields: [
      field('choices[].message.content', TELEMETRY, 'break', 'observed'),
      field('choices[].finish_reason', PUBLIC_ERRORS, 'warn', 'observed', {
        note: '`length` without a client cap is read as a context overflow.',
      }),
      field('usage.prompt_tokens', TELEMETRY, 'warn', 'observed'),
      field('usage.completion_tokens', TELEMETRY, 'warn', 'observed'),
      field('timings.prompt_n', TELEMETRY, 'warn', 'observed'),
      field('timings.predicted_n', TELEMETRY, 'warn', 'observed'),
      field('timings.prompt_per_second', TELEMETRY, 'info', 'observed'),
      field('timings.predicted_per_second', TELEMETRY, 'info', 'observed'),
      field('choices[].message.reasoning_content', TELEMETRY, 'warn', 'conditional', {
        note: 'Only a reasoning model with a reasoning format fills it.',
      }),
      field('choices[].delta.content', TELEMETRY, 'break', 'observed', { when: 'stream' }),
      field('timings.predicted_n', TELEMETRY, 'warn', 'observed', { when: 'stream' }),
      field('error.message', PUBLIC_ERRORS, 'break', 'observed', { when: 'context-overflow' }),
      field('error.type', PUBLIC_ERRORS, 'warn', 'observed', { when: 'context-overflow' }),
      field('error.n_prompt_tokens', null, 'info', 'observed', { when: 'context-overflow' }),
      field('error.n_ctx', null, 'info', 'observed', { when: 'context-overflow' }),
    ],
  },
  {
    id: 'completions',
    method: 'POST',
    path: '/v1/completions',
    source: 'src/server/public/index.ts',
    source_text: '/completions',
    severity_if_lost: 'warn',
    live_expectation: 'observed',
  },
  {
    id: 'embeddings',
    method: 'POST',
    path: EMBEDDINGS_PATH,
    source: 'src/embedding/readiness.ts',
    severity_if_lost: 'break',
    live_expectation: 'observed',
    note: 'Answers 501 on a server started without `--embedding`; test/live/embedding-upstream.test.ts covers the vectors.',
  },
  {
    id: 'messages',
    method: 'POST',
    path: '/v1/messages',
    source: 'src/server/public/index.ts',
    source_text: '/messages',
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'Without it core translates Anthropic messages to chat completions itself.',
  },
  {
    id: 'messages-count-tokens',
    method: 'POST',
    path: '/v1/messages/count_tokens',
    source: 'src/server/public/index.ts',
    source_text: '/messages/count_tokens',
    severity_if_lost: 'warn',
    live_expectation: 'observed',
  },
  {
    id: 'metrics',
    method: 'GET',
    path: '/metrics',
    source: 'src/server/public/listing.ts',
    requires: ['--metrics'],
    severity_if_lost: 'warn',
    live_expectation: 'observed',
    note: 'Prometheus text at the root, behind the key; 501 `not_supported_error` without `--metrics`.',
  },
  {
    id: 'systemone',
    method: 'POST',
    path: SYSTEMONE_PATH,
    source: 'src/decision/service.ts',
    min_build: UPSTREAM_DECISION_MIN_BUILD,
    severity_if_lost: 'break',
    live_expectation: 'observed',
    note: 'Answers 501 for a model that is not a decision model; test/live/decision-upstream.test.ts covers the answers.',
  },
]
