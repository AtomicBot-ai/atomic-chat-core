/**
 * The hidden `foundry-host` mode of the core binaries (openspec change `add-foundry-local`, design D1):
 * one process per model or command, so a crash of Microsoft's native library never takes the core
 * down. Core starts it with `process.execPath`; nothing else should.
 *
 * Exit codes: 0 done; 2 usage (a bug on core's side); 3 the library does not load or speaks another
 * C API; 4 a library call failed. Errors go to stderr as one line each; stdout carries JSON lines only.
 */

import { existsSync } from 'node:fs'
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
