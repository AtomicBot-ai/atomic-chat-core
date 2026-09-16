/**
 * Is an agent's launcher on this machine, and what do we execute?
 *
 * Same answer as the Rust CLI (`is_on_path`, `is_command_installed`, `agent_program` in
 * `bin/jan-cli.rs`): probe PATH with `which`/`where`, then the prefix locations an installer can use
 * without touching PATH. A launcher found on PATH is executed by its bare name so the command we
 * print is the one the user could retype; one found off PATH is executed by absolute path.
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Agent } from './catalog.js'
import { offPathCandidates } from './catalog.js'

export const PATH_PROBE_TIMEOUT_MS = 5000

export interface DetectDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  /** Run the PATH probe; resolves true when the command exists. */
  onPath?: (bin: string) => Promise<boolean>
  /** Does this absolute path exist as a file? */
  isFile?: (path: string) => Promise<boolean>
}

export interface AgentDetection {
  installed: boolean
  /** Absolute path when the launcher was found off PATH; undefined when the bare name resolves. */
  path: string | undefined
  /** What to execute: the bare name, or the absolute path. */
  program: string
}

const defaultIsFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

function defaultOnPath(bin: string, platform: NodeJS.Platform): Promise<boolean> {
  const probe = platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(probe, [bin], { timeout: PATH_PROBE_TIMEOUT_MS, windowsHide: true }, (err) => resolve(!err))
  })
}

export async function detectAgent(agent: Agent, deps: DetectDeps = {}): Promise<AgentDetection> {
  const platform = deps.platform ?? process.platform
  const onPath = deps.onPath ?? ((bin: string) => defaultOnPath(bin, platform))
  const isFile = deps.isFile ?? defaultIsFile
  if (await onPath(agent.detectBin)) {
    return { installed: true, path: undefined, program: agent.detectBin }
  }
  const home = deps.home ?? homedir()
  for (const candidate of offPathCandidates(agent.detectBin, home, deps.env ?? process.env, platform)) {
    if (await isFile(candidate)) return { installed: true, path: candidate, program: candidate }
  }
  return { installed: false, path: undefined, program: agent.detectBin }
}

/** Detect several agents at once, for `launch --list`. */
export async function detectAgents(
  agents: readonly Agent[],
  deps: DetectDeps = {}
): Promise<Map<string, AgentDetection>> {
  const out = new Map<string, AgentDetection>()
  await Promise.all(
    agents.map(async (agent) => {
      out.set(agent.id, await detectAgent(agent, deps))
    })
  )
  return out
}
