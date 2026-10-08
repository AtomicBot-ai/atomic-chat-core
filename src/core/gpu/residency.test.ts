import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { GpuResidency } from './residency.js'
import type { ResidencyOccupant } from './residency.js'

/** A machine whose sessions the test controls: `evict` removes the occupant unless it is stuck. */
function machine() {
  const occupants: ResidencyOccupant[] = []
  const evicted: string[] = []
  const add = (
    provider: string,
    model_id: string,
    over: Partial<ResidencyOccupant> & { stuck?: boolean; failWith?: string } = {}
  ): ResidencyOccupant => {
    const { stuck, failWith, ...rest } = over
    const occupant: ResidencyOccupant = {
      provider,
      model_id,
      cards: 'all',
      auxiliary: false,
      state: 'ready',
      evict: async () => {
        evicted.push(`${provider}/${model_id}`)
        await new Promise((resolve) => setImmediate(resolve))
        if (stuck) {
          occupant.state = 'stop-unconfirmed'
          if (failWith !== undefined) throw new Error(failWith)
          return
        }
        occupants.splice(occupants.indexOf(occupant), 1)
      },
      ...rest,
    }
    occupants.push(occupant)
    return occupant
  }
  const residency = new GpuResidency({ occupants: () => [...occupants] })
  return { occupants, evicted, add, residency }
}

const rejection = async (promise: Promise<unknown>): Promise<AtomicCoreError> => {
  try {
    await promise
  } catch (error) {
    return error as AtomicCoreError
  }
  throw new Error('expected a rejection')
}

describe('GpuResidency.claim', () => {
  it('stops everything else on the card, each confirmed, before the load may start', async () => {
    const m = machine()
    m.add('llamacpp-upstream', 'chat')
    m.add('llamacpp-upstream', 'embed', { auxiliary: true })
    m.add('diffusion', 'flux')
    m.add('llamacpp-upstream', 'cpu', { cards: [] })

    await m.residency.hook('tensorrt-llm')({ model_id: 'llama-3', cards: ['GPU-0'], auxiliary: false })

    expect(m.evicted).toEqual(['llamacpp-upstream/chat', 'diffusion/flux'])
    expect(m.occupants.map((o) => o.model_id)).toEqual(['embed', 'cpu'])
  })

  it('refuses with GPU_BUSY naming the session whose stop was not confirmed, and why', async () => {
    const m = machine()
    m.add('tensorrt-llm', 'stuck', { cards: ['GPU-0'], stuck: true, failWith: 'docker stop timed out' })

    const error = await rejection(
      m.residency.claim({ provider: 'llamacpp-upstream', model_id: 'chat', cards: 'all', auxiliary: false })
    )
    expect(error.code).toBe('GPU_BUSY')
    expect(error.details).toBe(
      'holder=tensorrt-llm/stuck state=stop-unconfirmed cards=GPU-0 cause=docker stop timed out'
    )
    // The reservation is kept: the next load is refused the same way, after one more attempt to stop it.
    const again = await rejection(
      m.residency.claim({ provider: 'mlx', model_id: 'm', cards: 'all', auxiliary: false })
    )
    expect(again.code).toBe('GPU_BUSY')
    expect(m.evicted).toEqual(['tensorrt-llm/stuck', 'tensorrt-llm/stuck'])
  })

  it('carries the engine’s own details of a failed stop into the refusal', async () => {
    const m = machine()
    const stuck = m.add('tensorrt-llm', 'stuck', { cards: ['GPU-0'], state: 'stop-unconfirmed' })
    stuck.evict = async () => {
      throw new AtomicCoreError(
        'MANAGED_STOP_UNCONFIRMED',
        'Docker did not confirm.',
        'ctr1: deadline exceeded'
      )
    }
    const error = await rejection(
      m.residency.claim({ provider: 'mlx', model_id: 'm', cards: 'all', auxiliary: false })
    )
    expect(error.details).toBe(
      'holder=tensorrt-llm/stuck state=stop-unconfirmed cards=GPU-0 cause=Docker did not confirm. (ctr1: deadline exceeded)'
    )
  })

  it('refuses too when a stop "succeeded" but the session is still listed as holding the card', async () => {
    const m = machine()
    m.add('diffusion', 'flux', { stuck: true })
    const error = await rejection(
      m.residency.claim({ provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false })
    )
    expect(error.details).toBe('holder=diffusion/flux state=stop-unconfirmed cards=all')
  })

  // ATO-549: a chat model loading while a clip was generating stopped sd-server and lost the clip.
  it('refuses a load over a session that is generating, and stops nothing at all', async () => {
    const m = machine()
    m.add('mlx', 'chat')
    m.add('diffusion', 'wan', {
      busy: 'Wan 2.2 is generating a video',
      remedy: 'Wait for the video to finish, or stop it, then try again.',
    })
    let granted = false
    const error = await rejection(
      m.residency.claim(
        { provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false },
        undefined,
        () => {
          granted = true
        }
      )
    )
    expect(error.code).toBe('GPU_BUSY')
    expect(error.message).toBe(
      'Wan 2.2 is generating a video; loading another model on the same GPU would cancel it. ' +
        'Wait for the video to finish, or stop it, then try again.'
    )
    expect(error.details).toBe('holder=diffusion/wan state=ready cards=all busy=true')
    expect(m.evicted).toEqual([])
    expect(granted).toBe(false)
  })

  it('refuses when a job starts while an earlier stop is awaited, before stopping that session', async () => {
    const m = machine()
    const chat = m.add('mlx', 'chat')
    const image = m.add('diffusion', 'flux')
    chat.evict = async () => {
      m.evicted.push('mlx/chat')
      m.occupants.splice(m.occupants.indexOf(chat), 1)
      image.busy = 'Flux is generating an image'
    }
    const error = await rejection(
      m.residency.claim({ provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false })
    )
    expect(error.message).toMatch(/^Flux is generating an image; loading another model/)
    expect(error.message).toMatch(/Wait for it to finish, or stop it, then try again\.$/)
    expect(m.evicted).toEqual(['mlx/chat'])
  })

  it('refuses over a job that started on a server spawning while the other stops were awaited', async () => {
    const m = machine()
    const chat = m.add('mlx', 'chat')
    chat.evict = async () => {
      m.evicted.push('mlx/chat')
      m.occupants.splice(m.occupants.indexOf(chat), 1)
      // A clip submitted meanwhile respawns sd-server: it holds the GPU as loading, with its job.
      m.add('diffusion', 'wan', { state: 'loading', busy: 'Wan 2.2 is generating a video' })
    }
    const error = await rejection(
      m.residency.claim({ provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false })
    )
    expect(error.details).toBe('holder=diffusion/wan state=loading cards=all busy=true')
    expect(m.evicted).toEqual(['mlx/chat'])
  })

  it('stops an idle image model as before', async () => {
    const m = machine()
    m.add('diffusion', 'flux')
    await m.residency.claim({ provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false })
    expect(m.evicted).toEqual(['diffusion/flux'])
  })

  it('lets the load start when an eviction rejected but its session is gone all the same', async () => {
    const m = machine()
    const flaky = m.add('mlx', 'm')
    flaky.evict = async () => {
      m.occupants.splice(m.occupants.indexOf(flaky), 1)
      throw new Error('already exited')
    }
    await m.residency.claim({ provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false })
    expect(m.occupants).toEqual([])
  })

  it('never waits and never evicts for a CPU-only, embedding or transcription load, and grants it at once', async () => {
    const m = machine()
    m.add('tensorrt-llm', 'stuck', { cards: ['GPU-0'], stuck: true })
    // A GPU claim holding the turn (its eviction does not finish) must not hold these up.
    let finish!: () => void
    const hung = m.add('mlx', 'hung')
    const gone = new Promise<void>((resolve) => {
      finish = () => {
        m.occupants.splice(m.occupants.indexOf(hung), 1)
        resolve()
      }
    })
    hung.evict = () => gone
    const holding = m.residency
      .claim({ provider: 'llamacpp', model_id: 'gpu', cards: 'all', auxiliary: false })
      .catch((e: unknown) => e)

    const granted: string[] = []
    await m.residency.claim(
      { provider: 'llamacpp', model_id: 'cpu', cards: [], auxiliary: false },
      undefined,
      () => granted.push('cpu')
    )
    await m.residency.claim(
      { provider: 'llamacpp-upstream', model_id: 'emb', cards: 'all', auxiliary: true },
      undefined,
      () => granted.push('emb')
    )
    expect(granted).toEqual(['cpu', 'emb'])
    expect(m.evicted).toEqual(['tensorrt-llm/stuck'])
    // Leave nothing pending: the held claim ends (refused over the stuck container).
    finish()
    expect(((await holding) as AtomicCoreError).code).toBe('GPU_BUSY')
  })

  it('grants inside its turn, so the next claim always sees the load it granted', async () => {
    const m = machine()
    const first = m.residency.claim(
      { provider: 'llamacpp', model_id: 'a', cards: 'all', auxiliary: false },
      undefined,
      () => void m.add('llamacpp', 'a', { state: 'loading' })
    )
    const second = m.residency.claim({ provider: 'mlx', model_id: 'b', cards: 'all', auxiliary: false })
    await first
    await second
    expect(m.evicted).toEqual(['llamacpp/a'])
  })

  it('does not grant a claim it refuses', async () => {
    const m = machine()
    m.add('tensorrt-llm', 'stuck', { cards: ['GPU-0'], stuck: true })
    let granted = false
    const error = await rejection(
      m.residency.claim({ provider: 'mlx', model_id: 'm', cards: 'all', auxiliary: false }, undefined, () => {
        granted = true
      })
    )
    expect(error.code).toBe('GPU_BUSY')
    expect(granted).toBe(false)
  })

  it('stops waiting for an eviction once its own load is cancelled, and hands the turn on', async () => {
    const m = machine()
    let finish!: () => void
    const slow = m.add('diffusion', 'flux')
    // One stop in flight, shared by every eviction that asks for it, as the engines do.
    const gone = new Promise<void>((resolve) => {
      finish = () => {
        m.occupants.splice(m.occupants.indexOf(slow), 1)
        resolve()
      }
    })
    slow.evict = () => gone
    const controller = new AbortController()
    const cancelled = m.residency.claim(
      { provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false },
      controller.signal
    )
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    expect((await rejection(cancelled)).code).toBe('MODEL_LOAD_CANCELLED')
    // The turn is free: another claim runs (and finds the image model still stopping).
    const next = m.residency.claim({ provider: 'mlx', model_id: 'm', cards: 'all', auxiliary: false })
    await new Promise((resolve) => setImmediate(resolve))
    finish()
    await next
  })

  it('takes GPU claims one at a time, so a load that finished its claim is seen, and stopped, by the next', async () => {
    const m = machine()
    let finishFirst!: () => void
    const slow = m.add('mlx', 'slow')
    slow.evict = () =>
      new Promise<void>((resolve) => {
        finishFirst = () => {
          m.occupants.splice(m.occupants.indexOf(slow), 1)
          resolve()
        }
      })

    const first = m.residency.claim({ provider: 'llamacpp', model_id: 'a', cards: 'all', auxiliary: false })
    await new Promise((resolve) => setImmediate(resolve))
    let secondDone = false
    const second = m.residency
      .claim({ provider: 'tensorrt-llm', model_id: 'b', cards: ['GPU-0'], auxiliary: false })
      .then(() => {
        secondDone = true
      })
    await new Promise((resolve) => setImmediate(resolve))
    expect(secondDone).toBe(false)

    finishFirst()
    await first
    // The first load now reports itself as starting; the second claim finds it and stops it.
    m.add('llamacpp', 'a', { state: 'loading' })
    await second
    expect(m.evicted).toEqual(['llamacpp/a'])
    expect(m.occupants).toEqual([])
  })

  it('a claim cancelled while it waits answers MODEL_LOAD_CANCELLED, evicts nothing and blocks no one', async () => {
    const m = machine()
    let release!: () => void
    const slow = m.add('mlx', 'slow')
    slow.evict = () =>
      new Promise<void>((resolve) => {
        release = () => {
          m.occupants.splice(m.occupants.indexOf(slow), 1)
          resolve()
        }
      })
    const first = m.residency.claim({ provider: 'llamacpp', model_id: 'a', cards: 'all', auxiliary: false })
    await new Promise((resolve) => setImmediate(resolve))

    const controller = new AbortController()
    const waiting = m.residency.claim(
      { provider: 'diffusion', model_id: 'flux', cards: 'all', auxiliary: false },
      controller.signal
    )
    controller.abort()
    expect((await rejection(waiting)).code).toBe('MODEL_LOAD_CANCELLED')

    release()
    await first
    m.add('llamacpp', 'a', { state: 'loading' })
    await m.residency.claim({ provider: 'mlx', model_id: 'next', cards: 'all', auxiliary: false })
    expect(m.evicted).toEqual(['llamacpp/a'])
  })

  it('stops evicting once the load it serves is cancelled', async () => {
    const m = machine()
    const controller = new AbortController()
    const first = m.add('mlx', 'one')
    first.evict = async () => {
      m.occupants.splice(m.occupants.indexOf(first), 1)
      controller.abort()
    }
    m.add('diffusion', 'two')
    const error = await rejection(
      m.residency.claim(
        { provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false },
        controller.signal
      )
    )
    expect(error.code).toBe('MODEL_LOAD_CANCELLED')
    expect(m.occupants.map((o) => o.model_id)).toEqual(['two'])
  })

  it('refuses a claim whose signal is already aborted before it touches anything', async () => {
    const m = machine()
    m.add('mlx', 'm')
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(
      m.residency.claim(
        { provider: 'llamacpp', model_id: 'c', cards: 'all', auxiliary: false },
        controller.signal
      )
    )
    expect(error.code).toBe('MODEL_LOAD_CANCELLED')
    expect(m.evicted).toEqual([])
  })
})
