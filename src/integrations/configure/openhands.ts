/**
 * OpenHands reads env overrides only when launched with `--override-with-envs`, using
 * `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`. The litellm `openai/` prefix on the model id is
 * required for a custom OpenAI-compatible base URL — without it litellm resolves the id against its
 * own model registry and fails before the request leaves the process.
 */

import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'
import { configureEnvAgent } from './env-agent.js'

const MARKER = '# Atomic Chat - OpenHands Config'

export const configureOpenhands: ConfigureWriter = (input) =>
  configureEnvAgent(input, { agentId: 'openhands', marker: MARKER, prefix: 'LLM_' })

registerWriter('openhands', configureOpenhands)
