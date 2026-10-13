/**
 * SGLang as a managed engine (change `add-sglang-runtime`, task 2.4, design D1): its adapter,
 * settings, memory rule and launch plan, route policy, and its descriptor in conf
 * (`runtimes/sglang.json`, read only once conf main publishes it — until then the provider is
 * unsupported, design D9).
 */
import { defaultDescriptorUrl } from '../environment/index.js'
import type { ManagedEngineSpec } from '../managed-engines/spec.js'
import type { ManagedTextCapabilities } from '../managed-text/index.js'
import type { SessionRoutePolicy } from '../shared/index.js'
import { SGLANG_ROUTES, mapSglangContextLengthError, sglangAdapter } from './adapter.js'
import { sglangCheckEngine, sglangLaunchPlan } from './memory.js'
import { sglangSettings, type SglangSettings } from './settings.js'

export const SGLANG_ENGINE_ID = 'sglang'

/**
 * What the public server (`:1337`) must know about an `sglang` session to route it honestly: only the
 * routes the adapter declares, tool calls and JSON output only as the session can, and SGLang's
 * context overflow answered as `context_length_exceeded`. `null` capabilities (a session the core did
 * not start) keep the routes and the mapping and leave tools and JSON output to the engine.
 */
export function sglangRoutePolicy(
  capabilities: ManagedTextCapabilities | null,
  limits: { contextLength: number; maxOutputTokens: number } | null = null
): SessionRoutePolicy {
  return {
    routes: SGLANG_ROUTES,
    tools: capabilities?.tools ?? true,
    structuredOutput: capabilities?.structured_output ?? true,
    mapError: mapSglangContextLengthError,
    ...(limits === null ? {} : limits),
  }
}

export const SGLANG_ENGINE: ManagedEngineSpec<SglangSettings> = {
  engine_id: SGLANG_ENGINE_ID,
  provider: SGLANG_ENGINE_ID,
  label: 'SGLang',
  descriptor: { engine_id: SGLANG_ENGINE_ID, label: 'SGLang', url: defaultDescriptorUrl(SGLANG_ENGINE_ID) },
  adapter: sglangAdapter,
  settings: sglangSettings,
  check: sglangCheckEngine,
  launchPlan: sglangLaunchPlan,
  routePolicy: sglangRoutePolicy,
}
