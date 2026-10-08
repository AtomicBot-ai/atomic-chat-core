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
  return { engine, kind, versions: async () => entry, ...over }
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
