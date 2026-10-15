/**
 * The arguments of the hidden `foundry-host` mode (openspec change `add-foundry-local`, task 5.1).
 * Core is the only caller, so the parse is strict: anything unknown is a bug on core's side.
 *
 *   foundry-host probe   --lib <build> --app-data <dir> --logs <dir> [--prepared <ep>]…
 *   foundry-host prepare --lib <build> --app-data <dir> --logs <dir> [<ep>…]
 *   foundry-host serve   --lib <build> --app-data <dir> --logs <dir> --model <dir> --ep <ep>
 *                        --port <p> --cache <dir> --id <name>:<version> [--tools]
 *                        [--reasoning-start <s> --reasoning-end <s>] [--context-length <n>]
 */

import { parseArgs } from 'node:util'
import { FOUNDRY_LOCAL_EXECUTION_PROVIDERS } from '../../../contracts/index.js'
import type { FoundryLocalExecutionProvider } from '../../../contracts/index.js'

interface CommonArgs {
  /** The build directory (`<root>/<tag>/<platform>`), holding `lib/`. */
  lib: string
  /** The library's own data (`app_data_dir`): accelerators, shared by every build. */
  appData: string
  logs: string
}

export type FoundryHostArgs =
  | (CommonArgs & {
      mode: 'probe'
      /** Accelerators core recorded as prepared; the library cannot tell (spike finding 18). */
      prepared: string[]
    })
  | (CommonArgs & { mode: 'prepare'; accelerators: string[] })
  | (CommonArgs & {
      mode: 'serve'
      model: string
      ep: FoundryLocalExecutionProvider
      port: number
      /** The host's own catalog index, deleted at exit. */
      cache: string
      /** `<name>:<version>`, never one of Microsoft's catalog ids (spike finding 7). */
      id: string
      tools: boolean
      reasoningStart?: string
      reasoningEnd?: string
      contextLength?: number
    })

export class FoundryHostUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FoundryHostUsageError'
  }
}

const COMMON_OPTIONS = {
  'lib': { type: 'string' },
  'app-data': { type: 'string' },
  'logs': { type: 'string' },
} as const

const required = (values: Record<string, unknown>, key: string): string => {
  const value = values[key]
  if (typeof value !== 'string' || value === '') throw new FoundryHostUsageError(`--${key} is required`)
  return value
}

function common(values: Record<string, unknown>): CommonArgs {
  return {
    lib: required(values, 'lib'),
    appData: required(values, 'app-data'),
    logs: required(values, 'logs'),
  }
}

export function parseFoundryHostArgs(argv: readonly string[]): FoundryHostArgs {
  const [mode, ...rest] = argv
  try {
    if (mode === 'probe') {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON_OPTIONS, prepared: { type: 'string', multiple: true } },
        strict: true,
      })
      return { mode, ...common(values), prepared: values.prepared ?? [] }
    }
    if (mode === 'prepare') {
      const { values, positionals } = parseArgs({
        args: rest,
        options: COMMON_OPTIONS,
        strict: true,
        allowPositionals: true,
      })
      return { mode, ...common(values), accelerators: positionals }
    }
    if (mode === 'serve') {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...COMMON_OPTIONS,
          'model': { type: 'string' },
          'ep': { type: 'string' },
          'port': { type: 'string' },
          'cache': { type: 'string' },
          'id': { type: 'string' },
          'tools': { type: 'boolean' },
          'reasoning-start': { type: 'string' },
          'reasoning-end': { type: 'string' },
          'context-length': { type: 'string' },
        },
        strict: true,
      })
      const ep = required(values, 'ep')
      if (!FOUNDRY_LOCAL_EXECUTION_PROVIDERS.some((known) => known === ep))
        throw new FoundryHostUsageError(`--ep ${ep} is not an accelerator this host runs`)
      const port = Number(required(values, 'port'))
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new FoundryHostUsageError(`--port ${values.port} is not a port`)
      const id = required(values, 'id')
      if (!/^[^:\s]+:\d+$/.test(id)) throw new FoundryHostUsageError(`--id ${id} is not <name>:<version>`)
      const context = values['context-length']
      const contextLength = context === undefined ? undefined : Number(context)
      if (contextLength !== undefined && (!Number.isSafeInteger(contextLength) || contextLength < 1))
        throw new FoundryHostUsageError(`--context-length ${context} is not a positive whole number`)
      return {
        mode,
        ...common(values),
        model: required(values, 'model'),
        ep: ep as FoundryLocalExecutionProvider,
        port,
        cache: required(values, 'cache'),
        id,
        tools: values.tools === true,
        ...(values['reasoning-start'] !== undefined ? { reasoningStart: values['reasoning-start'] } : {}),
        ...(values['reasoning-end'] !== undefined ? { reasoningEnd: values['reasoning-end'] } : {}),
        ...(contextLength !== undefined ? { contextLength } : {}),
      }
    }
  } catch (error) {
    if (error instanceof FoundryHostUsageError) throw error
    throw new FoundryHostUsageError(error instanceof Error ? error.message : String(error))
  }
  throw new FoundryHostUsageError(
    `foundry-host: unknown mode ${JSON.stringify(mode ?? '')} (probe, prepare, serve)`
  )
}
