#!/usr/bin/env node
/**
 * What `fake-model-docker.mjs` runs as "the container": a tiny OpenAI-compatible server on the given
 * port, shaped like `trtllm-serve` where the e2e looks. `GET /health` answers 200 (or 503 forever in
 * `slow` mode); the completion routes echo the request body back as `received`, stream when asked, and
 * answer a prompt containing `OVERFLOW` with `trtllm-serve`'s own context-overflow error.
 *
 *   node fake-model-engine.mjs <port> <ready|slow>
 */
import { createServer } from 'node:http'

const [port, mode] = process.argv.slice(2)
const OVERFLOW = {
  object: 'error',
  message: 'The sum of prompt length (9000), query length (0) should not exceed max_num_tokens (8192)',
  type: 'BadRequestError',
  param: null,
  code: 400,
}

createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.url === '/health') {
      res.writeHead(mode === 'slow' ? 503 : 200)
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      json(200, { object: 'list', data: [{ id: 'engine-model', object: 'model' }] })
      return
    }
    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/v1/completions')) {
      if (body.includes('OVERFLOW')) {
        json(400, OVERFLOW)
        return
      }
      const parsed = JSON.parse(body || '{}')
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' } }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      json(200, {
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hello from the container' },
            finish_reason: 'stop',
          },
        ],
        received: parsed,
      })
      return
    }
    json(404, { detail: 'Not Found' })
  })
}).listen(Number(port), '127.0.0.1')
