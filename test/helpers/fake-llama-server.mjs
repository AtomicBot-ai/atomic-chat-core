#!/usr/bin/env node
/**
 * A stand-in for `llama-server`, close enough that the core cannot tell the difference: it prints
 * the real readiness and device log lines, answers the routes the runtime and the proxy use, and
 * can fail the way a real backend fails (out of memory, SIGSEGV, silence).
 *
 * Driven by argv (the same flags `args.ts` emits) plus env:
 *   FAKE_LLAMA_MODE   ready | no-ready | hang | oom | segv | exit-<code> | projector-fail | mtp-fail
 *   FAKE_LLAMA_GPU    1 → print CUDA backend/offload/buffer lines
 *   FAKE_LLAMA_DELAY  milliseconds before the ready line
 *   LLAMA_API_KEY     when set, every route but `/health` demands `Authorization: Bearer <key>`
 */
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const mode = process.env.FAKE_LLAMA_MODE ?? 'ready'
const port = Number(flag('--port', '0'))
const modelPath = flag('-m', flag('--model', ''))
const modelAlias = flag('-a', flag('--alias', 'fake-model'))
const apiKey = process.env.LLAMA_API_KEY ?? ''
const err = (line) => process.stderr.write(`${line}\n`)

if (argv.includes('--list-devices')) {
  process.stdout.write('Available devices:\n')
  process.stdout.write('  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 23875 MiB free)\n')
  process.stdout.write('  Vulkan0: NVIDIA GeForce RTX 4090 (24564 MiB, 23875 MiB free)\n')
  process.exit(0)
}
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write('usage: llama-server [options]\n')
  process.stdout.write(
    process.env.FAKE_LLAMA_SPEC_TYPES ?? '  --spec-type {draft-mtp}    speculative decoding type\n'
  )
  process.exit(0)
}

// ── startup log, as llama.cpp prints it ───────────────────────────────────────
err(`build: 6325 (fake) with cc (GCC) 13.2.0 for x86_64-linux-gnu`)
if (process.env.FAKE_LLAMA_GPU === '1') {
  err('load_backend: loaded CUDA backend from /backends/libggml-cuda.so')
  err('load_backend: loaded CPU backend from /backends/libggml-cpu.so')
}
err(`llama_model_loader: loaded meta data with 30 key-value pairs from ${modelPath}`)
if (process.env.FAKE_LLAMA_GPU === '1') {
  err('load_tensors: offloaded 33/33 layers to GPU')
  err('load_tensors:        CUDA0 model buffer size =  3820.93 MiB')
  err('load_tensors:          CPU model buffer size =   102.50 MiB')
}

if (mode === 'hang') {
  setInterval(() => {}, 1000) // never ready, never exits
} else if (mode === 'oom') {
  err('ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 4096.00 MiB on device 0')
  err('llama_model_load: error loading model: unable to allocate CUDA0 buffer')
  process.exit(1)
} else if (mode === 'projector-fail') {
  err('clip_model_load: unknown projector type: fake-projector')
  err('mtmd_init_from_file: failed to load CLIP model')
  process.exit(1)
} else if (mode === 'mtp-fail') {
  err("main: the draft model doesn't contain MTP layers")
  process.exit(1)
} else if (mode === 'segv') {
  process.kill(process.pid, 'SIGSEGV')
} else if (mode.startsWith('exit-')) {
  err('main: error: something went wrong')
  process.exit(Number(mode.slice('exit-'.length)) || 1)
} else {
  startServer()
}

function unauthorized(req) {
  if (!apiKey) return false
  const header = req.headers.authorization ?? ''
  return header !== `Bearer ${apiKey}`
}

function startServer() {
  let ready = mode !== 'no-ready'
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/health') return json(ready ? 200 : 503, { status: ready ? 'ok' : 'loading' })
    if (unauthorized(req))
      return json(401, { error: { message: 'Invalid API key', type: 'authentication_error' } })
    if (url.pathname === '/props')
      return json(200, {
        default_generation_settings: { n_ctx: 4096 },
        total_slots: 1,
        chat_template: '{{ messages }}',
        modalities: { vision: false, audio: false },
      })
    if (url.pathname === '/v1/models')
      return json(200, { object: 'list', data: [{ id: modelAlias, object: 'model', owned_by: 'llamacpp' }] })
    if (url.pathname === '/tokenize') return readBody(req).then((b) => json(200, { tokens: tokenize(b) }))
    if (url.pathname === '/apply-template')
      return readBody(req).then((b) => json(200, { prompt: JSON.stringify(b?.messages ?? []) }))
    if (url.pathname === '/embedding' || url.pathname === '/v1/embeddings')
      return readBody(req).then(() => json(200, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }))
    // Real llama-server answers both the prefixed and unprefixed forms.
    if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')
      return readBody(req).then((b) => completions(b, res))
    return json(404, { error: { message: `no route ${url.pathname}`, type: 'not_found' } })
  })
  server.listen(port, '127.0.0.1', () => {
    const bound = server.address().port
    const delay = Number(process.env.FAKE_LLAMA_DELAY ?? '0')
    const announce = () => {
      if (mode === 'no-ready') return
      err(`main: server is listening on http://127.0.0.1:${bound} - starting the main loop`)
      err('srv  update_slots: all slots are idle')
      ready = true
    }
    if (delay > 0) setTimeout(announce, delay).unref?.()
    else announce()
  })
  process.on('SIGTERM', () => {
    server.close()
    process.exit(0)
  })
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })

const tokenize = (body) => {
  const text = typeof body?.content === 'string' ? body.content : ''
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((_, i) => 1000 + i)
}

function completions(body, res) {
  const content = process.env.FAKE_LLAMA_REPLY ?? 'hello from the fake backend'
  if (!body?.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: modelAlias,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: content.split(' ').length, total_tokens: 10 },
      })
    )
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  const words = content.split(' ')
  let i = 0
  const tick = () => {
    if (res.writableEnded) return
    if (i < words.length) {
      const delta = i === 0 ? { role: 'assistant', content: words[i] } : { content: ` ${words[i]}` }
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: modelAlias,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`
      )
      i++
      return void setTimeout(tick, 5)
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: modelAlias,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`
    )
    res.write('data: [DONE]\n\n')
    res.end()
  }
  tick()
}
