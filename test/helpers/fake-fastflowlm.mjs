// A separate local-only process. Its HTTP fixtures exercise the real gateway, sockets and journal.
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const checkpoint = args[1],
  port = Number(args[args.indexOf('--port') + 1])
const cache = process.cwd()
if (!args.includes('--atomic-local-only') || process.env.HF_TOKEN || process.env.FLM_BACKEND) process.exit(2)
let busy = false,
  stuck = false
const server = createServer(async (req, res) => {
  const send = (code, data) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (req.url === '/v1/models') {
    writeFileSync(join(cache, 'listened'), '')
    return send(200, {
      object: 'list',
      data: existsSync(join(cache, 'ready')) ? [{ object: 'model', id: checkpoint }] : [],
    })
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  if (!body.messages) {
    if (stuck) return
    return send(busy ? 503 : 400, { error: busy ? 'busy' : 'invalid_local_request' })
  }
  if (body.model !== checkpoint) return send(400, { error: 'wrong checkpoint' })
  const text = body.messages[0].content
  appendFileSync(join(cache, 'requests.jsonl'), JSON.stringify(body) + '\n')
  if (text === 'hold' || text === 'hang') {
    stuck = text === 'hang'
    busy = true
    res.once('close', () => {
      // The native handler can take time to observe the closed socket and release the NPU.
      if (!stuck)
        setTimeout(() => {
          busy = false
        }, 200)
    })
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'data: ' + JSON.stringify({ model: checkpoint, choices: [{ delta: { content: 'hello' } }] }) + '\n\n'
      )
    }
    writeFileSync(join(cache, 'generating'), '')
    return
  }
  if (text === 'crash') {
    process.exit(8)
  }
  const result = {
    model: checkpoint,
    usage: { completion_tokens: 1 },
    choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
  }
  if (text === 'tool-result') {
    const call = {
      id: 'call-1',
      type: 'function',
      function: { name: 'weather', arguments: '{"city":"Paris"}' },
    }
    result.choices = [
      {
        [body.stream ? 'delta' : 'message']: {
          role: 'assistant',
          content: null,
          reasoning_content: 'Look up weather.',
          tool_calls: [call],
        },
        finish_reason: 'tool_calls',
      },
    ]
  }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify(result) + '\n\ndata: [DONE]\n\n')
    return
  }
  send(200, result)
})
server.listen(port, '127.0.0.1', () =>
  console.log('[FLM]  WebServer started on port ' + port + ' with 1 I/O threads')
)
