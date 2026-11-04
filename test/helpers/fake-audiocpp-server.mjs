#!/usr/bin/env node
/**
 * A stand-in for audio.cpp's `audiocpp_server` (v0.9.3, `test/fixtures/audiocpp/v0.9.3/`), close enough
 * that the core cannot tell the difference: it answers `--version` and `--list-devices`, reads the
 * one-model `server.json` the core writes, traces the model facts the real one traces, binds only once
 * the model "loaded", serves `/health`, `/v1/models[?include_params=true]`, `/v1/audio/voices`,
 * `/v1/audio/speech` (WAV bytes) and `/v1/tasks/run` (JSON with the WAV as base64, twice), refuses an
 * option the family does not declare the way the real one does, and can fail the way it fails.
 *
 * Driven by argv plus env:
 *   FAKE_AUDIO_MODE         ok | slow (every generation takes FAKE_AUDIO_SLOW_MS and ignores a client
 *                           that hangs up) | crash-mid-job (a generation request kills the process) |
 *                           load-fail (exits before listening) | oom (exits before listening, out of
 *                           device memory) | reject (every generation answers 500 with
 *                           FAKE_AUDIO_REJECT_MESSAGE) | foreign-listener (listens, but lists no model of
 *                           ours, like another server on the port)
 *   FAKE_AUDIO_ONCE_MARKER  path; the mode applies only to the first process that creates the file, every
 *                           later one runs `ok` — so "the next job respawns it and completes" can be shown
 *   FAKE_AUDIO_LOAD_MS      milliseconds before the port is bound (the model "loading")
 *   FAKE_AUDIO_GEN_MS       milliseconds a generation takes (default 30)
 *   FAKE_AUDIO_SLOW_MS      milliseconds a generation takes in `slow` (default 600000)
 *   FAKE_AUDIO_REJECT_MESSAGE  the engine's words in `reject` (default the Qwen3 Base refusal)
 *   FAKE_AUDIO_VARIANT      what `runtime.model.variant` says (default by family)
 *   FAKE_AUDIO_BACKENDS     what `--version` lists after `backends:` (default `cpu,metal`)
 *   FAKE_AUDIO_DEVICES      `gpu` (default) or `cpu`: whether `--list-devices` shows a GPU
 *   FAKE_AUDIO_PID_FILE     path; the pid is appended there on startup
 *   FAKE_AUDIO_ARGV_FILE    path; the argv is written there as JSON on startup
 *   FAKE_AUDIO_ENV_FILE     path; `{TMPDIR, TEMP, TMP, HOME, cwd, config}` as JSON on startup
 *   FAKE_AUDIO_BODY_FILE    path; the body of the last generation request, as JSON
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const env = process.env
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const out = (text) => process.stdout.write(`${text}\n`)
const err = (text) => process.stderr.write(`${text}\n`)
const trace = (text) => out(`[TRACE ts=20261029-150000] ${text}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (argv.includes('--version')) {
  out('audio.cpp 0.9.3')
  out('git: 41c1f8ff 2026-10-26')
  out('build: Release, fake, test')
  out(`backends: ${env.FAKE_AUDIO_BACKENDS ?? 'cpu,metal'}`)
  process.exit(0)
}
if (argv.includes('--list-devices')) {
  out(`available_devices=${env.FAKE_AUDIO_DEVICES === 'cpu' ? 1 : 2}`)
  if (env.FAKE_AUDIO_DEVICES !== 'cpu') out('  MTL:0 "Fake GPU" [GPU]')
  out('  CPU:0 "Fake CPU" [CPU]')
  process.exit(0)
}
if (argv.includes('--help')) {
  out('audiocpp_server [--config <server.json>] [--ui] [--host <ip>] [--port <port>] [--backend <backend>]')
  process.exit(0)
}

/** The configured mode, unless a once-marker says an earlier process already played it. */
function configuredMode() {
  const mode = env.FAKE_AUDIO_MODE ?? 'ok'
  if (!env.FAKE_AUDIO_ONCE_MARKER) return mode
  try {
    closeSync(openSync(env.FAKE_AUDIO_ONCE_MARKER, 'wx'))
    return mode
  } catch {
    return 'ok'
  }
}

const configFile = flag('--config', undefined)
if (!configFile) {
  err('audiocpp_server failed: missing required --config argument (or use --ui for the native WebUI)')
  process.exit(1)
}
const mode = configuredMode()
if (env.FAKE_AUDIO_PID_FILE) appendFileSync(env.FAKE_AUDIO_PID_FILE, `${process.pid}\n`)
if (env.FAKE_AUDIO_ARGV_FILE) writeFileSync(env.FAKE_AUDIO_ARGV_FILE, JSON.stringify(argv))
const config = JSON.parse(readFileSync(configFile, 'utf8'))
if (env.FAKE_AUDIO_ENV_FILE)
  writeFileSync(
    env.FAKE_AUDIO_ENV_FILE,
    JSON.stringify({
      TMPDIR: env.TMPDIR ?? null,
      TEMP: env.TEMP ?? null,
      TMP: env.TMP ?? null,
      HOME: env.HOME ?? null,
      cwd: process.cwd(),
      config,
    })
  )

const model = config.models?.[0]
const port = Number(flag('--port', String(config.port ?? 8080)))
const backend = flag('--backend', 'cuda')

/** What each family declares, as `/v1/models?include_params=true` lists it (trimmed from the real ones). */
const PARAMS = {
  kokoro_tts: [
    { name: 'voice_id', type: 'enum', required: false, default: 'af_heart', values: ['af_heart', 'am_adam'] },
    { name: 'language', type: 'string', required: false },
    { name: 'seed', type: 'int', required: false },
    { name: 'speed', type: 'float', required: false, default: 1, min: 0.25, max: 4 },
  ],
  qwen3_tts: [
    { name: 'language', type: 'string', required: false, default: 'auto' },
    { name: 'temperature', type: 'float', required: false, default: 0.9, min: 0 },
    { name: 'seed', type: 'int', required: false },
    { name: 'reference_text', type: 'string', required: false },
    { name: 'instruct', type: 'string', required: false },
    { name: 'voice_id', type: 'enum', required: false, values: ['ryan', 'vivian'] },
  ],
  stable_audio: [
    { name: 'negative_prompt', type: 'string', required: false },
    { name: 'duration_sec', type: 'float', required: false, default: 120, min: 0 },
    { name: 'num_inference_steps', type: 'int', required: false, default: 8, min: 1 },
    { name: 'guidance_scale', type: 'float', required: false, default: 1 },
    { name: 'seed', type: 'int', required: false },
  ],
  ace_step: [
    { name: 'lyrics', type: 'string', required: false },
    { name: 'duration_sec', type: 'float', required: false, default: -1 },
    { name: 'bpm', type: 'int', required: false },
    { name: 'num_inference_steps', type: 'int', required: false, default: 8, max: 8 },
    { name: 'seed', type: 'int', required: false },
  ],
}
const VARIANTS = { kokoro_tts: 'Kokoro 82M', qwen3_tts: '0b6-base', stable_audio: 'small', ace_step: 'turbo' }
const params = PARAMS[model?.family] ?? [{ name: 'seed', type: 'int', required: false }]
const variant = env.FAKE_AUDIO_VARIANT ?? VARIANTS[model?.family] ?? 'base'

// ── the loader, as audio.cpp prints it with --log --load-progress 1 ───────────
trace(`server.model.id ${model?.id}`)
trace(`server.model.path ${model?.path}`)
trace(`server.model.family ${model?.family}`)
trace(`server.model.backend ${backend}`)
if (!model?.path || !existsSync(model.path)) {
  err(`audiocpp_server failed: model path does not exist: ${model?.path}`)
  process.exit(1)
}
trace('runtime.load.phase inspect')
trace(`runtime.model.family ${model.family}`)
trace(`runtime.model.variant ${variant}`)
trace(`runtime.model.supports_speaker_reference ${model.family === 'qwen3_tts' ? 1 : 0}`)
trace('runtime.load.phase load')
if (mode === 'load-fail') {
  err('audiocpp_server failed: unsupported model contract for this build')
  process.exit(1)
}
if (mode === 'oom') {
  err(
    'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 6200.00 MiB on device 0: cudaMalloc failed: out of memory'
  )
  err('audiocpp_server failed: failed to allocate buffer for weights')
  process.exit(1)
}
await sleep(Number(env.FAKE_AUDIO_LOAD_MS ?? '0'))
trace(`${model.family}.weights.weights.upload_progress 1`)
trace('runtime.load.phase loaded')
trace('server.load.progress 1')

// ── WAV writer: a sine, 16-bit PCM ────────────────────────────────────────────
function wav(sampleRate, channels, seconds) {
  const frames = Math.max(1, Math.round(sampleRate * seconds))
  const data = Buffer.alloc(frames * channels * 2)
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000)
    for (let c = 0; c < channels; c++) data.writeInt16LE(sample, (i * channels + c) * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8, 'latin1')
  head.write('fmt ', 12, 'latin1')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(channels, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * channels * 2, 28)
  head.writeUInt16LE(channels * 2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'latin1')
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const json = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
const engineError = (res, status, message, type = 'server_error') =>
  json(res, status, { error: { message, type } })
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
const declared = (name) => params.some((p) => p.name === name)
const familyName = { kokoro_tts: 'Kokoro TTS', qwen3_tts: 'Qwen3 TTS' }[model.family] ?? model.family
const unknownOption = (name) =>
  `unknown ${familyName} request option: ${name}. The option may be misspelled or require a newer audio.cpp runtime.`

let busy = false
/** Run a generation the way the mode says; answers what to send, or nothing when the process dies. */
async function generate() {
  if (mode === 'crash-mid-job') {
    await sleep(50)
    err('GGML_ASSERT(ggml_nelements(a) == ne0*ne1) failed')
    process.exit(134)
  }
  await sleep(
    mode === 'slow' ? Number(env.FAKE_AUDIO_SLOW_MS ?? '600000') : Number(env.FAKE_AUDIO_GEN_MS ?? '30')
  )
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/health')
    return json(res, 200, {
      status: 'ok',
      backend,
      models: 1,
      ui: false,
      ui_management: false,
      version: '0.9.3',
      git: '41c1f8ff',
      git_date: '2026-10-26',
    })
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (mode === 'foreign-listener')
      return json(res, 200, { object: 'list', data: [{ id: 'some-llm', object: 'model' }] })
    const entry = {
      id: model.id,
      object: 'model',
      owned_by: 'engine',
      family: model.family,
      task: model.task,
      mode: model.mode,
      device: 0,
      loaded: true,
      configured: true,
      path: model.path,
    }
    if (url.searchParams.get('include_params') === 'true') entry.params = params
    return json(res, 200, { object: 'list', data: [entry] })
  }
  if (req.method === 'GET' && url.pathname === '/v1/audio/voices') return json(res, 200, { voices: [] })
  if (req.method !== 'POST' || (url.pathname !== '/v1/audio/speech' && url.pathname !== '/v1/tasks/run'))
    return json(res, 404, { error: { message: 'not found', type: 'not_found' } })

  const text = await readBody(req)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return engineError(res, 500, 'invalid json body')
  }
  if (env.FAKE_AUDIO_BODY_FILE) writeFileSync(env.FAKE_AUDIO_BODY_FILE, JSON.stringify(body))
  if (body.model !== model.id) return engineError(res, 500, `unknown model id: ${body.model}`)
  const speech = url.pathname === '/v1/audio/speech'
  const options = speech ? { ...(body.options ?? {}) } : { ...(body.request?.options ?? {}) }
  if (speech) {
    if (typeof body.input !== 'string') return engineError(res, 500, 'missing required json key: input')
    for (const [key, option] of [
      ['voice', 'voice_id'],
      ['speed', 'speed'],
      ['language', 'language'],
      ['seed', 'seed'],
      ['reference_text', 'reference_text'],
    ])
      if (body[key] !== undefined) options[option] = body[key]
  } else if (typeof body.request?.text !== 'string')
    return engineError(res, 500, 'missing required json key: request.text')
  for (const key of Object.keys(options)) if (!declared(key)) return engineError(res, 500, unknownOption(key))
  if (speech && model.family === 'qwen3_tts' && /base$/.test(variant) && !body.voice_ref)
    return engineError(res, 500, 'Qwen3 base TTS requires voice clone reference audio')
  if (body.voice_ref !== undefined) {
    const ref = Buffer.from(String(body.voice_ref?.data ?? ''), 'base64')
    if (body.voice_ref?.type !== 'base64' || ref.toString('latin1', 0, 4) !== 'RIFF')
      return engineError(res, 500, 'invalid WAV RIFF header')
  }
  if (mode === 'reject')
    return engineError(
      res,
      500,
      env.FAKE_AUDIO_REJECT_MESSAGE ?? 'Qwen3 base TTS requires voice clone reference audio'
    )
  if (busy)
    return engineError(
      res,
      503,
      `model '${model.id}' is busy: timed out after 0 ms waiting for the inference lock`,
      'server_busy'
    )
  busy = true
  try {
    await generate()
  } finally {
    busy = false
  }
  if (speech) {
    const clip = wav(24000, 1, 0.25)
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': clip.length })
    return res.end(clip)
  }
  const seconds = Math.min(
    Math.max(Number(options.duration_sec ?? 1), 0.1),
    Number(env.FAKE_AUDIO_MAX_SEC ?? '1')
  )
  const audio = wav(44100, 2, seconds).toString('base64')
  return json(res, 200, {
    audio,
    sample_rate: 44100,
    channels: 2,
    named_audio_outputs: [{ id: 7, audio, sample_rate: 44100, channels: 2 }],
    timing: { wall_ms: 30, audio_duration_ms: seconds * 1000, rtf: 0.03 },
  })
})

server.on('error', (error) => {
  err(`audiocpp_server failed: could not bind 127.0.0.1:${port} (${error.code ?? error.message})`)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => out(`audiocpp_server listening on http://127.0.0.1:${port}`))
