import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { ModelCapabilityService } from './capabilities.js'
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
