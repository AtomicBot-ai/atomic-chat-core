import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { MANAGED_TEXT_ADAPTER_CONTRACT_VERSION, ManagedTextAdapterRegistry } from './adapter.js'
import type { ManagedTextAdapter } from './adapter.js'

function adapter(
  over: Partial<ManagedTextAdapter<{ ctx: number }>> = {}
): ManagedTextAdapter<{ ctx: number }> {
  return {
    id: 'fake-engine',
    contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
    readiness: { path: '/health', expectedStatus: 200 },
    stageMarkers: [],
    validateSettings: () => ({ ctx: 4096 }),
    buildLaunch: () => ({ engine: { container_port: 8000 }, argv: ['serve'] }),
    readinessTimeoutMs: () => 60_000,
    classifyExit: () => ({ kind: 'other', message: 'exited' }),
    capabilities: () => ({
      tools: false,
      reasoning: false,
      structured_output: false,
      vision: false,
      embeddings: false,
      responses: false,
    }),
    ...over,
  }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof AtomicCoreError ? error.code : 'not-an-AtomicCoreError'
  }
  return undefined
}

describe('ManagedTextAdapterRegistry', () => {
  it('resolves a registered adapter by adapter_id and contract version', () => {
    const registry = new ManagedTextAdapterRegistry()
    const a = adapter()
    registry.register(a)
    expect(registry.resolve('fake-engine', MANAGED_TEXT_ADAPTER_CONTRACT_VERSION)).toBe(a)
    expect(registry.resolve('fake-engine')).toBe(a)
    expect(registry.has('fake-engine')).toBe(true)
    expect(registry.ids()).toEqual(['fake-engine'])
  })

  it.each([
    ['an adapter_id nothing registered', 'other-engine', undefined],
    ['a contract version this core does not implement', 'fake-engine', 2],
  ])('refuses %s with MANAGED_ADAPTER_UNAVAILABLE', (_case, id, version) => {
    const registry = new ManagedTextAdapterRegistry()
    registry.register(adapter())
    expect(codeOf(() => registry.resolve(id, version))).toBe('MANAGED_ADAPTER_UNAVAILABLE')
  })

  it('refuses a second adapter under the same id', () => {
    const registry = new ManagedTextAdapterRegistry()
    registry.register(adapter())
    expect(codeOf(() => registry.register(adapter()))).toBe('INVALID_ARGUMENT')
  })

  it.each([
    ['an empty id', { id: '' }],
    ['a non-integer contract version', { contractVersion: 1.5 }],
    ['a readiness path without a leading slash', { readiness: { path: 'health', expectedStatus: 200 } }],
    ['a protocol-relative readiness path', { readiness: { path: '//evil.example/x', expectedStatus: 200 } }],
    ['a readiness path with a query', { readiness: { path: '/health?x=1', expectedStatus: 200 } }],
    ['a readiness path that climbs', { readiness: { path: '/a/../b', expectedStatus: 200 } }],
    ['a redirect as the expected status', { readiness: { path: '/health', expectedStatus: 302 } }],
    ['a non-integer expected status', { readiness: { path: '/health', expectedStatus: 200.5 } }],
  ])('refuses to register %s', (_case, over) => {
    const registry = new ManagedTextAdapterRegistry()
    expect(
      codeOf(() => registry.register(adapter(over as Partial<ManagedTextAdapter<{ ctx: number }>>)))
    ).toBe('INVALID_ARGUMENT')
    expect(registry.has((over as { id?: string }).id ?? 'fake-engine')).toBe(false)
  })
})
