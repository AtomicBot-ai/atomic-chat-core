/**
 * The hidden `litert-host` mode of the core binaries (openspec change `add-litert-lm-runtime`, design
 * D1): one process per model or command, so a crash of Google's native library never takes the core
 * down. Core starts it with `process.execPath`; nothing else should.
 *
 * stdout carries JSON lines only: the probe answer, the file metadata, or `serve`'s readiness line.
 * Errors go to stderr; the ones core maps to its own codes are one JSON line `{code, …}` there.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LiteRtHostUsageError, parseLiteRtHostArgs } from './args.js'
import type { LiteRtHostArgs } from './args.js'
import { LiteRtLibraryError } from './library.js'
import type { LiteRtLibrary, LoadLiteRtLibrary } from './library.js'
import { compareVersions } from '../../../backend/index.js'
import { createLiteRtServer } from './server.js'

/** The host's exit codes; core reads 6 and 7 as its `LITERT_LM_*` codes. */
export const EXIT = {
  ok: 0,
  /** A bug on core's side. */
  usage: 2,
  /** The library does not load (or its stream shim does not compile). */
  load: 3,
  /** A library call failed: a broken file, an engine the backend cannot create, a port in use. */
  libraryCall: 4,
  requiresNewerEngine: 6,
  variantUnsupported: 7,
} as const

export interface StopWatch {
  stopped: Promise<void>
  dispose(): void
}

export interface LiteRtHostDeps {
  stdout: (line: string) => void
  stderr: (line: string) => void
  loadLibrary: LoadLiteRtLibrary
  /** SIGTERM, SIGINT or stdin closed; made before the engine, so an early stop is never missed. */
  watchStop?: () => StopWatch
}

/** SIGTERM, SIGINT or the end of stdin, whichever comes first (Windows has no SIGTERM). */
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

/** Line-oriented output over a stream-oriented CLI io. */
export function lineIo(io: {
  stdout: (text: string) => void
  stderr: (text: string) => void
}): Pick<LiteRtHostDeps, 'stdout' | 'stderr'> {
  return { stdout: (line) => io.stdout(`${line}\n`), stderr: (line) => io.stderr(`${line}\n`) }
}

/** Opens the library through `bun:ffi`; under Node this mode cannot run, and says so. */
export const loadLibraryWithBun: LoadLiteRtLibrary = async (libDir, options) => {
  let module: { loadBunLiteRtLibrary: LoadLiteRtLibrary }
  try {
    module = await import('./ffi-bun.js')
  } catch (error) {
    throw new LiteRtLibraryError(
      'load',
      `litert-host runs only inside a compiled binary (${error instanceof Error ? error.message : String(error)})`
    )
  }
  return module.loadBunLiteRtLibrary(libDir, options)
}

/** Where a build keeps the library: `<build>/lib` (task 4.2). */
export function libraryDir(build: string): string {
  return join(build, 'lib')
}

const json = (value: unknown): string => JSON.stringify(value)

/** Runs `litert-host <argv…>` and returns its exit code. */
export async function runLiteRtHost(argv: readonly string[], deps: LiteRtHostDeps): Promise<number> {
  let args: LiteRtHostArgs
  try {
    args = parseLiteRtHostArgs(argv)
  } catch (error) {
    deps.stderr(error instanceof LiteRtHostUsageError ? error.message : String(error))
    return EXIT.usage
  }
  let library: LiteRtLibrary
  try {
    library = await deps.loadLibrary(
      libraryDir(args.lib),
      args.mode === 'serve' && args.ovLibs ? { ovLibsDir: args.ovLibs } : undefined
    )
  } catch (error) {
    deps.stderr(
      `LiteRT-LM does not load from ${args.lib}: ${error instanceof Error ? error.message : String(error)}`
    )
    return EXIT.load
  }
  try {
    if (args.mode === 'probe') {
      deps.stdout(json({ version: library.version, abi: library.abi, backends: library.backends }))
      return EXIT.ok
    }
    if (args.mode === 'inspect') {
      deps.stdout(json(library.inspect(args.file)))
      return EXIT.ok
    }
    return await serve(library, args, deps)
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return EXIT.libraryCall
  }
}

async function serve(
  library: LiteRtLibrary,
  args: Extract<LiteRtHostArgs, { mode: 'serve' }>,
  deps: LiteRtHostDeps
): Promise<number> {
  const watch = (deps.watchStop ?? watchStopSignals)()
  try {
    const info = library.inspect(args.model)
    if (info.min_runtime_version && compareVersions(info.min_runtime_version, args.engineVersion) > 0) {
      deps.stderr(
        json({
          code: 'LITERT_LM_MODEL_REQUIRES_NEWER_ENGINE',
          required: info.min_runtime_version,
          engine: args.engineVersion,
        })
      )
      return EXIT.requiresNewerEngine
    }
    if (!info.backends.includes(args.backend)) {
      deps.stderr(
        json({
          code: 'LITERT_LM_VARIANT_UNSUPPORTED',
          backend: args.backend,
          backends: info.backends,
          message: `This file runs on ${info.backends.join(', ') || 'no backend'}, not ${args.backend}.`,
        })
      )
      return EXIT.variantUnsupported
    }
    await mkdir(args.cache, { recursive: true })
    const maxNumTokens = Math.min(args.maxTokens, info.max_context_tokens ?? args.maxTokens)
    const visionBackend = info.modalities.includes('vision') ? (info.vision_backends[0] ?? null) : null
    const speculative = args.speculative && info.speculative_decoding
    const engine = library.createEngine({
      model: args.model,
      backend: args.backend,
      visionBackend,
      maxNumTokens,
      cacheDir: args.cache,
      ...(args.dispatch ? { dispatchLibDir: args.dispatch } : {}),
      speculative,
    })
    const server = createLiteRtServer({
      engine,
      modelId: args.id,
      caps: { vision: visionBackend !== null, reasoning: args.reasoning },
      log: (line) => deps.stderr(line),
    })
    try {
      const url = await server.listen(args.port)
      deps.stdout(
        json({
          ready: true,
          url,
          model_id: args.id,
          backend: args.backend,
          max_num_tokens: maxNumTokens,
          vision: visionBackend !== null,
          speculative,
        })
      )
      await watch.stopped
      return EXIT.ok
    } finally {
      await server.close()
      engine.close()
    }
  } finally {
    watch.dispose()
  }
}
