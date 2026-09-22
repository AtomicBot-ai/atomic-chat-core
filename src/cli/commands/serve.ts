/** `serve <model>` — load a model through the owner and expose it on the public API. */

import { parseArgs } from 'node:util'
import { basename, extname, join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { LocalProviderId } from '../../contracts/index.js'
import {
  APPLE_MODEL_ID,
  FOUNDATION_MODELS_BINARY,
  FOUNDATION_MODELS_STARTUP_TIMEOUT_SECS,
} from '../../runtime/foundation-models/index.js'
import { MLX_DEFAULT_TIMEOUT_SECS, MLX_SERVER_BINARY } from '../../runtime/mlx/index.js'
import type { CoreClient } from '../../client/index.js'
import type { DataLayout } from '../../config/index.js'
import { LOCAL_PROVIDER } from '../../core/index.js'
import { versionBackendFromBinPath } from '../../backend/index.js'
import {
  chooseDefaultHfFile,
  downloadHfModel,
  fetchHfGgufFiles,
  hfToken,
  looksLikeHfRepo,
  ModelRegistry,
} from '../../models/index.js'
import type { ModelEntry } from '../../models/index.js'
import { withAttachedOwner } from '../owner.js'
import type { CliIo } from '../io.js'
import { apiUrl, formatBytes, layoutFor, pathValue } from './shared.js'
import { printFirstRunNotice } from './telemetry.js'

export const DEFAULT_SERVE_PORT = 6767
export const DEFAULT_SERVE_TIMEOUT_SECS = 120
export const DEFAULT_SERVE_GPU_LAYERS = -1
export const DEFAULT_SERVE_CTX_SIZE = 32_768

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
  await printFirstRunNotice(io, layout.core.telemetry)
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
