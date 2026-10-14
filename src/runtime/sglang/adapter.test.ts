import { describe, expect, it } from 'vitest'
import type { ModelFamilySupport } from '../../contracts/index.js'
import type { ManagedLaunchContext } from '../managed-text/index.js'
import { ManagedRequestRefusal, ManagedTextAdapterRegistry } from '../managed-text/index.js'
import {
  SGLANG_CONTEXT_OVERFLOW_BODIES,
  SGLANG_CONTEXT_TOO_LONG_LOG,
  SGLANG_NOT_ENOUGH_MEMORY_LOG,
  SGLANG_NO_KV_MEMORY_LOG,
  SGLANG_OOM_LOG,
  SGLANG_OTHER_LOG,
  SGLANG_START_LOG,
  SGLANG_UNSUPPORTED_ARCHITECTURE_LOG,
} from '../../../test/helpers/sglang-log-fixtures.js'
import { sglangAdapter, type SglangLaunchPlan } from './adapter.js'
import { sglangSettings, type SglangSettings } from './settings.js'

/** Change `add-sglang-runtime`, task 2.2 (design D3, D5; spec `sglang-runtime`). */
const GiB = 1024 ** 3
const family = (over: Partial<ModelFamilySupport> = {}): ModelFamilySupport => ({
  tool_parser: 'qwen3_coder',
  reasoning_parser: 'qwen3',
  structured_output: true,
  ...over,
})
const PLAN: SglangLaunchPlan = { memFractionStatic: 0.7234, multimodal: true }
const context = (
  over: Partial<ManagedLaunchContext<SglangSettings>> = {}
): ManagedLaunchContext<SglangSettings> => ({
  modelId: 'Qwen/Qwen3.5-2B',
  settings: sglangSettings({}),
  modelPath: '/atomic/model',
  engineCachePath: '/atomic/engine-cache',
  generationFilesPath: '/atomic/run',
  weightBytes: 4 * GiB,
  family: family(),
  unifiedMemory: false,
  gpuTotalVramBytes: 8 * GiB,
  gpuComputeCapability: '8.9',
  plan: PLAN,
  ...over,
})
const argvOf = (over: Partial<ManagedLaunchContext<SglangSettings>> = {}) =>
  sglangAdapter.buildLaunch(context(over)).argv
const flag = (argv: string[], name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined

describe('the sglang adapter', () => {
  it('registers as sglang under the shared contract, with /health as readiness', () => {
    const registry = new ManagedTextAdapterRegistry()
    registry.register(sglangAdapter)
    expect(registry.resolve('sglang', 1)).toBe(sglangAdapter)
    expect(sglangAdapter.readiness).toEqual({ path: '/health', expectedStatus: 200 })
  })

  // Scenario "Движок отвечает на health, но не генерирует": ready only once one token was generated.
  it('proves a ready engine generates: one token through the chat route before ready', () => {
    expect(sglangAdapter.generationProbe).toEqual({
      modelsPath: '/v1/models',
      path: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false },
    })
  })
})

describe('buildLaunch: argv', () => {
  it('serves the mounted model under its id, on the container port, with core’s static share', () => {
    const launch = sglangAdapter.buildLaunch(context())
    expect(launch.engine.container_port).toBe(30000)
    expect(launch.argv.slice(0, 3)).toEqual(['python3', '-m', 'sglang.launch_server'])
    expect(flag(launch.argv, '--model-path')).toBe('/atomic/model')
    expect(flag(launch.argv, '--served-model-name')).toBe('Qwen/Qwen3.5-2B')
    expect(flag(launch.argv, '--host')).toBe('0.0.0.0')
    expect(flag(launch.argv, '--port')).toBe('30000')
    expect(flag(launch.argv, '--context-length')).toBe('8192')
    expect(flag(launch.argv, '--max-running-requests')).toBe('1')
    expect(flag(launch.argv, '--mem-fraction-static')).toBe('0.7234')
  })

  it('values left at their defaults are not passed: SGLang keeps its own', () => {
    const argv = argvOf({ plan: { ...PLAN, multimodal: false }, family: null })
    for (const absent of [
      '--max-total-tokens',
      '--chunked-prefill-size',
      '--disable-radix-cache',
      '--dtype',
      '--random-seed',
      '--kv-cache-dtype',
      '--disable-decode-cuda-graph',
      '--disable-prefill-cuda-graph',
      '--json-model-override-args',
      '--tool-call-parser',
      '--reasoning-parser',
      '--preferred-sampling-params',
    ]) {
      expect(argv, absent).not.toContain(absent)
    }
  })

  it('passes every further option the settings set', () => {
    const argv = argvOf({
      settings: sglangSettings({
        max_running_requests: 2,
        max_total_tokens: 16384,
        chunked_prefill_size: 2048,
        enable_prefix_caching: false,
        dtype: 'bfloat16',
        seed: 7,
      }),
    })
    expect(flag(argv, '--max-running-requests')).toBe('2')
    expect(flag(argv, '--max-total-tokens')).toBe('16384')
    expect(flag(argv, '--chunked-prefill-size')).toBe('2048')
    expect(argv).toContain('--disable-radix-cache')
    expect(flag(argv, '--dtype')).toBe('bfloat16')
    expect(flag(argv, '--random-seed')).toBe('7')
  })

  // Scenario "Окружение и аргументы контейнера".
  it('Окружение и аргументы контейнера: never --trust-remote-code, --log-requests, an API key or metrics, whatever the settings', () => {
    const argv = argvOf({
      settings: sglangSettings({
        trust_remote_code: true,
        log_requests: true,
        api_key: 'k',
        admin_api_key: 'a',
        enable_metrics: true,
      }),
    })
    for (const forbidden of [
      '--trust-remote-code',
      '--log-requests',
      '--api-key',
      '--admin-api-key',
      '--enable-metrics',
    ]) {
      expect(argv).not.toContain(forbidden)
    }
  })

  it('Окружение и аргументы контейнера: Hugging Face offline, no tracking, every compile cache in the engine cache', () => {
    const { env } = sglangAdapter.buildLaunch(context())
    expect(env).toMatchObject({
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      DO_NOT_TRACK: '1',
      SGLANG_CACHE_DIR: '/atomic/engine-cache/sglang',
      SGLANG_JIT_CACHE_DIR: '/atomic/engine-cache/sglang/jit',
      TRITON_CACHE_DIR: '/atomic/engine-cache/triton',
      TORCHINDUCTOR_CACHE_DIR: '/atomic/engine-cache/inductor',
      FLASHINFER_WORKSPACE_BASE: '/atomic/engine-cache/flashinfer',
      CUDA_CACHE_PATH: '/atomic/engine-cache/nv',
      TILELANG_CACHE_DIR: '/atomic/engine-cache/tilelang',
    })
    for (const value of Object.values(env ?? {}).filter((v) => v.startsWith('/'))) {
      expect(value.startsWith('/atomic/engine-cache/')).toBe(true)
    }
  })

  it('accepts text only: a multimodal checkpoint is told it is a language model only; a text-only one gets nothing', () => {
    expect(JSON.parse(flag(argvOf(), '--json-model-override-args') ?? '{}')).toEqual({
      language_model_only: true,
    })
    expect(argvOf({ plan: { ...PLAN, multimodal: false } })).not.toContain('--json-model-override-args')
    // SGLang v0.5.21 refuses its --language-model-only flag for every architecture of the descriptor.
    expect(argvOf()).not.toContain('--language-model-only')
  })

  it('FP8 KV only on compute capability 8.9 and newer; the model’s own precision elsewhere', () => {
    const fp8 = sglangSettings({ kv_cache_dtype: 'fp8' })
    expect(flag(argvOf({ settings: fp8, gpuComputeCapability: '8.9' }), '--kv-cache-dtype')).toBe('fp8_e4m3')
    expect(flag(argvOf({ settings: fp8, gpuComputeCapability: '12.0' }), '--kv-cache-dtype')).toBe('fp8_e4m3')
    expect(argvOf({ settings: fp8, gpuComputeCapability: '8.6' })).not.toContain('--kv-cache-dtype')
    expect(argvOf({ settings: fp8, gpuComputeCapability: null })).not.toContain('--kv-cache-dtype')
    expect(argvOf({ gpuComputeCapability: '9.0' })).not.toContain('--kv-cache-dtype')
  })

  it('CUDA graphs: auto captures decode graphs up to the parallel requests, on is SGLang’s own, off disables both phases', () => {
    const auto = argvOf({ settings: sglangSettings({ max_running_requests: 3 }) })
    expect(flag(auto, '--cuda-graph-max-bs-decode')).toBe('3')
    expect(auto).not.toContain('--disable-decode-cuda-graph')
    const on = argvOf({ settings: sglangSettings({ cuda_graphs: 'on' }) })
    expect(on).not.toContain('--cuda-graph-max-bs-decode')
    expect(on).not.toContain('--disable-decode-cuda-graph')
    const off = argvOf({ settings: sglangSettings({ cuda_graphs: 'off' }) })
    expect(off).toContain('--disable-decode-cuda-graph')
    expect(off).toContain('--disable-prefill-cuda-graph')
    expect(off).not.toContain('--cuda-graph-max-bs-decode')
    // The deprecated spelling of v0.5.21 is never used.
    expect(off).not.toContain('--disable-cuda-graph')
  })

  it('passes the family’s parsers, and none when the family has none', () => {
    const argv = argvOf()
    expect(flag(argv, '--tool-call-parser')).toBe('qwen3_coder')
    expect(flag(argv, '--reasoning-parser')).toBe('qwen3')
    const bare = argvOf({ family: family({ tool_parser: null, reasoning_parser: null }) })
    expect(bare).not.toContain('--tool-call-parser')
    expect(bare).not.toContain('--reasoning-parser')
    expect(argvOf({ family: null })).not.toContain('--tool-call-parser')
  })

  // Scenario "Длинный промпт без max_tokens": SGLang's scheduler caps a request that names no output at
  // this limit and then at the room left in the context; it refuses nothing.
  it('Длинный промпт без max_tokens: the output setting is SGLang’s own limit for a request that names none', () => {
    const { env } = sglangAdapter.buildLaunch(
      context({ settings: sglangSettings({ max_output_tokens: 4096 }) })
    )
    expect(env?.['SGLANG_MAX_NEW_TOKENS_LIMIT']).toBe('4096')
  })

  it('refuses to launch without core’s memory plan: the static share is never guessed', () => {
    const { plan: _plan, ...noPlan } = context()
    expect(() => sglangAdapter.buildLaunch(noPlan as ManagedLaunchContext<SglangSettings>)).toThrow(
      /memory plan/
    )
    expect(() =>
      sglangAdapter.buildLaunch(context({ plan: { memFractionStatic: 1, multimodal: false } }))
    ).toThrow(/memory plan/)
  })
})

describe('capabilities — Возможности модели sglang объявляются, а не угадываются', () => {
  it('tools and reasoning only with a parser, structured output only as the family says; never vision, embeddings or Responses', () => {
    expect(sglangAdapter.capabilities({ settings: sglangSettings({}), family: family() })).toEqual({
      tools: true,
      reasoning: true,
      structured_output: true,
      vision: false,
      embeddings: false,
      responses: false,
    })
    expect(
      sglangAdapter.capabilities({
        settings: sglangSettings({}),
        family: family({ tool_parser: null, reasoning_parser: null, structured_output: false }),
      })
    ).toMatchObject({ tools: false, reasoning: false, structured_output: false })
    expect(sglangAdapter.capabilities({ settings: sglangSettings({}), family: null })).toMatchObject({
      tools: false,
    })
  })
})

describe('the gateway routes and request rewrites', () => {
  const settings = sglangSettings({ max_output_tokens: 1000 })
  const caps = (over: Partial<ReturnType<typeof sglangAdapter.capabilities>> = {}) => ({
    ...sglangAdapter.capabilities({ settings, family: family() }),
    ...over,
  })
  const rewrite = (route: string, body: unknown, capabilities = caps(), with_ = settings) =>
    sglangAdapter.rewriteRequestBody?.(route, body, with_, capabilities)

  // Scenario "Служебный маршрут движка": the gateway answers 404 for any route not declared here.
  it('Служебный маршрут движка: declares only chat, completions and the model list; the two POST routes are rewritable', () => {
    expect(sglangAdapter.routes).toEqual([
      { method: 'POST', path: '/v1/chat/completions' },
      { method: 'POST', path: '/v1/completions' },
      { method: 'GET', path: '/v1/models' },
    ])
    expect(sglangAdapter.rewritableRoutes).toEqual([
      { method: 'POST', path: '/v1/chat/completions' },
      { method: 'POST', path: '/v1/completions' },
    ])
    for (const path of ['/v1/embeddings', '/server_info', '/flush_cache', '/metrics', '/health_generate']) {
      expect(sglangAdapter.routes.some((route) => route.path === path)).toBe(false)
    }
  })

  it('caps the output a client asks for at the setting, and adds none when it asked for none', () => {
    // SGLang refuses input + max_tokens over the context: a cap written into every request would refuse
    // a long prompt that still fits. SGLANG_MAX_NEW_TOKENS_LIMIT covers the request that names none.
    expect(rewrite('/v1/chat/completions', { messages: [] })).toEqual({ messages: [] })
    expect(rewrite('/v1/completions', { prompt: 'x' })).toEqual({ prompt: 'x' })
    expect(rewrite('/v1/chat/completions', { messages: [], max_tokens: 5000 })).toEqual({
      messages: [],
      max_tokens: 1000,
    })
    expect(rewrite('/v1/chat/completions', { messages: [], max_completion_tokens: 5000 })).toEqual({
      messages: [],
      max_completion_tokens: 1000,
    })
    expect(rewrite('/v1/completions', { prompt: 'x', max_tokens: 10 })).toEqual({
      prompt: 'x',
      max_tokens: 10,
    })
    expect(() => rewrite('/v1/completions', { prompt: 'x', max_tokens: 0 })).toThrow(/positive integer/)
  })

  it('writes the sampling defaults into a request that sets none, and never over the client’s own', () => {
    // SGLang's OpenAI path fills every sampling value before --preferred-sampling-params is read, so
    // the defaults travel in the request.
    const withDefaults = sglangSettings({
      max_output_tokens: 1000,
      default_temperature: 0.6,
      default_top_k: 20,
    })
    expect(rewrite('/v1/chat/completions', { messages: [] }, caps(), withDefaults)).toEqual({
      messages: [],
      temperature: 0.6,
      top_k: 20,
    })
    expect(rewrite('/v1/completions', { prompt: 'x', temperature: 0 }, caps(), withDefaults)).toEqual({
      prompt: 'x',
      temperature: 0,
      top_k: 20,
    })
  })

  // Scenario "Модель без парсера tools".
  it('Модель без парсера tools: a request with tools is refused as an unsupported capability', () => {
    const call = () =>
      rewrite('/v1/chat/completions', { tools: [{ type: 'function' }] }, caps({ tools: false }))
    expect(call).toThrow(ManagedRequestRefusal)
    expect(call).toThrow(/does not support tool calling/)
    expect(() =>
      rewrite(
        '/v1/chat/completions',
        { response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } } },
        caps({ structured_output: false })
      )
    ).toThrow(/does not support structured output/)
  })

  // Scenario "Изображение в запросе".
  it('Изображение в запросе: a message with an image is refused, whatever the model', () => {
    const body = {
      model: 'Qwen/Qwen3.5-2B',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: 'data:' } },
          ],
        },
      ],
    }
    expect(() => rewrite('/v1/chat/completions', body)).toThrow(/does not support images/)
    try {
      rewrite('/v1/chat/completions', body)
    } catch (error) {
      expect((error as ManagedRequestRefusal).openaiCode).toBe('unsupported_capability')
    }
  })
})

// Scenario "Длинная переписка".
describe('Переполнение контекста sglang без авто-роста', () => {
  it.each(Object.entries(SGLANG_CONTEXT_OVERFLOW_BODIES))(
    'Длинная переписка: maps the %s wording to context_length_exceeded with both numbers',
    (kind, body) => {
      const mapped = sglangAdapter.mapErrorResponse?.('/v1/chat/completions', 400, body) as {
        error: { code: string; message: string; type: string }
      } | null
      expect(mapped?.error.code).toBe('context_length_exceeded')
      expect(mapped?.error.type).toBe('invalid_request_error')
      expect(mapped?.error.message).toMatch(/8192/)
      expect(mapped?.error.message).toMatch(kind === 'input' ? /9000/ : /9100/)
    }
  )

  it('relays every other error as it is, and never grows the context', () => {
    expect(
      sglangAdapter.mapErrorResponse?.('/v1/chat/completions', 400, '{"object":"error","message":"bad"}')
    ).toBeNull()
    expect(
      sglangAdapter.mapErrorResponse?.('/v1/chat/completions', 500, SGLANG_CONTEXT_OVERFLOW_BODIES.input)
    ).toBeNull()
  })
})

describe('Ответ с выключенными размышлениями приходит в content', () => {
  const rewriteFor = (body: unknown) =>
    sglangAdapter.rewriteResponseFor?.('/v1/chat/completions', body, family())
  it('moves reasoning into content when the request did not turn thinking on, and leaves it otherwise', () => {
    const answer = () => ({ choices: [{ message: { content: '', reasoning_content: 'Hello' } }] })
    expect(rewriteFor({ messages: [] })?.(answer())).toEqual({
      choices: [{ message: { content: 'Hello', reasoning_content: null } }],
    })
    expect(rewriteFor({ chat_template_kwargs: { enable_thinking: true } })).toBeNull()
    expect(
      sglangAdapter.rewriteResponseFor?.('/v1/chat/completions', {}, family({ reasoning_parser: null }))
    ).toBeNull()
  })
})

describe('Этапы и таймаут загрузки SGLang', () => {
  it('marks initializing-engine from the weights, the KV pool and the graph capture', () => {
    const lines = SGLANG_START_LOG.split('\n')
    const marked = lines.filter((line) =>
      sglangAdapter.stageMarkers.some((marker) => marker.pattern.test(line))
    )
    expect(sglangAdapter.stageMarkers.every((marker) => marker.stage === 'initializing-engine')).toBe(true)
    expect(marked.some((line) => /Load weight begin/.test(line))).toBe(true)
    expect(marked.some((line) => /Memory pool end/.test(line))).toBe(true)
    expect(marked.some((line) => /Capture decode cuda graph begin/.test(line))).toBe(true)
    expect(marked.length).toBeGreaterThanOrEqual(4)
  })

  it('times out from the weights with room for a first compilation, and a setting overrides it', () => {
    const small = sglangAdapter.readinessTimeoutMs(4 * GiB, sglangSettings({}))
    const large = sglangAdapter.readinessTimeoutMs(40 * GiB, sglangSettings({}))
    expect(small).toBe(10 * 60_000 + 4 * 20_000)
    expect(large).toBeGreaterThan(small)
    expect(sglangAdapter.readinessTimeoutMs(4 * GiB, sglangSettings({ load_timeout_seconds: 90 }))).toBe(
      90_000
    )
  })

  it('classifies CUDA out of memory with its numbers', () => {
    const oom = sglangAdapter.classifyExit(SGLANG_OOM_LOG, 1)
    expect(oom.kind).toBe('out-of-memory')
    expect(oom.numbers).toEqual({ requested_gib: 1.17, free_gib: 0.5 })
    expect(oom.message).toMatch(/1\.17 GiB/)
  })

  // Scenario "Веса не оставляют места под KV-cache".
  it('classifies the weights leaving no memory for the KV cache, with the share and the least that would do', () => {
    const noKv = sglangAdapter.classifyExit(SGLANG_NO_KV_MEMORY_LOG, 1)
    expect(noKv.kind).toBe('out-of-memory')
    expect(noKv.numbers).toEqual({ mem_fraction_static: 0.75, minimum_mem_fraction_static: 0.812 })
    expect(noKv.message).toMatch(/0\.75/)
    expect(noKv.message).toMatch(/0\.812/)
  })

  it('classifies a KV pool of no tokens as out of memory, with the share', () => {
    const empty = sglangAdapter.classifyExit(SGLANG_NOT_ENOUGH_MEMORY_LOG, 1)
    expect(empty.kind).toBe('out-of-memory')
    expect(empty.numbers).toEqual({ mem_fraction_static: 0.7 })
    expect(empty.message).toMatch(/0\.7/)
  })

  it('classifies a context setting longer than the model’s own, with both numbers and what to change', () => {
    const tooLong = sglangAdapter.classifyExit(SGLANG_CONTEXT_TOO_LONG_LOG, 1)
    expect(tooLong.kind).toBe('other')
    expect(tooLong.numbers).toEqual({ context_length: 8192, model_context_length: 4096 })
    expect(tooLong.message).toMatch(/context length 8192 .*model.*4096.*Lower the context length/)
  })

  it('classifies an unknown architecture and anything else', () => {
    const arch = sglangAdapter.classifyExit(SGLANG_UNSUPPORTED_ARCHITECTURE_LOG, 1)
    expect(arch.kind).toBe('unsupported-model')
    expect(arch.message).toMatch(/FancyNewForCausalLM/)
    const other = sglangAdapter.classifyExit(SGLANG_OTHER_LOG, 1)
    expect(other.kind).toBe('other')
    expect(other.message).toMatch(/SGLang exited with code 1/)
  })
})

describe('restartKey', () => {
  it('every setting but the load timeout restarts the container (the output cap is a launch limit too)', () => {
    const key = (stored: Record<string, unknown>) =>
      JSON.stringify(sglangAdapter.restartKey?.(sglangSettings(stored)))
    expect(key({ load_timeout_seconds: 60 })).toBe(key({}))
    for (const changed of [
      { context_length: 16384 },
      { max_output_tokens: 100 },
      { max_running_requests: 2 },
      { mem_fraction_static: 0.7 },
      { max_total_tokens: 4096 },
      { cuda_graphs: 'off' },
      { kv_cache_dtype: 'fp8' },
      { enable_prefix_caching: false },
      { chunked_prefill_size: 2048 },
      { dtype: 'float16' },
      { seed: 3 },
      { default_temperature: 0.2 },
    ]) {
      expect(key(changed), JSON.stringify(changed)).not.toBe(key({}))
    }
  })
})
