import { describe, expect, it } from 'vitest'
import { BUNDLED_MANIFEST_BASELINE } from './bundled-manifest-baseline.js'

describe('BUNDLED_MANIFEST_BASELINE', () => {
  it('is a real, mirrored tag whose assets all belong to that tag', () => {
    expect(BUNDLED_MANIFEST_BASELINE.tag_name).toMatch(/^b\d+$/)
    expect(BUNDLED_MANIFEST_BASELINE.download_base).toMatch(/^https:\/\//)
    for (const asset of BUNDLED_MANIFEST_BASELINE.assets) {
      if (asset.name.startsWith('cudart-')) {
        expect(asset.sha256).toBeUndefined()
        continue
      }
      expect(asset.name).toContain(`llama-${BUNDLED_MANIFEST_BASELINE.tag_name}-bin-`)
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.size).toBeGreaterThan(0)
    }
  })
})
