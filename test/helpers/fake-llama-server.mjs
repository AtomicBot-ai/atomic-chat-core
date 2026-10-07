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
 *   FAKE_LLAMA_ARGV_FILE  path; one JSON record per start is appended there — pid, label, argv and
 *                     the inference-relevant environment. It is what a test reads instead of `ps`,
 *                     which only ever shows a process that is still alive. Written after the
 *                     `--list-devices` and `-h` probes, so the file holds starts, not probes.
 *   FAKE_LLAMA_DEVICES  `;`-separated device lines for `--list-devices` (e.g.
 *                     `MTL0: Apple M4 Pro (18186 MiB, 18185 MiB free)`); a CUDA + Vulkan pair by default
 *   FAKE_LLAMA_LABEL  free-form name of the pack that launched this fake; recorded verbatim
 *   FAKE_LLAMA_STDOUT text; printed as one stdout line among the startup log, which llama.cpp itself
 *                     writes to stderr, so a test can follow both of the engine's streams
 *   LLAMA_API_KEY     when set, every route but `/health`, `/v1/health`, `/models` and `/v1/models`
 *                     demands `Authorization: Bearer <key>` (the real server's public endpoints)
 *   FAKE_LLAMA_DECISION  1 → a TurboQuant build with the decision role (1.7.0+): `-h` lists `--decision`,
 *                     and started with `--decision` the fake is a decision server (DECISION.md): no
 *                     chat routes; `/health`, `/v1/models` (capabilities), `/props.decision`,
 *                     `POST /v1/systemone`, `POST /v1/router/score`, with the engine's error envelope.
 *                     Without it, `--decision` is an unknown argument (an older build): exit 1.
 *                     Every decision answer carries `x-fake-body-sha256` / `x-fake-body-bytes` of the
 *                     raw request body it received, so a test can prove a passthrough is byte-exact.
 *   FAKE_DECISION_API_VERSION  `/props.decision.api_version` (default 1)
 *   FAKE_DECISION_CALIBRATED   0 → no router calibration: `/v1/router/score` answers 501
 *                     `ROUTER_NOT_CALIBRATED` unless started with `--decision-allow-uncalibrated`
 *   FAKE_DECISION_DELAY_MS     milliseconds before each systemone / router answer
 *   FAKE_DECISION_LOAD_MS      `/health` answers 503 for this long after the start (the engine loading)
 *   FAKE_DECISION_NO_CAPABILITY  1 → `/v1/models` lists no `decision` capability (not a decision server)
 *   FAKE_DECISION_UPSTREAM     1 → stock llama.cpp b11370+ with an upstream decision GGUF: a decision
 *                     server without `--decision`, `/v1/models` lists `architecture.output_modalities`
 *                     `["decisions"]` (and `image` input with `--mmproj`), `/props` has no decision
 *                     block, `/v1/router/score` is a 404, and `/v1/systemone` answers only `answers`
 *                     and `usage`, as upstream does.
 *   FAKE_EMBEDDING_AUDIO   1 → with `--embedding --mmproj`, `/props.modalities` also says `audio` (the
 *                     projector has an audio encoder); with `--mmproj` alone it says `vision` only.
 *                     In embedding mode a `/v1/embeddings` input may be a `{content: [parts]}` item: its
 *                     vector's first number is the count of its parts, a text item's is its length.
 *                     Every `/v1/embeddings` answer carries `x-fake-body-sha256` of the raw body it received.
 *   FAKE_EMBEDDING_VIDEO   1 → with `--embedding --mmproj`, `/props.modalities` also says `video`
 *   FAKE_EMBEDDING_REFUSE  1 → `/v1/embeddings` answers 400 (a pooling the OpenAI endpoint cannot
 *                     serve), as llama.cpp does for a model without pooling
 *   FAKE_DECISION_NO_CONVERT   1 → a build from before the converter: `-h` does not list
 *                     `--decision-convert-cache`, and `-m <folder>` fails the load with exit 1.
 *                     Otherwise `-m <folder>` is a laya checkpoint (it needs `rl_agent_config.json`):
 *                     "converted" into `<--decision-convert-cache>/<key>/<folder name>.gguf` once,
 *                     a cache hit after that, and reported in `/props.decision` (`source`,
 *                     `cache_path`, `checkpoint`).
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'

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
  if (process.env.FAKE_LLAMA_DEVICES !== undefined) {
    for (const line of process.env.FAKE_LLAMA_DEVICES.split(';')) process.stdout.write(`  ${line}\n`)
  } else {
    process.stdout.write('  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 23875 MiB free)\n')
    process.stdout.write('  Vulkan0: NVIDIA GeForce RTX 4090 (24564 MiB, 23875 MiB free)\n')
  }
  process.exit(0)
}
const decisionBuild = process.env.FAKE_LLAMA_DECISION === '1'
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write('usage: llama-server [options]\n')
  process.stdout.write(
    process.env.FAKE_LLAMA_SPEC_TYPES ?? '  --spec-type {draft-mtp}    speculative decoding type\n'
  )
  if (decisionBuild) {
    process.stdout.write(
      '  --decision                  serve a decision model (/v1/systemone, /v1/router/score)\n'
    )
    process.stdout.write('  --decision-spec FILE        decision spec replacing the one in the GGUF\n')
    if (process.env.FAKE_DECISION_NO_CONVERT !== '1') {
      process.stdout.write('  --decision-convert-cache DIR  where a checkpoint directory is converted to\n')
      process.stdout.write('  --decision-convert-type TYPE  f16 or f32\n')
    }
  }
  process.exit(0)
}
const upstreamDecision = decisionBuild && process.env.FAKE_DECISION_UPSTREAM === '1'
const decisionMode = argv.includes('--decision') || upstreamDecision
if (decisionMode && !decisionBuild) {
  err('error: invalid argument: --decision')
  process.exit(1)
}

if (process.env.FAKE_LLAMA_PID_FILE) appendFileSync(process.env.FAKE_LLAMA_PID_FILE, `${process.pid}\n`)
if (process.env.FAKE_LLAMA_ARGV_FILE) {
  // Only the variables that decide how a model loads. `PATH` is deliberately left out: it is long,
  // it is noise, and a record past the pipe buffer would interleave with the record of a fake that
  // started at the same moment — which happens whenever a model switch overlaps an embedding load.
  const kept = /^(LLAMA_|GGML_|CUDA_|HIP_|ROCR_|HSA_)|_LIBRARY_PATH$/
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (kept.test(key)) env[key] = value
  appendFileSync(
    process.env.FAKE_LLAMA_ARGV_FILE,
    `${JSON.stringify({
      pid: process.pid,
      atMs: Date.now(),
      label: process.env.FAKE_LLAMA_LABEL ?? '',
      exe: process.argv[1],
      argv,
      env,
    })}\n`
  )
}

// ── startup log, as llama.cpp prints it ───────────────────────────────────────
err(`build: 6325 (fake) with cc (GCC) 13.2.0 for x86_64-linux-gnu`)
if (process.env.FAKE_LLAMA_STDOUT) process.stdout.write(`${process.env.FAKE_LLAMA_STDOUT}\n`)
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
} else if (decisionMode) {
  startDecisionServer()
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
    if (url.pathname === '/health' || url.pathname === '/v1/health')
      return json(ready ? 200 : 503, { status: ready ? 'ok' : 'loading' })
    if (url.pathname === '/v1/models' || url.pathname === '/models')
      return json(200, { object: 'list', data: [{ id: modelAlias, object: 'model', owned_by: 'llamacpp' }] })
    if (unauthorized(req))
      return json(401, { error: { message: 'Invalid API key', type: 'authentication_error' } })
    if (url.pathname === '/props') {
      const embeddingProjector = argv.includes('--embedding') && argv.includes('--mmproj')
      return json(200, {
        default_generation_settings: { n_ctx: 4096 },
        total_slots: 1,
        chat_template: '{{ messages }}',
        modalities: {
          vision: embeddingProjector,
          audio: embeddingProjector && process.env.FAKE_EMBEDDING_AUDIO === '1',
          video: embeddingProjector && process.env.FAKE_EMBEDDING_VIDEO === '1',
        },
      })
    }
    // Real llama-server serves Prometheus metrics at its root (with `--metrics`), behind the key.
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      return res.end(`llamacpp:prompt_tokens_total 3\nllamacpp:requests_processing 0\n`)
    }
    if (url.pathname === '/tokenize') return readBody(req).then((b) => json(200, { tokens: tokenize(b) }))
    if (url.pathname === '/apply-template')
      return readBody(req).then((b) => json(200, { prompt: JSON.stringify(b?.messages ?? []) }))
    if (url.pathname === '/embedding' || url.pathname === '/v1/embeddings')
      return readRawBody(req).then(({ raw, body }) => {
        // The bytes it received, so a test can prove a passthrough left them alone.
        res.setHeader('x-fake-body-sha256', createHash('sha256').update(raw).digest('hex'))
        if (!argv.includes('--embedding'))
          return json(501, { error: { message: 'embedding mode is disabled' } })
        if (process.env.FAKE_EMBEDDING_REFUSE === '1')
          return json(400, {
            error: {
              code: 400,
              message: "Pooling type 'none' is not OAI compatible",
              type: 'invalid_request_error',
            },
          })
        const input = Array.isArray(body?.input) ? body.input : [body?.input]
        const first = (item) => (Array.isArray(item?.content) ? item.content.length : String(item).length)
        return json(200, {
          object: 'list',
          model: modelAlias,
          data: input.map((item, index) => ({ embedding: [first(item), 0.2, 0.3], index })),
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

/** The body as bytes, and parsed (`{}` when it is not JSON). */
const readRawBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let body = {}
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
      } catch {
        body = {}
      }
      resolve({ raw, body })
    })
  })

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

// ── decision mode (DECISION.md, API version 1) ─────────────────────────────────

/** `-m <folder>`: the conversion the real engine does, as files and `/props` fields; exits on a refusal. */
function convertCheckpoint() {
  const isDir = (() => {
    try {
      return statSync(modelPath).isDirectory()
    } catch {
      return false
    }
  })()
  if (!isDir) return { source: 'gguf', cache_path: null, checkpoint: null }
  if (process.env.FAKE_DECISION_NO_CONVERT === '1') {
    err(`llama_model_load: error loading model: failed to open ${modelPath}: is a directory`)
    process.exit(1)
  }
  if (!existsSync(join(modelPath, 'rl_agent_config.json'))) {
    err(`decision: ${modelPath} is a directory but not a laya checkpoint`)
    process.exit(1)
  }
  const outtype = flag('--decision-convert-type', 'f16')
  const cacheDir = flag('--decision-convert-cache', join(modelPath, '..', '.fake-gguf-cache'))
  const name = basename(modelPath)
  const key = createHash('sha256').update(`${outtype}\0${name}`).digest('hex').slice(0, 32)
  const cachePath = join(cacheDir, key, `${name}.gguf`)
  const cacheHit = existsSync(cachePath)
  if (!cacheHit) {
    mkdirSync(join(cacheDir, key), { recursive: true })
    writeFileSync(cachePath, 'GGUF')
  }
  err(`decision: ${cacheHit ? 'cache hit' : 'converted'}: ${cachePath}`)
  return {
    source: 'checkpoint-dir',
    cache_path: cachePath,
    checkpoint: {
      dir: modelPath,
      cache_dir: cacheDir,
      key,
      outtype,
      cache_hit: cacheHit,
      convert_ms: cacheHit ? 0 : 5,
      converter: 1,
    },
  }
}

function startDecisionServer() {
  const converted = upstreamDecision ? {} : convertCheckpoint()
  const startedAt = Date.now()
  const loadMs = Number(process.env.FAKE_DECISION_LOAD_MS ?? '0')
  const delayMs = Number(process.env.FAKE_DECISION_DELAY_MS ?? '0')
  const apiVersion = Number(process.env.FAKE_DECISION_API_VERSION ?? '1')
  const calibrated = process.env.FAKE_DECISION_CALIBRATED !== '0'
  const allowUncalibrated = argv.includes('--decision-allow-uncalibrated')
  const routerServes = calibrated || allowUncalibrated
  const alias = flag(
    '-a',
    flag('--alias', modelPath.replace(/^.*[\\/]/, '').replace(/\.gguf$/, '') || 'fake-decision')
  )
  const threads = Number(flag('-t', '4'))
  const specSha = '0'.repeat(64)
  const runtime = {
    layout: 'laya',
    format: 'laya-v1',
    plan: 'sequential',
    spec_sha256: specSha,
    calibration: 'none',
  }
  const capabilities = ['decision', 'systemone', ...(calibrated ? ['router_score'] : [])]
  const loaded = () => Date.now() - startedAt >= loadMs

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const bodyHeaders = {
        'x-fake-body-sha256': createHash('sha256').update(raw).digest('hex'),
        'x-fake-body-bytes': String(raw.length),
      }
      const send = (status, body, extra = {}) => {
        const text = JSON.stringify(body)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          ...(status >= 400 ? { connection: 'close' } : {}),
          ...extra,
        })
        res.end(text)
      }
      const fail = (status, reason, message, param) =>
        send(
          status,
          {
            error: {
              code: status,
              type: status === 501 ? 'not_supported_error' : 'invalid_request_error',
              reason,
              message,
              ...(param ? { param } : {}),
            },
          },
          bodyHeaders
        )
      if (url.pathname === '/health' || url.pathname === '/v1/health')
        return loaded()
          ? send(200, { status: 'ok', ok: true, model: alias, layout: 'laya' })
          : send(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } })
      if (upstreamDecision && (url.pathname === '/v1/models' || url.pathname === '/models'))
        return send(200, {
          object: 'list',
          data: [
            {
              id: alias,
              object: 'model',
              owned_by: 'llamacpp',
              architecture: {
                input_modalities: argv.includes('--mmproj') ? ['text', 'image'] : ['text'],
                output_modalities: process.env.FAKE_DECISION_NO_CAPABILITY === '1' ? ['text'] : ['decisions'],
              },
            },
          ],
          models: [{ name: alias, model: alias, capabilities: ['completion'] }],
        })
      if (url.pathname === '/v1/models' || url.pathname === '/models')
        return send(200, {
          object: 'list',
          data: [
            {
              id: alias,
              object: 'model',
              owned_by: 'llamacpp',
              ...(process.env.FAKE_DECISION_NO_CAPABILITY === '1' ? {} : { capabilities }),
              decision: { api_version: apiVersion, layout: 'laya', model_id: alias, model_version: '0.0.0' },
            },
          ],
        })
      if (!loaded())
        return send(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } })
      if (unauthorized(req))
        return send(401, { error: { code: 401, message: 'Invalid API Key', type: 'authentication_error' } })
      if (upstreamDecision && url.pathname === '/props' && req.method === 'GET')
        return send(200, { model_alias: alias, model_path: modelPath, build_info: 'b11436-fake' })
      if (url.pathname === '/props' && req.method === 'GET')
        return send(200, {
          model_alias: alias,
          model_path: modelPath,
          build_info: 'b10269-fake',
          decision: {
            api_version: apiVersion,
            endpoints: ['/v1/systemone', '/v1/router/score'],
            layout: 'laya',
            format: 'laya-v1',
            model_id: alias,
            model_version: '0.0.0',
            spec_version: 1,
            spec_sha256: specSha,
            spec_source: argv.includes('--decision-spec') ? 'file' : 'default',
            question_types: ['noul', 'choice', 'score'],
            limits: {
              max_questions: 16,
              max_candidates: 16,
              max_options: 20,
              max_checks: 32,
              max_tokens: 1024,
            },
            confidence: 'laya',
            calibration: { method: 'none', calibrated: false, version: 'none' },
            router: {
              available: routerServes,
              calibrated,
              method: calibrated ? 'platt' : 'none',
              card_schema: 'atomic.executor-card/1',
              card_renderer: 'card-v1',
            },
            plan: { name: 'sequential', router: 'sequential', n_threads: threads },
            device: 'cpu',
            ...converted,
            future_field: { added_by: 'a newer engine' },
          },
        })
      const isSystemone = url.pathname === '/v1/systemone'
      const isRouter = url.pathname === '/v1/router/score'
      if (!(isSystemone || (isRouter && !upstreamDecision)) || req.method !== 'POST')
        return send(404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } })
      if (isRouter && !routerServes)
        return fail(501, 'ROUTER_NOT_CALIBRATED', 'this model has no router calibration')
      let body
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch (e) {
        return fail(400, 'MALFORMED_JSON', `malformed JSON: ${e.message}`)
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body))
        return fail(400, 'BODY_NOT_OBJECT', 'the body must be a JSON object')
      const answer = () => (isSystemone ? systemone(body) : routerScore(body))
      if (delayMs > 0) setTimeout(answer, delayMs)
      else answer()

      function systemone(b) {
        if (b.state === undefined || b.state === null)
          return fail(400, 'INVALID_REQUEST', 'state is required', 'state')
        if (typeof b.questions !== 'object' || b.questions === null || Array.isArray(b.questions))
          return fail(400, 'INVALID_REQUEST', 'questions must be an object', 'questions')
        const answers = {}
        for (const [id, q] of Object.entries(b.questions)) {
          if (q?.type === 'noul') answers[id] = { type: 'noul', noul: 0.75, confidence: 0.75 }
          else if (q?.type === 'choice' || q?.type === 'score') {
            const labels = Array.isArray(q.criteria) ? q.criteria.map(String) : Object.keys(q.criteria ?? {})
            if (labels.length === 0)
              return fail(400, 'TOO_FEW_OPTIONS', 'no options', `questions.${id}.criteria`)
            const rest = labels.length > 1 ? 0.3 / (labels.length - 1) : 0
            const probabilities = Object.fromEntries(
              labels.map((l, i) => [
                q.type === 'score' ? String(i) : l,
                i === 0 ? (labels.length > 1 ? 0.7 : 1) : rest,
              ])
            )
            answers[id] =
              q.type === 'choice'
                ? {
                    type: 'choice',
                    choice: Array.isArray(q.criteria) ? q.criteria[0] : labels[0],
                    probabilities,
                    confidence: 0.5,
                  }
                : {
                    type: 'score',
                    score: labels.slice(1).reduce((s, _, i) => s + (i + 1) * rest, 0),
                    probabilities,
                    legend: Object.fromEntries(labels.map((l, i) => [String(i), q.criteria[i]])),
                    confidence: 0.5,
                  }
          } else
            return fail(
              400,
              'UNKNOWN_QUESTION_TYPE',
              `unknown question type ${JSON.stringify(q?.type)}`,
              `questions.${id}.type`
            )
        }
        const n = raw.length
        if (upstreamDecision)
          return send(200, { answers, usage: { input_tokens: n, output_tokens: 0 } }, bodyHeaders)
        send(
          200,
          {
            model: alias,
            answers,
            usage: { input_tokens: n, output_tokens: 0, evaluated_tokens: n },
            latency_ms: 1.5,
            timings: { queue_ms: 0, render_ms: 0.1, compute_ms: 1.4 },
            warnings: [],
            runtime,
          },
          bodyHeaders
        )
      }

      function routerScore(b) {
        for (const key of ['task', 'criterion', 'candidates'])
          if (b[key] === undefined) return fail(400, 'INVALID_REQUEST', `${key} is required`, key)
        if (!Array.isArray(b.candidates))
          return fail(400, 'INVALID_REQUEST', 'candidates must be a list', 'candidates')
        const seen = new Set()
        const scores = []
        for (const [i, c] of b.candidates.entries()) {
          if (typeof c?.id !== 'string' || !/^[A-Za-z0-9._:/@+-]{1,128}$/.test(c.id))
            return fail(400, 'INVALID_CANDIDATE_ID', 'bad candidate id', `candidates[${i}].id`)
          if (seen.has(c.id))
            return fail(400, 'DUPLICATE_CANDIDATE_ID', `duplicate id ${c.id}`, `candidates[${i}].id`)
          seen.add(c.id)
          if (
            typeof c.card !== 'object' ||
            c.card === null ||
            typeof c.card.name !== 'string' ||
            typeof c.card.kind !== 'string'
          )
            return fail(400, 'INVALID_CARD', 'card needs name and kind', `candidates[${i}].card`)
          const measured = (c.card.checks ?? []).find((ch) => ch?.status === 'measured')
          const p = measured ? Math.min(0.99, Math.max(0.01, measured.passed / measured.total)) : 0.5
          scores.push({
            id: c.id,
            p_success: p,
            logit: Math.log(p / (1 - p)),
            calibrated,
            input_tokens: 100,
            truncated_tokens: 0,
          })
        }
        send(
          200,
          {
            object: 'router.scores',
            model: alias,
            scores,
            usage: { input_tokens: 100 * scores.length, output_tokens: 0, passes: scores.length },
            latency_ms: 2.5,
            timings: { queue_ms: 0, render_ms: 0.2, compute_ms: 2.3 },
            runtime,
            warnings: [],
          },
          bodyHeaders
        )
      }
    })
  })
  server.listen(port, '127.0.0.1', () => {
    err(`main: server is listening on http://127.0.0.1:${server.address().port} - decision mode`)
  })
  process.on('SIGTERM', () => {
    server.close()
    process.exit(0)
  })
}
