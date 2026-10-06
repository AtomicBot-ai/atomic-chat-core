import { describe, expect, it } from 'vitest'
import type { ModelFamilySupport } from '../../contracts/index.js'
import type { ManagedLaunchContext } from '../managed-text/index.js'
import { ManagedRequestRefusal, ManagedTextAdapterRegistry } from '../managed-text/index.js'
import {
  VLLM_CONTEXT_OVERFLOW_BODIES,
  VLLM_FREE_MEMORY_DEVICE_LOG,
  VLLM_FREE_MEMORY_LOG,
  VLLM_KV_TOO_SMALL_LOG,
  VLLM_OOM_LOG,
  VLLM_OTHER_LOG,
  VLLM_START_LOG,
  VLLM_UNSUPPORTED_ARCHITECTURE_LOG,
} from '../../../test/helpers/vllm-log-fixtures.js'
import { vllmAdapter, type VllmLaunchPlan } from './adapter.js'
import { vllmSettings, type VllmSettings } from './settings.js'

/** Change `add-vllm-runtime`, task 3.2 (design D8; spec `vllm-runtime`). */
const GiB = 1024 ** 3
const family = (over: Partial<ModelFamilySupport> = {}): ModelFamilySupport => ({
  tool_parser: 'qwen3_coder',
  reasoning_parser: 'qwen3',
  structured_output: true,
  ...over,
})
const PLAN: VllmLaunchPlan = {
  kvCacheMemoryBytes: 1_610_612_736,
  gpuMemoryUtilization: 0.87,
  multimodal: true,
}
const context = (
  over: Partial<ManagedLaunchContext<VllmSettings>> = {}
): ManagedLaunchContext<VllmSettings> => ({
  modelId: 'Qwen/Qwen3.5-2B',
  settings: vllmSettings({}),
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
const argvOf = (over: Partial<ManagedLaunchContext<VllmSettings>> = {}) =>
  vllmAdapter.buildLaunch(context(over)).argv
const flag = (argv: string[], name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined

describe('the vllm adapter', () => {
  it('registers as vllm under the shared contract, with /health as readiness', () => {
    const registry = new ManagedTextAdapterRegistry()
    registry.register(vllmAdapter)
    expect(registry.resolve('vllm', 1)).toBe(vllmAdapter)
    expect(vllmAdapter.readiness).toEqual({ path: '/health', expectedStatus: 200 })
  })
})

describe('buildLaunch: argv', () => {
  it('serves the mounted model under its id, on the container port, with core’s KV bytes and memory share', () => {
    const launch = vllmAdapter.buildLaunch(context())
    expect(launch.engine.container_port).toBe(8000)
    expect(launch.argv.slice(0, 3)).toEqual(['vllm', 'serve', '/atomic/model'])
    expect(flag(launch.argv, '--served-model-name')).toBe('Qwen/Qwen3.5-2B')
    expect(flag(launch.argv, '--host')).toBe('0.0.0.0')
    expect(flag(launch.argv, '--port')).toBe('8000')
    expect(flag(launch.argv, '--max-model-len')).toBe('8192')
    expect(flag(launch.argv, '--max-num-seqs')).toBe('1')
    expect(flag(launch.argv, '--kv-cache-memory-bytes')).toBe('1610612736')
    expect(flag(launch.argv, '--gpu-memory-utilization')).toBe('0.87')
  })

  it('Контейнер vLLM не обращается в сеть: never --trust-remote-code, --enable-log-requests or --api-key, whatever the settings', () => {
    const argv = argvOf({
      settings: vllmSettings({ trust_remote_code: true, enable_log_requests: true, api_key: 'k' }),
    })
    for (const forbidden of ['--trust-remote-code', '--enable-log-requests', '--api-key']) {
      expect(argv).not.toContain(forbidden)
    }
  })

  it('switches usage stats off and Hugging Face offline, and keeps every compile cache in the engine cache', () => {
    const { env } = vllmAdapter.buildLaunch(context())
    expect(env).toMatchObject({
      VLLM_NO_USAGE_STATS: '1',
      DO_NOT_TRACK: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      VLLM_CACHE_ROOT: '/atomic/engine-cache/vllm',
      TRITON_CACHE_DIR: '/atomic/engine-cache/triton',
      TORCHINDUCTOR_CACHE_DIR: '/atomic/engine-cache/inductor',
      FLASHINFER_WORKSPACE_BASE: '/atomic/engine-cache/flashinfer',
    })
  })

  it('accepts text only: a multimodal model reserves nothing for images or video; a text-only one gets no multimodal flag', () => {
    expect(flag(argvOf(), '--limit-mm-per-prompt')).toBe('{"image":0,"video":0}')
    expect(argvOf({ plan: { ...PLAN, multimodal: false } })).not.toContain('--limit-mm-per-prompt')
  })

  it('caps a reply the client did not cap through vLLM’s own default, so a long prompt keeps the room it has', () => {
    const argv = argvOf({ settings: vllmSettings({ max_output_tokens: 1000 }) })
    expect(flag(argv, '--override-generation-config')).toBe('{"max_new_tokens":1000}')
  })

  it('FP8 KV only on compute capability 8.9 and newer; the model’s own precision elsewhere', () => {
    const fp8 = vllmSettings({ kv_cache_dtype: 'fp8' })
    expect(flag(argvOf({ settings: fp8, gpuComputeCapability: '8.9' }), '--kv-cache-dtype')).toBe('fp8')
    expect(flag(argvOf({ settings: fp8, gpuComputeCapability: '12.0' }), '--kv-cache-dtype')).toBe('fp8')
    expect(argvOf({ settings: fp8, gpuComputeCapability: '8.6' })).not.toContain('--kv-cache-dtype')
    expect(argvOf({ settings: fp8, gpuComputeCapability: null })).not.toContain('--kv-cache-dtype')
    expect(argvOf({ gpuComputeCapability: '9.0' })).not.toContain('--kv-cache-dtype')
  })

  it('CUDA graphs auto: off below 12 GiB of card, on from 12 GiB; on and off as set', () => {
    expect(argvOf({ gpuTotalVramBytes: 8 * GiB })).toContain('--enforce-eager')
    expect(argvOf({ gpuTotalVramBytes: 12 * GiB })).not.toContain('--enforce-eager')
    expect(argvOf({ gpuTotalVramBytes: null, unifiedMemory: true })).not.toContain('--enforce-eager')
    expect(
      argvOf({ settings: vllmSettings({ cuda_graphs: 'on' }), gpuTotalVramBytes: 8 * GiB })
    ).not.toContain('--enforce-eager')
    expect(argvOf({ settings: vllmSettings({ cuda_graphs: 'off' }), gpuTotalVramBytes: 24 * GiB })).toContain(
      '--enforce-eager'
    )
  })

  it('passes the family’s parsers, and none when the family has none', () => {
    const argv = argvOf()
    expect(argv).toContain('--enable-auto-tool-choice')
    expect(flag(argv, '--tool-call-parser')).toBe('qwen3_coder')
    expect(flag(argv, '--reasoning-parser')).toBe('qwen3')
    const bare = argvOf({ family: family({ tool_parser: null, reasoning_parser: null }) })
    expect(bare).not.toContain('--enable-auto-tool-choice')
    expect(bare).not.toContain('--tool-call-parser')
    expect(bare).not.toContain('--reasoning-parser')
    expect(argvOf({ family: null })).not.toContain('--tool-call-parser')
  })

  it('passes every further option the settings set, and nothing for what they leave to the engine', () => {
    const plain = argvOf()
    for (const flagName of [
      '--max-num-batched-tokens',
      '--no-enable-prefix-caching',
      '--cpu-offload-gb',
      '--dtype',
      '--seed',
      '--async-scheduling',
    ]) {
      expect(plain).not.toContain(flagName)
    }
    const argv = argvOf({
      settings: vllmSettings({
        max_num_batched_tokens: 2048,
        enable_prefix_caching: false,
        cpu_offload_gb: 2,
        dtype: 'float16',
        seed: 7,
        async_scheduling: true,
        default_temperature: 0.7,
        default_top_k: 20,
        max_output_tokens: 1000,
      }),
    })
    expect(flag(argv, '--max-num-batched-tokens')).toBe('2048')
    expect(argv).toContain('--no-enable-prefix-caching')
    expect(flag(argv, '--cpu-offload-gb')).toBe('2')
    expect(flag(argv, '--dtype')).toBe('float16')
    expect(flag(argv, '--seed')).toBe('7')
    expect(argv).toContain('--async-scheduling')
    expect(JSON.parse(flag(argv, '--override-generation-config') ?? '{}')).toEqual({
      max_new_tokens: 1000,
      temperature: 0.7,
      top_k: 20,
    })
  })

  it('refuses to launch without core’s memory plan: the share of the card is never guessed', () => {
    const { plan: _plan, ...noPlan } = context()
    expect(() => vllmAdapter.buildLaunch(noPlan as ManagedLaunchContext<VllmSettings>)).toThrow(/memory plan/)
  })
})

describe('capabilities — Возможности модели vllm объявляются, а не угадываются', () => {
  it('tools and reasoning only with a parser, structured output only as the family says; never vision, embeddings or Responses', () => {
    expect(vllmAdapter.capabilities({ settings: vllmSettings({}), family: family() })).toEqual({
      tools: true,
      reasoning: true,
      structured_output: true,
      vision: false,
      embeddings: false,
      responses: false,
    })
    expect(
      vllmAdapter.capabilities({
        settings: vllmSettings({}),
        family: family({ tool_parser: null, reasoning_parser: null, structured_output: false }),
      })
    ).toMatchObject({ tools: false, reasoning: false, structured_output: false })
    expect(vllmAdapter.capabilities({ settings: vllmSettings({}), family: null })).toMatchObject({
      tools: false,
    })
  })
})

describe('the gateway routes and request rewrites', () => {
  const settings = vllmSettings({ max_output_tokens: 1000 })
  const caps = (over: Partial<ReturnType<typeof vllmAdapter.capabilities>> = {}) => ({
    ...vllmAdapter.capabilities({ settings, family: family() }),
    ...over,
  })
  const rewrite = (route: string, body: unknown, capabilities = caps()) =>
    vllmAdapter.rewriteRequestBody?.(route, body, settings, capabilities)

  it('declares only chat, completions and the model list; the two POST routes are rewritable', () => {
    expect(vllmAdapter.routes).toEqual([
      { method: 'POST', path: '/v1/chat/completions' },
      { method: 'POST', path: '/v1/completions' },
      { method: 'GET', path: '/v1/models' },
    ])
    expect(vllmAdapter.rewritableRoutes).toEqual([
      { method: 'POST', path: '/v1/chat/completions' },
      { method: 'POST', path: '/v1/completions' },
    ])
  })

  it('caps the output a client asks for at the setting, and adds none when it asked for none', () => {
    // vLLM refuses input + max_tokens over the context: a cap written into every request would refuse a
    // long prompt that still fits. The launch's default cap covers the request that names none.
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

  it('Модель без парсера tools: a request with tools is refused as an unsupported capability', () => {
    const call = () =>
      rewrite('/v1/chat/completions', { tools: [{ type: 'function' }] }, caps({ tools: false }))
    expect(call).toThrow(ManagedRequestRefusal)
    expect(call).toThrow(/does not support tool calling/)
  })

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

describe('Переполнение контекста vllm без авто-роста', () => {
  it.each(Object.entries(VLLM_CONTEXT_OVERFLOW_BODIES))(
    'maps the %s wording to context_length_exceeded with both numbers',
    (_kind, body) => {
      const mapped = vllmAdapter.mapErrorResponse?.('/v1/chat/completions', 400, body) as {
        error: { code: string; message: string }
      } | null
      expect(mapped?.error.code).toBe('context_length_exceeded')
      expect(mapped?.error.message).toMatch(/8192/)
    }
  )

  it('relays every other error as it is, and never grows the context', () => {
    expect(
      vllmAdapter.mapErrorResponse?.('/v1/chat/completions', 400, '{"error":{"message":"bad"}}')
    ).toBeNull()
    expect(
      vllmAdapter.mapErrorResponse?.('/v1/chat/completions', 500, VLLM_CONTEXT_OVERFLOW_BODIES.total)
    ).toBeNull()
  })
})

describe('Ответ с выключенными размышлениями приходит в content', () => {
  const rewriteFor = (body: unknown) =>
    vllmAdapter.rewriteResponseFor?.('/v1/chat/completions', body, family())
  it('moves reasoning into content when the request did not turn thinking on, and leaves it otherwise', () => {
    const answer = () => ({ choices: [{ message: { content: '', reasoning_content: 'Hello' } }] })
    expect(rewriteFor({ messages: [] })?.(answer())).toEqual({
      choices: [{ message: { content: 'Hello', reasoning_content: null } }],
    })
    expect(rewriteFor({ chat_template_kwargs: { enable_thinking: true } })).toBeNull()
    expect(
      vllmAdapter.rewriteResponseFor?.('/v1/chat/completions', {}, family({ reasoning_parser: null }))
    ).toBeNull()
  })
})

describe('Этапы и таймаут загрузки vLLM', () => {
  it('marks initializing-engine from the weights, the profiling, the compilation and the graph capture', () => {
    const lines = VLLM_START_LOG.split('\n')
    const marked = lines.filter((line) =>
      vllmAdapter.stageMarkers.some((marker) => marker.pattern.test(line))
    )
    expect(marked.length).toBeGreaterThanOrEqual(4)
    expect(vllmAdapter.stageMarkers.every((marker) => marker.stage === 'initializing-engine')).toBe(true)
    expect(marked.some((line) => /Starting to load model/.test(line))).toBe(true)
    expect(marked.some((line) => /Capturing CUDA graphs/.test(line))).toBe(true)
  })

  it('times out from the weights with room for a first compilation, and a setting overrides it', () => {
    const small = vllmAdapter.readinessTimeoutMs(4 * GiB, vllmSettings({}))
    const large = vllmAdapter.readinessTimeoutMs(40 * GiB, vllmSettings({}))
    expect(small).toBeGreaterThanOrEqual(10 * 60_000)
    expect(large).toBeGreaterThan(small)
    expect(vllmAdapter.readinessTimeoutMs(4 * GiB, vllmSettings({ load_timeout_seconds: 90 }))).toBe(90_000)
  })

  it('classifies an exit: out of memory with numbers, free memory below the share, a context the KV cache cannot hold, an unknown architecture, anything else', () => {
    const oom = vllmAdapter.classifyExit(VLLM_OOM_LOG, 1)
    expect(oom.kind).toBe('out-of-memory')
    expect(oom.message).toMatch(/1\.17 GiB/)
    expect(oom.message).toMatch(/512/)
    const free = vllmAdapter.classifyExit(VLLM_FREE_MEMORY_LOG, 1)
    expect(free.kind).toBe('out-of-memory')
    expect(free.numbers).toMatchObject({ free_gib: 5.84, total_gib: 7.63 })
    // vLLM 0.31 names the device; before, this fell through to "exited with code 1" (Windows acceptance).
    const named = vllmAdapter.classifyExit(VLLM_FREE_MEMORY_DEVICE_LOG, 1)
    expect(named.kind).toBe('out-of-memory')
    expect(named.numbers).toEqual({ free_gib: 6.89, total_gib: 8, utilization: 0.9081, requested_gib: 7.26 })
    expect(named.message).toMatch(/6\.89 GiB of 8\.0 GiB free.*7\.26 GiB/)
    const kv = vllmAdapter.classifyExit(VLLM_KV_TOO_SMALL_LOG, 1)
    expect(kv.kind).toBe('out-of-memory')
    expect(kv.numbers).toMatchObject({ max_model_len: 32768, kv_cache_tokens: 2720 })
    expect(kv.message).toMatch(/32768/)
    expect(kv.message).toMatch(/2720/)
    const arch = vllmAdapter.classifyExit(VLLM_UNSUPPORTED_ARCHITECTURE_LOG, 1)
    expect(arch.kind).toBe('unsupported-model')
    expect(arch.message).toMatch(/FancyNewForCausalLM/)
    expect(vllmAdapter.classifyExit(VLLM_OTHER_LOG, 1).kind).toBe('other')
  })
})

describe('restartKey', () => {
  it('every setting but the load timeout restarts the container (the output cap is a launch default too)', () => {
    const key = (stored: Record<string, unknown>) =>
      JSON.stringify(vllmAdapter.restartKey?.(vllmSettings(stored)))
    expect(key({ max_output_tokens: 100 })).not.toBe(key({ max_output_tokens: 200 }))
    expect(key({ load_timeout_seconds: 60 })).toBe(key({}))
    expect(key({ context_length: 16384 })).not.toBe(key({}))
    expect(key({ max_num_seqs: 2 })).not.toBe(key({}))
    expect(key({ cuda_graphs: 'off' })).not.toBe(key({}))
    expect(key({ kv_cache_dtype: 'fp8' })).not.toBe(key({}))
    expect(key({ kv_cache_max_tokens: 1000 })).not.toBe(key({}))
    for (const changed of [
      { max_num_batched_tokens: 2048 },
      { enable_prefix_caching: false },
      { cpu_offload_gb: 1 },
      { dtype: 'float16' },
      { seed: 3 },
      { async_scheduling: true },
      { default_temperature: 0.2 },
    ]) {
      expect(key(changed), JSON.stringify(changed)).not.toBe(key({}))
    }
  })
})
