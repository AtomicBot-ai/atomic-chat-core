#!/usr/bin/env node
/**
 * A stand-in for the two sidecar servers the app bundles, `foundation-models-server` and
 * `mlx-server`: it prints their real readiness and failure lines, answers the routes clients use,
 * and fails the way they fail. Launched as `node <script> <the real argv>`.
 *
 * Driven by argv plus env:
 *   FAKE_SIDECAR_KIND   fm | mlx
 *   FAKE_SIDECAR_MODE   ready | hang | error-line | exit-<code> | exit-clean | oom
 *   FAKE_SIDECAR_DELAY  milliseconds before the ready line
 *   FAKE_SIDECAR_ARGV   path; the argv is written there as JSON (appended as one line per start)
 *   FAKE_SIDECAR_REASON the reason in the `[foundation-models] ERROR:` line (error-line mode)
 *   FAKE_FM_CHECK       what `--check` prints (fm)
 *   FAKE_SIDECAR_REPLY  what a chat completion says (`fake <kind> reply` by default); a request with
 *                       `stream: true` gets it as SSE chunks, one word each, the way the real servers do
 *   FAKE_MLX_MIN_CTX    chat answers mlx-vlm's KV overflow while `--max-kv-size` is below this (mlx)
 */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const kind = process.env.FAKE_SIDECAR_KIND ?? 'fm'
const mode = process.env.FAKE_SIDECAR_MODE ?? 'ready'
const port = Number(flag('--port', '0'))
const apiKey = flag('--api-key', '')
const out = (line) => process.stdout.write(`${line}\n`)
const err = (line) => process.stderr.write(`${line}\n`)

if (process.env.FAKE_SIDECAR_ARGV) appendFileSync(process.env.FAKE_SIDECAR_ARGV, `${JSON.stringify(argv)}\n`)

if (kind === 'fm' && argv.includes('--check')) {
  out(process.env.FAKE_FM_CHECK ?? 'available')
  process.exit(0)
}

if (kind === 'fm') {
  out('[foundation-models] Foundation Models Server starting...')
  out(`[foundation-models] Port: ${port}`)
} else {
  err(`Loading model from ${flag('--model', '')}`)
}

if (mode === 'hang') {
  setInterval(() => {}, 1000)
} else if (mode === 'error-line') {
  err(
    `[foundation-models] ERROR: ${process.env.FAKE_SIDECAR_REASON ?? 'Apple Intelligence is not enabled in System Settings'}`
  )
  // The real server exits right after; stay a moment so a fail-fast reader is what reports it.
  setTimeout(() => process.exit(1), 300)
} else if (mode === 'oom') {
  err(
    'libc++abi: terminating due to uncaught exception of type std::runtime_error: [metal::malloc] Attempting to allocate 18253611008 bytes which is greater than the maximum allowed buffer size of 17179869184 bytes.'
  )
  process.exit(134)
} else if (mode === 'exit-clean') {
  process.exit(0)
} else if (mode.startsWith('exit-')) {
  err('Traceback (most recent call last): ...')
  process.exit(Number(mode.slice('exit-'.length)))
} else {
  const minCtx = Number(process.env.FAKE_MLX_MIN_CTX ?? 0)
  const maxKv = Number(flag('--max-kv-size', '0'))
  const server = createServer((req, res) => {
    const send = (status, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    }
    if (req.url === '/health') return send(200, { status: 'ok' })
    if (kind === 'fm' && apiKey && req.headers.authorization !== `Bearer ${apiKey}`)
      return send(401, {
        error: {
          message: 'Unauthorized: invalid or missing API key',
          type: 'authentication_error',
          code: 'unauthorized',
        },
      })
    if (req.url === '/v1/models')
      return send(200, {
        object: 'list',
        data: [{ id: kind === 'fm' ? 'apple/on-device' : flag('--model', ''), object: 'model' }],
      })
    if (req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (kind === 'mlx' && minCtx > 0 && maxKv > 0 && maxKv < minCtx)
          return send(500, { detail: `Generation failed: kv cache exceeded max_kv_size=${maxKv}` })
        const model = kind === 'fm' ? 'apple/on-device' : flag('--model', '')
        const content = process.env.FAKE_SIDECAR_REPLY ?? `fake ${kind} reply`
        let wantsStream = false
        try {
          wantsStream = JSON.parse(body || '{}').stream === true
        } catch {
          // not JSON: answer as a plain completion
        }
        if (wantsStream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          const chunk = (delta, finish_reason) =>
            `data: ${JSON.stringify({
              id: 'chatcmpl-fake',
              object: 'chat.completion.chunk',
              model,
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`
          content.split(' ').forEach((word, i) => {
            res.write(chunk(i === 0 ? { role: 'assistant', content: word } : { content: ` ${word}` }, null))
          })
          res.write(chunk({}, 'stop'))
          res.write('data: [DONE]\n\n')
          return res.end()
        }
        send(200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        })
      })
      return
    }
    send(404, { detail: 'Not Found' })
  })
  server.listen(port, '127.0.0.1', () => {
    setTimeout(
      () => {
        if (kind === 'fm') {
          out(`[foundation-models] http server listening on http://127.0.0.1:${port}`)
          out(`[foundation-models] server is listening on 127.0.0.1:${port}`)
          err(
            `2026-09-17T12:36:50+1000 info Hummingbird: [HummingbirdCore] Server started and listening on 127.0.0.1:${port}`
          )
        } else {
          err(`INFO:     Uvicorn running on http://127.0.0.1:${port} (Press CTRL+C to quit)`)
        }
      },
      Number(process.env.FAKE_SIDECAR_DELAY ?? 0)
    )
  })
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
