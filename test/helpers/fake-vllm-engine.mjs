#!/usr/bin/env node
/**
 * What `fake-model-docker.mjs` runs as a `vllm serve` container (change `add-vllm-runtime`, task 3.4): a
 * tiny OpenAI-compatible server on the given port, shaped like vLLM 0.31 where the e2e looks.
 * `GET /health` answers 200 (or 503 forever in `slow` mode); the completion routes echo the request
 * body back as `received` and the `Authorization` header they got as `auth`, stream when asked, and
 * answer a prompt containing `OVERFLOW` with vLLM's own context-overflow error. Every other route —
 * `/v1/embeddings`, `/metrics`, `/tokenize` — answers as vLLM would, so a test proves the session
 * gateway never let a request reach it (the answer would say `reached: true`).
 *
 *   node fake-vllm-engine.mjs <port> <ready|slow>
 */
import { createServer } from 'node:http'

const [port, mode] = process.argv.slice(2)
const OVERFLOW = {
  object: 'error',
  message:
    "This model's maximum context length is 8192 tokens. However, your request has 9000 input tokens. Please reduce the length of the input messages.",
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
      json(200, { object: 'list', data: [{ id: 'engine-model', object: 'model', owned_by: 'vllm' }] })
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
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello from vllm' } }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      json(200, {
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello from vllm' }, finish_reason: 'stop' }],
        received: parsed,
        auth: req.headers.authorization ?? null,
      })
      return
    }
    json(200, { reached: true, url: req.url })
  })
}).listen(Number(port), '127.0.0.1')
