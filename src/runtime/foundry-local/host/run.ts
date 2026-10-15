/**
 * The hidden `foundry-host` mode of the core binaries (openspec change `add-foundry-local`, design D1):
 * one process per model or command, so a crash of Microsoft's native library never takes the core
 * down. Core starts it with `process.execPath`; nothing else should.
 *
 * Exit codes: 0 done; 2 usage (a bug on core's side); 3 the library does not load or speaks another
 * C API; 4 a library call failed. Errors go to stderr as one line each; stdout carries JSON lines only.
 */

import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FoundryHostUsageError, parseFoundryHostArgs } from './args.js'
import type { FoundryHostArgs } from './args.js'
import { describeDiscoverable } from './execution-providers.js'
import { FoundryLibraryError } from './library.js'
import type { FoundryLibrary, FoundryManager, LoadFoundryLibrary } from './library.js'

export interface FoundryHostDeps {
  stdout: (line: string) => void
  stderr: (line: string) => void
  loadLibrary: LoadFoundryLibrary
  /**
   * What the library's log gained since the previous call (the first call: since the host started).
   * The C API reports no per-accelerator failure (spike finding 11); its log does.
   */
  readLogTail?: (logsDir: string) => Promise<string>
}

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
export function failureReason(log: string, name: string): string | null {
  const family = name.replace(/ExecutionProvider$/, '').toLowerCase()
  const lines = log
    .split(/\r?\n/)
    .filter((line) => /\[(warning|error)\]/i.test(line))
    .filter((line) => !/Failed to download or register EP/i.test(line))
    .filter((line) => line.includes(name) || line.toLowerCase().includes(family))
  const last = lines.at(-1)
  return last ? last.replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*/, '').trim() : null
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
      `foundry-host runs inside the compiled atomic-chat-core binaries only (${error instanceof Error ? error.message : String(error)})`
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
        manager.downloadAndRegisterEps([name], (_label, percent) =>
          deps.stdout(json({ accelerator: name, stage: 'downloading', fraction: Math.min(1, percent / 100) }))
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
          thrown ?? failureReason(await readLog(args.logs), name) ?? `Foundry Local did not register ${name}.`
        deps.stdout(json({ accelerator: name, stage: 'failed', fraction: null, reason }))
        summary.push({ name, prepared: false, reason })
      }
    }
    deps.stdout(json({ done: true, accelerators: summary }))
  } finally {
    close(manager)
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
    else {
      deps.stderr(`foundry-host ${args.mode} is not implemented yet`)
      return 2
    }
    return 0
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 4
  }
}
