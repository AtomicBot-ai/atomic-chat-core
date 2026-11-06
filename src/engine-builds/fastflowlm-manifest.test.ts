import { expect, it } from 'vitest'
import { flmRelease } from '../../test/helpers/fastflowlm-manifest.js'
import { parseFastFlowLmManifest, fastFlowLmBuildKey } from './fastflowlm-manifest.js'

it('reads empty and immutable two-platform releases ordered by numeric Atomic revision', () => {
  const releases = [flmRelease(10), flmRelease(2)]
  expect(parseFastFlowLmManifest({ schema_version: 1, releases })).toEqual({ schema_version: 1, releases })
  expect(parseFastFlowLmManifest({ schema_version: 1, releases: [] })).toHaveProperty('releases', [])
  expect(fastFlowLmBuildKey(releases[0]!.version)).toEqual([1, 0, 11, 10])
  expect(() => parseFastFlowLmManifest({ schema_version: 1, releases: releases.reverse() })).toThrow()
})

it('rejects inconsistent provenance, mutable URLs, bad hashes and duplicate platforms', () => {
  for (const mutate of [
    (r: ReturnType<typeof flmRelease>) => {
      r.assets[0]!.sha256 = 'bad'
    },
    (r: ReturnType<typeof flmRelease>) => {
      r.assets[0]!.url += '/../evil.zip'
    },
    (r: ReturnType<typeof flmRelease>) => {
      r.min_core_version = '4294967296.0.0'
    },
    (r: ReturnType<typeof flmRelease>) => {
      r.atomic_revision++
    },
    (r: ReturnType<typeof flmRelease>) => {
      r.assets[0] = r.assets[1]!
    },
    (r: ReturnType<typeof flmRelease>) => {
      r.provenance.document.url = 'https://example.org/latest'
    },
  ]) {
    const release = flmRelease()
    mutate(release)
    expect(() => parseFastFlowLmManifest({ schema_version: 1, releases: [release] })).toThrow()
  }
})
