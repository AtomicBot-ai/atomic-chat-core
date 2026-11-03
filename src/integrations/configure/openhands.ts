/**
 * OpenHands reads `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` only when launched with
 * `--override-with-envs`, and `launch` sets them on the child (`childEnv`). The litellm `openai/`
 * prefix on the model id is required for a custom OpenAI-compatible base URL — without it litellm
 * resolves the id against its own model registry and fails before the request leaves the process.
 * Nothing is persisted; Connect only removes what an older release did (`legacy-env-block.ts`).
 */

import { legacyEnvAgentWriter } from './legacy-env-block.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

export const configureOpenhands: ConfigureWriter = legacyEnvAgentWriter('# Atomic Chat - OpenHands Config')

registerWriter('openhands', configureOpenhands)
