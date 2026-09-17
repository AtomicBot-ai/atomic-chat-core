import { describe, expect, it } from 'vitest'
import { CLIENT_EXPIRY_MS, ClientRegistry } from './clients.js'

function clockRegistry() {
  let now = 1_000_000
  const registry = new ClientRegistry(() => now)
  return { registry, advance: (ms: number) => (now += ms) }
}

describe('ClientRegistry', () => {
  it('registers a client with an id and remembers who it is', () => {
    const { registry } = clockRegistry()
    const client = registry.register({ name: 'atomic-chat-cli', pid: 42 })
    expect(client.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(client).toMatchObject({ name: 'atomic-chat-cli', pid: 42 })
    expect(registry.list()).toHaveLength(1)
    expect(registry.register().name).toBe('unnamed')
    expect(registry.register({ pid: null }).pid).toBeNull()
    expect(registry.count()).toBe(3)
  })

  it('keeps a heartbeating client alive and drops one that stops', () => {
    const { registry, advance } = clockRegistry()
    const a = registry.register({ name: 'app' })
    const b = registry.register({ name: 'cli' })
    advance(CLIENT_EXPIRY_MS - 1)
    expect(registry.heartbeat(a.id)).toBe(true)
    advance(CLIENT_EXPIRY_MS - 1)
    expect(registry.list().map((c) => c.name)).toEqual(['app'])
    expect(registry.heartbeat(b.id)).toBe(false)
  })

  it('unregisters explicitly and reports unknown ids', () => {
    const { registry } = clockRegistry()
    const client = registry.register({ name: 'cli' })
    expect(registry.unregister(client.id)).toBe(true)
    expect(registry.unregister(client.id)).toBe(false)
    expect(registry.heartbeat('not-an-id')).toBe(false)
    expect(registry.list()).toEqual([])
  })

  it('reports the other clients, which is what blocks a shutdown', () => {
    const { registry } = clockRegistry()
    const app = registry.register({ name: 'app' })
    const cli = registry.register({ name: 'cli' })
    expect(registry.others(cli.id).map((c) => c.name)).toEqual(['app'])
    expect(registry.others(undefined)).toHaveLength(2)
    registry.unregister(app.id)
    expect(registry.others(cli.id)).toEqual([])
  })

  it('closes admission atomically once shutdown is accepted', () => {
    const { registry } = clockRegistry()
    const active = registry.register({ name: 'serve' })
    expect(registry.acceptShutdown(undefined, false)).toHaveLength(1)
    expect(registry.register({ name: 'another' }).name).toBe('another')
    registry.unregister(active.id)
    expect(registry.acceptShutdown(undefined, false)).toHaveLength(1)
    expect(registry.acceptShutdown(undefined, true)).toHaveLength(1)
    expect(() => registry.register({ name: 'late' })).toThrow(/stopping/)
  })

  it('truncates an absurd client name instead of storing it', () => {
    const { registry } = clockRegistry()
    expect(registry.register({ name: 'x'.repeat(5000) }).name).toHaveLength(200)
  })
})
