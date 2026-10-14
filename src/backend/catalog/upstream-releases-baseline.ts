// Offline snapshot of atomic-chat-conf/backends/llamacpp-upstream-releases.json (without `$schema`).
// The core reads it when neither the live list, the legacy manifest nor the disk cache is
// available, so a cold offline core still knows which upstream packs exist and what they hash to.
// It is NOT a pin: a live list is always preferred. Re-copy it from conf when a release is approved
// there.
import raw from './upstream-releases-baseline.json' with { type: 'json' }
import { parseUpstreamReleases } from './upstream-releases.js'
import type { UpstreamReleaseCatalog } from './upstream-releases.js'

const parsed = parseUpstreamReleases(raw)
if (!parsed) throw new Error('upstream-releases-baseline.json is not a valid upstream release list')

export const UPSTREAM_RELEASES_BASELINE: UpstreamReleaseCatalog = parsed
