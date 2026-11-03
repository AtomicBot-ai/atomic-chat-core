/**
 * Poolside CLI has no BYOK config file; in standalone mode it reads `POOLSIDE_STANDALONE_BASE_URL`
 * (with `/v1`, as its docs keep it), `POOLSIDE_API_KEY`, `POOLSIDE_STANDALONE_MODEL` and
 * `POOLSIDE_STANDALONE_CONTEXT_LENGTH` from the environment, which `launch` sets on the child
 * (`childEnv`). Nothing is persisted; Connect only removes what an older release did
 * (`legacy-env-block.ts`).
 */

import { legacyEnvAgentWriter } from './legacy-env-block.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

export const configurePoolside: ConfigureWriter = legacyEnvAgentWriter('# Atomic Chat - Poolside Config')

registerWriter('poolside', configurePoolside)
