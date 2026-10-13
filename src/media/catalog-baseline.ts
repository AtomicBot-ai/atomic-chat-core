// Offline snapshot of atomic-chat-conf/providers/media.json (without `$schema`): what the core offers
// when neither the live catalog nor its disk cache are available. Re-copy it from conf when the
// catalog changes there; a live document with a newer `catalog_version` always wins.
import raw from './catalog-baseline.json' with { type: 'json' }
import { parseMediaCatalog } from './catalog.js'
import type { MediaCatalog } from './catalog.js'

const parsed = parseMediaCatalog(raw)
if (!parsed) throw new Error('catalog-baseline.json is not a valid remote media catalog')

export const MEDIA_CATALOG_BASELINE: MediaCatalog = parsed
