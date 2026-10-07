/**
 * "Is this a decision model I can talk to?", the check DECISION.md prescribes for a client:
 * `GET /health` answers 200, then `GET /v1/models` lists the `decision` capability, then
 * `GET /props` has `decision.api_version == 1`.
 *
 * `/health` answers 503 while the engine loads (the HTTP server starts first), so the chain is polled
 * until the startup deadline. Only a clear verdict from a 200 answer refuses the build: `/v1/models`
 * without the `decision` capability, `/props` without a decision block, or another `api_version`.
 * That is some other `llama-server` (a build that ignored `--decision`, a stranger on the port) or a
 * future API version. Anything else on the two later requests (a transport error, a request timeout
 * on a busy machine, a 5xx or any other non-200, a 200 that is not JSON) says nothing about the build
 * and counts as still loading: the refusal is remembered (`DecisionEngineResolver.reject`), so it
 * must not come from a slow answer. The parsers are pure; `checkReadiness` does one round of the
 * chain over the injected HTTP.
 *
 * Upstream llama.cpp has no `/props.decision` and no `decision` capability: its `/v1/models` entry
 * carries `architecture.output_modalities`, `["decisions"]` for a decision model and `["text"]` for
 * anything else. So an upstream process is ready once `/v1/models` lists `decisions`, and its props
 * are filled in by the core (`upstreamProps`): the request contract it shares with the fork, the one
 * endpoint it serves, and whether it reads images.
 */

import { DECISION_API_VERSION } from '../contracts/index.js'
import type { DecisionCapability, DecisionDialect, DecisionProps } from '../contracts/index.js'
import type { DecisionHttp } from './http.js'

export const HEALTH_PATH = '/health'
export const MODELS_PATH = '/v1/models'
export const PROPS_PATH = '/props'
/** Each readiness request on its own; the startup deadline bounds the whole wait. */
export const READINESS_REQUEST_TIMEOUT_MS = 2_000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Every capability the model list names. Real servers answer `{data: [...]}` (OpenAI) and newer
 * builds also `{models: [...]}`; both are read, and the union is kept.
 */
export function capabilitiesOf(body: unknown): DecisionCapability[] {
  if (!isRecord(body)) return []
  const found = new Set<string>()
  for (const key of ['data', 'models']) {
    const list = body[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const caps = isRecord(entry) ? entry['capabilities'] : undefined
      if (Array.isArray(caps)) for (const cap of caps) if (typeof cap === 'string') found.add(cap)
    }
  }
  return [...found]
}

/** The `decision` block of `/props`, when it has a numeric `api_version`. Unknown fields are kept. */
export function decisionPropsOf(body: unknown): DecisionProps | undefined {
  if (!isRecord(body)) return undefined
  const block = body['decision']
  if (!isRecord(block) || typeof block['api_version'] !== 'number') return undefined
  return block as DecisionProps
}

export type ReadinessResult =
  | { kind: 'loading'; detail: string }
  | { kind: 'ready'; props: DecisionProps; capabilities: DecisionCapability[] }
  | { kind: 'unsupported'; detail: string }

/**
 * The verdict on the two answers after health: pure, so every refusal is tested without a server.
 * `status: 0` is a transport error (its `text` the message). Only a 200 that parses as JSON can
 * refuse; every other answer is `loading`.
 */
export function judgeDecisionEndpoint(
  models: { status: number; text: string },
  props: { status: number; text: string }
): ReadinessResult {
  const modelsBody = models.status === 200 ? parseJson(models.text) : undefined
  if (modelsBody === undefined) return { kind: 'loading', detail: notAVerdict(MODELS_PATH, models) }
  const capabilities = capabilitiesOf(modelsBody)
  if (!capabilities.includes('decision'))
    return {
      kind: 'unsupported',
      detail: `${MODELS_PATH} does not list the "decision" capability (got ${JSON.stringify(capabilities)})`,
    }
  const propsBody = props.status === 200 ? parseJson(props.text) : undefined
  if (propsBody === undefined) return { kind: 'loading', detail: notAVerdict(PROPS_PATH, props) }
  const decision = decisionPropsOf(propsBody)
  if (!decision) return { kind: 'unsupported', detail: `${PROPS_PATH} has no decision block` }
  if (decision.api_version !== DECISION_API_VERSION)
    return {
      kind: 'unsupported',
      detail: `${PROPS_PATH} reports decision api_version ${decision.api_version}, this core speaks ${DECISION_API_VERSION}`,
    }
  return { kind: 'ready', props: decision, capabilities }
}

/** What an upstream decision process serves: `/v1/systemone` only, no router. */
export const UPSTREAM_DECISION_ENDPOINTS: readonly string[] = ['/v1/systemone']

/** The first `data` entry's `architecture.<key>` (upstream b11370 on); `[]` when there is none. */
export function modalitiesOf(body: unknown, key: 'input_modalities' | 'output_modalities'): string[] {
  const list = isRecord(body) ? body['data'] : undefined
  if (!Array.isArray(list)) return []
  for (const entry of list) {
    const arch = isRecord(entry) ? entry['architecture'] : undefined
    const values = isRecord(arch) ? arch[key] : undefined
    if (Array.isArray(values)) return values.filter((v): v is string => typeof v === 'string')
  }
  return []
}

/** The props the core stands in for an upstream process, which has no `/props.decision`. */
export function upstreamProps(body: unknown): DecisionProps {
  const list = isRecord(body) ? body['data'] : undefined
  const first = Array.isArray(list) && isRecord(list[0]) ? list[0] : undefined
  const id = typeof first?.['id'] === 'string' ? first['id'] : undefined
  return {
    api_version: DECISION_API_VERSION,
    endpoints: [...UPSTREAM_DECISION_ENDPOINTS],
    source: 'gguf',
    ...(id !== undefined ? { model_id: id } : {}),
    input_modalities: modalitiesOf(body, 'input_modalities'),
  }
}

/** The verdict on an upstream `/v1/models` answer after health. Pure, like `judgeDecisionEndpoint`. */
export function judgeUpstreamDecisionEndpoint(models: { status: number; text: string }): ReadinessResult {
  const body = models.status === 200 ? parseJson(models.text) : undefined
  if (body === undefined) return { kind: 'loading', detail: notAVerdict(MODELS_PATH, models) }
  const outputs = modalitiesOf(body, 'output_modalities')
  if (!outputs.includes('decisions'))
    return {
      kind: 'unsupported',
      detail: `${MODELS_PATH} does not list the "decisions" output modality (got ${JSON.stringify(outputs)})`,
    }
  return { kind: 'ready', props: upstreamProps(body), capabilities: ['decision', 'systemone'] }
}

/** Why an answer is not a verdict, for the timeout's details. */
function notAVerdict(path: string, answer: { status: number; text: string }): string {
  if (answer.status === 0) return `${path}: ${answer.text}`
  if (answer.status !== 200) return `${path} answered ${answer.status}`
  return `${path} answered 200 with a body that is not JSON`
}

/**
 * One round of the chain against `baseUrl`. A transport error or a request timeout is "still
 * loading": the port may not be bound yet, or the engine is too busy loading to answer in time.
 */
export async function checkReadiness(
  http: DecisionHttp,
  baseUrl: string,
  apiKey: string,
  timeoutMs = READINESS_REQUEST_TIMEOUT_MS,
  dialect: DecisionDialect = 'turboquant'
): Promise<ReadinessResult> {
  const get = (path: string) =>
    http.request(`${baseUrl}${path}`, { method: 'GET', apiKey, timeoutMs }).catch((error: unknown) => ({
      status: 0,
      text: error instanceof Error ? error.message : String(error),
    }))
  const health = await get(HEALTH_PATH)
  if (health.status !== 200)
    return {
      kind: 'loading',
      detail: health.status === 0 ? health.text : `${HEALTH_PATH} answered ${health.status}`,
    }
  if (dialect === 'upstream') return judgeUpstreamDecisionEndpoint(await get(MODELS_PATH))
  const [models, props] = [await get(MODELS_PATH), await get(PROPS_PATH)]
  return judgeDecisionEndpoint(models, props)
}
