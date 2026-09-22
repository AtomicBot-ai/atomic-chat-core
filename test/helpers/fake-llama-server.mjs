#!/usr/bin/env node
/**
 * A stand-in for `llama-server`, close enough that the core cannot tell the difference: it prints
 * the real readiness and device log lines, answers the routes the runtime and the proxy use, and
 * can fail the way a real backend fails (out of memory, SIGSEGV, silence).
 *
 * Driven by argv (the same flags `args.ts` emits) plus env:
 *   FAKE_LLAMA_MODE   ready | no-ready | hang | oom | segv | exit-<code> | projector-fail | mtp-fail |
 *                     tensor-count
 *   FAKE_LLAMA_GPU    1 → print CUDA backend/offload/buffer lines
 *   FAKE_LLAMA_DELAY  milliseconds before the ready line
 *   FAKE_LLAMA_MIN_CTX  chat answers llama.cpp's context-overflow 400 while `--ctx-size` is below this
 *   FAKE_LLAMA_TOOL_CALL  JSON `{"name": ..., "arguments": {...}}`; a chat request that offers a tool of that
 *                         name and carries no tool result yet is answered with that call, and the
 *                         request that brings the result back gets the reply followed by the result
 *   FAKE_LLAMA_COMPLETION_STEPS  JSON array of strings; the Nth `POST /completion` of this process is
 *                         answered with the Nth string (the last one from then on), streamed or not.
 *                         `{{seen:TEXT}}` in a step becomes `yes` or `no`: whether TEXT was in that
 *                         request's prompt. For clients that drive the raw completion endpoint with
 *                         a grammar and expect scripted output, such as an agent loop.
 *   FAKE_LLAMA_COMPUTE_ERROR_MARKER  path; the first chat request anywhere creates it and answers
 *                     llama.cpp's poisoned-backend 500 ("Compute error"), later ones succeed
 *   FAKE_LLAMA_PID_FILE  path; the pid is appended there on startup, one per line, so a test can
 *                     find (and count) children that never became sessions
 *   LLAMA_API_KEY     when set, every route but `/health` demands `Authorization: Bearer <key>`
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
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

if (process.env.FAKE_LLAMA_PID_FILE) appendFileSync(process.env.FAKE_LLAMA_PID_FILE, `${process.pid}\n`)

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
} else if (mode === 'tensor-count') {
  // Printed on stdout, as the loader does it.
  process.stdout.write(
    'llama_model_load: done_getting_tensors: wrong number of tensors; expected 417, got 408\n'
  )
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
    // Real llama-server serves Prometheus metrics at its root (with `--metrics`), behind the key.
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      return res.end(`llamacpp:prompt_tokens_total 3\nllamacpp:requests_processing 0\n`)
    }
    if (url.pathname === '/tokenize') return readBody(req).then((b) => json(200, { tokens: tokenize(b) }))
    if (url.pathname === '/apply-template')
      return readBody(req).then((b) => json(200, { prompt: JSON.stringify(b?.messages ?? []) }))
    if (url.pathname === '/embedding' || url.pathname === '/v1/embeddings')
      return readBody(req).then((body) => {
        if (!argv.includes('--embedding'))
          return json(501, { error: { message: 'embedding mode is disabled' } })
        const input = Array.isArray(body?.input) ? body.input : [body?.input]
        return json(200, {
          object: 'list',
          model: modelAlias,
          data: input.map((text, index) => ({ embedding: [String(text).length, 0.2, 0.3], index })),
          usage: { prompt_tokens: input.length, total_tokens: input.length },
        })
      })
    // Real llama-server answers both the prefixed and unprefixed forms.
    if (url.pathname === '/completion' || url.pathname === '/completions')
      return readBody(req).then((b) => rawCompletion(b, res))
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
  const minCtx = Number(process.env.FAKE_LLAMA_MIN_CTX ?? '0')
  if (minCtx > 0 && Number(flag('--ctx-size', flag('-c', '0'))) < minCtx) {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        error: {
          code: 400,
          message: 'the request exceeds the available context size, try increasing it',
          type: 'exceed_context_size_error',
        },
      })
    )
  }
  const marker = process.env.FAKE_LLAMA_COMPUTE_ERROR_MARKER
  if (marker && !existsSync(marker)) {
    writeFileSync(marker, String(process.pid))
    res.writeHead(500, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: { code: 500, message: 'Compute error.', type: 'server_error' } }))
  }
  // One scripted tool turn: call the tool when it is on offer and has not answered yet; once its
  // result is in the conversation, say the reply and repeat what the tool said, so a test can see
  // that the result reached the model.
  const toolCall = scriptedToolCall(body)
  if (toolCall) return answerWithToolCall(body, res, toolCall)
  const toolResult = lastToolResult(body)
  if (process.env.FAKE_LLAMA_TOOL_CALL && toolResult !== null) {
    return answerWithText(
      body,
      res,
      `${content} | tool said: ${toolResult.replace(/\s+/g, ' ').slice(0, 400)}`
    )
  }
  return answerWithText(body, res, content)
}

let completionsServed = 0

/** llama.cpp's raw `/completion`: one flat prompt in, `content` out, `stop: true` on the last event. */
function rawCompletion(body, res) {
  const steps = JSON.parse(process.env.FAKE_LLAMA_COMPLETION_STEPS ?? '[]')
  const step = steps[Math.min(completionsServed, steps.length - 1)] ?? ''
  completionsServed++
  const prompt = typeof body?.prompt === 'string' ? body.prompt : JSON.stringify(body?.prompt ?? '')
  const content = step.replace(/\{\{seen:([^}]*)\}\}/g, (_, text) => (prompt.includes(text) ? 'yes' : 'no'))
  const tail = {
    stop: true,
    truncated: false,
    tokens_evaluated: 3,
    tokens_predicted: content.length,
    tokens_cached: 0,
    id_slot: body?.id_slot ?? 0,
    model: modelAlias,
    timings: { prompt_n: 3, predicted_n: content.length, prompt_per_second: 100, predicted_per_second: 100 },
  }
  if (!body?.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ content, ...tail }))
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  for (let at = 0; at < content.length; at += 24) {
    res.write(`data: ${JSON.stringify({ content: content.slice(at, at + 24), stop: false })}\n\n`)
  }
  res.write(`data: ${JSON.stringify({ content: '', ...tail })}\n\n`)
  res.end()
}

function scriptedToolCall(body) {
  const raw = process.env.FAKE_LLAMA_TOOL_CALL
  if (!raw || lastToolResult(body) !== null) return null
  const call = JSON.parse(raw)
  const offered = (body?.tools ?? []).some((tool) => tool?.function?.name === call.name)
  return offered ? call : null
}

function lastToolResult(body) {
  const message = [...(body?.messages ?? [])].reverse().find((m) => m?.role === 'tool')
  if (!message) return null
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

function answerWithToolCall(body, res, call) {
  const toolCalls = [
    {
      index: 0,
      id: 'call_fake_1',
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    },
  ]
  if (!body?.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: modelAlias,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: toolCalls },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      })
    )
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  const chunk = (delta, finish_reason) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: modelAlias,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`
  res.write(chunk({ role: 'assistant', content: null, tool_calls: toolCalls }, null))
  res.write(chunk({}, 'tool_calls'))
  res.write('data: [DONE]\n\n')
  res.end()
}

function answerWithText(body, res, content) {
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
