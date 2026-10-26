import { describe, expect, it } from 'vitest'
import { APP_LEASE_CHECK_MS, appLeaseDecision, stalledMs, workInProgress } from './app-lease.js'
import type { AppLeaseCheck } from './app-lease.js'
import type { GpuOccupant } from './gpu/index.js'

const check = (over: Partial<AppLeaseCheck> = {}): AppLeaseCheck => ({
  clients: 0,
  everRegistered: true,
  now: 100_000,
  startupDeadline: 45_000,
  work: [],
  ...over,
})

describe('appLeaseDecision', () => {
  it.each<[string, Partial<AppLeaseCheck>, ReturnType<typeof appLeaseDecision>]>([
    ['an attached app keeps its core', { clients: 1 }, { action: 'keep' }],
    [
      'an attached app keeps a busy core',
      { clients: 2, work: ['Z-Image is generating an image'] },
      { action: 'keep' },
    ],
    [
      'a new core waits for the app that started it',
      { everRegistered: false, now: 45_000 },
      { action: 'keep' },
    ],
    [
      'a core nobody ever attached to retires after the startup window',
      { everRegistered: false, now: 45_001 },
      { action: 'retire' },
    ],
    ['an idle core whose app is gone retires', {}, { action: 'retire' }],
    [
      'a core whose app is gone finishes the image first',
      { work: ['Z-Image is generating an image'] },
      { action: 'wait', work: ['Z-Image is generating an image'] },
    ],
    [
      'a core nobody ever attached to finishes a load first',
      { everRegistered: false, now: 90_000, work: ['llamacpp-upstream/m is loading'] },
      { action: 'wait', work: ['llamacpp-upstream/m is loading'] },
    ],
  ])('%s', (_name, over, expected) => {
    expect(appLeaseDecision(check(over))).toEqual(expected)
  })
})

describe('stalledMs', () => {
  it.each<[string, number, number, number]>([
    ['a check on time', 0, APP_LEASE_CHECK_MS, 0],
    ['a check a little late counts its lateness', 0, APP_LEASE_CHECK_MS + 40, 40],
    ['a process that swapped for a minute', 0, APP_LEASE_CHECK_MS + 60_000, 60_000],
    ['a clock that went back', 10_000, 4_000, 0],
  ])('%s', (_name, previous, now, expected) => {
    expect(stalledMs(previous, now)).toBe(expected)
  })

  it('takes the interval it was asked to check at', () => {
    expect(stalledMs(0, 30_000, 10_000)).toBe(20_000)
  })
})

describe('workInProgress', () => {
  const occupant = (over: Partial<GpuOccupant>): GpuOccupant => ({
    provider: 'llamacpp-upstream',
    model_id: 'm',
    cards: 'all',
    auxiliary: false,
    state: 'ready',
    ...over,
  })

  it('names a running job and a model being loaded', () => {
    expect(
      workInProgress([
        occupant({
          provider: 'diffusion',
          model_id: 'z-image:q3_k_m',
          busy: 'Z-Image is generating an image',
        }),
        occupant({ state: 'loading', model_id: 'qwen' }),
      ])
    ).toEqual(['Z-Image is generating an image', 'llamacpp-upstream/qwen is loading'])
  })

  it('counts neither an idle resident model, a stopping one, nor an embedding load', () => {
    expect(
      workInProgress([
        occupant({}),
        occupant({ state: 'stopping' }),
        occupant({ state: 'stop-unconfirmed' }),
        occupant({ state: 'loading', auxiliary: true, model_id: 'embed' }),
      ])
    ).toEqual([])
  })
})
