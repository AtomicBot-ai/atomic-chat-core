import { describe, expect, it, vi } from 'vitest'
import type { ModelYmlDocument } from '../../models/index.js'
import { withLlamacppDefaults } from './args.js'
import type { LlamacppConfigInput } from './args.js'
import { autoUnloadTargets, nextRetry, planLlamaLoad, resolveModelMaxCtxTrain } from './load-plan.js'
import type { LoadPlan, LoadPlanDeps } from './load-plan.js'

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

  it('never lists devices off Apple silicon or for an embedding model', async () => {
    const listDevices = vi.fn(async () => METAL_18)
    const { unifiedMemory: _unused, ...offMac } = fitDeps({ listDevices })
    const plan = await planLlamaLoad(input({ fit: true, fit_target: '' }), offMac)
    expect(plan.config.fit_target).toBe('')
    const noFacts = await planLlamaLoad(
      input({ fit: true, fit_target: '' }),
      fitDeps({ listDevices, unifiedMemory: async () => undefined })
    )
    expect(noFacts.config.fit_target).toBe('')
    const embedding = await planLlamaLoad(
      { ...input({ fit: true, fit_target: '' }), isEmbedding: true },
      fitDeps({ listDevices })
    )
    expect(embedding.config.fit_target).toBe('')
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

  it('counts every shard and the minimum context of every slot toward what the model needs', async () => {
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
    // Four slots at a 32K floor: 11 GiB of KV alone, more than Metal leaves.
    const slots = await planLlamaLoad(
      input({ fit: true, fit_target: '', fit_ctx: '32768', parallel: 4 } as Partial<LlamacppConfigInput>),
      fitDeps()
    )
    expect(slots.config.fit_target).toBe('')
    // Concurrent mode's slots count, not `parallel`: three slots at 32K are 8448 MiB of KV, and
    // 2292 + 8448 + 1024 MiB needs more than half of 18 GiB.
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
    expect(concurrent.config.fit_target).toBe(String(13_640 - 11_765))
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
