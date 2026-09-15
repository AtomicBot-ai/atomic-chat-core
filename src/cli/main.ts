/**
 * CLI dispatcher (pure). The executable entry is `bin.ts`.
 * Subcommands land per phase (PLAN.md §4): daemon, serve, models, server, shutdown (phase 1);
 * launch (phase 2); backends, hardware, settings, providers, auth, doctor (phases 3–5).
 */

import { parseArgs } from 'node:util'
import { CORE_VERSION } from '../version.js'

export const USAGE = `atomic-chat-core ${CORE_VERSION}

Usage: atomic-chat-core <command> [options]

Commands:
  serve       Load a local model and expose it over an OpenAI-compatible API   (phase 1)
  models      List / import / delete models in the Atomic Chat data folder      (phase 1)
  server      Inspect or control the local API server on :1337                 (phase 1)
  launch      Start a model and launch a coding agent wired to it              (phase 2)

Options:
  -h, --help      Show this help
  -v, --version   Print the version
`

export interface CliResult {
  exitCode: number
  stdout?: string
  stderr?: string
}

/** Pure dispatcher so tests can drive it without spawning. */
export function runCli(argv: string[]): CliResult {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: false,
  })

  if (values.version) return { exitCode: 0, stdout: `${CORE_VERSION}\n` }
  if (values.help || positionals.length === 0) return { exitCode: values.help ? 0 : 2, stdout: USAGE }

  const command = positionals[0]
  return { exitCode: 2, stderr: `Unknown or not yet implemented command: ${command}\n\n${USAGE}` }
}
