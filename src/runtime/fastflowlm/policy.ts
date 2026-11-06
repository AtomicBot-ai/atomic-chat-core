import type { FastFlowLmModelDescriptor } from '../../contracts/index.js'
import { asksForStructuredOutput, asksForTools, ManagedRequestRefusal } from '../managed-text/index.js'

export const FLM_ROUTES = [
  { method: 'GET', path: '/v1/models' },
  { method: 'POST', path: '/v1/chat/completions' },
] as const
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const refuse = (message: string): never => {
  throw new ManagedRequestRefusal(message, 'unsupported_parameter')
}
export function loadedCheckpoint(body: unknown, checkpoint: string) {
  return (
    record(body) &&
    body.object === 'list' &&
    Array.isArray(body.data) &&
    body.data.length === 1 &&
    body.data[0]?.id === checkpoint &&
    body.data[0]?.object === 'model'
  )
}
export function flmChatRequest(
  body: unknown,
  id: string,
  checkpoint: string,
  caps: FastFlowLmModelDescriptor['capabilities']
) {
  if (!record(body) || body.model !== id || !Array.isArray(body.messages))
    return refuse('Expected a chat request for the loaded FastFlowLM model.')
  for (const field of [
    'backend',
    'checkpoint',
    'model_path',
    'config_path',
    'catalog',
    'images',
    'audio',
    'videos',
    'functions',
    'function_call',
  ])
    if (field in body) return refuse('FastFlowLM does not support ' + field + ' on this session.')
  if ('modalities' in body && (!Array.isArray(body.modalities) || body.modalities.some((m) => m !== 'text')))
    return refuse('FastFlowLM supports text only.')
  for (const msg of body.messages) {
    if (!record(msg) || ['images', 'audio', 'videos'].some((k) => k in msg))
      return refuse('Expected a text chat message.')
    const c = msg.content
    if (
      c != null &&
      typeof c !== 'string' &&
      (!Array.isArray(c) || c.some((p) => !record(p) || p.type !== 'text' || typeof p.text !== 'string'))
    )
      return refuse('FastFlowLM supports text input only.')
  }
  if (!caps.tools && asksForTools(body)) return refuse('Tools are unavailable for this model.')
  if (!caps.structured_output && asksForStructuredOutput(body))
    return refuse('Structured output is unavailable for this model.')
  const kw = record(body.chat_template_kwargs) ? body.chat_template_kwargs : {}
  const flags = [body.think, body.enable_thinking, kw.enable_thinking].filter((v) => v !== undefined)
  if (flags.some((v) => typeof v !== 'boolean' || v !== flags[0]))
    return refuse('Conflicting or invalid FastFlowLM thinking options.')
  const think = flags[0] ?? caps.reasoning
  if (!caps.reasoning && (think === true || body.reasoning_effort != null))
    return refuse('Reasoning is unavailable for this model.')
  return {
    ...body,
    model: checkpoint,
    think,
  }
}
/** Preserve the engine payload, including SSE deltas and token usage. */
export function flmResponse(body: Record<string, unknown>, id: string) {
  if (body.object === 'list' && Array.isArray(body.data))
    return { ...body, data: body.data.map((row) => ({ ...row, id })) }
  return 'model' in body ? { ...body, model: id } : body
}
