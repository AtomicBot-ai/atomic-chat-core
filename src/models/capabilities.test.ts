import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { ContextPlan } from '../contracts/index.js'
import { ModelCapabilityService, modelYmlContextPlan } from './capabilities.js'
import type { CapabilitiesDeps } from './capabilities.js'
import { ModelRegistry } from './registry.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-capabilities-')
})
afterEach(() => data.cleanup())

const LLAMA: Record<string, string> = {
  'general.architecture': 'llama',
  'llama.context_length': '8192',
}

function service(metadata: Record<string, Record<string, string>> = {}) {
  return new ModelCapabilityService({
    layout: data.layout,
    registry: () => new ModelRegistry(data.layout),
    readMetadata: async (path) => {
      const found = Object.entries(metadata).find(([suffix]) => path.endsWith(suffix))
      if (!found) throw new Error(`no fixture metadata for ${path}`)
      return found[1]
    },
  })
}

describe('validateGguf', () => {
  it('accepts a model and hands back what it read', async () => {
    const result = await service({ 'model.gguf': LLAMA }).validateGguf('/x/model.gguf')

    expect(result.isValid).toBe(true)
    expect(result.metadata?.['general.architecture']).toBe('llama')
  })

  it('rejects a CLIP file by name, because it parses perfectly and is not a model', async () => {
    // A projector imported as a model produces a session that answers every prompt with nothing.
    const clip = { 'general.architecture': 'clip' }

    const result = await service({ 'mmproj.gguf': clip }).validateGguf('/x/mmproj.gguf')

    expect(result.isValid).toBe(false)
    expect(result.error).toMatch(/CLIP/)
    expect(result.metadata, 'the caller still gets what was read').toBeDefined()
  })

  it('rejects a decision model, which answers probabilities and runs only in the decision module', async () => {
    const laya = { 'general.architecture': 'laya', 'laya.context_length': '1024' }
    const stamped = { ...LLAMA, 'general.architecture': 'qwen35', 'decision.layout': 'semif-letters' }

    const result = await service({ 'laya.gguf': laya, 'arbiter.gguf': stamped }).validateGguf('/x/laya.gguf')
    const arbiter = await service({ 'arbiter.gguf': stamped }).validateGguf('/x/arbiter.gguf')

    expect(result).toMatchObject({ isValid: false, error: expect.stringMatching(/decision model/) })
    expect(result.metadata?.['general.architecture']).toBe('laya')
    expect(arbiter.isValid).toBe(false)
  })

  it('rejects a laya checkpoint folder without reading it as a GGUF', async () => {
    const folder = new ModelCapabilityService({
      layout: data.layout,
      registry: () => new ModelRegistry(data.layout),
      readMetadata: async () => {
        throw new Error('a folder is not read as a GGUF')
      },
      isCheckpointDir: async (path) => path.endsWith('laya-multilingual'),
    })

    const result = await folder.validateGguf('/data/decision/models/laya-multilingual')

    expect(result).toEqual({ isValid: false, error: expect.stringMatching(/decision model/) })
  })

  it('answers rather than throws for a file that is not a GGUF at all', async () => {
    // The user pointed at a file; "that is not a model" is the answer, not a core failure.
    const result = await service().validateGguf('/x/notes.txt')

    expect(result.isValid).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('capabilities', () => {
  it('reads the trained context and the model kind from the header', async () => {
    await data.writeModel('demo')

    const caps = await service({ 'model.gguf': LLAMA }).capabilities('llamacpp-upstream', 'demo')

    expect(caps.maxCtxTrain).toBe(8192)
    expect(caps.isEmbedding).toBe(false)
    expect(caps.vision).toBe(false)
  })

  it('answers for a model it cannot read, instead of failing the list it is part of', async () => {
    await data.writeModel('broken')

    const caps = await service().capabilities('llamacpp-upstream', 'broken')

    expect(caps.modelId).toBe('broken')
    expect(caps.maxCtxTrain).toBeUndefined()
    expect(caps.mmprojExists).toBe(false)
  })

  it('answers for a model that is not installed at all', async () => {
    const caps = await service().capabilities('llamacpp-upstream', 'missing')

    expect(caps).toMatchObject({ modelId: 'missing', isEmbedding: false, vision: false })
  })

  it('reports speculative support from the model id, which needs no files', async () => {
    const caps = await service().capabilities('llamacpp-upstream', 'missing')

    expect(typeof caps.gemmaMtp).toBe('boolean')
    expect(typeof caps.dflash).toBe('boolean')
    expect(Array.isArray(caps.dflashDrafts)).toBe(true)
  })

  it('reports an embedding model as one', async () => {
    await data.writeModel('embedder')
    const embedding = { ...LLAMA, 'general.architecture': 'bert', 'bert.pooling_type': '1' }

    const caps = await service({ 'model.gguf': embedding }).capabilities('llamacpp-upstream', 'embedder')

    expect(caps.isEmbedding).toBe(true)
    expect(caps.isDecision).toBe(false)
  })

  it('reports a decision model as one, and never as an embedding model', async () => {
    await data.writeModel('router')
    const laya = { 'general.architecture': 'laya', 'laya.context_length': '1024', 'laya.pooling_type': '1' }

    const caps = await service({ 'model.gguf': laya }).capabilities('llamacpp-upstream', 'router')

    expect(caps).toMatchObject({ isDecision: true, isEmbedding: false })
  })
})

describe('capabilities — the context plan', () => {
  const PLAN: ContextPlan = { recommendedCtx: 50_432, maxCtx: 50_432, trainedCtx: 8192, basis: 'gpu' }
  const planned = (
    metadata: Record<string, Record<string, string>>,
    planContext: NonNullable<CapabilitiesDeps['planContext']>,
    fileSize?: CapabilitiesDeps['fileSize']
  ) =>
    new ModelCapabilityService({
      layout: data.layout,
      registry: () => new ModelRegistry(data.layout),
      readMetadata: async (path) => {
        const found = Object.entries(metadata).find(([suffix]) => path.endsWith(suffix))
        if (!found) throw new Error(`no fixture metadata for ${path}`)
        return found[1]
      },
      planContext,
      ...(fileSize ? { fileSize } : {}),
    })

  it('asks the provider’s planner with the header and the weights of every shard', async () => {
    await data.writeModel('demo', {}, { ggufBytes: 1000 })
    const asked: Array<[string, number]> = []
    const caps = await planned({ 'model.gguf': LLAMA }, async (provider, model) => {
      asked.push([provider, model.weightsBytes])
      expect(model.metadata).toBe(LLAMA)
      return PLAN
    }).capabilities('llamacpp-upstream', 'demo')
    expect(caps.contextPlan).toEqual(PLAN)
    expect(asked).toEqual([['llamacpp-upstream', 1000]])

    await data.writeModel('split', { model_path: 'llamacpp/models/split/m-00001-of-00002.gguf' })
    const sizes: Record<string, number> = { '-00001-of-00002.gguf': 3000, '-00002-of-00002.gguf': 4000 }
    const weights: number[] = []
    await planned(
      { 'm-00001-of-00002.gguf': LLAMA },
      async (_provider, model) => {
        weights.push(model.weightsBytes)
        return PLAN
      },
      async (path) => Object.entries(sizes).find(([suffix]) => path.endsWith(suffix))?.[1]
    ).capabilities('llamacpp-upstream', 'split')
    expect(weights).toEqual([7000])
  })

  it('gives none for an embedding model, a planner that has none or fails, or no planner', async () => {
    await data.writeModel('embedder')
    const embedding = { ...LLAMA, 'general.architecture': 'bert', 'bert.pooling_type': '1' }
    let asked = 0
    const counting = async () => {
      asked++
      return PLAN
    }
    expect(
      (await planned({ 'model.gguf': embedding }, counting).capabilities('llamacpp-upstream', 'embedder'))
        .contextPlan
    ).toBeUndefined()
    expect(asked).toBe(0)
    await data.writeModel('demo')
    expect(
      (
        await planned({ 'model.gguf': LLAMA }, async () => undefined).capabilities(
          'llamacpp-upstream',
          'demo'
        )
      ).contextPlan
    ).toBeUndefined()
    expect(
      (
        await planned({ 'model.gguf': LLAMA }, async () => {
          throw new Error('probe failed')
        }).capabilities('llamacpp-upstream', 'demo')
      ).contextPlan
    ).toBeUndefined()
    expect(
      (await service({ 'model.gguf': LLAMA }).capabilities('llamacpp-upstream', 'demo')).contextPlan
    ).toBe(undefined)
  })

  it('takes the window a model.yml block fixes, without asking the planner', async () => {
    await data.writeModel('npu', {
      geniex: {
        model_id: 'm',
        variant_id: 'v',
        plugin: 'llama_cpp',
        backend: 'npu',
        context_length: 4096,
        tools: false,
        reasoning: false,
        vision: false,
        source: 'curated',
      },
    })
    let asked = 0
    const caps = await planned({ 'model.gguf': LLAMA }, async () => {
      asked++
      return PLAN
    }).capabilities('llamacpp-upstream', 'npu')
    expect(caps.contextPlan).toEqual({ recommendedCtx: 4096, maxCtx: 4096, trainedCtx: 4096, basis: 'model' })
    expect(asked).toBe(0)
  })
})

describe('modelYmlContextPlan', () => {
  const yml = (extra: Record<string, unknown>) =>
    ({ model_path: 'm.gguf', name: 'm', size_bytes: 0, ...extra }) as Parameters<
      typeof modelYmlContextPlan
    >[0]

  it('reads the Foundry Local, LiteRT-LM, GenieX or FastFlowLM window, and nothing else', () => {
    expect(modelYmlContextPlan(yml({ foundry_local: { context_length: 8192 } }))?.maxCtx).toBe(8192)
    expect(modelYmlContextPlan(yml({ litert_lm: { context_length: 32_768 } }))).toEqual({
      recommendedCtx: 32_768,
      maxCtx: 32_768,
      trainedCtx: 32_768,
      basis: 'model',
    })
    expect(modelYmlContextPlan(yml({ geniex: { context_length: 4096 } }))?.maxCtx).toBe(4096)
    expect(modelYmlContextPlan(yml({ fastflowlm: { context_length: 131_072 } }))?.maxCtx).toBe(131_072)
    expect(modelYmlContextPlan(yml({ litert_lm: {} }))).toBeUndefined()
    expect(modelYmlContextPlan(yml({ geniex: { context_length: 0 } }))).toBeUndefined()
    expect(modelYmlContextPlan(yml({}))).toBeUndefined()
  })
})

describe('mmprojExists', () => {
  it('reads vision from the projector, not from the model', async () => {
    // `classifyProjector` answers "vision" for metadata with no clip keys, because a projector that
    // says nothing else is a vision projector. Asked about a text model it would claim every one of
    // them takes images — which is exactly the bug this guards.
    await data.writeModel('text-only')
    const caps = await service({ 'model.gguf': LLAMA }).capabilities('llamacpp-upstream', 'text-only')
    expect(caps.vision, 'a model with no projector takes no images').toBe(false)

    await data.writeModel('sees')
    const modelsDir = data.layout.provider('llamacpp-upstream').modelsDir
    await writeFile(join(modelsDir, 'sees', 'mmproj.gguf'), 'x')

    const withProjector = await service({
      'model.gguf': LLAMA,
      'mmproj.gguf': { 'clip.has_vision_encoder': 'true' },
    }).capabilities('llamacpp-upstream', 'sees')

    expect(withProjector.vision).toBe(true)
    expect(withProjector.audio).toBe(false)
  })

  it('finds the projector the model.yml names', async () => {
    await data.writeModel('vision', { mmproj_path: 'llamacpp/models/vision/proj.gguf' })
    const projector = join(data.layout.root, 'llamacpp/models/vision/proj.gguf')
    await mkdir(join(projector, '..'), { recursive: true })
    await writeFile(projector, 'x')

    const caps = await service({ 'model.gguf': LLAMA }).capabilities('llamacpp-upstream', 'vision')

    expect(caps.mmprojExists).toBe(true)
  })

  it('finds the conventional one beside the model when the yml names none', async () => {
    // Models imported before the yml carried the field would otherwise lose their vision.
    await data.writeModel('vision')
    const modelsDir = data.layout.provider('llamacpp-upstream').modelsDir
    await writeFile(join(modelsDir, 'vision', 'mmproj.gguf'), 'x')

    const caps = await service({ 'model.gguf': LLAMA }).capabilities('llamacpp-upstream', 'vision')

    expect(caps.mmprojExists).toBe(true)
  })

  it('reports none when neither is there', async () => {
    await data.writeModel('text-only')

    const caps = await service({ 'model.gguf': LLAMA }).capabilities('llamacpp-upstream', 'text-only')

    expect(caps.mmprojExists).toBe(false)
  })

  it('does not take a declared path that does not exist as a projector', async () => {
    await data.writeModel('broken-vision', { mmproj_path: 'llamacpp/models/broken-vision/gone.gguf' })

    const caps = await service({ 'model.gguf': LLAMA }).capabilities('llamacpp-upstream', 'broken-vision')

    expect(caps.mmprojExists).toBe(false)
  })
})
