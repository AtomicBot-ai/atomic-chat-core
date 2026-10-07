// Offline snapshot of atomic-chat-conf/models/atomic-prism-models.json (without `$schema`): what the
// core decides with when neither the live rules nor their disk cache are available. Re-copy it from
// conf when the rules change there; a live document always wins.
import raw from './rules-baseline.json' with { type: 'json' }
import { parsePrismModelRules } from './rules.js'
import type { PrismModelRules } from './rules.js'

const parsed = parsePrismModelRules(raw)
if (!parsed) throw new Error('rules-baseline.json is not a valid PrismML model rules document')

export const PRISM_MODEL_RULES_BASELINE: PrismModelRules = parsed
