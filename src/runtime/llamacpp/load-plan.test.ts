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
