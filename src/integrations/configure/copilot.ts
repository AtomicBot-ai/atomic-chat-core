/**
 * GitHub Copilot CLI has no provider config file — it reads its BYOK settings from the environment
 * at launch — so configuring it means persisting `COPILOT_*` to the shell rc (Windows: `setx`).
 * `COPILOT_OFFLINE` is on so no GitHub sign-in is required and traffic stays on the local provider.
 *
 * Copilot is the one agent that OMITS the key variable entirely when there is none, rather than
 * writing an `atomic` placeholder: an empty `COPILOT_PROVIDER_API_KEY` would be sent as a credential.
 */

import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'
import { configureEnvAgent } from './env-agent.js'

const MARKER = '# Atomic Chat - Copilot CLI Config'

export const configureCopilot: ConfigureWriter = (input) =>
  configureEnvAgent(input, { agentId: 'copilot', marker: MARKER, prefix: 'COPILOT_' })

registerWriter('copilot', configureCopilot)
