#!/usr/bin/env node
/**
 * A stand-in for `atomic-chat-core litert-host` (change `add-litert-lm-runtime`): the same modes,
 * arguments, readiness line, `/v1/*` routes, exit codes and stop on SIGTERM or stdin end as
 * `src/runtime/litert-lm/host/run.ts` with a real library.
 *
 *   FAKE_LITERT_MODE     ready (default) | crash-after-ready | hang | exit-3 | exit-6 | exit-7
 *   FAKE_LITERT_ARGV     a file each start appends {argv} to
 *   FAKE_LITERT_INSPECT  the JSON `inspect` prints (default: a Gemma 4 E2B file on CPU and GPU)
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const arg = (key) => {
  const at = argv.indexOf(key)
  return at >= 0 ? argv[at + 1] : undefined
}
if (process.env.FAKE_LITERT_ARGV)
  appendFileSync(process.env.FAKE_LITERT_ARGV, `${JSON.stringify({ argv })}\n`)
const mode = process.env.FAKE_LITERT_MODE ?? 'ready'
const INFO = process.env.FAKE_LITERT_INSPECT
  ? JSON.parse(process.env.FAKE_LITERT_INSPECT)
  : {
      model_type: 'llm',
      max_context_tokens: 32003,
      dynamic_context: true,
      function_calling: false,
      thinking: false,
      modalities: ['text', 'vision', 'audio'],
      backends: ['cpu', 'gpu'],
      vision_backends: ['cpu'],
      npu: null,
      speculative_decoding: true,
      min_runtime_version: null,
    }

if (mode === 'exit-3') {
  console.error('LiteRT-LM does not load from build: dlopen: image not found')
  process.exit(3)
}
if (argv[0] === 'probe') {
  console.log(JSON.stringify({ version: '0.18.1', abi: 1, backends: ['cpu', 'gpu'] }))
  process.exit(0)
}
if (argv[0] === 'inspect') {
  const file = argv.at(-1)
  if (!file || !existsSync(file)) {
    console.error(`loaded_file_create: ${file} is not a LiteRT-LM file`)
    process.exit(4)
  }
  console.log(JSON.stringify(INFO))
  process.exit(0)
}
if (argv[0] !== 'serve') {
  console.error(`litert-host: unknown mode ${JSON.stringify(argv[0] ?? '')} (probe, inspect, serve)`)
  process.exit(2)
}

if (mode === 'exit-6') {
  console.error(
    JSON.stringify({ code: 'LITERT_LM_MODEL_REQUIRES_NEWER_ENGINE', required: '0.19', engine: '0.18.1' })
  )
  process.exit(6)
}
if (mode === 'exit-7') {
  console.error(
    JSON.stringify({ code: 'LITERT_LM_VARIANT_UNSUPPORTED', backend: arg('--backend'), backends: ['cpu'] })
  )
  process.exit(7)
}
if (mode === 'hang') setInterval(() => {}, 1_000)
else {
  mkdirSync(arg('--cache'), { recursive: true })
  const id = arg('--id')
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/v1/models')
      return send(200, { object: 'list', data: [{ id, object: 'model', created: 0, owned_by: 'litert-lm' }] })
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const content = `fake reply to ${body.messages?.at(-1)?.content ?? ''}`
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(
            `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: id, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`
          )
          res.write(
            `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
          )
          return res.end('data: [DONE]\n\n')
        }
        send(200, {
          id: 'c',
          object: 'chat.completion',
          model: id,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      })
      return
    }
    send(404, {
      error: {
        message: `${req.method} ${req.url} is not served by LiteRT-LM.`,
        type: 'invalid_request_error',
      },
    })
  })
  server.listen(Number(arg('--port')), '127.0.0.1', () => {
    console.log(
      JSON.stringify({
        ready: true,
        url: `http://127.0.0.1:${server.address().port}`,
        model_id: id,
        backend: arg('--backend'),
        max_num_tokens: Number(arg('--max-tokens')),
        vision: true,
        speculative: argv.includes('--speculative'),
      })
    )
    if (mode === 'crash-after-ready') setTimeout(() => process.exit(9), 200)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stdin.on('end', stop)
  process.stdin.resume()
}
