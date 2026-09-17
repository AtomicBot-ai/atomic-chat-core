import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  backendExeCandidates,
  dataLayout,
  llamaServerExeName,
  modelDirFromId,
  modelIdFromDir,
  resolveDataRelative,
} from './paths.js'

const layout = dataLayout('/data')

describe('dataLayout', () => {
  it('shares the GGUF tree between both llama.cpp providers and isolates backends', () => {
    expect(layout.provider('llamacpp-upstream').modelsDir).toBe('/data/llamacpp/models')
    expect(layout.provider('llamacpp').modelsDir).toBe('/data/llamacpp/models')
    expect(layout.provider('llamacpp-upstream').backendsDir).toBe('/data/llamacpp-upstream/backends')
    expect(layout.provider('llamacpp').backendsDir).toBe('/data/llamacpp/backends')
    expect(layout.provider('llamacpp').libDir).toBe('/data/llamacpp/lib')
    expect(layout.provider('llamacpp-upstream').libDir).toBeUndefined()
    expect(layout.provider('mlx').modelsDir).toBe('/data/mlx/models')
  })
  it('puts every new file under <data>/atomic-core and keeps the legacy files at the root', () => {
    expect(layout.core.settings).toBe('/data/atomic-core/settings.json')
    expect(layout.core.instanceLock).toBe('/data/atomic-core/instance.lock')
    expect(layout.serverStateFile).toBe('/data/local-api-server.json')
    expect(layout.chatgptAuthFile).toBe('/data/atomic-chatgpt-auth.json')
  })
  it("keeps image generation where the app's plugin put it", () => {
    // `state.rs` at 767ff6350: `<data>/diffusion/{backends,models,scratch}`, gallery in `<data>/images`.
    expect(layout.diffusion).toEqual({
      root: '/data/diffusion',
      backendsDir: '/data/diffusion/backends',
      modelsDir: '/data/diffusion/models',
      scratchDir: '/data/diffusion/scratch',
      defaultOutputDir: '/data/images',
    })
  })
})

describe('path helpers', () => {
  it('names the executable per platform and lists both pack layouts', () => {
    expect(llamaServerExeName('win32')).toBe('llama-server.exe')
    expect(llamaServerExeName('darwin')).toBe('llama-server')
    expect(
      backendExeCandidates(layout.provider('llamacpp-upstream'), 'b10405', 'macos-arm64', 'llama-server')
    ).toEqual([
      '/data/llamacpp-upstream/backends/b10405/macos-arm64/build/bin/llama-server',
      '/data/llamacpp-upstream/backends/b10405/macos-arm64/llama-server',
    ])
  })
  it('maps model ids to nested directories and back with forward slashes', () => {
    const models = '/data/llamacpp/models'
    expect(modelDirFromId(models, 'org/model/q4')).toBe('/data/llamacpp/models/org/model/q4')
    expect(modelIdFromDir(models, '/data/llamacpp/models/org/model/q4')).toBe('org/model/q4')
  })
  it('resolves model.yml paths relative to <data> unless absolute', () => {
    expect(resolveDataRelative('/data', 'llamacpp/models/x/model.gguf', isAbsolute)).toBe(
      '/data/llamacpp/models/x/model.gguf'
    )
    expect(resolveDataRelative('/data', '/abs/model.gguf', isAbsolute)).toBe('/abs/model.gguf')
  })
})
