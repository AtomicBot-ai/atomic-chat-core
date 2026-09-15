import { describe, expect, it } from 'vitest'
import { AtomicCore, CORE_VERSION } from './core.js'

describe('AtomicCore', () => {
  it('exposes the package version', async () => {
    const core = await AtomicCore.create()
    expect(core.version).toBe(CORE_VERSION)
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('freezes the options it was created with', async () => {
    const core = await AtomicCore.create({ dataFolder: '/tmp/x', role: 'auto' })
    expect(core.options).toEqual({ dataFolder: '/tmp/x', role: 'auto' })
    expect(Object.isFrozen(core.options)).toBe(true)
    await core.dispose()
  })
})
