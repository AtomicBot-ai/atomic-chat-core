/**
 * Muse Code is the one agent with no writable endpoint configuration at all: the provider is chosen
 * per invocation with `--provider meta --base-url <url> --model <id>` (see the catalog's run args),
 * and Muse only checks that `META_API_KEY` is present — the call goes wherever `--base-url` points —
 * so the local server's own key (or the `atomic` placeholder) set on the child satisfies both ends.
 * Nothing is persisted; Connect only removes what an older release did (`legacy-env-block.ts`).
 */

import { legacyEnvAgentWriter } from './legacy-env-block.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

export const configureMuse: ConfigureWriter = legacyEnvAgentWriter('# Atomic Chat - Muse Code Config')

registerWriter('muse', configureMuse)
