/**
 * CLI dispatcher. `bin.ts` is the only file with side effects; everything here takes a `CliIo`, so
 * a test can run a command and read what it printed without spawning a process.
 *
 * Phase 1 ships `daemon`, `serve`, `models`, `server` and `shutdown` (PLAN.md §4); `launch` and the
 * rest land with their phases.
 */

import { AtomicCoreError } from '../contracts/index.js'
import { CORE_VERSION } from '../version.js'
import {
  daemonCommand,
  modelsCommand,
  serveCommand,
  serverCommand,
  shutdownCommand,
} from './commands/index.js'
import { launchCommand } from './launch.js'
import { authCommand, providersCommand } from './cloud.js'
import type { CliIo } from './io.js'

export const USAGE = `atomic-chat-core ${CORE_VERSION}

Usage: atomic-chat-core <command> [options]

Commands:
  serve <model>   Load a model in the core and expose it over an OpenAI-compatible API
  models list     List the chat models installed in the CLI data folder
  server status   Report whether a local API server is reachable
  daemon          Run the core that owns this data folder (started for you by other commands)
  shutdown        Stop the core that owns this data folder
  launch <agent>  Start a model and launch a coding agent already wired to it
  providers       List, register or remove cloud providers the API server routes to
  auth chatgpt    Connect, inspect or disconnect a ChatGPT subscription

Common options:
  --data-folder <path>   Data folder to work with (default: <system data>/atomic-chat-cli/data)
  -h, --help             Show this help
  -v, --version          Print the version

Serve compatibility options:
  --model-path <gguf>    Serve a GGUF directly; model id defaults to its filename
  --provider <id>        llamacpp-upstream (default), mlx or foundation-models
  --resources-dir <dir>  Folder with the desktop app's sidecar servers (mlx-server, foundation-models-server)
  --bin <path>           Use this llama-server (or sidecar server) executable
  --port <port>          Public OpenAI API port (default: 6767; 0 = random)
  --mmproj <path>        Vision projector path
  --embedding            Start in embedding mode
  --timeout <seconds>    Readiness timeout (default: 120)
  --n-gpu-layers <n>     GPU layers (-1 = all; default: -1)
  --ctx-size <tokens>    Context size (default: 32768)
  --fit                  Let llama.cpp choose context size for available memory
  --threads <n>          CPU inference threads (0 = auto)
  --api-key <key>        Require this key on the public API
  --standalone           Run a foreground owner in an explicit, separate --data-folder
  -d, --detach           Compatibility flag; the persistent owner is already detached
  --log <path>           Append llama.cpp stdout/stderr to a file
  -v, --verbose          Relay llama.cpp output while the model loads
  --select               Pick a GGUF when downloading owner/repository from Hugging Face
  --json                 Print the result as JSON

Notes:
  The core keeps running when a command exits, so a model stays loaded between commands and
  Ctrl+C detaches instead of unloading. Stop it explicitly with \`atomic-chat-core shutdown\`.
`

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const command = argv[0]
  // Parse global flags only before the command. In particular, `serve -v` is verbose backend
  // output, not the top-level version flag.
  if (command === '--version' || command === '-v') {
    io.stdout(`${CORE_VERSION}\n`)
    return 0
  }
  if (command === '--help' || command === '-h' || !command) {
    io.stdout(USAGE)
    return command ? 0 : 2
  }

  const rest = argv.slice(1)
  try {
    switch (command) {
      case 'daemon':
        return await daemonCommand(rest, io)
      case 'serve':
        return await serveCommand(rest, io)
      case 'models':
        return await modelsCommand(rest, io)
      case 'server':
        return await serverCommand(rest, io)
      case 'launch':
        return await launchCommand(rest, io)
      case 'shutdown':
        return await shutdownCommand(rest, io)
      case 'providers':
        return await providersCommand(rest, io)
      case 'auth':
        return await authCommand(rest, io)
      default:
        io.stderr(`Unknown command: ${command}\n\n${USAGE}`)
        return 2
    }
  } catch (e) {
    io.stderr(`Error: ${describe(e)}\n`)
    return 1
  }
}

function describe(error: unknown): string {
  if (error instanceof AtomicCoreError) {
    return `${error.message}${error.details ? `\n  ${error.details}` : ''} [${error.code}]`
  }
  if (error instanceof Error) return error.message
  return String(error)
}
