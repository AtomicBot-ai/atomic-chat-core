import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChatRunRegistry,
  RUN_MAX_AGE_MS,
  RUN_MAX_BUFFER_BYTES,
  RUN_MAX_RETAINED,
  RUN_TTL_AFTER_FINISH_MS,
} from './run-registry.js'
import type { ChatRun, RunRead } from './run-registry.js'

const registries: ChatRunRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
  vi.useRealTimers()
})

/** A registry on a clock the test moves. */
function registry(options: ConstructorParameters<typeof ChatRunRegistry>[0] = {}) {
  const clock = { now: 1_000 }
  const runs = new ChatRunRegistry({ now: () => clock.now, ...options })
  registries.push(runs)
  return { runs, clock }
}

const event = (text: string) => Buffer.from(`data: ${text}\n\n`)
const text = (read: RunRead) => (read.kind === 'items' ? Buffer.concat(read.bytes).toString() : 'gone')

function started(runs: ChatRunRegistry, key?: string, abort = () => {}): ChatRun {
  const run = runs.create(key, abort)
  if (!run) throw new Error('no run')
  return run
}

describe('the bounds', () => {
  it('are the documented constants', () => {
    expect([RUN_MAX_BUFFER_BYTES, RUN_MAX_RETAINED, RUN_TTL_AFTER_FINISH_MS, RUN_MAX_AGE_MS]).toEqual([
      4 * 1024 * 1024,
      16,
      600_000,
      3_600_000,
    ])
  })
})

describe('ChatRun', () => {
  it('numbers events from 1 with an id line, and replays what comes after a seq', () => {
    const { runs } = registry()
    const run = started(runs)
    expect(run.seq).toBe(0)
    expect([
      run.appendEvent(event('a')),
      run.appendEvent(event('b')),
      run.appendEvent(event('[DONE]')),
    ]).toEqual([1, 2, 3])
    expect(text(run.read(0, 0))).toBe('id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 3\ndata: [DONE]\n\n')
    expect(text(run.read(run.startIndex(2) as number, 2))).toBe('id: 3\ndata: [DONE]\n\n')
    expect(text(run.read(run.startIndex(3) as number, 3))).toBe('')
    expect(run.read(0, 0)).toMatchObject({ next: 3 })
  })

  it('keeps comment lines unnumbered, and replays those after the cursor with the events', () => {
    const { runs } = registry()
    const run = started(runs)
    run.appendComment(Buffer.from(': ping\n'))
    run.appendEvent(event('a'))
    run.appendComment(Buffer.from(': ping\n'))
    run.appendEvent(event('b'))

    expect(run.seq).toBe(2)
    expect(run.startIndex(0)).toBe(0)
    expect(text(run.read(run.startIndex(1) as number, 1))).toBe(': ping\nid: 2\ndata: b\n\n')
  })

  it('skips the events up to a cursor past the newest, as they arrive', () => {
    const { runs } = registry()
    const run = started(runs)
    run.appendEvent(event('a'))
    const start = run.startIndex(3) as number
    run.appendEvent(event('b'))
    run.appendEvent(event('c'))
    run.appendEvent(event('d'))
    expect(text(run.read(start, 3))).toBe('id: 4\ndata: d\n\n')
  })

  it('drops the oldest events past the byte cap, and a cursor before them is gone', () => {
    const { runs } = registry({ maxBufferBytes: 40 })
    const run = started(runs)
    for (const n of [1, 2, 3, 4]) run.appendEvent(event(`e${n}`)) // 16 bytes each with the id line

    expect(run.startIndex(1)).toBe('gone')
    expect(run.startIndex(2)).toBe(2)
    expect(text(run.read(2, 2))).toBe('id: 3\ndata: e3\n\nid: 4\ndata: e4\n\n')
    expect(run.read(1, 0)).toEqual({ kind: 'gone' })
    expect(run.end).toBe(4)
  })

  it('keeps the newest event even when it alone is over the cap', () => {
    const { runs } = registry({ maxBufferBytes: 8 })
    const run = started(runs)
    run.appendEvent(event('first'))
    run.appendEvent(event('second'))
    expect(run.startIndex(1)).toBe(1)
    expect(text(run.read(1, 1))).toBe('id: 2\ndata: second\n\n')
  })

  it('ignores appends once finished, and wakes whoever waits on either', async () => {
    const { runs } = registry()
    const run = started(runs)
    const appended = run.changed()
    run.appendEvent(event('a'))
    await appended
    const ended = run.changed()
    run.finish()
    await ended
    run.finish()
    expect(run.appendEvent(event('late'))).toBe(0)
    run.appendComment(Buffer.from(': late\n'))
    expect(run.end).toBe(1)
    expect(run.finishedAt).toBe(1_000)
  })

  it('cancels once: the upstream is aborted and the run ends', () => {
    const { runs } = registry()
    const abort = vi.fn()
    const run = started(runs, undefined, abort)
    run.cancel()
    run.cancel()
    expect(abort).toHaveBeenCalledTimes(1)
    expect(run.finished).toBe(true)
  })

  it('does not abort a run that already ended, and survives an abort that throws', () => {
    const { runs } = registry()
    const abort = vi.fn()
    const done = started(runs, undefined, abort)
    done.finish()
    done.cancel()
    expect(abort).not.toHaveBeenCalled()

    const throwing = started(runs, undefined, () => {
      throw new Error('already gone')
    })
    expect(() => throwing.cancel()).not.toThrow()
    expect(throwing.finished).toBe(true)
  })

  it('counts its followers, never below zero', () => {
    const { runs } = registry()
    const run = started(runs)
    run.attach()
    run.attach()
    run.detach()
    expect(run.followers).toBe(1)
    run.detach()
    run.detach()
    expect(run.followers).toBe(0)
  })
})

describe('ChatRunRegistry', () => {
  it('gives every run an unguessable base64url id of 192 bits', () => {
    const { runs } = registry()
    const ids = new Set([started(runs).id, started(runs).id, started(runs).id])
    expect(ids.size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('finds a run only for the key that started it, and answers a foreign, unknown or malformed id alike', () => {
    const { runs } = registry()
    const run = started(runs, 'device-a')
    expect(runs.find(run.id, 'device-a')).toBe(run)
    expect(runs.find(run.id, 'device-b')).toBeUndefined()
    expect(runs.find(run.id, undefined)).toBeUndefined()
    expect(runs.find('A'.repeat(32), 'device-a')).toBeUndefined()
    expect(runs.find('../../etc', 'device-a')).toBeUndefined()
  })

  it('lets anyone with the id read a run started on a keyless listener', () => {
    const { runs } = registry()
    const run = started(runs, undefined)
    expect(runs.find(run.id, undefined)).toBe(run)
    expect(runs.find(run.id, 'any-key')).toBe(run)
  })

  it('forgets a finished run after its TTL, and not before', () => {
    const { runs, clock } = registry({ ttlAfterFinishMs: 100 })
    const run = started(runs)
    clock.now += 1_000
    run.finish()
    clock.now += 99
    expect(runs.find(run.id, undefined)).toBe(run)
    clock.now += 1
    expect(runs.find(run.id, undefined)).toBeUndefined()
    expect(runs.size).toBe(0)
  })

  it('cancels and forgets a run nobody follows past the max age, but leaves a followed one alone', () => {
    const { runs, clock } = registry({ maxAgeMs: 100 })
    const abortLone = vi.fn()
    const abortFollowed = vi.fn()
    const lone = started(runs, undefined, abortLone)
    const followed = started(runs, undefined, abortFollowed)
    followed.attach()
    clock.now += 100
    runs.sweep()

    expect(abortLone).toHaveBeenCalledTimes(1)
    expect(runs.find(lone.id, undefined)).toBeUndefined()
    expect(abortFollowed).not.toHaveBeenCalled()
    expect(runs.find(followed.id, undefined)).toBe(followed)

    followed.detach()
    runs.sweep()
    expect(abortFollowed).toHaveBeenCalledTimes(1)
    expect(runs.size).toBe(0)
  })

  it('makes room by forgetting the oldest finished run, and declines when every run still generates', () => {
    const { runs, clock } = registry({ maxRuns: 2 })
    const first = started(runs)
    const second = started(runs)
    expect(runs.create(undefined, () => {})).toBeUndefined()

    clock.now += 10
    second.finish()
    clock.now += 10
    first.finish()
    const third = started(runs)
    expect(runs.find(second.id, undefined)).toBeUndefined()
    expect(runs.find(first.id, undefined)).toBe(first)
    expect(runs.find(third.id, undefined)).toBe(third)
  })

  it('cancels every run when closed, and finds none after', () => {
    const { runs } = registry()
    const abort = vi.fn()
    const run = started(runs, 'k', abort)
    runs.close()
    expect(abort).toHaveBeenCalledTimes(1)
    expect(runs.find(run.id, 'k')).toBeUndefined()
  })

  it('sweeps on a timer while it keeps runs, and stops once it keeps none', () => {
    vi.useFakeTimers()
    const { runs, clock } = registry({ ttlAfterFinishMs: 50, sweepIntervalMs: 1_000 })
    const run = started(runs)
    run.finish()
    clock.now += 50
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(runs.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the monotonic clock by default', () => {
    const runs = new ChatRunRegistry()
    registries.push(runs)
    const before = performance.now()
    const run = started(runs)
    expect(run.createdAt).toBeGreaterThanOrEqual(before)
    expect(run.createdAt).toBeLessThanOrEqual(performance.now())
  })
})
