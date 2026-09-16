/**
 * Poolside CLI has no BYOK config file; it reads `POOLSIDE_STANDALONE_*` from the environment.
 * The base URL is normalised by `poolsideStandaloneBaseUrl` (trim, strip trailing slashes, strip one
 * `/v1`, strip trailing slashes again) because Poolside appends its own paths — leaving `/v1` on
 * would make it request `/v1/v1/...`.
 */

import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'
import { configureEnvAgent } from './env-agent.js'

const MARKER = '# Atomic Chat - Poolside Config'

export const configurePoolside: ConfigureWriter = (input) =>
  configureEnvAgent(input, { agentId: 'poolside', marker: MARKER, prefix: 'POOLSIDE_' })

registerWriter('poolside', configurePoolside)
