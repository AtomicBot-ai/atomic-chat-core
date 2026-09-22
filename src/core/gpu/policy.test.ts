import { describe, expect, it } from 'vitest'
import { ResidencyPolicy, type Reservation, type SessionKey } from './policy.js'

const session = (over: Partial<SessionKey> = {}): SessionKey => ({
  scope_id: 'app',
  provider: 'llamacpp',
  model_id: 'qwen3-4b',
  generation: 'g1',
  ...over,
})

const policy = (): ResidencyPolicy => {
  let serial = 0
  return new ResidencyPolicy({
    newReservationId: () => {
      serial += 1
      return `res-${serial}`
    },
  })
}

const taken = (p: ResidencyPolicy, key: SessionKey, gpu = 'GPU-0'): Reservation => {
  const result = p.reserve(key, gpu)
  if (!result.ok) throw new Error(`expected the reserve to succeed: ${result.error.code}`)
  return result.value
}

const refusal = (result: { ok: boolean; error?: { code: string } }): string => {
  if (result.ok) throw new Error('expected a refusal')
  return result.error?.code ?? ''
}

describe('one resident model per GPU (GPU01)', () => {
  it('turns a second load away, names what to stop, and hands over once it is confirmed gone', () => {
    const p = policy()
    const a = session()
    const b = session({ provider: 'tensorrt-llm', model_id: 'llama-3.1-8b-fp8', generation: 'g2' })

    const first = taken(p, a)
    expect(refusal(p.reserve(b, 'GPU-0'))).toBe('GPU_BUSY')
    expect(p.evictionsFor(b, 'GPU-0')).toEqual([a])

    p.markStarted(first, 'exec-a')
    // A model answering a request right now is listed exactly like an idle one: the user asked to
    // load something else, and that is the whole decision.
    expect(p.evictionsFor(b, 'GPU-0')).toEqual([a])
    expect(refusal(p.reserve(b, 'GPU-0'))).toBe('GPU_BUSY')

    expect(
      p.confirmStopped(first, { kind: 'container', execution_id: 'exec-a', observed: 'exited' }).ok
    ).toBe(true)
    expect(p.evictionsFor(b, 'GPU-0')).toEqual([])
    const second = taken(p, b)
    expect(second.session).toEqual(b)
    expect(p.list()).toEqual([{ gpu_id: 'GPU-0', session: b, started: false }])
  })

  it('leaves another device alone, because the rule is per GPU and not per machine', () => {
    const p = policy()
    taken(p, session(), 'GPU-0')
    const other = session({ model_id: 'other', generation: 'g9' })
    expect(p.evictionsFor(other, 'GPU-1')).toEqual([])
    expect(p.reserve(other, 'GPU-1').ok).toBe(true)
  })

  it('answers a repeated reserve from the same session instead of calling it busy', () => {
    const p = policy()
    const a = session()
    const first = taken(p, a)
    const again = p.reserve(a, 'GPU-0')
    expect(again.ok && again.value.reservation_id).toBe(first.reservation_id)
  })
})

describe('releasing only on evidence (GPU02)', () => {
  it('lets a spawn that never started anything go, and refuses that excuse afterwards', () => {
    const p = policy()
    const a = session()
    const reservation = taken(p, a)

    // The child never existed, so there is nothing to observe exiting.
    expect(
      p.confirmStopped(reservation, { kind: 'not-started', reservation_id: reservation.reservation_id }).ok
    ).toBe(true)
    expect(p.list()).toEqual([])

    const second = taken(p, a)
    expect(p.markStarted(second, 'exec-1').ok).toBe(true)
    // Now something is running: only its observed exit frees the device.
    expect(
      refusal(p.confirmStopped(second, { kind: 'not-started', reservation_id: second.reservation_id }))
    ).toBe('MANAGED_STOP_UNCONFIRMED')
    expect(p.list()).toHaveLength(1)
  })

  it('keeps the reservation when a stop cannot be proved, so the memory is never handed on twice', () => {
    const p = policy()
    const a = session()
    const b = session({ provider: 'mlx', generation: 'g2' })
    const reservation = taken(p, a)
    p.markStarted(reservation, 'exec-1')

    // An unload that timed out simply produces no proof; the caller has nothing to pass here.
    expect(refusal(p.reserve(b, 'GPU-0'))).toBe('GPU_BUSY')
    expect(p.list()).toHaveLength(1)

    expect(
      p.confirmStopped(reservation, {
        kind: 'native',
        host_pid: 4242,
        process_identity: 'exec-1',
        verified_exited: true,
      }).ok
    ).toBe(true)
    expect(p.reserve(b, 'GPU-0').ok).toBe(true)
  })

  it('refuses a proof that names a different container than the one it started', () => {
    const p = policy()
    const reservation = taken(p, session())
    p.markStarted(reservation, 'exec-1')
    expect(
      refusal(
        p.confirmStopped(reservation, { kind: 'container', execution_id: 'exec-2', observed: 'exited' })
      )
    ).toBe('MANAGED_IDENTITY_MISMATCH')
    expect(p.list()).toHaveLength(1)
  })

  it('accepts a container reported absent as readily as one reported exited', () => {
    const p = policy()
    const reservation = taken(p, session())
    p.markStarted(reservation, 'exec-1')
    expect(
      p.confirmStopped(reservation, { kind: 'container', execution_id: 'exec-1', observed: 'absent' }).ok
    ).toBe(true)
  })

  it('refuses to start a second thing under one reservation', () => {
    const p = policy()
    const reservation = taken(p, session())
    expect(p.markStarted(reservation, 'exec-1').ok).toBe(true)
    // Idempotent for the same execution, a mismatch for another.
    expect(p.markStarted(reservation, 'exec-1').ok).toBe(true)
    expect(refusal(p.markStarted(reservation, 'exec-2'))).toBe('MANAGED_IDENTITY_MISMATCH')
  })
})

describe('identity (GPU03)', () => {
  it('ignores a confirmation from a generation that has been replaced', () => {
    const p = policy()
    const old = taken(p, session({ generation: 'g1' }))
    p.markStarted(old, 'exec-1')
    p.confirmStopped(old, { kind: 'container', execution_id: 'exec-1', observed: 'exited' })

    const fresh = taken(p, session({ generation: 'g2' }))
    p.markStarted(fresh, 'exec-2')

    // The old owner comes back and confirms its stop again.
    expect(
      refusal(p.confirmStopped(old, { kind: 'container', execution_id: 'exec-1', observed: 'exited' }))
    ).toBe('SESSION_GENERATION_STALE')
    expect(p.list()).toEqual([{ gpu_id: 'GPU-0', session: session({ generation: 'g2' }), started: true }])
    expect(fresh.reservation_id).not.toBe(old.reservation_id)
  })

  it('treats the same model on another engine as another session entirely', () => {
    const p = policy()
    const llama = session({ provider: 'llamacpp', model_id: 'qwen3-4b' })
    const trt = session({ provider: 'tensorrt-llm', model_id: 'qwen3-4b' })
    taken(p, llama)
    // Same model id, different engine: not the holder, so it has to wait like anything else.
    expect(refusal(p.reserve(trt, 'GPU-0'))).toBe('GPU_BUSY')
    expect(p.evictionsFor(trt, 'GPU-0')).toEqual([llama])
  })

  it('keeps the two data scopes apart', () => {
    const p = policy()
    const app = session({ scope_id: 'app' })
    const cli = session({ scope_id: 'cli' })
    taken(p, app)
    expect(p.evictionsFor(cli, 'GPU-0')).toEqual([app])
    expect(refusal(p.reserve(cli, 'GPU-0'))).toBe('GPU_BUSY')
  })

  it('treats a duplicate confirmation of a reservation nobody replaced as harmless', () => {
    const p = policy()
    const reservation = taken(p, session())
    p.markStarted(reservation, 'exec-1')
    const proof = { kind: 'container', execution_id: 'exec-1', observed: 'exited' } as const
    expect(p.confirmStopped(reservation, proof).ok).toBe(true)
    expect(p.confirmStopped(reservation, proof).ok).toBe(true)
    expect(p.list()).toEqual([])
  })
})

describe('across engines (GPU04)', () => {
  it('makes image generation and text inference take turns on the one card', () => {
    const p = policy()
    const image = session({ provider: 'sd-cpp', model_id: 'sdxl' })
    const text = session({ provider: 'tensorrt-llm', model_id: 'llama-3.1-8b-fp8', generation: 'g2' })

    const held = taken(p, image)
    expect(p.evictionsFor(text, 'GPU-0')).toEqual([image])
    expect(refusal(p.reserve(text, 'GPU-0'))).toBe('GPU_BUSY')

    p.markStarted(held, 'sd-1')
    p.confirmStopped(held, { kind: 'native', host_pid: 11, process_identity: 'sd-1', verified_exited: true })
    const textHeld = taken(p, text)

    // And the other way round: the image engine now waits for the container.
    expect(p.evictionsFor(image, 'GPU-0')).toEqual([text])
    expect(refusal(p.reserve(image, 'GPU-0'))).toBe('GPU_BUSY')
    expect(textHeld.gpu_id).toBe('GPU-0')
  })

  it('never lists a model that is not on the GPU at all', () => {
    const p = policy()
    const text = session({ provider: 'tensorrt-llm', generation: 'g2' })
    // A CPU-only session does not reserve, so there is nothing here to evict for.
    expect(p.evictionsFor(text, 'GPU-0')).toEqual([])
    expect(p.reserve(text, 'GPU-0').ok).toBe(true)
  })
})
