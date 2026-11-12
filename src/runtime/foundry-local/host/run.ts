/**
 * The hidden `foundry-host` mode of the core binaries (openspec change `add-foundry-local`, design D1):
 * one process per model or command, so a crash of Microsoft's native library never takes the core
 * down. Core starts it with `process.execPath`; nothing else should.
 *
 * Exit codes: 0 done; 2 usage (a bug on core's side); 3 the library does not load or speaks another
 * C API; 4 a library call failed. Errors go to stderr as one line each; stdout carries JSON lines only.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { compareVersions } from '../../../backend/index.js'
import { FoundryHostUsageError, parseFoundryHostArgs } from './args.js'
import type { FoundryHostArgs } from './args.js'
import { describeDiscoverable, executionProvider } from './execution-providers.js'
import { FoundryLibraryError } from './library.js'
import type { FoundryLibrary, FoundryManager, LoadFoundryLibrary } from './library.js'
import { repairFoundryToolTemplate } from './tool-template.js'

export interface FoundryHostDeps {
  stdout: (line: string) => void
  stderr: (line: string) => void
  loadLibrary: LoadFoundryLibrary
  /**
   * What the library's log gained since the previous call (the first call: since the host started).
   * The C API reports no per-accelerator failure (spike finding 11); its log does.
   */
  readLogTail?: (logsDir: string) => Promise<string>
  /**
   * Starts watching for core's stop: SIGTERM, SIGINT or stdin closed (Windows has no SIGTERM). Made
   * before the model loads, so a stop sent right after the readiness line is never missed.
   */
  watchStop?: () => StopWatch
  /** Deletes the host's catalog cache at exit. */
  removeDir?: (path: string) => Promise<void>
}

export interface StopWatch {
  stopped: Promise<void>
  /** Let go of the signals and of stdin, so nothing keeps the process alive after the host is done. */
  dispose(): void
}

/** SIGTERM, SIGINT or the end of stdin, whichever comes first. */
export function watchStopSignals(): StopWatch {
  let resolve: () => void = () => {}
  const stopped = new Promise<void>((done) => (resolve = done))
  const stop = () => resolve()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stdin.on('end', stop)
  process.stdin.on('close', stop)
  process.stdin.resume()
  return {
    stopped,
    dispose() {
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
      process.stdin.off('end', stop)
      process.stdin.off('close', stop)
      process.stdin.pause()
      process.stdin.destroy()
    },
  }
}

/** Where the built-in server serves models registered in the local catalog (spike finding 7). */
export const LOCAL_CATALOG_BASE_PATH = '/catalogs/local'

/** Reads what `foundry_local_<date>.log` files under `logsDir` gained since the reader was made. */
export function logTailReader(): (logsDir: string) => Promise<string> {
  const offsets = new Map<string, number>()
  let primed = false
  const files = async (dir: string) =>
    (await readdir(dir).catch(() => [] as string[])).filter((name) => /^foundry_local.*\.log$/.test(name))
  return async (logsDir) => {
    if (!primed) {
      primed = true
      for (const name of await files(logsDir))
        offsets.set(name, (await stat(join(logsDir, name)).catch(() => ({ size: 0 }))).size)
    }
    let text = ''
    for (const name of await files(logsDir)) {
      const path = join(logsDir, name)
      const size = (await stat(path).catch(() => ({ size: 0 }))).size
      const from = Math.min(offsets.get(name) ?? 0, size)
      if (size > from) {
        const handle = await open(path, 'r')
        try {
          const buffer = Buffer.alloc(Math.min(size - from, 256 * 1024))
          await handle.read(buffer, 0, buffer.length, size - buffer.length)
          text += buffer.toString('utf8')
        } finally {
          await handle.close()
        }
      }
      offsets.set(name, size)
    }
    return text
  }
}

/**
 * The library's own words for why `name` was not registered: the last warning or error that names the
 * accelerator or its family (`cuda` for `CUDAExecutionProvider`), not the generic summary line.
 */
export function failureReason(log: string, name: string, cudaMajor: 12 | 13 = 12): string | null {
  const family = name.replace(/ExecutionProvider$/, '').toLowerCase()
  const lines = log
    .split(/\r?\n/)
    .filter((line) => /\[(warning|error)\]/i.test(line))
    .filter((line) => !/Failed to download or register EP/i.test(line))
    .filter((line) => line.includes(name) || line.toLowerCase().includes(family))
  const last = lines.at(-1)
  if (!last) return null
  const blocked = /failed to load '([^']+)' \(4551\)/.exec(last)
  if (blocked) return appControlBlocked(blocked[1] ?? '', family)
  const detail = last.replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*/, '').trim()
  if (family === 'cuda' && /\.dll['"]?\s*\(126\)/i.test(last))
    return `CUDA could not load a required DLL. Install CUDA ${cudaMajor} and cuDNN 9 for CUDA ${cudaMajor}, make their bin directories available through CUDA_PATH, CUDNN_PATH or PATH, then retry preparation. ${detail}`
  return detail
}

/**
 * Windows' 4551 (`ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION`): Smart App Control or an organization's
 * app control policy refused a library without a signature. Microsoft's CUDA bundle ships
 * `onnxruntime-genai-cuda.dll` unsigned, so on a laptop with Smart App Control on the whole bundle
 * downloads and then cannot load. The person can act on this, not on the path and the code.
 */
const ACCELERATOR_LABELS: Record<string, string> = {
  cuda: 'CUDA',
  webgpu: 'WebGPU',
  openvino: 'OpenVINO',
  nvtensorrtrtx: 'TensorRT-RTX',
  qnn: 'QNN',
}

function appControlBlocked(path: string, family: string): string {
  const file = path.split(/[\\/]/).at(-1) || 'a library'
  const accelerator = ACCELERATOR_LABELS[family] ?? family
  return (
    `Windows blocked ${file}, a library of Microsoft's ${accelerator} accelerator that has no digital signature: ` +
    "Smart App Control or your organization's app control policy does not let unsigned libraries load. " +
    `To use ${accelerator}, turn Smart App Control off in Windows Security → App & browser control → ` +
    'Smart App Control settings (Windows cannot turn it back on without a reset), or on a managed PC ask your ' +
    'administrator to allow it; then press Retry. Models on WebGPU and CPU run without it.'
  )
}

/** Line-oriented output over a stream-oriented CLI io: one JSON or error line per call. */
export function lineIo(io: {
  stdout: (text: string) => void
  stderr: (text: string) => void
}): Pick<FoundryHostDeps, 'stdout' | 'stderr'> {
  return { stdout: (line) => io.stdout(`${line}\n`), stderr: (line) => io.stderr(`${line}\n`) }
}

/** The name the library reports itself under (telemetry, logs). */
export const FOUNDRY_HOST_APP_NAME = 'atomic-chat'

const json = (value: unknown): string => JSON.stringify(value)

/** `<build>/lib` when the build has one (release archives do), else the folder itself. */
export function libraryDir(build: string, exists: (path: string) => boolean = existsSync): string {
  return exists(join(build, 'lib')) ? join(build, 'lib') : build
}

/** Opens the library through `bun:ffi`; under Node this mode cannot run, and says so. */
export const loadLibraryWithBun: LoadFoundryLibrary = async (libDir) => {
  let module: { loadBunFoundryLibrary: LoadFoundryLibrary }
  try {
    module = await import('./ffi-bun.js')
  } catch (error) {
    throw new FoundryLibraryError(
      'load',
      0,
      `foundry-host runs only inside a compiled binary (${error instanceof Error ? error.message : String(error)})`
    )
  }
  return module.loadBunFoundryLibrary(libDir)
}

function openManager(
  library: FoundryLibrary,
  args: FoundryHostArgs,
  extra: { cache: string; endpoints: string[] }
) {
  return library.createManager({
    appName: FOUNDRY_HOST_APP_NAME,
    appDataDir: args.appData,
    logsDir: args.logs,
    modelCacheDir: extra.cache,
    webServiceEndpoints: extra.endpoints,
    // Design D8: the optional telemetry off; `ProcessInfo` still goes, and is disclosed.
    additionalOptions: { DisableNonessentialTelemetry: 'true' },
    allowEpDownloads: args.mode === 'prepare',
  })
}

function close(manager: FoundryManager): void {
  try {
    manager.shutdown()
  } finally {
    manager.release()
  }
}

async function probe(
  library: FoundryLibrary,
  args: Extract<FoundryHostArgs, { mode: 'probe' }>,
  deps: FoundryHostDeps
) {
  const manager = openManager(library, args, { cache: join(args.appData, 'cache'), endpoints: [] })
  try {
    const accelerators = manager.discoverableEps().map((ep) => ({
      name: ep.name,
      ...describeDiscoverable(ep.name),
      prepared: args.prepared.includes(ep.name),
    }))
    deps.stdout(json({ c_api_version: library.cApiVersion, version: library.version, accelerators }))
  } finally {
    close(manager)
  }
}

interface PrepareSummary {
  name: string
  prepared: boolean
  reason?: string
}

/**
 * The accelerators the library downloads from Microsoft's CDN and reports on the calling thread,
 * synchronously (spike findings 2, 15). Every other one comes through Windows ML, which reported
 * nothing on a machine that already had it (finding 16) and, on a first install on a Core Ultra
 * laptop, called back from a thread of its own; it gets no callback and reports a start and an end.
 */
const CDN_ACCELERATORS = new Set([
  'CUDAExecutionProvider',
  'WebGpuExecutionProvider',
  'WebGPUExecutionProvider',
])

/**
 * Task 5.2: each accelerator on its own `Manager_DownloadAndRegisterEps` call, so one failure never
 * cancels the others and each gets its own reason. Lines: `{accelerator, stage, fraction}` with
 * `stage` started → downloading* → done | failed; Windows ML accelerators report no downloading lines
 * at all (spike finding 16), and a failed one has `fraction: null` (rulings R6). Last line: the summary.
 */
async function prepare(
  library: FoundryLibrary,
  args: Extract<FoundryHostArgs, { mode: 'prepare' }>,
  deps: FoundryHostDeps
) {
  const readLog = deps.readLogTail ?? logTailReader()
  await readLog(args.logs)
  const manager = openManager(library, args, { cache: join(args.appData, 'cache'), endpoints: [] })
  const summary: PrepareSummary[] = []
  const cudaMajor = basename(args.lib) === 'win-arm64' ? 13 : 12
  try {
    const offered = manager.discoverableEps().map((ep) => ep.name)
    const wanted = args.accelerators.length > 0 ? args.accelerators : offered
    for (const name of wanted) {
      if (!offered.includes(name)) {
        summary.push({ name, prepared: false, reason: `This computer does not offer ${name}.` })
        continue
      }
      deps.stdout(json({ accelerator: name, stage: 'started', fraction: 0 }))
      let thrown: string | null = null
      try {
        // The callback goes only where the library calls it on this thread: Windows ML reported a first
        // install from a thread of its own, and Bun's plain callback called there failed the prepare.
        await manager.downloadAndRegisterEps(
          [name],
          CDN_ACCELERATORS.has(name)
            ? (_label, percent) =>
                deps.stdout(
                  json({ accelerator: name, stage: 'downloading', fraction: Math.min(1, percent / 100) })
                )
            : undefined
        )
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error)
      }
      const registered = manager.discoverableEps().some((ep) => ep.name === name && ep.registered)
      if (registered) {
        deps.stdout(json({ accelerator: name, stage: 'done', fraction: 1 }))
        summary.push({ name, prepared: true })
      } else {
        const reason =
          thrown ??
          failureReason(await readLog(args.logs), name, cudaMajor) ??
          `Foundry Local did not register ${name}.`
        deps.stdout(json({ accelerator: name, stage: 'failed', fraction: null, reason }))
        summary.push({ name, prepared: false, reason })
      }
    }
    deps.stdout(json({ done: true, accelerators: summary }))
  } finally {
    close(manager)
  }
}

type BoundaryMarkers = readonly [start: string, end: string]

const QWEN_TOOL_MARKERS = ['<tool_call>', '</tool_call>'] as const
const PHI_TOOL_MARKERS = ['<|tool_call|>', '<|/tool_call|>'] as const
const MISTRAL_TOOL_MARKERS = ['[TOOL_CALLS]', '</s>'] as const
const GEMMA_TOOL_MARKERS = ['<|tool_call>', '<tool_call|>'] as const
const GEMMA_REASONING_MARKERS = ['<|channel>', '<channel|>'] as const

// Microsoft catalog markers for installed revisions whose model.yml predates marker storage.
const LEGACY_TOOL_MARKERS = new Map<string, readonly BoundaryMarkers[]>([
  ['qwen3_5', [QWEN_TOOL_MARKERS]],
  ['qwen3_5_text', [QWEN_TOOL_MARKERS]],
  ['qwen3_vl', [QWEN_TOOL_MARKERS]],
  ['smollm3', [QWEN_TOOL_MARKERS]],
  ['mistral', [MISTRAL_TOOL_MARKERS]],
  ['mistral3', [MISTRAL_TOOL_MARKERS]],
  ['gemma4', [GEMMA_TOOL_MARKERS]],
  ['olmo', [['<function_calls>', '</function_calls>']]],
  ['decoder-pipeline', [QWEN_TOOL_MARKERS, PHI_TOOL_MARKERS]],
])

// GenAI 0.19 already publishes these token IDs without explicit model config.
const GENAI_TOOL_MARKERS = new Map<string, BoundaryMarkers>([
  ['qwen2', QWEN_TOOL_MARKERS],
  ['qwen3', QWEN_TOOL_MARKERS],
  ['phi3', PHI_TOOL_MARKERS],
])

interface AddedToken {
  content: string
  id: number
  special?: boolean
}

function sameMarkers(a: BoundaryMarkers, b: BoundaryMarkers | undefined): boolean {
  return a[0] === b?.[0] && a[1] === b?.[1]
}

function markers(start: string | undefined, end: string | undefined): BoundaryMarkers | undefined {
  return start && end && start !== end ? [start, end] : undefined
}

async function replaceModelFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.atomic-${randomUUID()}.tmp`
  try {
    const { mode } = await stat(path)
    await writeFile(temporary, contents, { flag: 'wx', mode })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Publish the model's own single-token boundaries before the native runtime loads it. */
async function publishModelBoundaries(
  args: Extract<FoundryHostArgs, { mode: 'serve' }>,
  reasoning: BoundaryMarkers | undefined
): Promise<BoundaryMarkers | undefined> {
  const configPath = join(args.model, 'genai_config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { model?: Record<string, unknown> }
  const model = config.model
  if (typeof model?.type !== 'string') return reasoning

  if (model.type === 'gemma4' || model.type === 'mistral' || model.type === 'smollm3') {
    const path = join(args.model, 'chat_template.jinja')
    const template = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (template !== undefined) {
      const repaired = repairFoundryToolTemplate(model.type, template)
      if (repaired !== template) await replaceModelFile(path, repaired)
    }
  }

  const explicitTools = markers(args.toolCallStart, args.toolCallEnd)
  const hasToolIds = model.bot_token_id !== undefined && model.eot_token_id !== undefined
  const builtinTools = GENAI_TOOL_MARKERS.get(model.type)
  const hasReasoningIds = model.bor_token_id !== undefined && model.eor_token_id !== undefined
  const gemma = model.type === 'gemma4'
  const normalizeGemmaReasoning =
    gemma && reasoning?.[0] === '<|channel>thought\\n' && reasoning[1] === '<|channel|>'
  const toolCandidates = explicitTools ? [explicitTools] : (LEGACY_TOOL_MARKERS.get(model.type) ?? [])
  const needToolIds = !hasToolIds && toolCandidates.some((pair) => !sameMarkers(pair, builtinTools))
  const needReasoningIds =
    reasoning &&
    !hasReasoningIds &&
    !(model.type === 'qwen3' && sameMarkers(reasoning, ['<think>', '</think>']))
  if (!needToolIds && !needReasoningIds && !gemma) return reasoning

  // Current catalog assets are flat. Leave packages that declare a separate tokenizer to GenAI.
  if (model.tokenizer_dir) return reasoning
  const tokenizerPath = join(args.model, 'tokenizer.json')
  const tokenizer = JSON.parse(await readFile(tokenizerPath, 'utf8')) as { added_tokens?: AddedToken[] }
  if (!Array.isArray(tokenizer.added_tokens)) return reasoning
  const tokens = new Map(tokenizer.added_tokens.map((token) => [token.content, token]))
  const resolvePair = ([start, end]: BoundaryMarkers) => {
    const a = tokens.get(start)
    const b = tokens.get(end)
    const valid = (token: AddedToken | undefined): token is AddedToken =>
      token !== undefined && Number.isInteger(token.id) && token.id >= 0 && token.id <= 0x7fffffff
    return valid(a) && valid(b) && a.id !== b.id ? ([a, b] as const) : undefined
  }
  const validTools = toolCandidates.map(resolvePair).filter((pair) => pair !== undefined)
  let configChanged = false
  let tokenizerChanged = false
  const publish = (pair: readonly [AddedToken, AddedToken], startKey: string, endKey: string) => {
    const [start, end] = pair
    if (model[startKey] !== undefined && model[startKey] !== start.id) return false
    if (model[endKey] !== undefined && model[endKey] !== end.id) return false
    if (model[startKey] === undefined || model[endKey] === undefined) {
      model[startKey] = start.id
      model[endKey] = end.id
      configChanged = true
    }
    if (gemma) {
      // ORT Extensions' SentencePiece BPE decoder always hides special added tokens.
      // Keep the model's IDs and pieces and let Foundry consume the visible boundaries.
      for (const token of pair) {
        if (token.special === true) {
          token.special = false
          tokenizerChanged = true
        }
      }
    }
    return true
  }
  if ((needToolIds || gemma) && validTools.length === 1 && validTools[0]) {
    publish(validTools[0], 'bot_token_id', 'eot_token_id')
  }
  const reasoningCandidate = normalizeGemmaReasoning ? GEMMA_REASONING_MARKERS : reasoning
  if (reasoningCandidate && (needReasoningIds || gemma)) {
    const pair = resolvePair(reasoningCandidate)
    if (pair && publish(pair, 'bor_token_id', 'eor_token_id')) reasoning = reasoningCandidate
  }

  if (tokenizerChanged) await replaceModelFile(tokenizerPath, JSON.stringify(tokenizer) + '\n')
  if (configChanged) await replaceModelFile(configPath, JSON.stringify(config, null, 2) + '\n')
  return reasoning
}

/**
 * Task 5.3: register the variant's accelerator (prepared only — nothing is downloaded here), register
 * the folder in this host's own catalog with the accelerator named explicitly, load, start the
 * built-in server on the loopback port core chose, print the readiness line, and on stop shut the
 * library down and delete the catalog cache. Exit 5: the accelerator is not prepared.
 */
async function serve(
  library: FoundryLibrary,
  args: Extract<FoundryHostArgs, { mode: 'serve' }>,
  deps: FoundryHostDeps
): Promise<number> {
  const ep = executionProvider(args.ep)
  const removeDir = deps.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true }))
  const watch = (deps.watchStop ?? watchStopSignals)()
  const manager = openManager(library, args, {
    cache: args.cache,
    endpoints: [`http://127.0.0.1:${args.port}`],
  })
  try {
    if (ep.register) {
      await manager.downloadAndRegisterEps([ep.register])
      if (!manager.discoverableEps().some((found) => found.name === ep.register && found.registered)) {
        deps.stderr(`${ep.register} is not prepared on this computer; prepare it before loading this model.`)
        return 5
      }
    }
    let reasoning = markers(args.reasoningStart, args.reasoningEnd)
    if (args.tools && compareVersions(library.version, '2.4.0') >= 0) {
      reasoning = await publishModelBoundaries(args, reasoning).catch((error: unknown) => {
        deps.stderr(
          `Could not publish Foundry Local boundary tokens: ${error instanceof Error ? error.message : String(error)}`
        )
        return reasoning
      })
    }
    const model = manager.registerLocalModel(args.model, args.id, {
      strings: {
        task: 'chat-completion',
        execution_provider: ep.metadata,
        ...(reasoning ? { reasoning_start: reasoning[0], reasoning_end: reasoning[1] } : {}),
      },
      ints: {
        supports_tool_calling: args.tools ? 1 : 0,
        supports_reasoning: reasoning ? 1 : 0,
        ...(args.contextLength !== undefined ? { context_length: args.contextLength } : {}),
      },
    })
    model.load()
    const [url] = manager.webServiceStart()
    deps.stdout(
      json({
        ready: true,
        url: url ?? `http://127.0.0.1:${args.port}`,
        base_path: LOCAL_CATALOG_BASE_PATH,
        model_id: args.id,
        execution_provider: model.executionProvider(),
      })
    )
    await watch.stopped
    return 0
  } finally {
    try {
      close(manager)
    } finally {
      watch.dispose()
      await removeDir(args.cache).catch(() => {})
    }
  }
}

export async function runFoundryHost(argv: readonly string[], deps: FoundryHostDeps): Promise<number> {
  let args: FoundryHostArgs
  try {
    args = parseFoundryHostArgs(argv)
  } catch (error) {
    deps.stderr(error instanceof FoundryHostUsageError ? error.message : String(error))
    return 2
  }
  let library: FoundryLibrary
  try {
    library = await deps.loadLibrary(libraryDir(args.lib))
  } catch (error) {
    deps.stderr(
      `foundry_local does not load from ${args.lib}: ${error instanceof Error ? error.message : String(error)}`
    )
    return 3
  }
  try {
    if (args.mode === 'probe') await probe(library, args, deps)
    else if (args.mode === 'prepare') await prepare(library, args, deps)
    else return await serve(library, args, deps)
    return 0
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 4
  }
}
