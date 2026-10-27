import { describe, expect, it } from 'vitest'
import { OpenAiRequestError } from '../../shared/index.js'
import { GeniexReplyParser, IMAGE_PLACEHOLDER, parseGeniexChatRequest } from './openai.js'

const CAPS = { vision: true, reasoning: false }
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
]

describe('parseGeniexChatRequest (task 5.4)', () => {
  it('turns OpenAI messages into template messages, tool calls and results with their names, tools as JSON', () => {
    const parsed = parseGeniexChatRequest(
      {
        model: 'm',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'developer', content: [{ type: 'text', text: 'No emoji.' }] },
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temperature_c":18}' },
        ],
        tools: TOOLS,
        unknown_field: 1,
      },
      CAPS
    )
    expect(parsed.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
      { role: 'system', content: [{ type: 'text', text: 'No emoji.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '{"temperature_c":18}' }],
        tool_call_id: 'call_1',
        tool_name: 'get_weather',
      },
    ])
    expect(parsed.toolsJson).toBe(JSON.stringify(TOOLS))
    expect(parsed).toMatchObject({
      stream: false,
      includeUsage: false,
      stop: [],
      responseFormat: null,
      thinking: false,
      images: [],
    })
  })

  it('takes an image as a data URL, numbered for the host to write, for a model with vision only', () => {
    const parsed = parseGeniexChatRequest(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              { type: 'text', text: 'Color?' },
            ],
          },
        ],
      },
      CAPS
    )
    expect(parsed.messages[0]?.content).toEqual([
      { type: 'image', path: IMAGE_PLACEHOLDER(0) },
      { type: 'text', text: 'Color?' },
    ])
    expect(parsed.images).toEqual([{ mime: 'image/png', base64: 'iVBORw0KGgo=' }])
    const refused = () =>
      parseGeniexChatRequest(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
            },
          ],
        },
        { vision: false, reasoning: false }
      )
    expect(refused).toThrow(OpenAiRequestError)
    expect(refused).toThrow(/image input/)
  })

  it.each([
    [{ messages: [{ role: 'user', content: 'x' }], n: 2 }, /n/],
    [
      {
        messages: [{ role: 'user', content: 'x' }],
        tools: TOOLS,
        tool_choice: { type: 'function', function: { name: 'w' } },
      },
      /tool_choice/,
    ],
    [{ messages: [] }, /messages/],
    [{ messages: [{ role: 'assistant', content: 'x' }] }, /last message/],
    [{ messages: [{ role: 'wizard', content: 'x' }] }, /role/],
    [{ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema' } }, /schema/],
    ['nope', /JSON object/],
  ])('refuses %j with a 400', (body, message) => {
    let error: unknown
    try {
      parseGeniexChatRequest(body, CAPS)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(OpenAiRequestError)
    expect((error as OpenAiRequestError).status).toBe(400)
    expect((error as OpenAiRequestError).body.error.message).toMatch(message)
  })
})

const feed = (parser: GeniexReplyParser, tokens: string[]) => [
  ...tokens.flatMap((token) => parser.add(token)),
  ...parser.flush(),
]

describe('GeniexReplyParser', () => {
  it('streams plain text as content deltas and finishes by the library stop reason', () => {
    const parser = new GeniexReplyParser([], false)
    expect(feed(parser, ['Hel', 'lo', ' there'])).toEqual([
      { content: 'Hel' },
      { content: 'lo' },
      { content: ' there' },
    ])
    expect(parser.finish('eos')).toBe('stop')
    expect(parser.finish('length')).toBe('length')
    expect(parser.finish('context_length')).toBe('length')
    expect(parser.message()).toEqual({ role: 'assistant', content: 'Hello there' })
    expect(parser.tokens).toBe(3)
  })

  it('reads a Qwen3 answer: <think> as reasoning_content, then a <tool_call> as tool_calls, split across tokens', () => {
    const parser = new GeniexReplyParser([], true, () => 'call_x')
    const deltas = feed(parser, [
      '<th',
      'ink>',
      '\nThe user wants',
      ' weather.\n',
      '</th',
      'ink>',
      '\n\n',
      '<tool_call>',
      '\n{"name": "get_',
      'weather", "arguments": {"city": "Paris"}}\n',
      '</tool_call>',
    ])
    expect(deltas).toEqual([
      { reasoning_content: '\nThe user wants' },
      { reasoning_content: ' weather.\n' },
      { content: '\n\n' },
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_x',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
    ])
    expect(parser.finish('eos')).toBe('tool_calls')
    expect(parser.message()).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'The user wants weather.',
      tool_calls: [
        { id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      ],
    })
  })

  it('reads a Gemma 4 answer: a fenced JSON block as tool calls when tools were asked, as text otherwise', () => {
    const parser = new GeniexReplyParser([], true, () => 'call_g')
    const tokens = [
      'I will check.\n',
      '```json\n',
      '[{"name": "get_weather", "parameters": {"city": "Berlin"}}]',
      '\n```',
      '\nDone.',
    ]
    expect(feed(parser, tokens)).toEqual([
      { content: 'I will check.\n' },
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_g',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
          },
        ],
      },
      { content: '\nDone.' },
    ])
    expect(parser.finish('eos')).toBe('tool_calls')
    const plain = new GeniexReplyParser([], false)
    expect(
      feed(plain, tokens)
        .map((d) => ('content' in d ? d.content : '?'))
        .join('')
    ).toBe(tokens.join(''))
    // A fenced block that is not a call stays text, verbatim.
    const code = new GeniexReplyParser([], true)
    expect(
      feed(code, ['```python\n', 'print(1)\n', '```'])
        .map((d) => ('content' in d ? d.content : '?'))
        .join('')
    ).toBe('```python\nprint(1)\n```')
  })

  it('cuts the reply at a stop string, even across tokens, and says when to stop the library', () => {
    const parser = new GeniexReplyParser(['END'], false)
    expect(parser.add('abc E')).toEqual([{ content: 'abc ' }])
    expect(parser.stopped).toBe(false)
    expect(parser.add('ND tail')).toEqual([])
    expect(parser.stopped).toBe(true)
    expect(parser.add('more')).toEqual([])
    expect(parser.flush()).toEqual([])
    expect(parser.message().content).toBe('abc ')
    const held = new GeniexReplyParser(['END'], false)
    held.add('x E')
    expect(held.flush()).toEqual([{ content: 'E' }])
  })

  it('gives back an unfinished marker as text at the end, and keeps a broken tool call as text', () => {
    const open = new GeniexReplyParser([], true)
    expect(feed(open, ['Sure <to'])).toEqual([{ content: 'Sure ' }, { content: '<to' }])
    const broken = new GeniexReplyParser([], true)
    expect(feed(broken, ['<tool_call>', 'not json', '</tool_call>'])).toEqual([
      { content: '<tool_call>not json</tool_call>' },
    ])
    expect(broken.finish('eos')).toBe('stop')
    const unterminated = new GeniexReplyParser([], true)
    expect(feed(unterminated, ['<think>', 'still thinking'])).toEqual([
      { reasoning_content: 'still thinking' },
    ])
  })
})
