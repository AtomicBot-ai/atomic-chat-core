import { describe, expect, it } from 'vitest'
import { MEDIA_DIALECT_KIND, MEDIA_DIALECTS } from '../../contracts/index.js'
import { MEDIA_ADAPTERS } from './registry.js'

describe('MEDIA_ADAPTERS', () => {
  it('has one adapter per dialect, speaking that dialect and making its kind', () => {
    for (const dialect of MEDIA_DIALECTS) {
      const adapter = MEDIA_ADAPTERS[dialect]
      expect(adapter.dialect, dialect).toBe(dialect)
      expect(adapter.kind, dialect).toBe(MEDIA_DIALECT_KIND[dialect])
    }
  })
})
