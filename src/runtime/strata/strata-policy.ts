import type { StrataCapabilities } from '../../contracts/index.js'
import { ManagedRequestRefusal } from '../managed-text/index.js'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Validate OpenAI chat input before exposing it to Control, which also accepts remote and local images. */
export function strataRequest(body: unknown, caps: StrataCapabilities): unknown {
  const request = object(body)
  if (!request || !Array.isArray(request.messages))
    throw new ManagedRequestRefusal('Strata chat requires a messages array.', 'invalid_messages')
  if (Object.keys(request).some((key) => key.startsWith('strata_') || key.startsWith('_')))
    throw new ManagedRequestRefusal(
      'Strata chat does not accept engine control fields.',
      'unsupported_parameter'
    )
  const tools =
    (Array.isArray(request.tools) && request.tools.length > 0) ||
    request.tool_choice !== undefined ||
    request.functions !== undefined ||
    request.function_call !== undefined
  if (tools && !caps.tools)
    throw new ManagedRequestRefusal('This Strata session does not support tools.', 'unsupported_tools')
  if (request.response_format != null) {
    const kind = object(request.response_format)?.type
    if (kind !== 'text' && kind !== 'json_object' && kind !== 'json_schema')
      throw new ManagedRequestRefusal('Unsupported Strata response_format.', 'unsupported_response_format')
    if (kind !== 'text') {
      if (!caps.structured_output)
        throw new ManagedRequestRefusal(
          'This Strata session does not have a full JSON Schema validator.',
          'unsupported_response_format'
        )
      if (tools)
        throw new ManagedRequestRefusal(
          'Strata cannot combine JSON output with tools.',
          'unsupported_response_format'
        )
      // Control validates the schema (including object-only root and reference rules) before generating.
    }
  }
  for (const message of request.messages) {
    const parts = object(message)?.content
    if (!Array.isArray(parts)) continue
    for (const value of parts) {
      const part = object(value)
      if (!part || (part.type !== 'text' && part.type !== 'image_url'))
        throw new ManagedRequestRefusal(
          'Strata accepts text and image_url content parts.',
          'unsupported_content'
        )
      if (part.type !== 'image_url') continue
      if (!caps.vision)
        throw new ManagedRequestRefusal('Vision is disabled for this Strata session.', 'unsupported_vision')
      const url = object(part.image_url)?.url
      if (
        typeof url !== 'string' ||
        !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
      )
        throw new ManagedRequestRefusal(
          'Strata vision requires a base64 image data URL.',
          'invalid_image_url'
        )
    }
  }
  return request
}
