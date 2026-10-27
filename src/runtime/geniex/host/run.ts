/**
 * The hidden `geniex-host` mode of the core binaries (openspec change `add-geniex-runtime`, design
 * D1): one process per model or command, so a crash of Qualcomm's native library never takes the
 * core down. Core starts it with `process.execPath`; nothing else should. The library runs in a
 * Worker (`engine.ts`); this thread keeps the HTTP server and the queue.
 *
 * stdout carries JSON lines only: the probe answer, the model metadata, or `serve`'s readiness line.
 * Errors go to stderr; the ones core maps to its own codes are one JSON line `{code, …}` there.
 */

import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compareVersions } from '../../../backend/index.js'
import { GeniexHostUsageError, parseGeniexHostArgs } from './args.js'
import type { GeniexHostArgs } from './args.js'
import type { GeniexEngine } from './engine.js'
import { GeniexInspectError, inspectGeniexModel } from './inspect.js'
import { GeniexLibraryError } from './library.js'
import { createGeniexServer } from './server.js'

/** The host's exit codes; core reads 6 and 7 as its `GENIEX_*` codes. */
export const EXIT = {
  ok: 0,
  /** A bug on core's side. */
  usage: 2,
  /** The library does not load (or there is no Worker to load it in). */
  load: 3,
  /** A library call failed, a model file cannot be read, a port is in use. */
  libraryCall: 4,
  requiresNewerEngine: 6,
  variantUnsupported: 7,
} as const

export interface StopWatch {
  stopped: Promise<void>
  dispose(): void
}

export interface GeniexHostDeps {
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** The Worker with the library in it; made once per run, destroyed at the end. */
  startEngine: () => GeniexEngine
  /** SIGTERM, SIGINT or stdin closed; made before the model, so an early stop is never missed. */
  watchStop?: () => StopWatch
}

/** SIGTERM, SIGINT or the end of stdin, whichever comes first (Windows has no SIGTERM). */
export function watchStopSignals(): StopWatch {
  let resolveStop: () => void = () => {}
  const stopped = new Promise<void>((done) => (resolveStop = done))
  const stop = () => resolveStop()
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
}): Pick<GeniexHostDeps, 'stdout' | 'stderr'> {
  return { stdout: (line) => io.stdout(`${line}\n`), stderr: (line) => io.stderr(`${line}\n`) }
}

/**
 * Where a build keeps the library: `<build>/lib` (task 4.2), absolute. Windows searches DLLs in the
 * folder `SetDllDirectoryW` names instead of the working one, so a relative path would not load.
 */
export function libraryDir(build: string): string {
  return resolve(build, 'lib')
}

const json = (value: unknown): string => JSON.stringify(value)
const said = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A library failure's exit code: `load` when the library did not open, else a failed call. */
const failureExit = (error: unknown): number =>
  error instanceof GeniexLibraryError && error.operation === 'load' ? EXIT.load : EXIT.libraryCall

/** Runs `geniex-host <argv…>` and returns its exit code. */
export async function runGeniexHost(argv: readonly string[], deps: GeniexHostDeps): Promise<number> {
  let args: GeniexHostArgs
  try {
    args = parseGeniexHostArgs(argv)
  } catch (error) {
    deps.stderr(error instanceof GeniexHostUsageError ? error.message : said(error))
    return EXIT.usage
  }
  if (args.mode === 'inspect') {
    try {
      deps.stdout(json(await inspectGeniexModel(args.path)))
      return EXIT.ok
    } catch (error) {
      deps.stderr(error instanceof GeniexInspectError ? error.message : said(error))
      return EXIT.libraryCall
    }
  }
  let engine: GeniexEngine
  try {
    engine = deps.startEngine()
  } catch (error) {
    deps.stderr(`GenieX does not load from ${args.lib}: ${said(error)}`)
    return EXIT.load
  }
  try {
    if (args.mode === 'probe') {
      try {
        deps.stdout(json(await engine.probe(libraryDir(args.lib))))
        return EXIT.ok
      } catch (error) {
        deps.stderr(`GenieX does not load from ${args.lib}: ${said(error)}`)
        return failureExit(error)
      }
    }
    return await serve(engine, args, deps)
  } finally {
    await engine.destroy().catch(() => {})
  }
}

async function serve(
  engine: GeniexEngine,
  args: Extract<GeniexHostArgs, { mode: 'serve' }>,
  deps: GeniexHostDeps
): Promise<number> {
  const watch = (deps.watchStop ?? watchStopSignals)()
  try {
    // What the model says about itself, before the library sees it (task 5.3).
    let info: Awaited<ReturnType<typeof inspectGeniexModel>>
    try {
      info = await inspectGeniexModel(args.model)
    } catch (error) {
      deps.stderr(said(error))
      return EXIT.libraryCall
    }
    if (args.plugin === 'qairt' && args.device !== 'npu') {
      deps.stderr(
        json({
          code: 'GENIEX_VARIANT_UNSUPPORTED',
          plugin: args.plugin,
          device: args.device,
          message: 'AI Hub bundles run on the NPU only.',
        })
      )
      return EXIT.variantUnsupported
    }
    if ((info.kind === 'qairt') !== (args.plugin === 'qairt')) {
      deps.stderr(
        json({
          code: 'GENIEX_VARIANT_UNSUPPORTED',
          plugin: args.plugin,
          device: args.device,
          message:
            info.kind === 'qairt'
              ? 'An AI Hub bundle runs with the qairt plugin, not llama_cpp.'
              : 'A GGUF file runs with the llama_cpp plugin, not qairt.',
        })
      )
      return EXIT.variantUnsupported
    }
    if (
      info.kind === 'qairt' &&
      info.min_runtime_version &&
      compareVersions(info.min_runtime_version, args.engineVersion) > 0
    ) {
      deps.stderr(
        json({
          code: 'GENIEX_MODEL_REQUIRES_NEWER_ENGINE',
          required: info.min_runtime_version,
          engine: args.engineVersion,
        })
      )
      return EXIT.requiresNewerEngine
    }
    const nCtx = Math.min(args.nCtx, info.max_context_tokens ?? args.nCtx)
    let created: { vision: boolean }
    try {
      created = await engine.create(libraryDir(args.lib), {
        plugin: args.plugin,
        device: args.device,
        model: args.model,
        mmproj: args.mmproj ?? null,
        nCtx,
        powerMode: args.powerMode,
      })
    } catch (error) {
      deps.stderr(`GenieX could not create the model from ${args.model}: ${said(error)}`)
      return failureExit(error)
    }
    // Only once there is a model to serve: a failed create leaves no folder behind.
    await mkdir(args.tmp, { recursive: true })
    const server = createGeniexServer({
      engine,
      modelId: args.id,
      caps: { vision: created.vision, reasoning: args.reasoning },
      defaultMaxTokens: Math.min(args.maxTokens, nCtx),
      tmpDir: args.tmp,
      log: (line) => deps.stderr(line),
    })
    try {
      const url = await server.listen(args.port)
      deps.stdout(
        json({
          ready: true,
          url,
          model_id: args.id,
          plugin: args.plugin,
          device: args.device,
          n_ctx: nCtx,
          vision: created.vision,
        })
      )
      await watch.stopped
      return EXIT.ok
    } catch (error) {
      deps.stderr(`GenieX host could not listen on 127.0.0.1:${args.port}: ${said(error)}`)
      return EXIT.libraryCall
    } finally {
      await server.close()
      await rm(args.tmp, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    watch.dispose()
  }
}
