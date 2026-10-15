#!/usr/bin/env node
/**
 * A stand-in for `atomic-chat-core foundry-host serve` (change `add-foundry-local`): the same
 * arguments, readiness line, `/catalogs/local/v1/*` routes, registration-id model matching and stop
 * on SIGTERM or stdin end as `src/runtime/foundry-local/host/run.ts` with a real library.
 *
 *   FAKE_FOUNDRY_MODE  ready (default) | crash-after-ready | hang | exit-3 | exit-5
 *   FAKE_FOUNDRY_ARGV  a file each start appends {argv, ort_telemetry_disabled, ci} to
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const arg = (key) => {
  const at = argv.indexOf(key)
  return at >= 0 ? argv[at + 1] : undefined
}
if (process.env.FAKE_FOUNDRY_ARGV)
  appendFileSync(
    process.env.FAKE_FOUNDRY_ARGV,
    `${JSON.stringify({
      argv,
      ort_telemetry_disabled: process.env.ORT_TELEMETRY_DISABLED ?? null,
      ci: process.env.CI ?? null,
    })}\n`
  )
const mode = process.env.FAKE_FOUNDRY_MODE ?? 'ready'
if (mode === 'exit-5') {
  console.error(
    'WebGpuExecutionProvider is not prepared on this computer; prepare it before loading this model.'
  )
  process.exit(5)
}
if (mode === 'exit-3') {
  console.error('foundry_local does not load from /b: libatomic.so.1: cannot open shared object file')
  process.exit(3)
}

const port = Number(arg('--port'))
const id = arg('--id')
const cache = arg('--cache')
mkdirSync(cache, { recursive: true })

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    if (!req.url.startsWith('/catalogs/local/v1/'))
      return send(res, 404, { error: { message: `the public catalog is not served here: ${req.url}` } })
    const path = req.url.slice('/catalogs/local'.length)
    if (req.method === 'GET' && path === '/v1/models')
      return send(res, 200, { object: 'list', data: [{ id, object: 'model', owned_by: 'local' }] })
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const request = JSON.parse(body || '{}')
      if (request.model !== id)
        return send(res, 404, { error: { message: `Model not found: No model matching '${request.model}'` } })
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(
          `data: ${JSON.stringify({ model: id, choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`
        )
        return res.end('data: [DONE]\n\n')
      }
      return send(res, 200, {
        model: id,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi from fake foundry' } }],
        usage: { completion_tokens: 4 },
      })
    }
    send(res, 404, { error: { message: 'no such route' } })
  })
})

if (mode !== 'hang')
  server.listen(port, '127.0.0.1', () => {
    console.log(
      JSON.stringify({
        ready: true,
        url: `http://127.0.0.1:${port}`,
        base_path: '/catalogs/local',
        model_id: id,
        execution_provider: arg('--ep'),
      })
    )
    if (mode === 'crash-after-ready')
      setTimeout(
        () => {
          console.error('onnxruntime: fatal error in the generator')
          process.exit(134)
        },
        Number(process.env.FAKE_FOUNDRY_CRASH_MS ?? 300)
      )
  })

const stop = () => {
  server.close()
  rmSync(cache, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', stop)
process.stdin.on('end', stop)
process.stdin.resume()
if (mode === 'hang') setInterval(() => {}, 1000)
