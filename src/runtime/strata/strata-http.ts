import type { StrataCapabilities } from '../../contracts/index.js'
import { generateGatewayKey, startManagedGateway } from '../managed-text/index.js'
import type { ManagedRoute } from '../managed-text/index.js'
import type { SessionRoutePolicy } from '../shared/index.js'
import { strataRequest } from './strata-policy.js'

const chat = { method: 'POST', path: '/v1/chat/completions' }
const routes: readonly ManagedRoute[] = [chat, { method: 'GET', path: '/v1/models' }]

export function strataHttp(
  upstreamPort: number,
  upstreamKey: string,
  modelId: string,
  caps: StrataCapabilities,
  contextLength: number,
  allowedHosts: string[],
  fetcher: typeof fetch = fetch
) {
  const policy: SessionRoutePolicy = {
    routes,
    tools: caps.tools,
    structuredOutput: caps.structured_output,
    contextLength,
    mapError: () => null,
  }
  return {
    policy,
    async proveHttp(status: { instanceId?: string }, signal: AbortSignal): Promise<boolean> {
      try {
        if (!status.instanceId) return false
        const response = await fetcher('http://127.0.0.1:' + upstreamPort + '/v1/telemetry', {
          headers: { authorization: 'Bearer ' + upstreamKey },
          signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
          redirect: 'error',
        })
        if (!response.ok) return false
        const telemetry = (await response.json()) as {
          instance?: { id?: unknown }
          model?: { id?: unknown; loaded?: unknown }
        }
        return (
          telemetry.instance?.id === status.instanceId &&
          telemetry.model?.id === modelId &&
          telemetry.model.loaded === true
        )
      } catch {
        return false
      }
    },
    async expose() {
      const apiKey = generateGatewayKey()
      const gateway = await startManagedGateway({
        upstream: { host: '127.0.0.1', port: upstreamPort, apiKey: upstreamKey },
        apiKey,
        allowedHosts,
        routes,
        rewritableRoutes: [chat],
        rewriteRequestBody: (_route, body) => strataRequest(body, caps),
      })
      return { port: gateway.port, apiKey, close: gateway.close }
    },
  }
}
