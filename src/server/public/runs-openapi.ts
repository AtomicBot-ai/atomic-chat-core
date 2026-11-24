/**
 * What the served OpenAPI document says about resumable chat streams (ADR
 * 2026-11-23-resumable-chat-completion-runs). The document itself is the app's, embedded verbatim
 * (`static-assets.generated.ts`); the run routes are the core's own, so they are added when it is
 * served. Whatever the app's document already describes is left as it is.
 */

import { RESUMABLE_REQUEST_HEADER, RUN_ID_HEADER, RUNS_PATH } from '../../contracts/index.js'
import { isJsonObject } from '../shims/index.js'
import type { JsonObject, JsonValue } from '../shims/index.js'

const TAG = 'Runs'

const errorResponse = (description: string): JsonObject => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/RunErrorDto' } } },
})

const runIdParameter: JsonObject = {
  name: 'run_id',
  in: 'path',
  required: true,
  description: `The \`${RUN_ID_HEADER}\` of the chat completion stream.`,
  schema: { type: 'string' },
}

const RUN_PATHS: Record<string, JsonObject> = {
  [`${RUNS_PATH}/{run_id}/events`]: {
    post: {
      summary: 'Resume a chat completion stream',
      description:
        `Replays the events of a resumable chat completion stream (one requested with \`${RESUMABLE_REQUEST_HEADER}: 1\`) ` +
        'after the given event id, then follows it live until it ends with `data: [DONE]`. The generation goes on ' +
        'while no client is connected. Only the API key that started the stream can read it. POST, not GET: ' +
        'proxies such as a Cloudflare quick tunnel hold a streamed GET answer back until it ends.',
      operationId: 'resumeChatCompletionRun',
      tags: [TAG],
      parameters: [
        runIdParameter,
        {
          name: 'after',
          in: 'query',
          required: false,
          description:
            'The `id` of the last event received; events after it are sent. Default 0: every buffered event.',
          schema: { type: 'integer', minimum: 0 },
        },
        {
          name: 'Last-Event-ID',
          in: 'header',
          required: false,
          description: 'Used as `after` when the query has none.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': {
          description: 'The missed events, then the live ones; each with an `id:` line.',
          headers: { [RUN_ID_HEADER]: { schema: { type: 'string' } } },
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        '400': errorResponse('`after` is not a non-negative integer (`invalid_value`).'),
        '404': errorResponse('No such run, it has expired, or another API key started it (`run_not_found`).'),
        '410': errorResponse(
          'The events after `after` are no longer buffered (`run_events_gone`); send the original request again.'
        ),
      },
    },
  },
  [`${RUNS_PATH}/{run_id}/cancel`]: {
    post: {
      summary: 'Cancel a chat completion stream',
      description:
        'Stops the generation of a resumable chat completion stream. Clients following it see it end.',
      operationId: 'cancelChatCompletionRun',
      tags: [TAG],
      parameters: [runIdParameter],
      responses: {
        '204': { description: 'Cancelled, or it had already ended.' },
        '404': errorResponse('No such run, it has expired, or another API key started it (`run_not_found`).'),
      },
    },
  },
}

const RUN_ERROR_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        type: { type: 'string' },
        code: { type: 'string', enum: ['run_not_found', 'run_events_gone', 'invalid_value'] },
        param: { type: 'string' },
      },
    },
  },
}

/** Add the run routes, their tag and schema, and the opt-in header on `/chat/completions`, in place. */
export function withRunRoutes(spec: JsonValue): void {
  if (!isJsonObject(spec)) return
  const paths = isJsonObject(spec['paths']) ? spec['paths'] : (spec['paths'] = {})
  for (const [path, item] of Object.entries(RUN_PATHS)) {
    if (!Object.hasOwn(paths, path)) paths[path] = structuredClone(item)
  }

  const tags = spec['tags']
  if (Array.isArray(tags) && !tags.some((tag) => isJsonObject(tag) && tag['name'] === TAG)) {
    tags.push({ name: TAG, description: 'Resuming and cancelling a resumable chat completion stream' })
  }

  const components = isJsonObject(spec['components']) ? spec['components'] : (spec['components'] = {})
  const schemas = isJsonObject(components['schemas']) ? components['schemas'] : (components['schemas'] = {})
  if (!Object.hasOwn(schemas, 'RunErrorDto')) schemas['RunErrorDto'] = structuredClone(RUN_ERROR_SCHEMA)

  const chatPath = paths['/chat/completions']
  const chat = isJsonObject(chatPath) && isJsonObject(chatPath['post']) ? chatPath['post'] : undefined
  if (!chat) return
  const parameters = Array.isArray(chat['parameters']) ? chat['parameters'] : (chat['parameters'] = [])
  if (!parameters.some((p) => isJsonObject(p) && p['name'] === RESUMABLE_REQUEST_HEADER)) {
    parameters.push({
      name: RESUMABLE_REQUEST_HEADER,
      in: 'header',
      required: false,
      description:
        'With `stream: true`, `1` makes the stream resumable: the answer carries `X-Atomic-Run-Id` and an `id:` ' +
        `on every event, the generation goes on if the client disconnects, and \`POST ${RUNS_PATH}/{run_id}/events\` ` +
        'reads the rest. Absent when the server could not keep the run; the stream is then a plain one.',
      schema: { type: 'string', enum: ['1'] },
    })
  }
}
