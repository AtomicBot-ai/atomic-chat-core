/**
 * `launch <agent>` — start a model in the core and hand the user a coding agent already pointed at
 * it. Port of `handle_launch` in `src-tauri/src/bin/jan-cli.rs`, with the same flags, the same
 * refusals and the same run modes.
 *
 * The one behavioural difference, stated in the help: the model lives in the core, not in this
 * process. A terminal agent still owns the session's lifetime — when it exits we unload the model
 * we loaded — but the core itself stays up, so the next command reuses it.
 */

import { execFile, spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { AtomicCoreError } from '../contracts/index.js'
import { LOCAL_PROVIDER } from '../core.js'
import { configureAgent } from '../integrations/configure/index.js'
import {
  AGENTS,
  apiUrlFor,
  childEnv,
  CONFLICTING_PROVIDER_ENV,
  detectAgents,
  findAgent,
  MUSE_CLI_REFUSAL,
} from '../integrations/index.js'
import type { Agent, AgentDetection } from '../integrations/index.js'
import { ModelRegistry } from '../models/index.js'
import { layoutFor } from './commands.js'
import type { CliIo } from './io.js'
import { attachToOwner } from './owner.js'

export const DEFAULT_LAUNCH_PORT = 6767
export const DEFAULT_LAUNCH_CTX_SIZE = 32_768
export const DEFAULT_LAUNCH_API_KEY = 'atomic'

export interface LaunchDeps {
  /** Write the agent's config files. Injected so tests never touch a real home directory. */
  configure?: ((agent: Agent, apiUrl: string, model: string, apiKey: string) => Promise<void>) | undefined
  /** Run the agent; resolves with its exit code. Injected in tests. */
  run?: ((spec: RunSpec) => Promise<number>) | undefined
  detect?: typeof detectAgents | undefined
}

export interface RunSpec {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** GUI launchers return at once, so the caller must keep serving until interrupted. */
  detached: boolean
}

export async function launchCommand(argv: string[], io: CliIo, deps: LaunchDeps = {}): Promise<number> {
  // Everything after the agent name belongs to the agent, including flags this CLI does not know:
  // `launch goose --debug` must reach Goose, not fail our own parser (Rust uses `trailing_var_arg`).
  const { own, forwarded } = splitAgentArgs(argv)
  const { values, positionals } = parseArgs({
    args: own,
    options: {
      'data-folder': { type: 'string' },
      'model': { type: 'string' },
      'bin': { type: 'string' },
      'port': { type: 'string' },
      'host': { type: 'string' },
      'api-key': { type: 'string' },
      'n-gpu-layers': { type: 'string' },
      'ctx-size': { type: 'string' },
      'fit': { type: 'boolean' },
      'no-fit': { type: 'boolean' },
      'list': { type: 'boolean' },
      'json': { type: 'boolean' },
      'verbose': { type: 'boolean', short: 'v' },
      'standalone': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const detect = deps.detect ?? detectAgents

  if (values.list) return listAgents(io, values.json === true, detect)

  const requested = positionals[0]
  const agentArgs = [...positionals.slice(1), ...forwarded]
  const agent = requested ? findAgent(requested) : await pickAgent(io, detect)
  if (!agent) {
    io.stderr(`Error: unknown agent '${requested}'.\n\n`)
    await listAgents(io, false, detect)
    return 1
  }
  if (agent.id === 'muse') {
    io.stderr(`Error: ${agent.name} cannot be launched from the CLI.\n\n`)
    for (const line of MUSE_CLI_REFUSAL) io.stderr(`  ${line}\n`)
    return 1
  }

  const detections = await detect([agent], { env: io.env })
  const detection = detections.get(agent.id) as AgentDetection
  if (!detection.installed) {
    io.stderr(`Error: ${agent.name} is not installed.\n\n`)
    io.stderr('  Install it first — the Atomic Chat desktop app can do this\n')
    io.stderr('  for you from the Launch page, or see:\n\n')
    io.stderr(`    ${agent.docsUrl}\n`)
    return 1
  }

  const layout = layoutFor(values, io)
  if (values.standalone && values['data-folder'] === undefined) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      '--standalone requires an explicit --data-folder.',
      'use a separate folder so the foreground owner cannot collide with the app'
    )
  }
  const modelId = values.model ?? (await pickModel(layout, io))
  const apiKey = values['api-key'] ?? DEFAULT_LAUNCH_API_KEY

  // `--fit` defaults to on for Claude Code, but only when `--ctx-size` was not given: an explicit
  // context size means the user wants exactly that, and fit would override it.
  const ctxGiven = values['ctx-size'] !== undefined
  const fit = values['no-fit'] ? false : (values.fit ?? (agent.id === 'claude-code' && !ctxGiven))
  const overrides: Record<string, unknown> = {
    ctx_size: ctxGiven ? Number(values['ctx-size']) : DEFAULT_LAUNCH_CTX_SIZE,
    fit,
  }
  if (values['n-gpu-layers'] !== undefined) overrides['n_gpu_layers'] = Number(values['n-gpu-layers'])

  const standaloneCore = values.standalone
    ? await (
        await import('../core.js')
      ).AtomicCore.create({ dataFolder: layout.root, controlPort: 0, env: io.env })
    : undefined
  const client = standaloneCore
    ? undefined
    : (
        await attachToOwner({
          layout,
          clientName: `atomic-chat-core launch ${agent.id}`,
          launch: true,
          log: (message) => io.stderr(`${message}\n`),
        })
      ).client

  let created = false
  try {
    // Validate/claim the public listener before a model load can auto-unload another session.
    const server = standaloneCore
      ? await standaloneCore.startPublicServer({
          port: values.port !== undefined ? Number(values.port) : DEFAULT_LAUNCH_PORT,
          ...(values.host ? { host: values.host } : {}),
          apiKey,
        })
      : await client!.startServer({
          port: values.port !== undefined ? Number(values.port) : DEFAULT_LAUNCH_PORT,
          ...(values.host ? { host: values.host } : {}),
          api_key: apiKey,
        })

    const acquired = standaloneCore
      ? await standaloneCore.acquire(LOCAL_PROVIDER, modelId, {
          overrides,
          ...(values.bin ? { exePath: values.bin } : {}),
        })
      : await client!.acquireModel(LOCAL_PROVIDER, modelId, {
          overrides,
          ...(values.bin ? { exePath: values.bin } : {}),
        })
    const session = acquired.session
    created = acquired.created

    const baseUrl = `http://${server.host === '0.0.0.0' ? '127.0.0.1' : server.host}:${server.port}`
    const apiUrl = apiUrlFor(agent, baseUrl, server.prefix)

    const configure =
      deps.configure ??
      ((a, u, m, k) =>
        configureAgent(a, u, m, k, {
          env: io.env,
          spawn: runCommand,
        }))
    try {
      await configure(agent, apiUrl, modelId, apiKey)
    } catch (e) {
      throw new AtomicCoreError(
        'IO_ERROR',
        `Could not configure ${agent.name}.`,
        e instanceof Error ? e.message : String(e)
      )
    }

    io.stderr(`\n  Agent     ${agent.name}\n`)
    io.stderr(`  Endpoint  ${apiUrl}\n`)
    io.stderr(`  Model     ${modelId}\n`)
    io.stderr(`  Session   pid ${session.pid}, port ${session.port}\n\n`)

    const args = [...agent.runArgs, ...agentArgs]
    const env = agentEnvironment(io.env, agent, apiUrl, modelId, apiKey)
    const run = deps.run ?? runAgent

    if (agent.runMode === 'gui') {
      await run({ program: detection.program, args, env, detached: true })
      io.stderr(`  ${agent.name} opened. The model stays loaded until you press Ctrl+C.\n\n`)
      await io.waitForShutdown(async () => {})
      return 0
    }

    io.stderr(`  → Launching: ${[detection.program, ...args].join(' ')}\n\n`)
    return await run({ program: detection.program, args, env, detached: false })
  } catch (e) {
    throw e instanceof AtomicCoreError
      ? e
      : new AtomicCoreError(
          'IO_ERROR',
          `Could not launch ${agent.name}.`,
          e instanceof Error ? e.message : String(e)
        )
  } finally {
    if (created) {
      if (standaloneCore) await standaloneCore.unload(LOCAL_PROVIDER, modelId).catch(() => {})
      else await client?.unloadModel(LOCAL_PROVIDER, modelId).catch(() => {})
    }
    await standaloneCore?.shutdown().catch(() => {})
  }
}

/**
 * Split our flags from the agent's. Everything before the first positional (the agent name) is
 * ours; everything after it goes to the agent, except the options we document for `launch` itself.
 */
export function splitAgentArgs(argv: string[]): { own: string[]; forwarded: string[] } {
  const OURS = new Set([
    '--data-folder',
    '--model',
    '--bin',
    '--port',
    '--host',
    '--api-key',
    '--n-gpu-layers',
    '--ctx-size',
  ])
  const FLAGS = new Set(['--fit', '--no-fit', '--standalone', '--list', '--json', '--verbose', '-v'])
  const own: string[] = []
  const forwarded: string[] = []
  let seenAgent = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') {
      forwarded.push(...argv.slice(i + 1))
      break
    }
    if (OURS.has(arg)) {
      own.push(arg, argv[i + 1] ?? '')
      i++
      continue
    }
    if (arg.startsWith('--fit=')) {
      own.push(arg === '--fit=false' ? '--no-fit' : '--fit')
      continue
    }
    if (FLAGS.has(arg) || arg.startsWith('--data-folder=') || (!seenAgent && arg.startsWith('-'))) {
      own.push(arg)
      continue
    }
    if (!seenAgent && !arg.startsWith('-')) {
      own.push(arg)
      seenAgent = true
      continue
    }
    forwarded.push(arg)
  }
  return { own, forwarded }
}

async function listAgents(io: CliIo, json: boolean, detect: typeof detectAgents): Promise<number> {
  const detections = await detect(AGENTS, { env: io.env })
  if (json) {
    io.stdout(
      `${JSON.stringify(
        AGENTS.map((agent) => ({
          id: agent.id,
          name: agent.name,
          bin: agent.detectBin,
          aliases: agent.aliases,
          installed: detections.get(agent.id)?.installed ?? false,
          path: detections.get(agent.id)?.path ?? null,
          requires_model: agent.requiresModel,
          endpoint_with_prefix: agent.endpointWithPrefix,
          run_mode: agent.runMode,
          run_args: agent.runArgs,
          docs_url: agent.docsUrl,
        })),
        null,
        2
      )}\n`
    )
    return 0
  }
  io.stdout('Agents this CLI can configure:\n\n')
  const width = Math.max(...AGENTS.map((a) => a.id.length), 12)
  for (const agent of AGENTS) {
    const mark = detections.get(agent.id)?.installed ? '●' : '○'
    io.stdout(`  ${mark} ${agent.id.padEnd(width)} ${agent.docsUrl}\n`)
  }
  io.stdout('\n  ● installed   ○ not found on PATH\n')
  return 0
}

async function pickAgent(io: CliIo, detect: typeof detectAgents): Promise<Agent | undefined> {
  const detections = await detect(AGENTS, { env: io.env })
  const installed = AGENTS.filter((a) => detections.get(a.id)?.installed && a.id !== 'muse')
  if (installed.length === 0) {
    throw new AtomicCoreError(
      'MODEL_NOT_FOUND',
      'No supported coding agent is installed.',
      'install one from the Launch page in Atomic Chat, or run `launch --list`'
    )
  }
  const index = await io.select(
    'Which agent should be launched?',
    installed.map((a) => a.name)
  )
  return installed[index]
}

async function pickModel(layout: ReturnType<typeof layoutFor>, io: CliIo): Promise<string> {
  const models = await new ModelRegistry(layout, LOCAL_PROVIDER).listChatModels()
  if (models.length === 0) {
    throw new AtomicCoreError(
      'MODEL_NOT_FOUND',
      'No chat models are installed.',
      'download one in Atomic Chat, or pass --model'
    )
  }
  if (models.length === 1) return (models[0] as { id: string }).id
  const index = await io.select(
    'Which model should be served?',
    models.map((m) => m.id)
  )
  return (models[index] as { id: string }).id
}

/**
 * The child's environment: ambient provider credentials removed (they would override the config we
 * just wrote and quietly send traffic to a cloud provider), then the variables the env-configured
 * agents read.
 */
export function agentEnvironment(
  base: NodeJS.ProcessEnv,
  agent: Agent,
  apiUrl: string,
  model: string,
  apiKey: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const name of CONFLICTING_PROVIDER_ENV) delete env[name]
  return { ...env, ...childEnv(agent, apiUrl, model, apiKey) }
}

export function runAgent(spec: RunSpec): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.program, spec.args, {
      env: spec.env,
      stdio: spec.detached ? 'ignore' : 'inherit',
      detached: spec.detached,
      windowsHide: true,
    })
    let settled = false
    child.once('error', (e) => {
      if (!settled) reject(new AtomicCoreError('IO_ERROR', `Could not launch '${spec.program}'.`, e.message))
    })
    if (spec.detached) {
      child.unref()
      // Give a launcher that fails immediately a chance to report before we call it a success.
      child.once('exit', (code, signal) => {
        if (!settled) {
          settled = true
          if (code === 0 && !signal) resolve(0)
          else
            reject(
              new AtomicCoreError(
                'IO_ERROR',
                `'${spec.program}' exited before its window opened.`,
                `exit ${code ?? signal ?? '?'}`
              )
            )
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve(0)
        }
      }, 250).unref()
      return
    }
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

export function runCommand(
  program: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error)
      else resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}
