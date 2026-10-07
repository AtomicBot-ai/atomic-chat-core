import { describe, expect, it } from 'vitest'
import { PRISM_MANIFEST_BASELINE } from './prism-manifest-baseline.js'
import { prismArchiveSources, prismTagBuild } from './prism-manifest.js'

describe('PRISM_MANIFEST_BASELINE', () => {
  it('parses and pins every asset by sha256', () => {
    expect(PRISM_MANIFEST_BASELINE.releases.length).toBeGreaterThan(0)
    for (const release of PRISM_MANIFEST_BASELINE.releases) {
      expect(prismTagBuild(release.tag)).not.toBeNull()
      expect(release.assets.length).toBeGreaterThan(0)
      for (const asset of release.assets) expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
  it('resolves every Windows CUDA pack together with its cudart companion', () => {
    for (const release of PRISM_MANIFEST_BASELINE.releases) {
      for (const asset of release.assets.filter((a) => a.companion_backend)) {
        const sources = prismArchiveSources(PRISM_MANIFEST_BASELINE, release.tag, asset.backend)
        expect(sources?.map((s) => s.companion)).toEqual([false, true])
      }
    }
  })
})
