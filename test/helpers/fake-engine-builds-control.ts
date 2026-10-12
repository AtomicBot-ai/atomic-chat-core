/** A recording `EngineBuildControl` for route and client tests: every call lands in `calls`. */
import type {
  EngineBuildCatalog,
  EngineBuildId,
  EngineBuildInstallResult,
  EngineBuildUpdateCheck,
} from '../../src/contracts/index.js'
import type { EngineBuildControl } from '../../src/server/control/types.js'

export function fakeEngineCatalog(engine: EngineBuildId): EngineBuildCatalog {
  return {
    engine,
    manifest: { tag: 'mlxvlm-macos-arm64-07ba5a1', source: 'remote', fetched_at: 1, error: null },
    manifest_error: null,
    host_backend_id: 'macos-arm64',
    host_reason: null,
    installed: [],
    active: null,
  }
}

export function fakeEngineBuildsControl(calls: string[]): EngineBuildControl {
  return {
    catalog: async (engine, request) => {
      calls.push(`engine-builds catalog ${engine} ${JSON.stringify(request)}`)
      return fakeEngineCatalog(engine)
    },
    checkUpdates: async (engine, request): Promise<EngineBuildUpdateCheck> => {
      calls.push(`engine-builds updates ${engine} ${JSON.stringify(request)}`)
      return { update_needed: false, current: null, target: null }
    },
    install: async (engine, request): Promise<EngineBuildInstallResult> => {
      calls.push(`engine-builds install ${engine} ${JSON.stringify(request)}`)
      return {
        installed: true,
        build: { tag: 'master-900-aaaaaaa', backend_id: 'macos-arm64', origin: 'downloaded' },
        retired: [],
        kept_in_use: [],
      }
    },
    remove: async (engine, tag, backendId) => {
      calls.push(`engine-builds remove ${engine} ${tag} ${backendId}`)
      return { removed: true }
    },
  }
}
