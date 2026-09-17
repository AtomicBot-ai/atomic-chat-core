import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../contracts/index.js'
import type { ProcessJournal } from '../../lock/index.js'
import { spawnManaged } from './process.js'
import type { ManagedProcess } from './process.js'
import { SidecarTable } from './sidecar.js'
import type { SidecarTableOptions } from './sidecar.js'

function table(extra: Partial<SidecarTableOptions> = {}) {
  const events: Array<{ name: string; payload: unknown }> = []
  const t = new SidecarTable({
    provider: 'mlx',
    instanceId: 'i',
    emit: (name, payload) => events.push({ name, payload }),
    describeExit: (exit) => `exit ${exit.code}`,
    unloadGraceMs: 1000,
    shutdownGraceMs: 500,
    engine: 'MLX',
    ...extra,
  })
  return { t, events }
}

const info = (model_id: string, pid: number): SessionInfo => ({
  pid,
  port: 3001,
  model_id,
  model_path: '/m',
  is_embedding: false,
  api_key: '',
})

const sleeper = () =>
  spawnManaged({
    exe: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    env: { ...process.env } as Record<string, string>,
  })

describe('SidecarTable', () => {
  it('runs one load at a time for the provider and lets a second caller join a load in flight', async () => {
    const { t } = table()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const a = t.load('a', async () => {
      order.push('a:start')
      await gate
      order.push('a:end')
      return info('a', 1)
    })
    const joined = t.load('a', async () => info('a', 99))
    const b = t.load('b', async () => {
      order.push('b:start')
      return info('b', 2)
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(t.isLoading('a')).toBe(true)
    expect(t.otherLoads('b')).toHaveLength(1)
    release()
    expect((await a).pid).toBe(1)
    expect((await joined).pid).toBe(1)
    await b
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
    expect(t.isLoading('a')).toBe(false)
  })

  it('waits for an in-flight load before unloading its newly published process', async () => {
    const { t, events } = table()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (entered = resolve))
    const load = t.load('m', async () => {
      entered()
      await gate
      const child = sleeper()
      return t.adopt({ info: info('m', child.pid), process: child, exe: process.execPath, extra: undefined })
    })
    await started
    const unload = t.unload('m')
    let finished = false
    void unload.then(() => (finished = true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished).toBe(false)
    release()
    const session = await load
    expect(await unload).toEqual({ success: true })
    expect(t.list()).toEqual([])
    expect(events.map((event) => event.name)).toEqual(['session:started', 'session:unloaded'])
    expect(() => process.kill(session.pid, 0)).toThrow()
  })

  it('deduplicates unloads and waits before starting a replacement load', async () => {
    const { t } = table()
    const first = sleeper()
    await t.adopt({ info: info('m', first.pid), process: first, exe: process.execPath, extra: undefined })
    let release!: () => void
    let terminating!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const entered = new Promise<void>((resolve) => (terminating = resolve))
    const delayed: ManagedProcess = {
      ...first,
      terminate: async (graceMs) => {
        terminating()
        await gate
        return first.terminate(graceMs)
      },
    }
    ;(t.get('m') as { process: ManagedProcess }).process = delayed
    const unload = t.unload('m')
    const joined = t.unload('m')
    await entered
    let replacementStarted = false
    const replacement = t.load('m', async () => {
      replacementStarted = true
      const child = sleeper()
      return t.adopt({ info: info('m', child.pid), process: child, exe: process.execPath, extra: undefined })
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(replacementStarted).toBe(false)
    release()
    expect(await unload).toEqual({ success: true })
    expect(await joined).toEqual({ success: true })
    const session = await replacement
    expect(session.pid).not.toBe(first.pid)
    expect(t.list()).toEqual([session])
    expect(await t.unload('m')).toEqual({ success: true })
  })

  it('does not finish shutdown while an earlier unload is still terminating its child', async () => {
    const { t } = table()
    const child = sleeper()
    await t.adopt({ info: info('m', child.pid), process: child, exe: process.execPath, extra: undefined })
    let release!: () => void
    let terminating!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const entered = new Promise<void>((resolve) => (terminating = resolve))
    ;(t.get('m') as { process: ManagedProcess }).process = {
      ...child,
      terminate: async (graceMs) => {
        terminating()
        await gate
        return child.terminate(graceMs)
      },
    }
    const unload = t.unload('m')
    await entered
    const shutdown = t.shutdown()
    let stopped = false
    void shutdown.then(() => (stopped = true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)
    release()
    expect(await unload).toEqual({ success: true })
    await shutdown
    expect(() => process.kill(child.pid, 0)).toThrow()
  })

  it('terminates a ready process when it cannot be journalled', async () => {
    const { t, events } = table({
      journal: {
        add: async () => Promise.reject(new Error('disk full')),
        remove: async () => {},
      } as unknown as ProcessJournal,
    })
    const proc = sleeper()
    await expect(
      t.adopt({ info: info('m', proc.pid), process: proc, exe: 'x', extra: undefined })
    ).rejects.toThrow('disk full')
    await proc.exited
    expect(t.list()).toEqual([])
    expect(events).toEqual([])
  })

  it('keeps a session whose process refused to stop, and reports why', async () => {
    const { t } = table()
    const proc = sleeper()
    await t.adopt({ info: info('m', proc.pid), process: proc, exe: 'x', extra: { ctx: 1 } })
    expect(t.get('m')?.extra).toEqual({ ctx: 1 })
    expect(t.usedPorts()).toEqual([3001])
    const stubborn: ManagedProcess = { ...proc, terminate: async () => Promise.reject(new Error('EPERM')) }
    ;(t.get('m') as { process: ManagedProcess }).process = stubborn
    expect(await t.unload('m')).toEqual({ success: false, error: 'EPERM' })
    expect(t.getLoadedModels()).toEqual(['m'])
    await expect(t.shutdown()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Could not stop every MLX session during shutdown.',
    })
    await proc.terminate(0)
  })

  it('refuses loads once closing', async () => {
    const { t } = table()
    await t.shutdown()
    expect(t.isClosing).toBe(true)
    expect(t.signal.aborted).toBe(true)
    expect(() => t.load('a', async () => info('a', 1))).toThrow(/stopping or has stopped/)
  })
})
