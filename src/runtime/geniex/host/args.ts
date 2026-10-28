/**
 * The arguments of the hidden `geniex-host` mode (openspec change `add-geniex-runtime`, task 5.1).
 * Core is the only caller, so the parse is strict: anything unknown is a bug on core's side.
 *
 *   geniex-host probe   --lib <build>
 *   geniex-host inspect <file | bundle folder>
 *   geniex-host serve   --lib <build> --engine-version <v> --model <file | bundle folder>
 *                       --plugin llama_cpp|qairt --device npu|gpu|cpu|hybrid [--mmproj <file>]
 *                       --nctx <n> [--threads <n>] --max-tokens <n> --power-mode <mode> --port <p, 0 for any>
 *                       --tmp <dir> --id <model id> [--reasoning]
 */

import { availableParallelism } from 'node:os'
import { parseArgs } from 'node:util'
import { GENIEX_DEVICES, GENIEX_PLUGINS } from '../../../contracts/index.js'
import type { GeniexDevice, GeniexPlugin } from '../../../contracts/index.js'
import { GENIEX_POWER_MODES } from './library.js'
import type { GeniexPowerMode } from './library.js'

export type GeniexHostArgs =
  | { mode: 'probe'; lib: string }
  | { mode: 'inspect'; path: string }
  | {
      mode: 'serve'
      /** The build directory, holding `lib/`. */
      lib: string
      /** The build's GenieX version, checked against a bundle's `min_runtime_version`. */
      engineVersion: string
      /** A GGUF file (`llama_cpp`) or an AI Hub bundle folder (`qairt`). */
      model: string
      plugin: GeniexPlugin
      device: GeniexDevice
      /** `llama_cpp` only: the vision projector beside the GGUF file. */
      mmproj?: string
      /** `n_ctx`, already cut to what the model allows. */
      nCtx: number
      threads: number
      /** The default `max_tokens` of a request that names none. */
      maxTokens: number
      /** The NPU power mode; ignored off the NPU. */
      powerMode: GeniexPowerMode
      port: number
      /** Where request images are written for the library; created when missing. */
      tmp: string
      /** The id `/v1/models` lists: core's session id. */
      id: string
      /** Think by default (`model.yml` `reasoning`); a request may still turn it off. */
      reasoning: boolean
    }

export class GeniexHostUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeniexHostUsageError'
  }
}

const required = (values: Record<string, unknown>, key: string): string => {
  const value = values[key]
  if (typeof value !== 'string' || value === '') throw new GeniexHostUsageError(`--${key} is required`)
  return value
}

const VERSION_RE = /^\d+\.\d+\.\d+$/

function wholeNumber(values: Record<string, unknown>, key: string, min: number, max: number): number {
  const raw = required(values, key)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new GeniexHostUsageError(`--${key} ${raw} is not a whole number from ${min} to ${max}`)
  return value
}

function oneOf<T extends string>(
  values: Record<string, unknown>,
  key: string,
  known: readonly T[],
  said: string
): T {
  const value = required(values, key)
  if (!known.some((candidate) => candidate === value))
    throw new GeniexHostUsageError(`--${key} ${value} is not ${said}`)
  return value as T
}

/**
 * Threads for the `llama_cpp` plugin when `--threads` is not given. Spike S3 on an 18-core X2 Elite
 * (Qwen3 4B Q4_0, cpu): the plugin's own default decoded at 17.7 tok/s, 12 threads at 40.7 (conf's
 * llama.cpp with `-t 12`: 39.5), 18 threads at 21.1 — the efficiency cores drag the pool down.
 */
export function defaultGeniexThreads(): number {
  return Math.max(1, Math.min(12, availableParallelism()))
}

export function parseGeniexHostArgs(argv: readonly string[]): GeniexHostArgs {
  const [mode, ...rest] = argv
  try {
    if (mode === 'probe') {
      const { values } = parseArgs({ args: rest, options: { lib: { type: 'string' } }, strict: true })
      return { mode, lib: required(values, 'lib') }
    }
    if (mode === 'inspect') {
      const { positionals } = parseArgs({ args: rest, options: {}, strict: true, allowPositionals: true })
      if (positionals.length !== 1 || !positionals[0])
        throw new GeniexHostUsageError('inspect takes one path')
      return { mode, path: positionals[0] }
    }
    if (mode === 'serve') {
      const { values } = parseArgs({
        args: rest,
        options: {
          'lib': { type: 'string' },
          'engine-version': { type: 'string' },
          'model': { type: 'string' },
          'plugin': { type: 'string' },
          'device': { type: 'string' },
          'mmproj': { type: 'string' },
          'nctx': { type: 'string' },
          'threads': { type: 'string' },
          'max-tokens': { type: 'string' },
          'power-mode': { type: 'string' },
          'port': { type: 'string' },
          'tmp': { type: 'string' },
          'id': { type: 'string' },
          'reasoning': { type: 'boolean' },
        },
        strict: true,
      })
      const lib = required(values, 'lib')
      const engineVersion = required(values, 'engine-version')
      if (!VERSION_RE.test(engineVersion))
        throw new GeniexHostUsageError(`--engine-version ${engineVersion} is not X.Y.Z`)
      const mmproj = values['mmproj']
      return {
        mode,
        lib,
        engineVersion,
        model: required(values, 'model'),
        plugin: oneOf(values, 'plugin', GENIEX_PLUGINS, 'llama_cpp or qairt'),
        device: oneOf(values, 'device', GENIEX_DEVICES, 'npu, gpu, cpu or hybrid'),
        ...(mmproj ? { mmproj } : {}),
        nCtx: wholeNumber(values, 'nctx', 1, 16_777_216),
        threads:
          values['threads'] === undefined ? defaultGeniexThreads() : wholeNumber(values, 'threads', 1, 1024),
        maxTokens: wholeNumber(values, 'max-tokens', 1, 16_777_216),
        powerMode: oneOf(values, 'power-mode', GENIEX_POWER_MODES, `one of ${GENIEX_POWER_MODES.join(', ')}`),
        port: wholeNumber(values, 'port', 0, 65535),
        tmp: required(values, 'tmp'),
        id: required(values, 'id'),
        reasoning: values['reasoning'] === true,
      }
    }
  } catch (error) {
    if (error instanceof GeniexHostUsageError) throw error
    throw new GeniexHostUsageError(error instanceof Error ? error.message : String(error))
  }
  throw new GeniexHostUsageError(
    `geniex-host: unknown mode ${JSON.stringify(mode ?? '')} (probe, inspect, serve)`
  )
}
