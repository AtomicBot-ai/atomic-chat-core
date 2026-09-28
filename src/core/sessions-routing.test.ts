/**
 * How `LocalSessions` hands the public server its targets: a runtime that declares a route policy
 * (`tensorrt-llm`) passes it along with the session, an external session of that provider gets the
 * provider's static policy, and every other session keeps the server's defaults (no policy at all).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { LocalProviderId, SessionInfo } from '../contracts/index.js'
import { ExternalSessions } from '../runtime/index.js'
import type { LocalRuntime, SessionRoutePolicy } from '../runtime/index.js'
import { LocalSessions, unknownProvider } from './sessions.js'

const info = (model_id: string, port: number): SessionInfo => ({
  pid: null,
  port,
  model_id,
  model_path: `/models/${model_id}`,
  is_embedding: false,
  api_key: 'k',
})

const policy: SessionRoutePolicy = {
  routes: [{ method: 'POST', path: '/v1/chat/completions' }],
  tools: false,
  structuredOutput: false,
  mapError: () => null,
}

function runtimeWith(sessions: SessionInfo[], routePolicy?: (id: string) => SessionRoutePolicy | undefined) {
  const runtime: LocalRuntime = {
    list: () => sessions,
    findSession: (id) => sessions.find((s) => s.model_id === id),
    getLoadedModels: () => sessions.map((s) => s.model_id),
    isLoading: () => false,
    load: async () => sessions[0] as SessionInfo,
    unload: async () => ({ success: true }),
    autoIncreaseCtx: async () => ({ ok: false, reason: 'unsupported' }),
    recreateSession: async () => ({ ok: false, reason: 'not-loaded' }),
    shutdown: async () => {},
    ...(routePolicy ? { routePolicy } : {}),
  }
  return runtime
}

describe('LocalSessions: route policies for the public server', () => {
  let data: TmpDataFolder
  let externals: ExternalSessions
  let sessions: LocalSessions

  beforeEach(async () => {
    data = await makeTmpDataFolder('atomic-core-sessions-routing-')
    externals = new ExternalSessions({ emit: () => {} })
    const runtimes = new Map<LocalProviderId, LocalRuntime>([
      ['llamacpp-upstream', runtimeWith([info('gguf', 5001)])],
      ['tensorrt-llm', runtimeWith([info('trt', 5002)], (id) => (id === 'trt' ? policy : undefined))],
    ])
    sessions = new LocalSessions({
      layout: data.layout,
      instanceId: 'instance-under-test',
      runtimes,
      externalSessions: externals,
      runtime: (provider) => {
        const found = runtimes.get(provider)
        if (!found) throw unknownProvider(provider, runtimes.keys())
        return found
      },
      assertRunning: () => {},
      increaseCtx: async () => ({ ok: false, reason: 'not-loaded' }),
      recreateSession: async () => ({ ok: false, reason: 'not-loaded' }),
      externalPolicy: (provider) => (provider === 'tensorrt-llm' ? { ...policy, tools: true } : undefined),
    })
  })
  afterEach(() => data.cleanup())

  it("carries the runtime's policy with its own session, and none for an engine without one", () => {
    expect(sessions.localTarget('tensorrt-llm', 'trt')).toMatchObject({ port: 5002, policy })
    expect(sessions.localTarget('llamacpp-upstream', 'gguf')).not.toHaveProperty('policy')
    expect(sessions.listLocalTargets().map((t) => [t.modelId, t.policy === undefined])).toEqual([
      ['gguf', true],
      ['trt', false],
    ])
  })

  it("gives an external session the provider's static policy", () => {
    externals.publish('app', 1, [{ provider: 'tensorrt-llm', model_id: 'ext', port: 6001 }])
    externals.publish('app', 2, [
      { provider: 'tensorrt-llm', model_id: 'ext', port: 6001 },
      { provider: 'mlx', model_id: 'm', port: 6002 },
    ])
    expect(sessions.localTarget('tensorrt-llm', 'ext')?.policy).toMatchObject({ tools: true })
    expect(sessions.localTarget('mlx', 'm')).not.toHaveProperty('policy')
  })
})
