import { describe, expect, it, vi } from 'vitest'
import { CoreEmitter } from './emitter.js'

const make = (ringSize = 1000) => new CoreEmitter({ instanceId: 'inst-1', now: () => 42, ringSize })

describe('CoreEmitter', () => {
  it('delivers typed events, numbers them and records them', () => {
    const e = make()
    const seen: unknown[] = []
    const off = e.on('server:started', (p) => seen.push(p))
    const rec = e.emit('server:started', { host: '127.0.0.1', port: 1337 })
    expect(rec).toEqual({
      seq: 1,
      ts: 42,
      name: 'server:started',
      payload: { host: '127.0.0.1', port: 1337 },
    })
    expect(seen).toEqual([{ host: '127.0.0.1', port: 1337 }])
    off()
    e.emit('server:started', { host: 'h', port: 1 })
    expect(seen).toHaveLength(1)
    expect(e.lastSeq).toBe(2)
  })

  it('onAny receives every record and listener errors do not break delivery', () => {
    const e = make()
    const all = vi.fn()
    e.onAny(all)
    e.on('server:stopped', () => {
      throw new Error('boom')
    })
    const second = vi.fn()
    e.on('server:stopped', second)
    expect(() => e.emit('server:stopped', {})).not.toThrow()
    expect(all).toHaveBeenCalledTimes(1)
    // node's EventEmitter stops at the first throwing listener; the record is still kept.
    expect(e.replayAfter(0)).toHaveLength(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('tells its owner about a throwing listener, and survives an owner that throws too', () => {
    const failures: Array<[string, unknown]> = []
    const e = new CoreEmitter({
      instanceId: 'i',
      onListenerError: (name, error) => failures.push([name, error]),
    })
    const boom = new Error('boom')
    e.on('server:stopped', () => {
      throw boom
    })
    e.onAny(() => {
      throw boom
    })
    e.emit('server:stopped', {})
    expect(failures).toEqual([
      ['server:stopped', boom],
      ['server:stopped', boom],
    ])
    const loud = new CoreEmitter({
      instanceId: 'i',
      onListenerError: () => {
        throw new Error('reporter down')
      },
    })
    loud.onAny(() => {
      throw boom
    })
    expect(() => loud.emit('server:stopped', {})).not.toThrow()
  })

  it('replays after a cursor and demands resync once the ring overflowed', () => {
    const e = make(3)
    for (let i = 0; i < 5; i++) e.emit('core:log', { level: 'info', msg: String(i) })
    expect(e.replayAfter(5)).toEqual([])
    expect(e.replayAfter(2)?.map((r) => r.seq)).toEqual([3, 4, 5])
    expect(e.replayAfter(1)).toBeUndefined()
    expect(e.replayAfter(0)).toBeUndefined()
    expect(make().replayAfter(0)).toEqual([])
    expect(make().replayAfter(3)).toEqual([])
  })

  it('formats and parses cursors bound to the instance id', () => {
    const e = make()
    e.emit('server:stopped', {})
    expect(e.cursor()).toBe('inst-1:1')
    expect(e.parseCursor('inst-1:1')).toBe(1)
    expect(e.parseCursor('other:1')).toBeUndefined()
    expect(e.parseCursor('inst-1:x')).toBeUndefined()
    expect(e.parseCursor('garbage')).toBeUndefined()
  })

  it('once fires a single time', () => {
    const e = make()
    const fn = vi.fn()
    e.once('server:stopped', fn)
    e.emit('server:stopped', {})
    e.emit('server:stopped', {})
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
