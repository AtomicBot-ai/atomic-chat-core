/**
 * The five agents that have no provider config file at all — Copilot, Goose, OpenHands, Poolside and
 * Muse Code read their endpoint from the environment. `configure_*` therefore persists the variables
 * instead of writing a file: a marked block in the user's shell rc on unix, `setx` on Windows.
 *
 * The variables themselves come from `childEnv`, which is the same list `launch` sets directly on
 * the spawned child — a rc file just written is not live in a process that is already running, so
 * the two must never drift.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { childEnv, findAgent } from '../catalog.js'
import type { EnvEntry } from '../config-io.js'
import { writeMarkedEnvToShell } from '../config-io.js'
import type { ConfigureInput } from './registry.js'

export interface EnvAgentSpec {
  /** Catalog id, used to look the variable list up in `childEnv`. */
  agentId: string
  /** The single comment line that both opens and closes our region in the rc file. */
  marker: string
  /** `export <prefix>…` lines are dropped even outside the block, as a stale-export safety net. */
  prefix: string
}

/** The variables this agent needs, in the order the Rust `*_env_vars` builder emits them. */
export function envAgentVars(agentId: string, apiUrl: string, model: string, apiKey: string): EnvEntry[] {
  const agent = findAgent(agentId)
  if (!agent) throw new AtomicCoreError('INTERNAL_ERROR', `Unknown agent: ${agentId}`)
  return Object.entries(childEnv(agent, apiUrl, model, apiKey)).map(([key, value]) => ({ key, value }))
}

/**
 * Persist the variables. On Windows each one goes through `setx` (a user-scope registry write) and
 * no file is touched at all; everywhere else they become one marked block in the shell rc.
 */
export async function configureEnvAgent(input: ConfigureInput, spec: EnvAgentSpec): Promise<void> {
  const entries = envAgentVars(spec.agentId, input.apiUrl, input.model, input.apiKey)
  if (input.platform === 'win32') {
    const spawn = input.spawn
    if (!spawn) {
      throw new AtomicCoreError(
        'INTERNAL_ERROR',
        'Setting a persistent environment variable needs a command runner.',
        'ConfigureInput.spawn is required on Windows'
      )
    }
    for (const entry of entries) {
      const result = await spawn('setx', [entry.key, entry.value])
      if (result.code !== 0) {
        throw new AtomicCoreError('IO_ERROR', `Failed to set env var ${entry.key}: ${result.stderr}`)
      }
    }
    return
  }
  await writeMarkedEnvToShell(input.fs, input.shell, input.platform, spec.marker, spec.prefix, entries)
}
