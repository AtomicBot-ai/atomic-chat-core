/**
 * Muse Code is the one agent with no writable endpoint configuration at all: the provider is chosen
 * per invocation with `--provider meta --base-url <url> --model <id>` (see the catalog's run args),
 * so `apiUrl` and `model` are accepted for symmetry and never written. Muse only checks that
 * `META_API_KEY` is present — the call goes wherever `--base-url` points — so the local server's own
 * key (or the `atomic` placeholder) satisfies both ends.
 */

import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'
import { configureEnvAgent } from './env-agent.js'

const MARKER = '# Atomic Chat - Muse Code Config'

export const configureMuse: ConfigureWriter = (input) =>
  configureEnvAgent(input, { agentId: 'muse', marker: MARKER, prefix: 'META_' })

registerWriter('muse', configureMuse)
