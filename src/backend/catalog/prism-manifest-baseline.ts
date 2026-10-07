// Offline snapshot of atomic-chat-conf/backends/atomic-prism-manifest.json (without `$schema`).
// The core reads it when neither the live manifest nor its disk cache is available, so a cold
// offline install still knows which PrismML packs exist and what they hash to. It is NOT a pin: a
// live manifest is always preferred. Re-copy it from conf when a release is approved there.
import raw from './prism-manifest-baseline.json' with { type: 'json' }
import { parsePrismManifest } from './prism-manifest.js'
import type { PrismManifest } from './prism-manifest.js'

const parsed = parsePrismManifest(raw)
if (!parsed) throw new Error('prism-manifest-baseline.json is not a valid Prism manifest')

export const PRISM_MANIFEST_BASELINE: PrismManifest = parsed
