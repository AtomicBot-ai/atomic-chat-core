/**
 * The dispatch point every agent config writer registers with — the TypeScript side of
 * `cli::integrations::configure`. `launch` calls `configureAgent`, and nothing else needs to know
 * which agent writes JSON, YAML, a shell rc, or no file at all.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { Agent } from '../catalog.js'
import { findAgent } from '../catalog.js'
import type { ConfigFs } from '../config-io.js'
import { nodeConfigFs } from '../config-io.js'

export interface ConfigureInput {
  apiUrl: string
  model: string
  apiKey: string
  fs: ConfigFs
  platform: NodeJS.Platform
  /** `$SHELL`; decides which rc file the env-var agents write to. */
  shell: string | undefined
  env: NodeJS.ProcessEnv
  /** Run a command (only Cline needs one). Resolves with its exit status and output. */
  spawn?: (program: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}

export type ConfigureWriter = (input: ConfigureInput) => Promise<void>

const WRITERS = new Map<string, ConfigureWriter>()

/** Register a writer for an agent id. Called once per module at import time. */
export function registerWriter(agentId: string, writer: ConfigureWriter): void {
  WRITERS.set(agentId, writer)
}

export function writerFor(agentId: string): ConfigureWriter | undefined {
  return WRITERS.get(agentId)
}

export function registeredAgents(): string[] {
  return [...WRITERS.keys()].sort()
}

export interface ConfigureOptions {
  home?: string
  fs?: ConfigFs
  platform?: NodeJS.Platform
  shell?: string | undefined
  env?: NodeJS.ProcessEnv
  spawn?: ConfigureInput['spawn']
}

/**
 * Point an agent at a local endpoint. `model` may be empty only for the agents whose Rust
 * counterpart accepts it (Claude Code and Zed treat it as "no model selected").
 */
export async function configureAgent(
  agent: Agent | string,
  apiUrl: string,
  model: string,
  apiKey: string,
  options: ConfigureOptions = {}
): Promise<void> {
  const resolved = typeof agent === 'string' ? findAgent(agent) : agent
  if (!resolved) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Unknown agent: ${String(agent)}`)
  }
  const writer = WRITERS.get(resolved.id)
  if (!writer) {
    throw new AtomicCoreError(
      'INTERNAL_ERROR',
      `Configuring ${resolved.name} is not implemented in this build.`,
      `no writer registered for "${resolved.id}"`
    )
  }
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? (platform === 'win32' ? env['USERPROFILE'] : env['HOME'])
  if (!options.fs && !home) {
    throw new AtomicCoreError('IO_ERROR', 'Cannot resolve the home directory to write agent config into.')
  }
  await writer({
    apiUrl,
    model,
    apiKey,
    fs: options.fs ?? nodeConfigFs(home as string),
    platform,
    shell: options.shell ?? env['SHELL'],
    env,
    ...(options.spawn ? { spawn: options.spawn } : {}),
  })
}
