#!/usr/bin/env node
/**
 * A stand-in for `atomic-chat-core geniex-host` (change `add-geniex-runtime`): the same modes,
 * arguments, readiness line, `/v1/*` routes, exit codes and stop on SIGTERM or stdin end as
 * `src/runtime/geniex/host/run.ts` with a real library.
 *
 *   FAKE_GENIEX_MODE     ready (default) | crash-after-ready | hang | exit-3 | exit-6 | exit-7
 *   FAKE_GENIEX_ARGV     a file each start appends {argv} to
 *   FAKE_GENIEX_DEVICES  the device ids `probe` prints, comma-separated (default: HTP0,GPUOpenCL,CPU)
 *   FAKE_GENIEX_INSPECT  the JSON `inspect` prints (default: a Qwen3 4B Q4_0 GGUF without mmproj)
 */
import { appendFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const arg = (key) => {
  const at = argv.indexOf(key)
  return at >= 0 ? argv[at + 1] : undefined
}
if (process.env.FAKE_GENIEX_ARGV)
  appendFileSync(process.env.FAKE_GENIEX_ARGV, `${JSON.stringify({ argv })}\n`)
const mode = process.env.FAKE_GENIEX_MODE ?? 'ready'
const devices = (process.env.FAKE_GENIEX_DEVICES ?? 'HTP0,GPUOpenCL,CPU').split(',').filter(Boolean)
const INFO = process.env.FAKE_GENIEX_INSPECT
  ? JSON.parse(process.env.FAKE_GENIEX_INSPECT)
  : {
      kind: 'gguf',
      architecture: 'qwen3',
      max_context_tokens: 40960,
      quantization: 'Q4_0',
      chat_template: true,
      vision: false,
    }

if (mode === 'exit-3') {
  console.error('GenieX does not load from build: LoadLibraryW geniex.dll: error 126')
  process.exit(3)
}
if (argv[0] === 'probe') {
  console.log(JSON.stringify({ version: '0.9.3', abi: 1, plugins: ['llama_cpp', 'qairt'], devices }))
  process.exit(0)
}
if (argv[0] === 'inspect') {
  const path = argv.at(-1)
  if (!path || !existsSync(path)) {
    console.error(`inspect: ${path} is not a GGUF file or a bundle folder`)
    process.exit(4)
  }
  console.log(JSON.stringify(INFO))
  process.exit(0)
}
if (argv[0] !== 'serve') {
  console.error(`geniex-host: unknown mode ${JSON.stringify(argv[0] ?? '')} (probe, inspect, serve)`)
  process.exit(2)
}

if (mode === 'exit-6') {
  console.error(
    JSON.stringify({
      code: 'GENIEX_MODEL_REQUIRES_NEWER_ENGINE',
      required: '0.10.0',
      engine: arg('--engine-version'),
    })
  )
  process.exit(6)
}
if (mode === 'exit-7') {
  console.error(
    JSON.stringify({
      code: 'GENIEX_VARIANT_UNSUPPORTED',
      plugin: arg('--plugin'),
      device: arg('--device'),
      message: 'AI Hub bundles run on the NPU only.',
    })
  )
  process.exit(7)
}
if (mode === 'hang') setInterval(() => {}, 1_000)
else {
  const id = arg('--id')
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/v1/models')
      return send(200, { object: 'list', data: [{ id, object: 'model', created: 0, owned_by: 'geniex' }] })
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
      error: { message: `${req.method} ${req.url} is not served by GenieX.`, type: 'invalid_request_error' },
    })
  })
  server.listen(Number(arg('--port')), '127.0.0.1', () => {
    console.log(
      JSON.stringify({
        ready: true,
        url: `http://127.0.0.1:${server.address().port}`,
        model_id: id,
        plugin: arg('--plugin'),
        device: arg('--device'),
        n_ctx: Number(arg('--nctx')),
        vision: argv.includes('--mmproj'),
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
