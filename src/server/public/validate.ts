/**
 * The shape checks the public server makes itself before a body reaches a local engine, each answered
 * with OpenAI's 400 envelope and a `param` naming the field. Pure.
 *
 * Each closes a gap where a local engine answered 200 to a request OpenAI refuses:
 * - a chat message whose `role` OpenAI does not define: a chat template drops a message whose role it
 *   does not know and answers whatever is left (QA B14, `"role": "not-a-real-role"` got a reply);
 * - a Responses `message` item with such a role, which the llama.cpp translation copies as it is;
 * - an embeddings `input` that mixes forms: llama.cpp reads `["alpha", 7, "omega"]` as one prompt of
 *   text and token 7 and answers one vector (QA B13).
 *
 * A remote provider validates its own requests and still gets the body unchecked.
 */

import { isJsonObject } from '../shims/index.js'
import { structuredErrorJson } from './errors.js'

/**
 * The chat roles OpenAI defines and every local engine reads: the roles the app, the shims and the
 * external agents send, and the ones the GenieX and LiteRT-LM hosts accept. The deprecated `function`
 * is not one.
 */
const CHAT_ROLES: readonly string[] = ['system', 'developer', 'user', 'assistant', 'tool']

/** The roles of a Responses API `message` input item. */
const RESPONSES_ROLES: readonly string[] = ['user', 'assistant', 'system', 'developer']

/** `a string`, `an array`, `null`…: a JSON value's type as OpenAI's messages name it. */
function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/** `'a', 'b' and 'c'`. */
function quoted(values: readonly string[]): string {
  const all = values.map((v) => `'${v}'`)
  return `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`
}

function roleRefusal(role: unknown, param: string, roles: readonly string[]): string | undefined {
  if (typeof role === 'string' && roles.includes(role)) return undefined
  const shown = typeof role === 'string' ? `'${role}'` : JSON.stringify(role)
  return structuredErrorJson(
    `Invalid value for '${param}': ${shown}. Supported values are: ${quoted(roles)}.`,
    'invalid_request_error',
    'invalid_value',
    param
  )
}

/**
 * The 400 for the first chat message that is not an object, has no `role`, or has a role OpenAI does not
 * define; `undefined` for any other body. A body without a `messages` array is the engine's to judge.
 */
export function messageRolesRefusal(json: unknown): string | undefined {
  const messages = isJsonObject(json) ? json['messages'] : undefined
  if (!Array.isArray(messages)) return undefined
  for (const [i, message] of messages.entries()) {
    const at = `messages[${i}]`
    if (!isJsonObject(message))
      return structuredErrorJson(
        `Invalid type for '${at}': expected an object, but got ${typeName(message)} instead.`,
        'invalid_request_error',
        'invalid_type',
        at
      )
    if (message['role'] === undefined)
      return structuredErrorJson(
        `Missing required parameter: '${at}.role'.`,
        'invalid_request_error',
        'missing_required_parameter',
        `${at}.role`
      )
    const refused = roleRefusal(message['role'], `${at}.role`, CHAT_ROLES)
    if (refused !== undefined) return refused
  }
  return undefined
}

/**
 * The 400 for the first Responses `message` input item (an item without a `type` is one) whose `role`
 * the Responses API does not define; `undefined` otherwise. An item without a `role` stays the
 * translation's `user`, as before.
 */
export function responsesRolesRefusal(json: unknown): string | undefined {
  const input = isJsonObject(json) ? json['input'] : undefined
  if (!Array.isArray(input)) return undefined
  for (const [i, item] of input.entries()) {
    if (!isJsonObject(item)) continue
    const type = typeof item['type'] === 'string' ? item['type'] : 'message'
    if (type !== 'message' || item['role'] === undefined) continue
    const refused = roleRefusal(item['role'], `input[${i}].role`, RESPONSES_ROLES)
    if (refused !== undefined) return refused
  }
  return undefined
}

const INPUT_FORMS =
  'Send a string, an array of strings, an array of token ids (integers) or an array of token id arrays, without mixing them.'

/**
 * What one element of an `input` array is: text (a string, or an input item the embedding model reads
 * media from: `{content: [...]}`, `{prompt_string, multimodal_data}`), a token id, or a token array.
 */
function elementForm(value: unknown): 'text' | 'token' | 'tokens' | undefined {
  if (typeof value === 'string' || isJsonObject(value)) return 'text'
  if (typeof value === 'number') return 'token'
  if (Array.isArray(value)) return 'tokens'
  return undefined
}

function inputRefusal(message: string, code: string): string {
  return structuredErrorJson(`Invalid 'input': ${message}`, 'invalid_request_error', code, 'input')
}

/** The refusal for `value`, at `at` in a token array, when it is no token id. */
function tokenRefusal(value: unknown, at: string): string | undefined {
  if (typeof value !== 'number')
    return inputRefusal(`${at} is ${typeName(value)}, not a token id. ${INPUT_FORMS}`, 'invalid_type')
  if (!Number.isSafeInteger(value) || value < 0)
    return inputRefusal(`${at} is ${value}, not a token id (a non-negative integer).`, 'invalid_value')
  return undefined
}

/**
 * The 400 for an embeddings `input` in no form OpenAI defines — a string, an array of strings, an array
 * of token ids, an array of token id arrays — where the embedding model's input items count as text and
 * may stand beside strings; `undefined` for any other body. Neither a missing `input` nor an empty one
 * is refused here (each route and engine judges those as before), nor anything inside an input item
 * (`checkEmbeddingRequest` and the engine judge that).
 */
export function embeddingInputRefusal(json: unknown): string | undefined {
  const input = isJsonObject(json) ? json['input'] : undefined
  if (input === undefined || typeof input === 'string' || isJsonObject(input)) return undefined
  if (!Array.isArray(input))
    return structuredErrorJson(
      `Invalid type for 'input': expected a string or an array, but got ${typeName(input)} instead.`,
      'invalid_request_error',
      'invalid_type',
      'input'
    )
  if (input.length === 0) return undefined
  const form = elementForm(input[0])
  if (form === undefined)
    return inputRefusal(`input[0] is ${typeName(input[0])}. ${INPUT_FORMS}`, 'invalid_type')
  for (const [i, item] of input.entries()) {
    const at = `input[${i}]`
    if (elementForm(item) !== form)
      return inputRefusal(
        `${at} is ${typeName(item)}, but input[0] is ${typeName(input[0])}. ${INPUT_FORMS}`,
        'invalid_type'
      )
    const tokens: Array<[unknown, string]> =
      form === 'token'
        ? [[item, at]]
        : form === 'tokens'
          ? (item as unknown[]).map((token, j) => [token, `${at}[${j}]`])
          : []
    for (const [token, where] of tokens) {
      const refused = tokenRefusal(token, where)
      if (refused !== undefined) return refused
    }
  }
  return undefined
}
