/**
 * The arguments of the hidden `litert-host` mode (openspec change `add-litert-lm-runtime`, task 5.1).
 * Core is the only caller, so the parse is strict: anything unknown is a bug on core's side.
 *
 *   litert-host probe   --lib <build>
 *   litert-host inspect --lib <build> <file>
 *   litert-host serve   --lib <build> --engine-version <v> --model <file> --backend cpu|gpu|npu
 *                       --max-tokens <n> --port <p, 0 for any> --cache <dir> --id <model id>
 *                       [--dispatch <dir> --ov-libs <dir>] [--speculative] [--reasoning]
 */

import { parseArgs } from 'node:util'

export const LITERT_LM_BACKENDS = ['cpu', 'gpu', 'npu'] as const
export type LiteRtLmBackend = (typeof LITERT_LM_BACKENDS)[number]

export type LiteRtHostArgs =
  | { mode: 'probe'; lib: string }
  | { mode: 'inspect'; lib: string; file: string }
  | {
      mode: 'serve'
      /** The build directory, holding `lib/`. */
      lib: string
      /** The build's LiteRT-LM version, checked against the file's `min_runtime_version`. */
      engineVersion: string
      model: string
      backend: LiteRtLmBackend
      /** The engine's `max_num_tokens`, already cut to what the file allows. */
      maxTokens: number
      port: number
      /** The library's `cache_dir`; created when missing. */
      cache: string
      /** The id `/v1/models` lists: core's session id. */
      id: string
      /** NPU only: the build's `vendors/intel_openvino/dispatch`. */
      dispatch?: string
      /** NPU only: the prepared OpenVINO libraries. */
      ovLibs?: string
      /** Use the file's draft model when it has one. */
      speculative: boolean
      /** Think by default (`model.yml` `reasoning`); a request may still turn it off. */
      reasoning: boolean
    }

export class LiteRtHostUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiteRtHostUsageError'
  }
}

const required = (values: Record<string, unknown>, key: string): string => {
  const value = values[key]
  if (typeof value !== 'string' || value === '') throw new LiteRtHostUsageError(`--${key} is required`)
  return value
}

const VERSION_RE = /^\d+\.\d+\.\d+$/

function wholeNumber(values: Record<string, unknown>, key: string, min: number, max: number): number {
  const raw = required(values, key)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new LiteRtHostUsageError(`--${key} ${raw} is not a whole number from ${min} to ${max}`)
  return value
}

export function parseLiteRtHostArgs(argv: readonly string[]): LiteRtHostArgs {
  const [mode, ...rest] = argv
  try {
    if (mode === 'probe') {
      const { values } = parseArgs({ args: rest, options: { lib: { type: 'string' } }, strict: true })
      return { mode, lib: required(values, 'lib') }
    }
    if (mode === 'inspect') {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { lib: { type: 'string' } },
        strict: true,
        allowPositionals: true,
      })
      const lib = required(values, 'lib')
      if (positionals.length !== 1 || !positionals[0])
        throw new LiteRtHostUsageError('inspect takes one model file')
      return { mode, lib, file: positionals[0] }
    }
    if (mode === 'serve') {
      const { values } = parseArgs({
        args: rest,
        options: {
          'lib': { type: 'string' },
          'engine-version': { type: 'string' },
          'model': { type: 'string' },
          'backend': { type: 'string' },
          'max-tokens': { type: 'string' },
          'port': { type: 'string' },
          'cache': { type: 'string' },
          'id': { type: 'string' },
          'dispatch': { type: 'string' },
          'ov-libs': { type: 'string' },
          'speculative': { type: 'boolean' },
          'reasoning': { type: 'boolean' },
        },
        strict: true,
      })
      const lib = required(values, 'lib')
      const engineVersion = required(values, 'engine-version')
      if (!VERSION_RE.test(engineVersion))
        throw new LiteRtHostUsageError(`--engine-version ${engineVersion} is not X.Y.Z`)
      const backend = required(values, 'backend')
      if (!LITERT_LM_BACKENDS.some((known) => known === backend))
        throw new LiteRtHostUsageError(`--backend ${backend} is not cpu, gpu or npu`)
      const dispatch = values['dispatch']
      const ovLibs = values['ov-libs']
      if (backend === 'npu' && (!dispatch || !ovLibs))
        throw new LiteRtHostUsageError('--backend npu needs --dispatch and --ov-libs')
      if (backend !== 'npu' && (dispatch !== undefined || ovLibs !== undefined))
        throw new LiteRtHostUsageError('--dispatch and --ov-libs are only for --backend npu')
      return {
        mode,
        lib,
        engineVersion,
        model: required(values, 'model'),
        backend: backend as LiteRtLmBackend,
        maxTokens: wholeNumber(values, 'max-tokens', 1, 16_777_216),
        port: wholeNumber(values, 'port', 0, 65535),
        cache: required(values, 'cache'),
        id: required(values, 'id'),
        ...(dispatch ? { dispatch } : {}),
        ...(ovLibs ? { ovLibs } : {}),
        speculative: values['speculative'] === true,
        reasoning: values['reasoning'] === true,
      }
    }
  } catch (error) {
    if (error instanceof LiteRtHostUsageError) throw error
    throw new LiteRtHostUsageError(error instanceof Error ? error.message : String(error))
  }
  throw new LiteRtHostUsageError(
    `litert-host: unknown mode ${JSON.stringify(mode ?? '')} (probe, inspect, serve)`
  )
}
