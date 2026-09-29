import { describe, expect, it } from 'vitest'
import type { AtomicCoreError, LocalProviderId, UnloadResult } from '../contracts/index.js'
import type { GpuOccupancy, LocalRuntime } from '../runtime/index.js'
import type { ResidencyOccupant } from './gpu/index.js'
import { wireGpuResidency } from './gpu-residency.js'

/** A runtime reduced to what residency reads: the sessions it reports on the GPU. */
function runtime(occupancy: GpuOccupancy[]): LocalRuntime {
  return { gpuOccupancy: () => occupancy } as unknown as LocalRuntime
}

function world() {
  const llama = [
    { model_id: 'chat', cards: 'all', auxiliary: false, state: 'ready' },
    { model_id: 'emb', cards: 'all', auxiliary: true, state: 'ready' },
    { model_id: 'cpu', cards: [], auxiliary: false, state: 'ready' },
  ] as GpuOccupancy[]
  const mlx = [
    { model_id: 'mlx-loading', cards: 'all', auxiliary: false, state: 'loading' },
  ] as GpuOccupancy[]
  const trt = [] as GpuOccupancy[]
  const image = [{ model_id: 'flux', cards: 'all', auxiliary: false, state: 'ready' }] as GpuOccupancy[]
  const leftovers: ResidencyOccupant[] = []
  const calls: string[] = []
  const tables: Record<string, GpuOccupancy[]> = { 'llamacpp-upstream': llama, mlx, 'tensorrt-llm': trt }
  const stuck = new Set<string>()
  const drop = (list: GpuOccupancy[], modelId: string) => {
    const index = list.findIndex((o) => o.model_id === modelId)
    if (index >= 0) list.splice(index, 1)
  }
  const residency = wireGpuResidency({
    runtimes: new Map<LocalProviderId, LocalRuntime>([
      ['llamacpp-upstream', runtime(llama)],
      ['mlx', runtime(mlx)],
      ['tensorrt-llm', runtime(trt)],
      // A runtime that reports nothing (Foundation Models) is simply not on the GPU.
      ['foundation-models', {} as LocalRuntime],
    ]),
    diffusion: () => ({
      gpuOccupancy: () => image,
      unloadModel: async () => {
        calls.push('diffusion.unloadModel')
        image.splice(0)
      },
    }),
    leftovers: () => leftovers,
    sessions: () => ({
      cancelLoad: (provider, modelId) => {
        calls.push(`cancelLoad ${provider}/${modelId}`)
        return true
      },
      unload: async (provider, modelId): Promise<UnloadResult> => {
        calls.push(`unload ${provider}/${modelId}`)
        if (stuck.has(modelId)) return { success: false, error: 'the process would not exit' }
        drop(tables[provider] ?? [], modelId)
        return { success: true }
      },
    }),
  })
  return { residency, calls, stuck, llama, mlx, trt, image, leftovers }
}

describe('wireGpuResidency', () => {
  it('stops every engine on the card through the core’s own unload — cancelling a load first — and diffusion through its service', async () => {
    const w = world()
    await w.residency.hook('tensorrt-llm')({ model_id: 'llama-3', cards: ['GPU-0'], auxiliary: false })
    expect(w.calls).toEqual([
      'unload llamacpp-upstream/chat',
      'cancelLoad mlx/mlx-loading',
      'unload mlx/mlx-loading',
      'diffusion.unloadModel',
    ])
    // The embedding model and the CPU model stay.
    expect(w.llama.map((o) => o.model_id)).toEqual(['emb', 'cpu'])
  })

  it('refuses with GPU_BUSY naming the session whose unload failed, and the reason', async () => {
    const w = world()
    w.stuck.add('chat')
    const error = (await w.residency
      .hook('diffusion')({ model_id: 'sdxl', cards: 'all', auxiliary: false })
      .catch((e: unknown) => e)) as AtomicCoreError
    expect(error.code).toBe('GPU_BUSY')
    expect(error.details).toBe(
      'holder=llamacpp-upstream/chat state=ready cards=all cause=the process would not exit'
    )
  })

  it('counts the containers a previous core left unconfirmed as holding every card', async () => {
    const w = world()
    w.leftovers.push({
      provider: 'tensorrt-llm',
      model_id: 'oldctr',
      cards: 'all',
      auxiliary: false,
      state: 'stop-unconfirmed',
      evict: async () => {
        w.calls.push('retry oldctr')
        throw new Error('Docker did not confirm container oldctr stopped.')
      },
    })
    const error = (await w.residency
      .hook('llamacpp')({ model_id: 'c', cards: 'all', auxiliary: false })
      .catch((e: unknown) => e)) as AtomicCoreError
    expect(w.calls).toContain('retry oldctr')
    expect(error.details).toBe(
      'holder=tensorrt-llm/oldctr state=stop-unconfirmed cards=all cause=Docker did not confirm container oldctr stopped.'
    )
  })

  it('reads a core with no image generation wired as having none on the GPU', async () => {
    const w = world()
    const residency = wireGpuResidency({
      runtimes: new Map(),
      diffusion: () => undefined,
      leftovers: () => [],
      sessions: () => {
        throw new Error('nothing to stop')
      },
    })
    await residency.hook('mlx')({ model_id: 'm', cards: 'all', auxiliary: false })
    expect(w.calls).toEqual([])
  })
})
