import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { spawnManaged } from './process.js'

describe('spawnManaged', () => {
  it('reports a spawn the runtime refused outright as the module spawn failure, never a raw throw', () => {
    let thrown: unknown
    try {
      // Not a spec any engine builds by accident: it stands for the class of refusals that arrive
      // before a child exists at all — on Bun a refused `uv_spawn` (EUNKNOWN), on Node an argv the
      // runtime rejects. The caller must still get this module's own error, with the runtime's words.
      spawnManaged({ exe: 5 as unknown as string, args: [], env: {} })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AtomicCoreError)
    expect((thrown as AtomicCoreError).code).toBe('IO_ERROR')
  })
})
