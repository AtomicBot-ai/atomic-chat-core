import { describe, expect, it, vi } from 'vitest'
import type { ModelYmlDocument } from '../../models/index.js'
import { generateApiKey } from '../shared/index.js'
import { planLlamaArgs, withLlamacppDefaults } from './args.js'
import type { LlamacppConfigInput } from './args.js'
import {
  autoUnloadTargets,
  llamaGpuFootprint,
  nextRetry,
  planLlamaLoad,
  resolveModelMaxCtxTrain,
  withPort,
} from './load-plan.js'
import type { LoadPlan, LoadPlanDeps } from './load-plan.js'
import { DEFAULT_N_PREDICT } from './generation-limits.js'

const baseConfig = (): LlamacppConfigInput => ({
  version_backend: 'b10405/macos-arm64',
  auto_unload: true,
  timeout: 600,
  llamacpp_env: '',
  fit: false,
  fit_ctx: '',
  fit_target: '',
  chat_template: '',
  n_gpu_layers: 100,
  offload_mmproj: true,
  cpu_moe: false,
  n_cpu_moe: 0,
  override_tensor_buffer_t: '',
  ctx_size: 16384,
  threads: 0,
  threads_batch: 0,
  n_predict: 0,
  batch_size: 0,
  ubatch_size: 0,
  device: '',
  split_mode: 'layer',
  main_gpu: 0,
  flash_attn: 'auto',
  cont_batching: false,
  no_mmap: false,
  mlock: false,
  no_kv_offload: false,
  cache_type_k: 'f16',
  cache_type_v: 'f16',
  defrag_thold: 0.1,
  rope_scaling: 'none',
  rope_scale: 1,
  rope_freq_base: 0,
  rope_freq_scale: 1,
  ctx_shift: false,
})

const yml = (extra: Partial<ModelYmlDocument> = {}): ModelYmlDocument => ({
  model_path: 'llamacpp/models/m/model.gguf',
  name: 'm',
  size_bytes: 100,
  model_size_bytes: 100,
  ...extra,
})

function deps(
  over: Partial<LoadPlanDeps> & { files?: Record<string, number>; meta?: Record<string, string> } = {}
): LoadPlanDeps {
  const files = over.files ?? { '/data/llamacpp/models/m/model.gguf': 100 }
  const meta = over.meta ?? { 'general.architecture': 'llama', 'llama.context_length': '4096' }
  return {
    joinData: (rel) => `/data/${rel}`,
    readModelYml: async () => yml(),
    resolveLatestBackend: async () => undefined,
    ensureBackendReady: async (backend, version) => ({
      backend,
      version,
      exePath: `/b/${version}/${backend}/llama-server`,
    }),
    cpuInfo: async () => ({ arch: 'arm64', extensions: [] }),
    exists: async (p) => p in files,
    fileSize: async (p) => files[p],
    readGgufMetadata: async () => meta,
    randomPort: async () => 3456,
    checkGemmaMtpSupport: () => false,
    ensureGemmaMtpDraft: async () => {},
    checkDflashSupport: () => false,
    ensureDflashDraft: async () => {},
    backendSupportsDflashSpec: async () => false,
    resolveLlama3TemplateOverride: () => undefined,
    ...over,
  }
}

const input = (config: Partial<LlamacppConfigInput> = {}, engine = {}) => ({
  provider: 'llamacpp-upstream' as const,
  modelId: 'm',
  config: { ...baseConfig(), ...config },
  engine: { timeout: 600, llamacpp_env: '', ...engine },
  isEmbedding: false,
  dataFolder: '/data',
})

describe('withPort', () => {
  it('moves the plan, its key and the key the engine reads to another port, and nothing else', async () => {
    const plan = await planLlamaLoad(input({}, { llamacpp_env: 'GGML_X=1' }), deps())
    const moved = withPort(plan, 3999)
    expect(moved.port).toBe(3999)
    expect(moved.apiKey).toBe(generateApiKey('m', 3999))
    expect(moved.apiKey).not.toBe(plan.apiKey)
    expect(moved.env).toEqual({ ...plan.env, LLAMA_API_KEY: moved.apiKey })
    expect({ ...moved, port: plan.port, apiKey: plan.apiKey, env: plan.env }).toEqual(plan)
    expect(plan.port).toBe(3456)
  })
})

describe('planLlamaLoad', () => {
  it('produces the basic plan: paths, port, key, env, clamped ctx, floored timeout', async () => {
    const plan = await planLlamaLoad(input({}, { llamacpp_env: 'GGML_X=1;LLAMA_Y=2' }), deps())
    expect(plan.exePath).toBe('/b/b10405/macos-arm64/llama-server')
    expect(plan.modelPath).toBe('/data/llamacpp/models/m/model.gguf')
    expect(plan.mmprojPath).toBeUndefined()
    expect(plan.port).toBe(3456)
    expect(plan.env['LLAMA_API_KEY']).toBe(plan.apiKey)
    expect(plan.env['LLAMA_ARG_TIMEOUT']).toBe('600')
    expect(plan.env['GGML_X']).toBe('1')
    expect(plan.env['LLAMA_Y']).toBeUndefined()
    expect(plan.config.ctx_size).toBe(4096)
    expect(plan.maxCtxTrain).toBe(4096)
    expect(plan.timeoutSecs).toBe(1800)
    expect(plan.warnings.some((w) => w.includes('clamping to 4096'))).toBe(true)
  })

  it('applies per-model overrides, resolves the latest sentinel and clamps flash_attn on old builds', async () => {
    const resolve = vi.fn(async () => 'b6000/macos-arm64')
    const plan = await planLlamaLoad(
      input({ version_backend: 'latest/macos-arm64' }, {}),
      deps({ resolveLatestBackend: resolve })
    )
    expect(resolve).toHaveBeenCalledWith('macos-arm64')
    expect(plan.version).toBe('b6000')
    expect(plan.config.flash_attn).toBe('off')
    const withOverride = await planLlamaLoad({ ...input(), overrides: { n_gpu_layers: 5 } }, deps())
    expect(withOverride.config.n_gpu_layers).toBe(5)
  })

  it('rejects a malformed backend, a no-AVX CPU on a CPU backend, missing and truncated files, incomplete shard sets', async () => {
    await expect(planLlamaLoad(input({ version_backend: 'none' }), deps())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(
      planLlamaLoad(
        input({ version_backend: 'b1/win-cpu-x64' }),
        deps({ cpuInfo: async () => ({ arch: 'x86_64', extensions: ['sse2'] }) })
      )
    ).rejects.toMatchObject({ code: 'CPU_NO_AVX' })
    await expect(planLlamaLoad(input(), deps({ files: {} }))).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
    })
    await expect(
      planLlamaLoad(input(), deps({ files: { '/data/llamacpp/models/m/model.gguf': 10 } }))
    ).rejects.toMatchObject({
      code: 'MODEL_FILE_CORRUPT',
    })
    const shardYml: ModelYmlDocument = {
      model_path: 'llamacpp/models/m/model-00002-of-00003.gguf',
      name: 'm',
      size_bytes: 3,
    }
    await expect(
      planLlamaLoad(
        input(),
        deps({
          readModelYml: async () => shardYml,
          files: { '/data/llamacpp/models/m/model-00002-of-00003.gguf': 1 },
        })
      )
    ).rejects.toMatchObject({ code: 'MODEL_SHARDS_INCOMPLETE' })
    const full = {
      '/data/llamacpp/models/m/model-00001-of-00003.gguf': 1,
      '/data/llamacpp/models/m/model-00002-of-00003.gguf': 1,
      '/data/llamacpp/models/m/model-00003-of-00003.gguf': 1,
    }
    const plan = await planLlamaLoad(input(), deps({ readModelYml: async () => shardYml, files: full }))
    expect(plan.modelPath).toBe('/data/llamacpp/models/m/model-00001-of-00003.gguf')
  })

  it('handles MTP: Gemma draft resolution, capability gate, and DFlash precedence', async () => {
    const gemma = await planLlamaLoad(
      input({ mtp: true }),
      deps({
        checkGemmaMtpSupport: () => true,
        readModelYml: vi
          .fn()
          .mockResolvedValueOnce(yml())
          .mockResolvedValueOnce(yml({ mtp_draft_path: 'drafts/mtp.gguf' })),
      })
    )
    expect(gemma.config.mtp).toBe(true)
    expect(gemma.config.mtp_draft_path).toBe('/data/drafts/mtp.gguf')

    const notCapable = await planLlamaLoad(input({ mtp: true }), deps())
    expect(notCapable.config.mtp).toBe(false)
    expect(notCapable.warnings.some((w) => w.includes('no MTP layers'))).toBe(true)

    const qwen = await planLlamaLoad(
      input({ mtp: true }),
      deps({
        meta: {
          'general.architecture': 'qwen35',
          'qwen35.block_count': '40',
          'qwen35.nextn_predict_layers': '1',
          'qwen35.context_length': '8192',
        },
      })
    )
    expect(qwen.config.mtp).toBe(true)
    expect(qwen.config.mtp_draft_path).toBe('')

    const both = await planLlamaLoad(
      input({ mtp: true, dflash: true }, { dflash_block_size: 16 }),
      deps({
        meta: {
          'general.architecture': 'qwen35',
          'qwen35.block_count': '40',
          'qwen35.nextn_predict_layers': '1',
        },
        backendSupportsDflashSpec: async () => true,
        readModelYml: async () => yml({ dflash_draft_path: 'drafts/dflash.gguf' }),
      })
    )
    expect(both.config.dflash).toBe(true)
    expect(both.config.mtp).toBe(false)
    expect(both.config.dflash_n_max).toBe(15)
    expect(both.config.dflash_draft_path).toBe('/data/drafts/dflash.gguf')
  })

  it('never looks for drafts on the TurboQuant provider, whatever the settings say', async () => {
    const ensureGemmaMtpDraft = vi.fn(async () => {})
    const ensureDflashDraft = vi.fn(async () => {})
    const plan = await planLlamaLoad(
      { ...input({ mtp: true, dflash: true }), provider: 'llamacpp' },
      deps({
        checkGemmaMtpSupport: () => true,
        checkDflashSupport: () => true,
        backendSupportsDflashSpec: async () => true,
        ensureGemmaMtpDraft,
        ensureDflashDraft,
      })
    )
    expect(plan.config).toMatchObject({
      mtp: false,
      dflash: false,
      mtp_draft_path: '',
      dflash_draft_path: '',
    })
    expect(ensureGemmaMtpDraft).not.toHaveBeenCalled()
    expect(ensureDflashDraft).not.toHaveBeenCalled()
  })

  it('drops DFlash when the binary lacks it or no draft resolves', async () => {
    const noBin = await planLlamaLoad(
      input({ dflash: true }),
      deps({ readModelYml: async () => yml({ dflash_draft_path: 'd.gguf' }) })
    )
    expect(noBin.config.dflash).toBe(false)
    expect(noBin.config.dflash_spec_supported).toBe(false)
    const noDraft = await planLlamaLoad(
      input({ dflash: true }),
      deps({ backendSupportsDflashSpec: async () => true })
    )
    expect(noDraft.config.dflash).toBe(false)
    expect(noDraft.config.dflash_n_max).toBe(0)
  })

  it('overrides a strict Llama 3 template only when no explicit template is set', async () => {
    const override = vi.fn(() => 'canonical-template')
    const plan = await planLlamaLoad(
      input(),
      deps({
        resolveLlama3TemplateOverride: override,
        meta: { 'general.architecture': 'llama', 'tokenizer.chat_template': 'strict' },
      })
    )
    expect(plan.config.chat_template).toBe('canonical-template')
    const explicit = await planLlamaLoad(
      input({ chat_template: 'mine' }),
      deps({ resolveLlama3TemplateOverride: override })
    )
    expect(explicit.config.chat_template).toBe('mine')
  })

  it('uses the swapped backend pair from ensureBackendReady and a stringly fit', async () => {
    const plan = await planLlamaLoad(
      input({ fit: 'true' as unknown as boolean }),
      deps({ ensureBackendReady: async () => ({ version: 'b9000', backend: 'macos-x64', exePath: '/alt' }) })
    )
    expect(plan.version).toBe('b9000')
    expect(plan.backend).toBe('macos-x64')
    expect(plan.exePath).toBe('/alt')
    expect(plan.config.fit).toBe(true)
  })
})

describe('planLlamaLoad — a --device the build does not have', () => {
  const VULKAN = [{ id: 'Vulkan0', name: 'AMD Radeon RX 7800 XT', mem: 16_368, free: 16_000 }]

  it('drops it with a warning instead of letting llama-server exit, and keeps what the build has', async () => {
    const listDevices = vi.fn(async () => VULKAN)
    const plan = await planLlamaLoad(input({ device: 'CUDA0,Vulkan0' }), deps({ listDevices }))
    expect(plan.config.device).toBe('Vulkan0')
    expect(plan.warnings).toContain(
      'Ignoring device CUDA0 for "m": b10405/macos-arm64 does not have it (it lists Vulkan0).'
    )
    expect(listDevices).toHaveBeenCalledWith('/b/b10405/macos-arm64/llama-server')
    const cpu = await planLlamaLoad(input({ device: 'CUDA0' }), deps({ listDevices: async () => [] }))
    expect(cpu.config.device).toBe('')
    expect(cpu.warnings).toContain(
      'Ignoring device CUDA0 for "m": b10405/macos-arm64 does not have it (it lists none).'
    )
  })

  it('changes nothing when the device is known, the list cannot be read, or nobody can list', async () => {
    const known = await planLlamaLoad(input({ device: 'vulkan0' }), deps({ listDevices: async () => VULKAN }))
    expect(known.config.device).toBe('vulkan0')
    expect(known.warnings.some((w) => w.startsWith('Ignoring device'))).toBe(false)
    const unreadable = await planLlamaLoad(
      input({ device: 'CUDA0' }),
      deps({ listDevices: async () => Promise.reject(new Error('timed out')) })
    )
    expect(unreadable.config.device).toBe('CUDA0')
    expect((await planLlamaLoad(input({ device: 'CUDA0' }), deps())).config.device).toBe('CUDA0')
    // No device to check: the list is read once, for the context plan alone.
    const listDevices = vi.fn(async () => VULKAN)
    const unpinned = await planLlamaLoad(input({ device: '' }), deps({ listDevices }))
    expect(listDevices).toHaveBeenCalledTimes(1)
    expect(unpinned.config.device).toBe('')
    expect(unpinned.warnings.some((w) => w.startsWith('Ignoring device'))).toBe(false)
  })

  it('lists the devices of a plan once, for the device check and the unified-memory fit alike', async () => {
    const METAL = [{ id: 'MTL0', name: 'Apple M4', mem: 12_124, free: 12_124 }]
    const listDevices = vi.fn(async (_exe: string) => METAL)
    const plan = await planLlamaLoad(
      input({ device: 'MTL0', fit: true }),
      deps({ listDevices, unifiedMemory: async () => ({ totalMemoryBytes: 16 * 2 ** 30 }) })
    )
    expect(plan.config.device).toBe('MTL0')
    expect(listDevices).toHaveBeenCalledTimes(1)
  })
})

describe('planLlamaLoad — a model fit_ctx', () => {
  it('wins over the provider one, as a number or its text, and an empty one keeps the provider’s', async () => {
    const plan = (model: unknown) =>
      planLlamaLoad(
        { ...input({ fit: true, fit_ctx: '8192' }), overrides: { fit_ctx: model as string } },
        deps()
      )
    expect((await plan('16384')).config.fit_ctx).toBe('16384')
    expect((await plan(32768)).config.fit_ctx).toBe('32768')
    expect((await plan('')).config.fit_ctx).toBe('8192')
    expect((await plan(undefined)).config.fit_ctx).toBe('8192')
    expect((await planLlamaLoad(input({ fit: true, fit_ctx: '8192' }), deps())).config.fit_ctx).toBe('8192')
  })
})

/** Integrations audit 2026-11-03: X6 (answer cap), S4 (fit-off window), S5 (prompt cache). */
describe('planLlamaLoad — the limits core starts llama.cpp with', () => {
  const GiB = 2 ** 30
  const LONG = { 'general.architecture': 'llama', 'llama.context_length': '131072' }

  it('caps an answer at 16384 tokens when n_predict is automatic, never above the window it knows', async () => {
    const plan = (config: Partial<LlamacppConfigInput>, meta = LONG) =>
      planLlamaLoad(input(config), deps({ meta }))
    expect((await plan({ ctx_size: 32_768 })).config.n_predict).toBe(DEFAULT_N_PREDICT)
    expect((await plan({ ctx_size: 8192 })).config.n_predict).toBe(8192)
    // Fit on with no ceiling: the window is llama.cpp's, at most the trained context.
    expect((await plan({ fit: true }, { ...LONG, 'llama.context_length': '4096' })).config.n_predict).toBe(
      4096
    )
    expect((await plan({ fit: true })).config.n_predict).toBe(DEFAULT_N_PREDICT)
    // The user's own: -1 is no limit, a number is theirs.
    expect((await plan({ n_predict: -1 })).config.n_predict).toBe(-1)
    expect((await plan({ n_predict: 500 })).config.n_predict).toBe(500)
  })

  it('gives a fit-off load without a window 32K, or the trained context when smaller', async () => {
    const plan = (meta: Record<string, string>) => planLlamaLoad(input({ ctx_size: 0 }), deps({ meta }))
    const long = await plan(LONG)
    expect(long.config.ctx_size).toBe(32_768)
    expect(long.warnings).toContain('No context size is set with fit off; loading "m" with 32768 tokens.')
    expect((await plan({ ...LONG, 'llama.context_length': '8192' })).config.ctx_size).toBe(8192)
    // A chosen window stands.
    expect((await planLlamaLoad(input({ ctx_size: 12_000 }), deps({ meta: LONG }))).config.ctx_size).toBe(
      12_000
    )
    // Fit on, or an embedding model: no window from core.
    expect(
      (await planLlamaLoad(input({ fit: true, ctx_size: 0 }), deps({ meta: LONG }))).config.ctx_size
    ).toBe(0)
  })

  it('narrows that default toward the previous 16K on a small Mac, never below it', async () => {
    // Llama 3.2 3B shaped: 112 KiB of KV a token. 8 GiB Mac: half is 4096 MiB, less 1926 MiB of
    // weights and 1024 MiB of reserve leaves 1146 MiB — 10487 tokens, so the 16K floor.
    const meta = {
      'general.architecture': 'llama',
      'llama.block_count': '28',
      'llama.context_length': '131072',
      'llama.attention.head_count': '24',
      'llama.attention.head_count_kv': '8',
      'llama.attention.key_length': '128',
      'llama.attention.value_length': '128',
    }
    const files = { '/data/llamacpp/models/m/model.gguf': 2_019_377_696 }
    const on = (totalMemoryBytes: number) =>
      planLlamaLoad(
        input({ ctx_size: 0 }),
        deps({ meta, files, unifiedMemory: async () => ({ totalMemoryBytes }) })
      )
    expect((await on(8 * GiB)).config.ctx_size).toBe(16_384)
    // 12 GiB: 6144 − 1926 − 1024 MiB = 3194 MiB, 29202 tokens → 29184.
    expect((await on(12 * GiB)).config.ctx_size).toBe(29_184)
    // 16 GiB and up: no 32K ceiling, the plan takes what half of RAM holds — 8192 − 1926 − 1024 MiB
    // leave 5242 MiB, 47928 tokens → 47872.
    expect((await on(16 * GiB)).config.ctx_size).toBe(47_872)
  })

  it('narrows the host prompt cache on a machine with at most 16 GiB of RAM', async () => {
    const cache = async (totalMemoryBytes: number | undefined, isEmbedding = false) =>
      (
        await planLlamaLoad(
          { ...input(), isEmbedding },
          deps({
            systemMemory: async () => (totalMemoryBytes === undefined ? undefined : { totalMemoryBytes }),
          })
        )
      ).cacheRamMiB
    expect(await cache(8 * GiB)).toBe(1024)
    expect(await cache(16 * GiB)).toBe(2048)
    expect(await cache(18 * GiB)).toBeUndefined()
    expect(await cache(undefined)).toBeUndefined()
    expect(await cache(8 * GiB, true)).toBeUndefined()
    expect('cacheRamMiB' in (await planLlamaLoad(input(), deps()))).toBe(false)
  })
})

describe('planLlamaLoad — fit margin on unified memory', () => {
  const GiB = 2 ** 30
  const MODEL = '/data/llamacpp/models/m/model.gguf'
  // owao/Nanbeige4.2-3B-GGUF IQ4_XS, as its GGUF describes itself.
  const NANBEIGE_META = {
    'general.architecture': 'nanbeige',
    'nanbeige.block_count': '22',
    'nanbeige.attention.head_count': '48',
    'nanbeige.attention.head_count_kv': '8',
    'nanbeige.attention.key_length': '128',
    'nanbeige.attention.value_length': '128',
    'nanbeige.embedding_length': '3072',
    'nanbeige.context_length': '262144',
  }
  // An 18 GiB Mac: Metal lets the GPU use about three quarters of it.
  const METAL_18 = [
    { id: 'MTL0', name: 'Apple M3 Pro', mem: 13_641, free: 13_640 },
    { id: 'BLAS', name: 'Accelerate', mem: 0, free: 0 },
  ]
  const fitDeps = (over: Partial<LoadPlanDeps> & { files?: Record<string, number> } = {}) =>
    deps({
      files: { [MODEL]: 2_403_808_096 },
      meta: NANBEIGE_META,
      unifiedMemory: async () => ({ totalMemoryBytes: 18 * GiB }),
      listDevices: async () => METAL_18,
      ...over,
    })
  // Half of 18 GiB is 9216 MiB; the rest of Metal's 13640 MiB is the margin.
  const HALF_OF_18 = String(13_640 - 9 * 1024)

  it('widens the margin so llama.cpp keeps to half of an 18 GB Mac', async () => {
    const listDevices = vi.fn(async () => METAL_18)
    const plan = await planLlamaLoad(input({ fit: true, fit_target: '1024' }), fitDeps({ listDevices }))
    expect(plan.config.fit_target).toBe(HALF_OF_18)
    expect(listDevices).toHaveBeenCalledWith('/b/b10405/macos-arm64/llama-server')
    expect(plan.warnings).toContain(
      `Unified memory: fitting "m" with a ${HALF_OF_18} MiB margin so llama.cpp leaves half of RAM to the system.`
    )
  })

  it('treats an empty margin, and one pinned to the Metal device, as the default', async () => {
    const empty = await planLlamaLoad(input({ fit: true, fit_target: '' }), fitDeps())
    expect(empty.config.fit_target).toBe(HALF_OF_18)
    const pinned = await planLlamaLoad(input({ fit: true, fit_target: '', device: 'MTL0' }), fitDeps())
    expect(pinned.config.fit_target).toBe(HALF_OF_18)
  })

  it.each([
    ['fit is off', { fit: false, fit_target: '1024' }, '1024'],
    ['the user set their own margin', { fit: true, fit_target: '2048' }, '2048'],
    ['the user pinned another device', { fit: true, fit_target: '', device: 'none' }, ''],
  ])('leaves the margin alone when %s', async (_name, config, expected) => {
    const listDevices = vi.fn(async () => METAL_18)
    const plan = await planLlamaLoad(input(config), fitDeps({ listDevices }))
    expect(plan.config.fit_target).toBe(expected)
  })

  it('widens no margin off Apple silicon, and lists no devices for an embedding model', async () => {
    const listDevices = vi.fn(async () => METAL_18)
    const { unifiedMemory: _unused, ...offMac } = fitDeps({ listDevices })
    const plan = await planLlamaLoad(input({ fit: true, fit_target: '' }), offMac)
    expect(plan.config.fit_target).toBe('')
    const noFacts = await planLlamaLoad(
      input({ fit: true, fit_target: '' }),
      fitDeps({ listDevices, unifiedMemory: async () => undefined })
    )
    expect(noFacts.config.fit_target).toBe('')
    // Off Apple silicon the devices are read once per plan, for the context plan (a GPU's floor).
    expect(listDevices).toHaveBeenCalledTimes(2)
    expect(plan.contextPlan?.basis).toBe('gpu')
    listDevices.mockClear()
    const embedding = await planLlamaLoad(
      { ...input({ fit: true, fit_target: '' }), isEmbedding: true },
      fitDeps({ listDevices })
    )
    expect(embedding.config.fit_target).toBe('')
    expect(embedding.contextPlan).toBeUndefined()
    expect(listDevices).not.toHaveBeenCalled()
  })

  it.each([
    ['the RAM probe throws', { unifiedMemory: async () => Promise.reject(new Error('os gone')) }],
    ['the device probe throws', { listDevices: async () => Promise.reject(new Error('timed out')) }],
    [
      'the build lists no Metal device',
      { listDevices: async () => [{ id: 'BLAS', name: 'x', mem: 0, free: 0 }] },
    ],
  ])('keeps the default when %s', async (_name, over) => {
    const plan = await planLlamaLoad(
      input({ fit: true, fit_target: '' }),
      fitDeps(over as Partial<LoadPlanDeps>)
    )
    expect(plan.config.fit_target).toBe('')
  })

  it('keeps the default for a model that needs more than half of RAM, so no layer leaves the GPU', async () => {
    const plan = await planLlamaLoad(
      input({ fit: true, fit_target: '1024' }),
      fitDeps({ files: { [MODEL]: 12 * GiB } })
    )
    expect(plan.config.fit_target).toBe('1024')
    expect(plan.warnings.some((w) => w.startsWith('Unified memory'))).toBe(false)
  })

  it('never lists devices when the host cannot', async () => {
    const { listDevices: _unused, ...noProbe } = fitDeps()
    const plan = await planLlamaLoad(input({ fit: true, fit_target: '' }), noProbe)
    expect(plan.config.fit_target).toBe('')
  })

  it('counts a draft model with the weights, and nothing for a draft it cannot measure', async () => {
    const draft = (kind: 'mtp' | 'dflash', onDisk: boolean) =>
      planLlamaLoad(
        input({ fit: true, fit_target: '', [kind]: true }, { dflash_block_size: 16 }),
        fitDeps({
          files: { [MODEL]: 2_403_808_096, ...(onDisk ? { [`/data/drafts/${kind}.gguf`]: 6 * GiB } : {}) },
          readModelYml: async () => yml({ [`${kind}_draft_path`]: `drafts/${kind}.gguf` }),
          backendSupportsDflashSpec: async () => true,
        })
      )
    // 2292 MiB of model + 6144 MiB of draft + 352 MiB of KV + 1024 MiB of reserve = 9812 MiB.
    expect((await draft('mtp', true)).config.fit_target).toBe(String(13_640 - 9_813))
    expect((await draft('dflash', true)).config.fit_target).toBe(String(13_640 - 9_813))
    expect((await draft('dflash', false)).config.fit_target).toBe(HALF_OF_18)
  })

  it('counts no KV for a model whose metadata cannot be read', async () => {
    // An 8 GiB model: weights + reserve alone are exactly half of 18 GiB, the KV tips it over.
    const at = (readGgufMetadata: LoadPlanDeps['readGgufMetadata']) =>
      planLlamaLoad(
        input({ fit: true, fit_target: '' }),
        fitDeps({ files: { [MODEL]: 8 * GiB }, readGgufMetadata })
      )
    expect((await at(async () => NANBEIGE_META)).config.fit_target).toBe(String(13_640 - 9_568))
    expect((await at(async () => undefined)).config.fit_target).toBe(HALF_OF_18)
    expect(
      (
        await at(async () => {
          throw new Error('not a GGUF')
        })
      ).config.fit_target
    ).toBe(HALF_OF_18)
  })

  it('counts every shard and the minimum context of the one KV pool every slot shares', async () => {
    const shard = (i: number) => `/data/llamacpp/models/m/model-0000${i}-of-00003.gguf`
    const shards = { [shard(1)]: 3 * GiB, [shard(2)]: 3 * GiB, [shard(3)]: 3 * GiB }
    const sharded = await planLlamaLoad(
      input({ fit: true, fit_target: '' }),
      fitDeps({
        files: shards,
        readModelYml: async () =>
          yml({ model_path: 'llamacpp/models/m/model-00001-of-00003.gguf', model_size_bytes: 0 }),
      })
    )
    // 9 GiB of weights + 352 MiB of KV at 4096 + 1 GiB of reserve = 10592 MiB, past half of 18 GiB:
    // the budget grows to hold it and the margin shrinks by as much.
    expect(sharded.config.fit_target).toBe(String(13_640 - 10_592))
    // Four slots at a 32K floor share one 32K pool under -kvu (`src/llama-context.cpp:389-390`):
    // 2292 + 2816 + 1024 MiB, under half of 18 GiB. Before -kvu was always sent this counted 11 GiB.
    const slots = await planLlamaLoad(
      input({ fit: true, fit_target: '', fit_ctx: '32768', parallel: 4 } as Partial<LlamacppConfigInput>),
      fitDeps()
    )
    expect(slots.config.fit_target).toBe(HALF_OF_18)
    // Concurrent mode's slots likewise.
    const concurrent = await planLlamaLoad(
      input({
        fit: true,
        fit_target: '',
        fit_ctx: '32768',
        parallel: 1,
        concurrent_mode: true,
        concurrent_slots: 3,
      } as Partial<LlamacppConfigInput>),
      fitDeps()
    )
    expect(concurrent.config.fit_target).toBe(HALF_OF_18)
    // A model whose 32K pool alone tips the budget over still widens the margin by the pool only.
    const big = await planLlamaLoad(
      input({ fit: true, fit_target: '', fit_ctx: '32768', parallel: 4 } as Partial<LlamacppConfigInput>),
      fitDeps({ files: { [MODEL]: 6 * GiB } })
    )
    expect(big.config.fit_target).toBe(String(13_640 - (6144 + 2816 + 1024)))
  })
})

describe('nextRetry / autoUnloadTargets / resolveModelMaxCtxTrain', () => {
  const plan = (over: Partial<LoadPlan> = {}): LoadPlan => ({
    provider: 'llamacpp-upstream',
    modelId: 'm',
    version: 'b1',
    backend: 'macos-arm64',
    exePath: '/x',
    config: withLlamacppDefaults(baseConfig()),
    port: 1,
    apiKey: 'k',
    env: {},
    modelPath: '/m',
    mmprojPath: '/mm',
    isEmbedding: false,
    timeoutSecs: 1800,
    maxCtxTrain: undefined,
    warnings: [],
    ...over,
  })
  it('retries text-only on an unsupported projector, except for the transcription model', () => {
    const r = nextRetry({ code: 'MULTIMODAL_PROJECTOR_LOAD_FAILED' }, plan(), 'voice')
    expect(r?.kind).toBe('text-only')
    expect(r?.plan.mmprojPath).toBeUndefined()
    expect(
      nextRetry({ code: 'MULTIMODAL_PROJECTOR_LOAD_FAILED' }, plan({ modelId: 'voice' }), 'voice')
    ).toBeUndefined()
    expect(
      nextRetry({ code: 'MULTIMODAL_PROJECTOR_LOAD_FAILED' }, plan({ mmprojPath: undefined }))
    ).toBeUndefined()
  })
  it('retries without MTP on an MTP rejection', () => {
    const p = plan({ config: { ...withLlamacppDefaults(baseConfig()), mtp: true, mtp_draft_path: '/d' } })
    const r = nextRetry(new Error("model doesn't contain MTP layers"), p)
    expect(r?.kind).toBe('without-mtp')
    expect(r?.plan.config.mtp).toBe(false)
    expect(r?.plan.config.mtp_draft_path).toBe('')
    expect(nextRetry(new Error('out of memory'), p)).toBeUndefined()
  })
  it('autoUnloadTargets excludes embeddings and the transcription companion', () => {
    const sessions = [
      { model_id: 'a', is_embedding: false },
      { model_id: 'e', is_embedding: true },
      { model_id: 'voice', is_embedding: false },
    ]
    expect(
      autoUnloadTargets(sessions, {
        autoUnload: true,
        isEmbedding: false,
        bypassAutoUnload: false,
        transcriptionModelId: 'voice',
      })
    ).toEqual(['a'])
    expect(
      autoUnloadTargets(sessions, { autoUnload: false, isEmbedding: false, bypassAutoUnload: false })
    ).toEqual([])
    expect(
      autoUnloadTargets(sessions, { autoUnload: true, isEmbedding: true, bypassAutoUnload: false })
    ).toEqual([])
    expect(
      autoUnloadTargets(sessions, { autoUnload: true, isEmbedding: false, bypassAutoUnload: true })
    ).toEqual([])
  })
  it.each([
    ['linux-cuda-12-common_cpus-x64', 'all'],
    ['linux-x64-cuda-12.4', 'all'],
    ['win-cuda-13.3-x64', 'all'],
    ['linux-vulkan-x64', 'all'],
    ['linux-x64-vulkan', 'all'],
    ['linux-x64-rocm', 'all'],
    ['win-rocm-10.0-x64', 'all'],
    ['macos-arm64', 'all'],
    ['macos-x64', 'all'],
    // An executable the CLI was pointed at: nothing says CPU, so it is treated as holding the GPUs.
    ['llama-server', 'all'],
    ['linux-cpu-x64', []],
    ['linux-x64-cpu', []],
    ['linux-aarch64-cpu', []],
    ['win-cpu-arm64', []],
    ['linux-avx2-x64', []],
    ['win-avx512-x64', []],
    ['linux-noavx-x64', []],
    ['linux-common_cpus-x64', []],
    ['linux-x64', []],
    ['linux-arm64', []],
  ] as const)('llamaGpuFootprint: backend %s holds %j', (backend, cards) => {
    expect(llamaGpuFootprint({ backend, isEmbedding: false, modelId: 'm' }).cards).toEqual(cards)
  })
  it('llamaGpuFootprint marks embeddings and the transcription companion auxiliary, chat not', () => {
    const gpu = { backend: 'linux-vulkan-x64' }
    expect(llamaGpuFootprint({ ...gpu, isEmbedding: true, modelId: 'e' }, 'voice').auxiliary).toBe(true)
    expect(llamaGpuFootprint({ ...gpu, isEmbedding: false, modelId: 'voice' }, 'voice').auxiliary).toBe(true)
    expect(llamaGpuFootprint({ ...gpu, isEmbedding: false, modelId: 'chat' }, 'voice').auxiliary).toBe(false)
    expect(llamaGpuFootprint({ ...gpu, isEmbedding: false, modelId: 'chat' }).auxiliary).toBe(false)
  })
  it('resolveModelMaxCtxTrain reads the arch key or returns undefined with a warning', async () => {
    const warn = vi.fn()
    expect(
      await resolveModelMaxCtxTrain('/m', {
        readGgufMetadata: async () => ({ 'general.architecture': 'x', 'x.context_length': '99' }),
      })
    ).toBe(99)
    expect(await resolveModelMaxCtxTrain('/m', { readGgufMetadata: async () => ({}) })).toBeUndefined()
    expect(
      await resolveModelMaxCtxTrain(
        '/m',
        {
          readGgufMetadata: async () => {
            throw new Error('io')
          },
        },
        warn
      )
    ).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

describe('planLlamaLoad — window ceiling on unified memory below 16 GiB', () => {
  const GiB = 2 ** 30
  const MODEL = '/data/llamacpp/models/m/model.gguf'
  // LiquidAI/LFM2.5-2.6B-GGUF Q4_K_M as the core's reader renders its GGUF (QA 2.2.29 B05): the
  // per-layer `head_count_kv` names the 8 of 30 blocks that attend, 16 KiB of KV per token.
  const LFM25_META = {
    'general.architecture': 'lfm2',
    'lfm2.block_count': '30',
    'lfm2.context_length': '131072',
    'lfm2.embedding_length': '2048',
    'lfm2.attention.head_count': '32',
    'lfm2.attention.head_count_kv':
      '[0, 0, 8, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 8, 0, 0, 8, 0, 0]',
  }
  // meta-llama/Llama-3.2-3B-Instruct Q4_K_M: dense, 28 blocks × 8 KV heads of 128, 112 KiB a token.
  const LLAMA32_3B_META = {
    'general.architecture': 'llama',
    'llama.block_count': '28',
    'llama.context_length': '131072',
    'llama.embedding_length': '3072',
    'llama.attention.head_count': '24',
    'llama.attention.head_count_kv': '8',
    'llama.attention.key_length': '128',
    'llama.attention.value_length': '128',
  }
  const LLAMA32_3B_WEIGHTS = 2_019_377_696
  // `MTL0: Apple M3 (5461 MiB, 5461 MiB free)`: Metal's two thirds of an 8 GiB Mac.
  const METAL_8 = [
    { id: 'MTL0', name: 'Apple M3', mem: 5_461, free: 5_461 },
    { id: 'BLAS', name: 'Accelerate', mem: 0, free: 0 },
  ]
  const smallMac = (
    over: Partial<LoadPlanDeps> & { files?: Record<string, number>; meta?: Record<string, string> } = {}
  ) =>
    deps({
      files: { [MODEL]: 1_674_455_040 },
      meta: LFM25_META,
      unifiedMemory: async () => ({ totalMemoryBytes: 8 * GiB }),
      listDevices: async () => METAL_8,
      ...over,
    })

  it('caps the window fit may pick for LFM2.5 2.6B on an 8 GiB Mac, beside the half-of-RAM margin', async () => {
    const plan = await planLlamaLoad(input({ fit: true, fit_target: '1024' }), smallMac())
    expect(plan.config.fit_target).toBe('1365')
    // 32768 tokens at 16 KiB: 512 MiB of KV instead of fit's 131072 tokens and 2048 MiB.
    expect(plan.fitCtxCeiling).toBe(32_768)
    expect(plan.maxCtxTrain).toBe(131_072)
    expect(plan.warnings).toContain(
      'Unified memory below 16 GiB: capping the window fit may pick for "m" at 32768 tokens.'
    )
  })

  it('narrows a dense model to what its estimate fits beside the weights and the reserve', async () => {
    const plan = await planLlamaLoad(
      input({ fit: true, fit_target: '' }),
      smallMac({ meta: LLAMA32_3B_META, files: { [MODEL]: LLAMA32_3B_WEIGHTS } })
    )
    expect(plan.config.fit_target).toBe('1365')
    // 4096 − 1926 − 1024 MiB leave 1146 MiB: 10487 tokens at 112 KiB, so 10240.
    expect(plan.fitCtxCeiling).toBe(10_240)
  })

  // The app grows a model's window under fit by reloading it with its own, higher `fit_ctx`: a
  // ceiling below that floor would end fit's search under it and the raise would change nothing.
  it('never caps the window below the model fit_ctx, which wins over the provider one', async () => {
    const llama = smallMac({ meta: LLAMA32_3B_META, files: { [MODEL]: LLAMA32_3B_WEIGHTS } })
    const withModelFloor = (fitCtx: unknown) =>
      planLlamaLoad(
        {
          ...input({ fit: true, fit_target: '', fit_ctx: '4096' }),
          overrides: { fit_ctx: fitCtx as string },
        },
        llama
      )
    // Below the ceiling the memory allows: the ceiling stands.
    const low = await withModelFloor('8192')
    expect(low.config.fit_ctx).toBe('8192')
    expect(low.fitCtxCeiling).toBe(10_240)
    // Above it (as the app's string or a number): no ceiling under the floor, fit sizes from there.
    for (const raised of ['16384', 16_384]) {
      const plan = await withModelFloor(raised)
      expect(plan.config.fit_ctx).toBe('16384')
      expect(plan.fitCtxCeiling).toBeUndefined()
    }
    // A floor the memory holds keeps a ceiling, never under the floor.
    const lfm = await planLlamaLoad(
      { ...input({ fit: true, fit_target: '', fit_ctx: '4096' }), overrides: { fit_ctx: '24576' } },
      smallMac()
    )
    expect(lfm.fitCtxCeiling).toBeGreaterThanOrEqual(24_576)
  })

  it('caps the pool the slots share, not a window per slot: more slots cost no more KV', async () => {
    // -kvu is always sent (args.ts): two slots draw from the same 32768 cells one would.
    const two = await planLlamaLoad(
      input({ fit: true, fit_target: '', concurrent_mode: true, concurrent_slots: 2 }),
      smallMac()
    )
    expect(two.fitCtxCeiling).toBe(32_768)
    const parallel = await planLlamaLoad(
      input({ fit: true, fit_target: '', parallel: 2 } as Partial<LlamacppConfigInput>),
      smallMac()
    )
    expect(parallel.fitCtxCeiling).toBe(32_768)
    // Four slots of Llama-3.2-3B narrow exactly as one does: 10240 tokens.
    const four = await planLlamaLoad(
      input({ fit: true, fit_target: '', concurrent_mode: true, concurrent_slots: 4 }),
      smallMac({ meta: LLAMA32_3B_META, files: { [MODEL]: LLAMA32_3B_WEIGHTS } })
    )
    expect(four.fitCtxCeiling).toBe(10_240)
  })

  it('counts a sliding-window layer once per slot of the shared pool', async () => {
    // Gemma 3 shaped: 26 blocks (4 global, 22 sliding), 4 KV heads of 256, a 512-token window.
    const gemma3 = {
      'general.architecture': 'gemma3',
      'gemma3.block_count': '26',
      'gemma3.context_length': '131072',
      'gemma3.attention.head_count': '8',
      'gemma3.attention.head_count_kv': '4',
      'gemma3.attention.key_length': '256',
      'gemma3.attention.value_length': '256',
      'gemma3.attention.sliding_window': '512',
    }
    const plan = (slots: number) =>
      planLlamaLoad(
        input({ fit: true, fit_target: '', parallel: slots } as Partial<LlamacppConfigInput>),
        smallMac({ meta: gemma3, files: { [MODEL]: 2.5 * GiB } })
      )
    // 512 MiB left. One slot: 22 sliding layers × 1024 cells × 4 KiB = 88 MiB, the rest at 16 KiB a
    // token for the 4 global layers: 27136 tokens.
    expect((await plan(1)).fitCtxCeiling).toBe(27_136)
    // Four slots: a window each, 2560 cells (220 MiB) — 18688 tokens, not a quarter of one slot's.
    expect((await plan(4)).fitCtxCeiling).toBe(18_688)
  })

  it('leaves the window to llama.cpp on a 16 GiB Mac', async () => {
    const plan = await planLlamaLoad(
      input({ fit: true, fit_target: '' }),
      smallMac({
        unifiedMemory: async () => ({ totalMemoryBytes: 16 * GiB }),
        listDevices: async () => [{ id: 'MTL0', name: 'Apple M4', mem: 12_124, free: 12_124 }],
      })
    )
    expect(plan.config.fit_target).toBe(String(12_124 - 8 * 1024))
    expect(plan.fitCtxCeiling).toBeUndefined()
    expect('fitCtxCeiling' in plan).toBe(false)
  })

  it.each([
    ['fit is off', { fit: false, fit_target: '' }, {}],
    ['the user set their own margin', { fit: true, fit_target: '2048' }, {}],
    ['the user raised the fit floor past the ceiling', { fit: true, fit_target: '', fit_ctx: '65536' }, {}],
    ['the user pinned another device', { fit: true, fit_target: '', device: 'none' }, {}],
    ['the GGUF cannot be read', { fit: true, fit_target: '' }, { readGgufMetadata: async () => undefined }],
    [
      'the model was trained for less than fits',
      { fit: true, fit_target: '' },
      { meta: { ...LFM25_META, 'lfm2.context_length': '4096' } },
    ],
  ])('caps nothing when %s', async (_name, config, over) => {
    const plan = await planLlamaLoad(input(config), smallMac(over as Partial<LoadPlanDeps>))
    expect(plan.fitCtxCeiling).toBeUndefined()
    expect(plan.warnings.some((w) => w.startsWith('Unified memory below 16 GiB'))).toBe(false)
  })

  it('caps nothing for an embedding model', async () => {
    const plan = await planLlamaLoad(
      { ...input({ fit: true, fit_target: '' }), isEmbedding: true },
      smallMac()
    )
    expect(plan.fitCtxCeiling).toBeUndefined()
  })
})

describe('planLlamaLoad — the context plan as the default window', () => {
  const GiB = 2 ** 30
  const MODEL = '/data/llamacpp/models/m/model.gguf'
  // bartowski/Meta-Llama-3.1-8B-Instruct-GGUF Q4_K_M: 128 KiB of KV a token, 4693 MiB of weights.
  const LLAMA31_8B_META = {
    'general.architecture': 'llama',
    'llama.block_count': '32',
    'llama.context_length': '131072',
    'llama.attention.head_count': '32',
    'llama.attention.head_count_kv': '8',
    'llama.attention.key_length': '128',
    'llama.attention.value_length': '128',
  }
  const CUDA_12 = [{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', mem: 12_288, free: 11_900 }]
  const onGpu = (devices = CUDA_12, over: Partial<LoadPlanDeps> = {}) =>
    deps({
      files: { [MODEL]: 4_920_734_016 },
      meta: LLAMA31_8B_META,
      listDevices: async () => devices,
      systemMemory: async () => ({ totalMemoryBytes: 32 * GiB, freeMemoryBytes: 24 * GiB }),
      ...over,
    })

  it('makes the plan fit’s floor on a discrete GPU, so fit moves layers instead of shrinking to 4K', async () => {
    const plan = await planLlamaLoad(input({ fit: true, fit_ctx: '4096', ctx_size: 0 }), onGpu())
    // 11900 − 1024 MiB, 4693 of weights, 1024 of reserve, a quarter of the weights may leave.
    expect(plan.config.fit_ctx).toBe('50432')
    expect(plan.contextPlan).toEqual({
      recommendedCtx: 50_432,
      maxCtx: 50_432,
      trainedCtx: 131_072,
      kvBytesPerToken: 131_072,
      basis: 'gpu',
    })
    expect(plan.warnings).toContain(
      'GPU: fit keeps at least 50432 tokens for "m", moving layers to system RAM if it must.'
    )
    // It reaches llama-server as `--fit-ctx`, with no `--ctx-size` to end fit's search.
    const { argv } = planLlamaArgs(plan.config, {
      provider: 'llamacpp-upstream',
      isEmbedding: false,
      modelId: 'm',
      modelPath: plan.modelPath,
      port: plan.port,
    })
    expect(argv.slice(argv.indexOf('--fit'), argv.indexOf('--fit') + 4)).toEqual([
      '--fit',
      'on',
      '--fit-ctx',
      '50432',
    ])
    expect(argv).not.toContain('--ctx-size')
    // The app's per-model 4096 is the schema default too, and an empty floor is no one's choice.
    const model = await planLlamaLoad(
      { ...input({ fit: true, fit_ctx: '' }), overrides: { fit_ctx: 4096 as unknown as string } },
      onGpu()
    )
    expect(model.config.fit_ctx).toBe('50432')
    // A 24 GB card holds the whole trained window beside the weights.
    const big = await planLlamaLoad(
      input({ fit: true, fit_ctx: '' }),
      onGpu([{ id: 'CUDA0', name: 'RTX 4090', mem: 24_564, free: 24_100 }])
    )
    expect(big.config.fit_ctx).toBe('131072')
  })

  it('keeps a fit floor somebody chose, and a plan that is no wider than llama.cpp’s own', async () => {
    const chosen = await planLlamaLoad(input({ fit: true, fit_ctx: '8192' }), onGpu())
    expect(chosen.config.fit_ctx).toBe('8192')
    expect(chosen.contextPlan?.maxCtx).toBe(50_432)
    // 8 GB card with a model larger than it: the floor fit would take anyway stays 4096 when the plan
    // gives no more.
    const tiny = await planLlamaLoad(
      input({ fit: true, fit_ctx: '4096' }),
      onGpu([{ id: 'CUDA0', name: 'GT 1030', mem: 2048, free: 1900 }], {
        systemMemory: async () => ({ totalMemoryBytes: 8 * GiB, freeMemoryBytes: 2 * GiB }),
      })
    )
    expect(tiny.contextPlan?.maxCtx).toBe(4096)
    expect(tiny.config.fit_ctx).toBe('4096')
    expect(tiny.warnings.some((w) => w.startsWith('GPU: fit keeps'))).toBe(false)
  })

  it('leaves the window to fit on unified memory, and plans it by fit’s budget', async () => {
    const plan = await planLlamaLoad(
      input({ fit: true, fit_ctx: '', fit_target: '' }),
      onGpu([{ id: 'MTL0', name: 'Apple M3 Pro', mem: 27_648, free: 27_648 }], {
        unifiedMemory: async () => ({ totalMemoryBytes: 36 * GiB }),
      })
    )
    expect(plan.config.fit_ctx).toBe('')
    expect(plan.config.fit_target).toBe(String(27_648 - 18 * 1024))
    // Half of 36 GiB: 18432 − 4693 − 1024 MiB of KV → 101632.
    expect(plan.contextPlan).toMatchObject({ maxCtx: 101_632, basis: 'unified' })
  })

  it('gives a fit-off load without a window the plan: every layer on the card, never below 32K', async () => {
    const plan = (devices: typeof CUDA_12) =>
      planLlamaLoad(input({ fit: false, ctx_size: 0 }), onGpu(devices))
    // 11900 − 1024 − 4693 − 1024 MiB of KV: 41216 tokens, all on the card.
    expect((await plan(CUDA_12)).config.ctx_size).toBe(41_216)
    expect((await plan([{ id: 'CUDA0', name: 'RTX 4090', mem: 24_564, free: 24_100 }])).config.ctx_size).toBe(
      131_072
    )
    expect((await plan([{ id: 'CUDA0', name: 'RTX 4060', mem: 8188, free: 7800 }])).config.ctx_size).toBe(
      32_768
    )
    // A CPU build lists no device: half of RAM, 16384 − 4693 − 1024 MiB → 85248.
    const cpu = await plan([])
    expect(cpu.config.ctx_size).toBe(85_248)
    expect(cpu.contextPlan?.basis).toBe('cpu')
    // A window somebody chose stands, and the plan still says how far it could grow.
    const chosen = await planLlamaLoad(input({ fit: false, ctx_size: 8192 }), onGpu())
    expect(chosen.config.ctx_size).toBe(8192)
    expect(chosen.contextPlan?.maxCtx).toBe(41_216)
  })

  it('keeps the previous small-Mac default when the GGUF gives no KV shape to plan with', async () => {
    const plan = await planLlamaLoad(
      input({ fit: false, ctx_size: 0 }),
      deps({
        meta: { 'general.architecture': 'llama', 'llama.context_length': '131072' },
        unifiedMemory: async () => ({ totalMemoryBytes: 8 * GiB }),
      })
    )
    expect(plan.contextPlan).toBeUndefined()
    expect(plan.config.ctx_size).toBe(16_384)
  })

  it('keeps the previous default when the device cannot be read', async () => {
    const plan = await planLlamaLoad(
      input({ fit: false, ctx_size: 0 }),
      onGpu(CUDA_12, {
        listDevices: async () => Promise.reject(new Error('timed out')),
        systemMemory: async () => undefined,
      })
    )
    expect(plan.config.ctx_size).toBe(32_768)
    expect(plan.contextPlan).toBeUndefined()
  })
})
