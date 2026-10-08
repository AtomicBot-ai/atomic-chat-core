/** A recording `EngineControl` for route and client tests: every call lands in `calls`. */
import type { EngineVersions } from '../../src/contracts/index.js'
import type { EngineControl } from '../../src/server/control/types.js'

export function fakeEngineVersions(engine: EngineVersions['engine']): EngineVersions {
  return {
    engine,
    kind: 'llamacpp',
    active_choice: 'client',
    builds: [],
    active: null,
    latest: null,
    update: { needed: false, target: null, apply: 'swap' },
    source: 'remote',
    source_error: null,
    error: null,
  }
}

export function fakeEnginesControl(calls: string[]): EngineControl {
  return {
    versions: async (request) => {
      calls.push(`engines versions ${JSON.stringify(request)}`)
      return { engines: [fakeEngineVersions('llamacpp-upstream')] }
    },
    update: async (engine, request) => {
      calls.push(`engines update ${engine} ${JSON.stringify(request)}`)
      return 'request_id' in request
        ? { operation_id: 'op-1' }
        : {
            updated: true,
            active: { version: 'b11500', variant: 'macos-arm64' },
            retired: [],
            kept_in_use: [],
          }
    },
    remove: async (engine, version, variant, options) => {
      calls.push(`engines remove ${engine} ${version} ${variant} ${JSON.stringify(options)}`)
      return engine === 'vllm' || engine === 'tensorrt-llm' ? { operation_id: 'op-2' } : { removed: true }
    },
    activate: async (engine, version, variant) => {
      calls.push(`engines activate ${engine} ${version} ${variant}`)
      return { activated: true, active: { version, variant } }
    },
  }
}
