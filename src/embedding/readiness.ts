/**
 * "Is this an embedding model I can serve?": `GET /health` answers 200, then one real
 * `POST /v1/embeddings` of a single word answers vectors, then `GET /props` says what an input may
 * hold. The vector's length is the model's (EmbeddingGemma 2's header says 512 where it answers 768),
 * and the probe also warms the graph, so the first client request does not pay for it.
 *
 * `/health` answers 503 while the engine loads, so the chain is polled until the startup deadline.
 * Only a clear verdict refuses: 501 on the probe is a server without `--embedding` (a stranger on the
 * port, a build that ignored the flag), any other 4xx is the model itself refusing (a pooling the
 * OpenAI endpoint cannot serve). A transport error, a timeout or a 5xx says nothing and counts as
 * still loading. The parsers are pure; `checkEmbeddingReadiness` does one round over the injected HTTP.
 */

import type { EmbeddingModality } from '../contracts/index.js'
import type { DecisionHttp } from '../decision/index.js'

export const HEALTH_PATH = '/health'
export const EMBEDDINGS_PATH = '/v1/embeddings'
export const PROPS_PATH = '/props'
/** Each readiness request on its own; the startup deadline bounds the whole wait. */
export const READINESS_REQUEST_TIMEOUT_MS = 2_000
/** The probe runs the model once: the first pass compiles kernels on some GPUs. */
export const PROBE_REQUEST_TIMEOUT_MS = 60_000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export type ReadinessResult =
  | { kind: 'loading'; detail: string }
  | { kind: 'ready'; dims: number; modalities: EmbeddingModality[] }
  /** Not an embedding server at all: the build or the flags are wrong. */
  | { kind: 'unsupported'; detail: string }
  /** An embedding server that refuses the model's vectors (its pooling, its input). */
  | { kind: 'refused'; detail: string }

/** The length of the first vector of an OpenAI embeddings answer; `undefined` when there is none. */
export function dimsOf(body: unknown): number | undefined {
  const list = isRecord(body) ? body['data'] : undefined
  const first = Array.isArray(list) && isRecord(list[0]) ? list[0]['embedding'] : undefined
  return Array.isArray(first) && first.length > 0 ? first.length : undefined
}

/** What one input may hold, from `/props.modalities`; text always. */
export function modalitiesOf(props: unknown): EmbeddingModality[] {
  const block = isRecord(props) ? props['modalities'] : undefined
  const out: EmbeddingModality[] = ['text']
  if (!isRecord(block)) return out
  if (block['vision'] === true) out.push('image')
  if (block['audio'] === true) out.push('audio')
  if (block['video'] === true) out.push('video')
  return out
}

/** The engine's own words from an error answer, for the details. */
function engineMessage(text: string): string {
  const body = parseJson(text)
  const error = isRecord(body) ? body['error'] : undefined
  const message = isRecord(error) ? error['message'] : undefined
  return typeof message === 'string' ? message : text.slice(0, 300)
}

/** The verdict on the probe and `/props` after health. Pure. `status: 0` is a transport error. */
export function judgeEmbeddingProbe(
  probe: { status: number; text: string },
  props: { status: number; text: string }
): ReadinessResult {
  if (probe.status === 501)
    return {
      kind: 'unsupported',
      detail: `${EMBEDDINGS_PATH} answered 501: ${engineMessage(probe.text)}`,
    }
  if (probe.status >= 400 && probe.status < 500)
    return {
      kind: 'refused',
      detail: `${EMBEDDINGS_PATH} answered ${probe.status}: ${engineMessage(probe.text)}`,
    }
  if (probe.status !== 200) return { kind: 'loading', detail: notAVerdict(EMBEDDINGS_PATH, probe) }
  const dims = dimsOf(parseJson(probe.text))
  if (dims === undefined)
    return { kind: 'refused', detail: `${EMBEDDINGS_PATH} answered 200 without a vector` }
  if (props.status !== 200) return { kind: 'loading', detail: notAVerdict(PROPS_PATH, props) }
  const body = parseJson(props.text)
  if (body === undefined) return { kind: 'loading', detail: notAVerdict(PROPS_PATH, props) }
  return { kind: 'ready', dims, modalities: modalitiesOf(body) }
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
export async function checkEmbeddingReadiness(
  http: DecisionHttp,
  baseUrl: string,
  apiKey: string,
  modelId: string,
  timeoutMs = READINESS_REQUEST_TIMEOUT_MS,
  probeTimeoutMs = PROBE_REQUEST_TIMEOUT_MS
): Promise<ReadinessResult> {
  const call = (path: string, method: 'GET' | 'POST', body: string | undefined, timeout: number) =>
    http
      .request(`${baseUrl}${path}`, {
        method,
        apiKey,
        timeoutMs: timeout,
        ...(body !== undefined ? { body } : {}),
      })
      .catch((error: unknown) => ({
        status: 0,
        text: error instanceof Error ? error.message : String(error),
      }))
  const health = await call(HEALTH_PATH, 'GET', undefined, timeoutMs)
  if (health.status !== 200)
    return {
      kind: 'loading',
      detail: health.status === 0 ? health.text : `${HEALTH_PATH} answered ${health.status}`,
    }
  const probe = await call(
    EMBEDDINGS_PATH,
    'POST',
    JSON.stringify({ input: ['ping'], model: modelId, encoding_format: 'float' }),
    probeTimeoutMs
  )
  const props = probe.status === 200 ? await call(PROPS_PATH, 'GET', undefined, timeoutMs) : probe
  return judgeEmbeddingProbe(probe, props)
}
