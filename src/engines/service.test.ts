import { describe, expect, it } from 'vitest'
import type { EngineId, EngineKind, EngineVersions } from '../contracts/index.js'
import { EnginesService, hostEngines } from './service.js'
import type { EngineHandle } from './service.js'

describe('hostEngines', () => {
  it('lists the llama.cpp providers, sd.cpp and MLX on macOS, and no managed engine', () => {
    expect(hostEngines('darwin', [])).toEqual([
      'llamacpp-upstream',
      'llamacpp',
      'atomic-prism',
      'sd-cpp',
      'mlx',
    ])
  })

  it('has no MLX off macOS, and the managed engines this core offers', () => {
    expect(hostEngines('win32', [])).toEqual(['llamacpp-upstream', 'llamacpp', 'atomic-prism', 'sd-cpp'])
    expect(hostEngines('linux', ['vllm', 'tensorrt-llm'])).toEqual([
      'llamacpp-upstream',
      'llamacpp',
      'atomic-prism',
      'sd-cpp',
      'tensorrt-llm',
      'vllm',
    ])
  })
})

function fakeHandle(engine: EngineId, kind: EngineKind, over: Partial<EngineHandle> = {}): EngineHandle {
  const entry: EngineVersions = {
    engine,
    kind,
    active_choice: kind === 'llamacpp' ? 'client' : 'core',
    builds: [],
    active: null,
    latest: null,
    update: { needed: false, target: null, apply: kind === 'managed' ? 'reinstall' : 'swap' },
    source: 'remote',
    source_error: null,
    error: null,
  }
  return {
    engine,
    kind,
    versions: async () => entry,
    update: async () => ({ updated: false, reason: 'no-update', active: null, retired: [], kept_in_use: [] }),
    remove: async () => ({ removed: false }),
    ...over,
  }
}

describe('EnginesService.versions', () => {
  it('answers the registered engines in catalog order and passes the request to each', async () => {
    const seen: unknown[] = []
    const service = new EnginesService({
      engines: [
        fakeHandle('mlx', 'engine-build'),
        fakeHandle('llamacpp-upstream', 'llamacpp', {
          versions: async (request) => {
            seen.push(request)
            return await fakeHandle('llamacpp-upstream', 'llamacpp').versions(request)
          },
        }),
      ],
    })
    const response = await service.versions({ force: true })
    expect(response.engines.map((entry) => entry.engine)).toEqual(['llamacpp-upstream', 'mlx'])
    expect(seen).toEqual([{ force: true }])
  })
})

describe('EnginesService.remove', () => {
  it('sends the removal to the engine it names, options included, and refuses any other engine', async () => {
    const seen: unknown[] = []
    const service = new EnginesService({
      engines: [
        fakeHandle('vllm', 'managed', {
          remove: async (version, variant, options) => {
            seen.push([version, variant, options])
            return { operation_id: 'op-1' }
          },
        }),
      ],
    })
    expect(await service.remove('vllm', 'vllm-0.31.0-r1', 'linux/amd64', { retainModels: false })).toEqual({
      operation_id: 'op-1',
    })
    expect(seen).toEqual([['vllm-0.31.0-r1', 'linux/amd64', { retainModels: false }]])
    await expect(service.remove('tensorrt-llm', 'x', 'y')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('EnginesService.activate', () => {
  it('refuses an engine whose active build the core picks', async () => {
    const service = new EnginesService({ engines: [fakeHandle('sd-cpp', 'engine-build')] })
    await expect(service.activate('sd-cpp', 'master-900-a', 'macos-arm64')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('sends the activation to a llama.cpp engine', async () => {
    const service = new EnginesService({
      engines: [
        fakeHandle('llamacpp', 'llamacpp', {
          activate: async (version, variant) => ({ activated: true, active: { version, variant } }),
        }),
      ],
    })
    expect(await service.activate('llamacpp', 'b1', 'win-cpu-x64')).toEqual({
      activated: true,
      active: { version: 'b1', variant: 'win-cpu-x64' },
    })
  })
})
