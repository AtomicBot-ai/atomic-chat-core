import { describe, expect, it } from 'vitest'
import type { AtomicCoreError, LocalProviderId, SessionInfo, UnloadResult } from '../contracts/index.js'
import type { ExternalSessions, GpuOccupancy, LocalRuntime } from '../runtime/index.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { ResidencyOccupant } from './gpu/index.js'
import { wireGpuResidency } from './gpu-residency.js'
import { LocalSessions } from './sessions.js'

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
  it('stops every engine on the card through the core’s own unload — cancelling any pending acquire first — and diffusion through its service', async () => {
    const w = world()
    await w.residency.hook('tensorrt-llm')({ model_id: 'llama-3', cards: ['GPU-0'], auxiliary: false })
    expect(w.calls).toEqual([
      'cancelLoad llamacpp-upstream/chat',
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

  it('a reload in place of A racing a claim that evicts A resolves: the reload gives up, the eviction goes on (final review I-3)', async () => {
    const data = await makeTmpDataFolder('residency-reload-race-')
    try {
      // `tensorrt-llm`'s A, loaded; a reload with new restart-relevant settings stops the old container
      // (held on `stopOld`) inside A's model transition, then claims the card again.
      const trt = new Map<string, GpuOccupancy['state']>()
      let releaseOldStop!: () => void
      const stopOld = new Promise<void>((resolve) => (releaseOldStop = resolve))
      let reloadStopping!: () => void
      const reloadIsStopping = new Promise<void>((resolve) => (reloadStopping = resolve))
      let evicting!: () => void
      const evictionStarted = new Promise<void>((resolve) => (evicting = resolve))
      const session = (model_id: string) => ({ model_id }) as unknown as SessionInfo
      const trtRuntime = {
        findSession: (id: string) => (trt.has(id) ? session(id) : undefined),
        isLoading: () => false,
        gpuOccupancy: () =>
          [...trt].map(([model_id, state]) => ({ model_id, cards: 'all', auxiliary: false, state })),
        load: async (id: string, opts: { signal?: AbortSignal } = {}) => {
          if (trt.has(id)) {
            reloadStopping()
            await stopOld
            trt.delete(id)
          }
          await residency.hook('tensorrt-llm')({ model_id: id, cards: 'all', auxiliary: false }, opts.signal)
          trt.set(id, 'ready')
          return session(id)
        },
        unload: async (id: string): Promise<UnloadResult> => {
          trt.delete(id)
          return { success: true }
        },
      } as unknown as LocalRuntime
      const mlx = new Map<string, GpuOccupancy['state']>()
      const mlxRuntime = {
        findSession: (id: string) => (mlx.has(id) ? session(id) : undefined),
        isLoading: () => false,
        gpuOccupancy: () => [],
        load: async (id: string, opts: { signal?: AbortSignal } = {}) => {
          await residency.hook('mlx')({ model_id: id, cards: 'all', auxiliary: false }, opts.signal)
          mlx.set(id, 'ready')
          return session(id)
        },
        unload: async () => ({ success: true }),
      } as unknown as LocalRuntime
      const runtimes = new Map<LocalProviderId, LocalRuntime>([
        ['tensorrt-llm', trtRuntime],
        ['mlx', mlxRuntime],
      ])
      // The real per-model transitions and cross-process claims the facade's `unload` goes through.
      const sessions = new LocalSessions({
        layout: data.layout,
        instanceId: 'core-1',
        runtimes,
        externalSessions: {} as ExternalSessions,
        runtime: (provider) => runtimes.get(provider) as LocalRuntime,
        assertRunning: () => {},
        increaseCtx: async () => ({ ok: false, reason: 'unsupported' }),
        recreateSession: async () => ({ ok: false, reason: 'not-loaded' }),
      })
      const residency = wireGpuResidency({
        runtimes,
        diffusion: () => undefined,
        leftovers: () => [],
        sessions: () => ({
          cancelLoad: (provider, modelId) => sessions.cancelLoad(provider, modelId),
          unload: (provider, modelId) => {
            evicting()
            return sessions.unload(provider, modelId)
          },
        }),
      })

      await sessions.acquire('tensorrt-llm', 'A', {})
      const reload = sessions.acquire('tensorrt-llm', 'A', {}).catch((e: unknown) => e)
      await reloadIsStopping
      // X's claim takes the one turn and evicts A, whose unload queues behind the reload's transition;
      // only then does the reload, done stopping its old container, claim the card again.
      const loadX = sessions.acquire('mlx', 'X', {})
      await evictionStarted
      releaseOldStop()

      let timer: ReturnType<typeof setTimeout> | undefined
      const hung = new Promise<'hung'>((resolve) => (timer = setTimeout(() => resolve('hung'), 3_000)))
      const outcome = await Promise.race([loadX.then(() => 'loaded' as const), hung])
      clearTimeout(timer)
      expect(outcome).toBe('loaded')
      expect(await reload).toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
      expect([...trt.keys()]).toEqual([])
      expect([...mlx.keys()]).toEqual(['X'])
    } finally {
      await data.cleanup()
    }
  }, 10_000)

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
