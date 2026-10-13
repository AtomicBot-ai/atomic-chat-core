import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from '../../version.js'
import { UPSTREAM_RELEASES_BASELINE } from './upstream-releases-baseline.js'
import { upstreamRemoteBackends, upstreamTagBuild } from './upstream-releases.js'

describe('UPSTREAM_RELEASES_BASELINE', () => {
  it('parses, downloads from the mirror and pins every archive by sha256', () => {
    expect(UPSTREAM_RELEASES_BASELINE.download_base).toMatch(/^https:\/\//)
    expect(UPSTREAM_RELEASES_BASELINE.releases.length).toBeGreaterThan(0)
    for (const release of UPSTREAM_RELEASES_BASELINE.releases) {
      expect(upstreamTagBuild(release.tag)).not.toBeNull()
      for (const asset of release.assets) {
        expect(asset.name).toContain(`llama-${release.tag}-bin-`)
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      }
    }
  })

  // A cold offline core still has something to recommend on the platforms that update at runtime.
  it.each([
    ['macos', 'arm64'],
    ['windows', 'x64'],
    ['windows', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ] as const)('offers this core an approved build on %s %s', (osType, arch) => {
    const offer = { coreVersion: CORE_VERSION, allowCandidates: false }
    expect(upstreamRemoteBackends(UPSTREAM_RELEASES_BASELINE, offer, osType, arch).length).toBeGreaterThan(0)
  })
})
