/**
 * vLLM as a managed engine (change `add-vllm-runtime`, task 3.4, design D3): its adapter, settings,
 * memory rule and launch plan, route policy, and its descriptor in conf (`runtimes/vllm.json`, read
 * only once conf main publishes it — until then the provider is unsupported, design D15).
 */
import { defaultDescriptorUrl } from '../environment/index.js'
import type { ManagedEngineSpec } from '../managed-engines/spec.js'
import type { ManagedTextCapabilities } from '../managed-text/index.js'
import type { SessionRoutePolicy } from '../shared/index.js'
import { VLLM_ROUTES, mapVllmContextLengthError, vllmAdapter } from './adapter.js'
import { vllmCheckEngine, vllmLaunchPlan } from './memory.js'
import { vllmSettings, type VllmSettings } from './settings.js'

export const VLLM_ENGINE_ID = 'vllm'

/**
 * What the public server (`:1337`) must know about a `vllm` session to route it honestly: only the
 * routes the adapter declares, tool calls and JSON output only as the session can, and vLLM's context
 * overflow answered as `context_length_exceeded`. `null` capabilities (a session the core did not
 * start) keep the routes and the mapping and leave tools and JSON output to the engine.
 */
export function vllmRoutePolicy(
  capabilities: ManagedTextCapabilities | null,
  limits: { contextLength: number; maxOutputTokens: number } | null = null
): SessionRoutePolicy {
  return {
    routes: VLLM_ROUTES,
    tools: capabilities?.tools ?? true,
    structuredOutput: capabilities?.structured_output ?? true,
    mapError: mapVllmContextLengthError,
    ...(limits === null ? {} : limits),
  }
}

export const VLLM_ENGINE: ManagedEngineSpec<VllmSettings> = {
  engine_id: VLLM_ENGINE_ID,
  provider: VLLM_ENGINE_ID,
  label: 'vLLM',
  descriptor: { engine_id: VLLM_ENGINE_ID, label: 'vLLM', url: defaultDescriptorUrl(VLLM_ENGINE_ID) },
  adapter: vllmAdapter,
  settings: vllmSettings,
  check: vllmCheckEngine,
  launchPlan: vllmLaunchPlan,
  routePolicy: vllmRoutePolicy,
}
