import { expect, it } from 'vitest'
import { flmChatRequest, flmMapError, flmResponse, loadedCheckpoint } from './policy.js'
const caps = { chat: true as const, tools: false, reasoning: false, structured_output: false }
const chat = { model: 'public', messages: [{ role: 'user', content: 'Hi' }] }
it('requires the selected checkpoint in the loaded model response', () => {
  expect(loadedCheckpoint({ models: ['qwen3:0.6b'] }, 'qwen3:0.6b')).toBe(false)
  expect(
    loadedCheckpoint({ object: 'list', data: [{ id: 'qwen3:0.6b', object: 'model' }] }, 'qwen3:0.6b')
  ).toBe(true)
})
it('pins chat to the selected checkpoint and rejects overrides and unqualified features', () => {
  expect(flmChatRequest(chat, 'public', 'qwen3:0.6b', caps)).toMatchObject({
    model: 'qwen3:0.6b',
    think: false,
  })
  for (const override of [
    { model: 'other' },
    { backend: 'cpu' },
    { images: [] },
    { think: true },
    { tools: [{}] },
    { response_format: { type: 'json_schema' } },
    { messages: [{ content: [{ type: 'image_url' }] }] },
  ])
    expect(() => flmChatRequest({ ...chat, ...override }, 'public', 'qwen3:0.6b', caps)).toThrow()
})
it('maps model identity only and preserves tool deltas, usage and finish reasons', () => {
  const chunk = {
    model: 'internal',
    choices: [{ delta: { tool_calls: [{}], reasoning_content: 'h' }, finish_reason: 'tool_calls' }],
    usage: { completion_tokens: 1 },
  }
  expect(flmResponse(chunk, 'public')).toEqual({ ...chunk, model: 'public' })
})
it('translates both enabled and disabled thinking per request', () => {
  const capable = { ...caps, reasoning: true }
  for (const enabled of [true, false]) {
    for (const value of [
      { enable_thinking: enabled },
      { chat_template_kwargs: { enable_thinking: enabled } },
      { think: enabled },
    ])
      expect(flmChatRequest({ ...chat, ...value }, 'public', 'qwen3:0.6b', capable).think).toBe(enabled)
  }
})

it('preserves qualified tool and structured-output requests while mapping only the checkpoint and thinking', () => {
  const request = {
    ...chat,
    messages: [
      { role: 'system', content: 'Use the supplied weather tool.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'sunny' },
    ],
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
    response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' } } },
    max_tokens: 64,
    temperature: 0.25,
    stream: true,
  }
  expect(
    flmChatRequest(request, 'public', 'qwen3:0.6b', {
      chat: true,
      tools: true,
      reasoning: true,
      structured_output: true,
    })
  ).toEqual({ ...request, model: 'qwen3:0.6b', think: true })
})
it.each([
  // What the pinned f37cdd29 answers (rest_handler.cpp; AutoModel::_shared_validate_capacity).
  ['{"error":{"message":"Max length reached!","type":"model_error","code":400}}', 'Max length reached!'],
  [
    `{"error":{"message":"Request exceeds the 4096-token limit of backend 'npu': rendered prompt has 5000 tokens","type":"model_error","code":400,"session_cleared":false}}`,
    "This model's maximum context length is 4096 tokens. However, your messages resulted in 5000 tokens. Please reduce the length of the messages.",
  ],
])('maps the engine overflow %s to context_length_exceeded', (body, message) => {
  expect(flmMapError(400, body)).toEqual({
    error: { message, type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' },
  })
})
it('leaves any other engine error and the full generation queue to the public server', () => {
  expect(
    flmMapError(400, `{"error":{"message":"'messages' is required and must be an array","code":400}}`)
  ).toBeNull()
  expect(
    flmMapError(
      503,
      '{"error":{"message":"The model generation queue is full.","type":"server_error","code":"queue_full"}}'
    )
  ).toBeNull()
  expect(
    flmMapError(
      500,
      '{"error":{"message":"Inference failed; the current conversation was cleared","code":500}}'
    )
  ).toBeNull()
})
