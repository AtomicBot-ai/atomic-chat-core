/**
 * The phase-1 commands (PLAN.md §4): `daemon`, `serve`, `models list`, `server status`, `shutdown`.
 *
 * Flags, defaults and exit codes follow the Rust `jan-cli` wherever it has an opinion — `serve`
 * defaults to port 6767, `models list --json` prints the same fields, `server status` exits 1 when
 * the server is unreachable — because both binaries will be installed side by side during the
 * migration. The deliberate difference is ownership: `serve` attaches to a core that keeps running
 * after Ctrl+C instead of owning the model itself, which the help text states outright.
 */

import { parseArgs } from 'node:util'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { LocalApiServerState, LocalProviderId } from '../contracts/index.js'
import {
  APPLE_MODEL_ID,
  FOUNDATION_MODELS_BINARY,
  FOUNDATION_MODELS_STARTUP_TIMEOUT_SECS,
} from '../runtime/foundation-models/index.js'
import { MLX_DEFAULT_TIMEOUT_SECS, MLX_SERVER_BINARY } from '../runtime/mlx/index.js'
import type { CoreClient } from '../client/index.js'
import { assertCliDataFolder, dataLayout, nodeDataFolderEnv, resolveCliDataFolder } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import { AtomicCore, LOCAL_PROVIDER } from '../core.js'
import { versionBackendFromBinPath } from '../backend/index.js'
import {
  chooseDefaultHfFile,
  downloadHfModel,
  fetchHfGgufFiles,
  hfToken,
  looksLikeHfRepo,
  ModelRegistry,
} from '../models/index.js'
import type { ModelEntry } from '../models/index.js'
import { withAttachedOwner } from './owner.js'
import type { CliIo } from './io.js'

export const DEFAULT_SERVE_PORT = 6767
export const DEFAULT_SERVE_TIMEOUT_SECS = 120
export const DEFAULT_SERVE_GPU_LAYERS = -1
export const DEFAULT_SERVE_CTX_SIZE = 32_768

export function layoutFor(values: Record<string, unknown>, io: CliIo): DataLayout {
  const explicit = typeof values['data-folder'] === 'string' ? (values['data-folder'] as string) : undefined
  const env = nodeDataFolderEnv(io.env)
  const root = explicit ?? resolveCliDataFolder(env)
  assertCliDataFolder(root, env)
  return dataLayout(root)
}

/** `models list` reads the folder directly, exactly as the Rust CLI does — no core needed. */
export async function modelsCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { 'json': { type: 'boolean' }, 'data-folder': { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const sub = positionals[0] ?? 'list'
  if (sub !== 'list') {
    io.stderr(`Unknown models subcommand: ${sub}\n`)
    return 2
  }
  const registry = new ModelRegistry(layoutFor(values, io), LOCAL_PROVIDER)
  const models = await registry.listChatModels()
  if (values.json) {
    io.stdout(`${JSON.stringify(models.map(jsonModel), null, 2)}\n`)
    return 0
  }
  if (models.length === 0) {
    io.stderr('No chat models installed.\n\n')
    io.stderr('  Download one in the Atomic Chat desktop app, or serve a\n')
    io.stderr('  HuggingFace GGUF repo directly:\n\n')
    io.stderr('    atomic-chat-cli serve <owner>/<repo>\n')
    return 0
  }
  const width = Math.max(8, ...models.map((m) => m.id.length))
  io.stdout(`\n  ${'MODEL ID'.padEnd(width)}  ${'SIZE'.padStart(9)}  CAPABILITIES\n`)
  for (const model of models) {
    const size = model.yml.size_bytes ? formatBytes(model.yml.size_bytes) : '-'
    const caps = model.yml.capabilities?.length ? model.yml.capabilities.join(', ') : '-'
    io.stdout(`  ${model.id.padEnd(width)}  ${size.padStart(9)}  ${caps}\n`)
  }
  io.stdout('\n')
  return 0
}

function jsonModel(model: ModelEntry): Record<string, unknown> {
  return {
    id: model.id,
    name: model.yml.name ?? null,
    model_path: model.yml.model_path,
    size_bytes: model.yml.size_bytes ?? 0,
    capabilities: model.yml.capabilities ?? [],
    mmproj_path: model.yml.mmproj_path ?? null,
  }
}

/** Human-readable size, same thresholds as the Rust `fmt_bytes`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`
}

/** `daemon` — become the owner and stay up until something asks us to stop. */
export async function daemonCommand(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-folder': { type: 'string' },
      'control-port': { type: 'string' },
      'control-host': { type: 'string' },
      'public-port': { type: 'string' },
      'public-host': { type: 'string' },
      'api-key': { type: 'string' },
      'resources-dir': { type: 'string' },
      'verbose': { type: 'boolean', short: 'v' },
    },
    strict: true,
    allowPositionals: false,
  })
  const layout = layoutFor(values, io)
  const resourcesDir = pathValue(values['resources-dir'], io.cwd)
  const core = await AtomicCore.create({
    dataFolder: layout.root,
    ownerScope: 'cli',
    ...(resourcesDir ? { resourcesDir } : {}),
    controlPort: values['control-port'] !== undefined ? Number(values['control-port']) : 0,
    ...(values['control-host'] ? { controlHost: values['control-host'] } : {}),
    env: io.env,
    logger: (level, message) => {
      if (values.verbose || level !== 'info') io.stderr(`[${level}] ${message}\n`)
    },
  })
  // The first stdout line is the handshake; everything else goes to stderr so it stays parseable.
  io.stdout(`${JSON.stringify(core.readyLine())}\n`)
  if (values['public-port'] !== undefined) {
    await core.startPublicServer({
      port: Number(values['public-port']),
      ...(values['public-host'] ? { host: values['public-host'] } : {}),
      ...(values['api-key'] ? { apiKey: values['api-key'] } : {}),
    })
  }
  // Either a signal reaches us, or something asked the core to stop through the control API.
  await Promise.race([
    io.waitForShutdown(async () => {
      await core.shutdown()
    }),
    core.stopped,
  ])
  return 0
}

/** `serve <model>` — attach (or start a core), load the model, expose it, and report where. */
export async function serveCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'data-folder': { type: 'string' },
      'port': { type: 'string' },
      'host': { type: 'string' },
      'api-key': { type: 'string' },
      'bin': { type: 'string' },
      'model-path': { type: 'string' },
      'mmproj': { type: 'string' },
      'embedding': { type: 'boolean' },
      'timeout': { type: 'string' },
      'ctx-size': { type: 'string' },
      'n-gpu-layers': { type: 'string' },
      'fit': { type: 'boolean' },
      'threads': { type: 'string' },
      'json': { type: 'boolean' },
      'detach': { type: 'boolean', short: 'd' },
      'log': { type: 'string' },
      'verbose': { type: 'boolean', short: 'v' },
      'select': { type: 'boolean' },
      'provider': { type: 'string' },
      'resources-dir': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  const layout = layoutFor(values, io)
  const provider = serveProvider(values.provider)
  if (provider === 'mlx' || provider === 'foundation-models')
    return serveSidecar(provider, values, positionals, layout, io)
  const registry = new ModelRegistry(layout, LOCAL_PROVIDER)
  const modelPath = pathValue(values['model-path'], io.cwd)
  const mmprojPath = pathValue(values.mmproj, io.cwd)
  const exePath = pathValue(values.bin, io.cwd)
  let modelId = await resolveServeModelId(positionals[0], modelPath, registry, io)
  if (!modelPath && !(await registry.find(modelId)) && looksLikeHfRepo(modelId)) {
    io.stderr(`Fetching GGUF files for ${modelId} from Hugging Face…\n`)
    const token = hfToken(io.env)
    const files = await fetchHfGgufFiles(modelId, {
      fetch: io.fetch,
      ...(token ? { token } : {}),
    })
    const chosen = values.select
      ? files[
          await io.select(
            'Select a quantization to download',
            files.map((file) => `${file.filename}  ${formatBytes(file.size)}`)
          )
        ]
      : chooseDefaultHfFile(files)
    if (!chosen) throw new Error('No Hugging Face file was selected.')
    io.stderr(`Downloading ${chosen.filename} (${formatBytes(chosen.size)})…\n`)
    modelId = await downloadHfModel({
      layout,
      registry,
      repoId: modelId,
      file: chosen,
      fetch: io.fetch,
      env: io.env,
      emit: (name, payload) => {
        if (name === 'download:progress' && (payload as { percent?: number }).percent === 100)
          io.stderr(`Downloaded ${modelId}.\n`)
      },
    })
  }

  const port = integerOption(values.port, DEFAULT_SERVE_PORT, '--port', 0, 65_535)
  const timeoutSecs = integerOption(
    values.timeout,
    DEFAULT_SERVE_TIMEOUT_SECS,
    '--timeout',
    1,
    Number.MAX_SAFE_INTEGER
  )
  const gpuLayers = integerOption(
    values['n-gpu-layers'],
    DEFAULT_SERVE_GPU_LAYERS,
    '--n-gpu-layers',
    -1,
    Number.MAX_SAFE_INTEGER
  )
  const ctxSize = values.fit
    ? 0
    : integerOption(values['ctx-size'], DEFAULT_SERVE_CTX_SIZE, '--ctx-size', 0, Number.MAX_SAFE_INTEGER)
  const threads = integerOption(values.threads, 0, '--threads', 0, Number.MAX_SAFE_INTEGER)
  const logPath = values.log
    ? pathValue(values.log, io.cwd)
    : values.detach
      ? join(layout.core.logsDir, 'serve.log')
      : undefined

  return withAttachedOwner(serveAttachOptions(layout, io), async ({ client }) => {
    const overrides: Record<string, unknown> = {
      ctx_size: ctxSize,
      n_gpu_layers: gpuLayers,
      fit: values.fit === true,
      threads,
      timeout: timeoutSecs,
    }

    const verbose = values.verbose === true
    const eventAbort = new AbortController()
    const eventReady = verbose ? subscribeToLogs(client, io, eventAbort.signal) : undefined
    if (eventReady) await eventReady

    let session
    let state
    try {
      // Claim/validate the public configuration before auto-unload can mutate sessions. An
      // incompatible running listener must reject this command while its current model stays live.
      state = await client.startServer({
        port,
        ...(values.host ? { host: values.host } : {}),
        ...(values['api-key'] ? { api_key: values['api-key'] } : {}),
      })
      session = await client.loadModel(LOCAL_PROVIDER, modelId, {
        isEmbedding: values.embedding === true,
        ...(exePath
          ? { exePath, versionBackend: versionBackendFromBinPath(exePath) ?? 'cli/llama-server' }
          : {}),
        ...(modelPath ? { modelPath } : {}),
        ...(mmprojPath ? { mmprojPath } : {}),
        timeoutSecs,
        ...(logPath ? { logPath } : {}),
        verbose,
        overrides,
      })
    } finally {
      eventAbort.abort()
    }
    if (values.json) {
      io.stdout(`${JSON.stringify({ session, server: state }, null, 2)}\n`)
    } else {
      io.stdout(`\n  ${modelId} is serving at ${apiUrl(state)}\n`)
      io.stdout(`  model process pid ${session.pid}, port ${session.port}\n`)
      if (state.requires_api_key) io.stdout('  clients must send the API key you configured\n')
      io.stdout('\n  The core keeps running after this command exits; stop it with `shutdown`.\n\n')
    }
    return 0
  })
}

const SERVE_PROVIDERS: readonly LocalProviderId[] = ['llamacpp-upstream', 'mlx', 'foundation-models']

function serveProvider(value: unknown): LocalProviderId {
  if (value === undefined) return LOCAL_PROVIDER
  if (SERVE_PROVIDERS.includes(value as LocalProviderId)) return value as LocalProviderId
  throw new AtomicCoreError(
    'INVALID_ARGUMENT',
    `--provider must be one of: ${SERVE_PROVIDERS.join(', ')}.`,
    String(value)
  )
}

const SIDECARS = {
  'mlx': { binary: MLX_SERVER_BINARY, name: 'MLX', timeoutSecs: MLX_DEFAULT_TIMEOUT_SECS },
  'foundation-models': {
    binary: FOUNDATION_MODELS_BINARY,
    name: 'Foundation Models',
    timeoutSecs: FOUNDATION_MODELS_STARTUP_TIMEOUT_SECS,
  },
} as const

/**
 * `serve --provider mlx|foundation-models`. Both servers ship with the desktop app, not with the
 * CLI, so a standalone CLI must be told where they are. MLX models are the ones the app installed
 * under `mlx/models`; Foundation Models has the one on-device model.
 */
async function serveSidecar(
  provider: 'mlx' | 'foundation-models',
  values: Record<string, unknown>,
  positionals: string[],
  layout: DataLayout,
  io: CliIo
): Promise<number> {
  const sidecar = SIDECARS[provider]
  const modelId =
    provider === 'foundation-models'
      ? positionals[0]?.trim() || APPLE_MODEL_ID
      : await resolveServeModelId(positionals[0], undefined, new ModelRegistry(layout, 'mlx'), io)
  const resourcesDir = pathValue(values['resources-dir'], io.cwd)
  const exePath =
    pathValue(values['bin'], io.cwd) ?? (resourcesDir ? join(resourcesDir, sidecar.binary) : undefined)
  if (!exePath)
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `${sidecar.name} needs --resources-dir <folder with ${sidecar.binary}> or --bin <server>.`
    )
  const port = integerOption(values['port'], DEFAULT_SERVE_PORT, '--port', 0, 65_535)
  const timeoutSecs = integerOption(
    values['timeout'],
    sidecar.timeoutSecs,
    '--timeout',
    1,
    Number.MAX_SAFE_INTEGER
  )
  const ctxSize =
    values['ctx-size'] !== undefined
      ? integerOption(values['ctx-size'], 0, '--ctx-size', 1, Number.MAX_SAFE_INTEGER)
      : undefined
  const logPath = values['log'] ? pathValue(values['log'], io.cwd) : undefined
  return withAttachedOwner(serveAttachOptions(layout, io), async ({ client }) => {
    const state = await client.startServer({
      port,
      ...(typeof values['host'] === 'string' ? { host: values['host'] } : {}),
      ...(typeof values['api-key'] === 'string' ? { api_key: values['api-key'] } : {}),
    })
    const session = await client.loadModel(provider, modelId, {
      exePath,
      timeoutSecs,
      isEmbedding: values['embedding'] === true,
      ...(ctxSize !== undefined ? { overrides: { ctx_size: ctxSize } } : {}),
      ...(logPath ? { logPath } : {}),
      verbose: values['verbose'] === true,
    })
    if (values['json']) io.stdout(`${JSON.stringify({ session, server: state }, null, 2)}\n`)
    else if (provider === 'mlx') {
      io.stdout(`\n  ${modelId} is serving at ${apiUrl(state)}\n`)
      io.stdout(`  model process pid ${session.pid}, port ${session.port}\n\n`)
    } else {
      io.stdout(`\n  ${modelId} is running on port ${session.port} (pid ${session.pid})\n`)
      io.stdout('  The public API does not route to Foundation Models; talk to that port directly.\n\n')
    }
    return 0
  })
}

/** How `serve` reaches its owner: start one when none runs, and say on stderr what went wrong. */
export function serveAttachOptions(layout: DataLayout, io: CliIo) {
  return {
    layout,
    clientName: 'atomic-chat-core serve',
    launch: true,
    log: (message: string) => io.stderr(`${message}\n`),
  }
}

async function resolveServeModelId(
  positional: string | undefined,
  modelPath: string | undefined,
  registry: ModelRegistry,
  io: CliIo
): Promise<string> {
  if (positional?.trim()) return positional.trim()
  if (modelPath) return basename(modelPath, extname(modelPath)) || 'model'
  const models = await registry.listChatModels()
  if (models.length === 0) {
    throw new Error('No chat models are installed. Pass --model-path or a Hugging Face owner/repository id.')
  }
  if (models.length === 1) {
    io.stderr(`Using model ${models[0]?.id}.\n`)
    return models[0]?.id as string
  }
  const index = await io.select(
    'Choose a model',
    models.map((model) => `${model.id}  ${formatBytes(model.yml.size_bytes)}`)
  )
  return (models[index] as ModelEntry).id
}

function pathValue(value: unknown, cwd: string): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function integerOption(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  return parsed
}

async function subscribeToLogs(client: CoreClient, io: CliIo, signal: AbortSignal): Promise<void> {
  let resolveOpen: (() => void) | undefined
  let rejectOpen: ((error: unknown) => void) | undefined
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  void client
    .events(
      (message) => {
        if (message.event !== 'core:log') return
        const payload = message.data as { msg?: unknown }
        if (typeof payload.msg === 'string') io.stderr(`${payload.msg}\n`)
      },
      { signal, onOpen: () => resolveOpen?.() }
    )
    .catch((error: unknown) => {
      if (!signal.aborted) rejectOpen?.(error)
    })
  return opened
}

/** `server status` — is a local API server reachable, and what does it serve? */
export async function serverCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'data-folder': { type: 'string' },
      'host': { type: 'string' },
      'port': { type: 'string' },
      'prefix': { type: 'string' },
      'api-key': { type: 'string' },
      'json': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const sub = positionals[0] ?? 'status'
  if (sub !== 'status') {
    io.stderr(`Unknown server subcommand: ${sub}\n`)
    return 2
  }
  const layout = layoutFor(values, io)
  const state = await readServerState(layout, values, io)
  const apiKey = values['api-key'] ?? io.env['ATOMIC_API_KEY'] ?? ''
  const reachable = await probe(state, io)
  const models = reachable ? await fetchModels(state, apiKey, io) : { error: 'server not reachable' }

  if (values.json) {
    io.stdout(
      `${JSON.stringify(
        {
          running: reachable,
          url: apiUrl(state),
          host: state.host,
          port: state.port,
          prefix: state.prefix,
          requires_api_key: state.requires_api_key,
          models: 'models' in models ? models.models : null,
          models_error: 'error' in models ? models.error : null,
        },
        null,
        2
      )}\n`
    )
  } else if (reachable) {
    io.stdout(`\n  ● Local API Server is running\n`)
    io.stdout(`  Endpoint  ${apiUrl(state)}\n`)
    if ('models' in models)
      io.stdout(`  Models    ${models.models.length ? models.models.join(', ') : 'none loaded'}\n`)
    else io.stdout(`  Models    ${models.error}\n`)
    io.stdout('\n')
  } else {
    io.stdout(`\n  ○ No Local API Server at ${apiUrl(state)}\n\n`)
  }
  return reachable ? 0 : 1
}

/** `shutdown` — stop the core that owns this folder. */
export async function shutdownCommand(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { 'data-folder': { type: 'string' }, 'force': { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  })
  const layout = layoutFor(values, io)
  let stopped = false
  try {
    await withAttachedOwner(
      { layout, clientName: 'atomic-chat-core shutdown' },
      async ({ client }, clientId) => {
        await client.shutdown({ force: values.force === true, client_id: clientId })
        stopped = true
      }
    )
  } catch (e) {
    if ((e as AtomicCoreError).code === 'CORE_NOT_RUNNING') {
      io.stdout('No core is running for this data folder.\n')
      return 0
    }
    throw e
  }
  if (stopped) io.stdout('Core is stopping.\n')
  return 0
}

async function readServerState(
  layout: DataLayout,
  values: Record<string, unknown>,
  io: CliIo
): Promise<LocalApiServerState> {
  // Prefer the running core's own state; fall back to the app's state file, then to defaults.
  let state: LocalApiServerState = {
    running: false,
    host: '127.0.0.1',
    port: 1337,
    prefix: '/v1',
    requires_api_key: false,
    pid: null,
  }
  try {
    state = await withAttachedOwner({ layout, clientName: 'atomic-chat-core server status' }, ({ client }) =>
      client.serverStatus()
    )
  } catch {
    // A crashed core can leave a stale discovery file beside a live legacy app state. Parse both
    // and prefer the first endpoint that actually answers instead of letting file age decide.
    const candidates: LocalApiServerState[] = []
    for (const fromFile of [
      await io.readFile(layout.core.publicServerState),
      await io.readFile(layout.serverStateFile),
    ]) {
      if (!fromFile) continue
      try {
        const parsed = JSON.parse(fromFile) as Partial<LocalApiServerState>
        if (typeof parsed.port === 'number' && typeof parsed.host === 'string')
          candidates.push({ ...state, ...parsed, pid: parsed.pid ?? null })
      } catch {
        /* a malformed state file means "unknown", not "crash" */
      }
    }
    state = candidates[0] ?? state
    for (const candidate of candidates) {
      if (await probe(candidate, io)) {
        state = candidate
        break
      }
    }
  }
  if (typeof values['host'] === 'string') state.host = values['host']
  if (values['port'] !== undefined) state.port = Number(values['port'])
  if (typeof values['prefix'] === 'string') state.prefix = values['prefix']
  return state
}

export function baseUrl(state: LocalApiServerState): string {
  const host = state.host === '0.0.0.0' ? '127.0.0.1' : state.host
  return `http://${host}:${state.port}`
}

export function apiUrl(state: LocalApiServerState): string {
  return `${baseUrl(state)}${state.prefix}`
}

async function probe(state: LocalApiServerState, io: CliIo): Promise<boolean> {
  const res = await io
    .fetch(`${baseUrl(state)}/`, { signal: AbortSignal.timeout(3000) })
    .catch(() => undefined)
  return res !== undefined && res.ok
}

async function fetchModels(
  state: LocalApiServerState,
  apiKey: string,
  io: CliIo
): Promise<{ models: string[] } | { error: string }> {
  const res = await io
    .fetch(`${apiUrl(state)}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    .catch((e: Error) => e)
  if (res instanceof Error) return { error: res.message }
  if (res.status === 401)
    return { error: 'server requires an API key — pass --api-key or set ATOMIC_API_KEY' }
  if (!res.ok) return { error: `server returned ${res.status}` }
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> }
  return { models: (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean) }
}
