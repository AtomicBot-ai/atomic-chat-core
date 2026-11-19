import type { StrataCapabilities } from '../../contracts/index.js'
import { generateGatewayKey, startManagedGateway } from '../managed-text/index.js'
import type { ManagedRoute } from '../managed-text/index.js'
import type { SessionRoutePolicy } from '../shared/index.js'
import { strataRequest } from './strata-policy.js'

const chat = { method: 'POST', path: '/v1/chat/completions' }
const routes: readonly ManagedRoute[] = [chat, { method: 'GET', path: '/v1/models' }]
const telemetryTimeoutMs = 2000

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
    async httpHealthFailure(
      status: { instanceId?: string },
      signal: AbortSignal
    ): Promise<string | undefined> {
      if (!status.instanceId) return 'Strata Control did not report an instance ID.'
      const timeout = AbortSignal.timeout(telemetryTimeoutMs)
      let response: Response
      try {
        response = await fetcher('http://127.0.0.1:' + upstreamPort + '/v1/telemetry', {
          headers: { authorization: 'Bearer ' + upstreamKey },
          signal: AbortSignal.any([signal, timeout]),
          redirect: 'error',
        })
      } catch {
        return timeout.aborted
          ? `Strata telemetry timed out after ${telemetryTimeoutMs} ms.`
          : 'Could not reach Strata telemetry.'
      }
      if (!response.ok) return `Strata telemetry returned HTTP ${response.status}.`
      let telemetry: {
        instance?: { id?: unknown }
        model?: { id?: unknown; loaded?: unknown }
      } | null
      try {
        telemetry = (await response.json()) as typeof telemetry
      } catch {
        return timeout.aborted
          ? `Strata telemetry timed out after ${telemetryTimeoutMs} ms.`
          : 'Could not read the Strata telemetry JSON.'
      }
      if (telemetry?.instance?.id !== status.instanceId) return 'Strata telemetry instance ID did not match.'
      if (telemetry.model?.id !== modelId) return 'Strata telemetry model ID did not match.'
      if (telemetry.model.loaded !== true) return 'Strata telemetry reported that the model was not loaded.'
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
