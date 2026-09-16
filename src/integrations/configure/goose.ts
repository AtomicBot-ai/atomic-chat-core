/**
 * Goose reads `GOOSE_PROVIDER` / `GOOSE_MODEL` plus the OpenAI host variables from the environment;
 * there is no provider file to patch. Goose appends its own path, so `OPENAI_HOST` is the bare
 * host:port (the catalog marks it `endpointWithPrefix: false`) and `OPENAI_BASE_PATH` carries the
 * chat-completions path.
 *
 * The block also holds `OPENAI_*` variables, which do not share the `GOOSE_` prefix. Rerun stays
 * idempotent because the whole marked region is removed first; the prefix filter is only the safety
 * net for stray lines outside it, which is why a user's own `export OPENAI_API_KEY` survives.
 */

import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'
import { configureEnvAgent } from './env-agent.js'

const MARKER = '# Atomic Chat - Goose Config'

export const configureGoose: ConfigureWriter = (input) =>
  configureEnvAgent(input, { agentId: 'goose', marker: MARKER, prefix: 'GOOSE_' })

registerWriter('goose', configureGoose)
