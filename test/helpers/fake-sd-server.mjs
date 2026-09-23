#!/usr/bin/env node
/**
 * A stand-in for stable-diffusion.cpp's `sd-server`, close enough that the core cannot tell the
 * difference: it takes the flags `args.ts` emits, prints the loader and step lines the real one
 * prints (the step bar as in-place `\r…ESC[K` redraws), answers the `/sdcpp/v1/*` routes the job
 * runner uses, and can fail the way the real one fails.
 *
 * Driven by argv plus env:
 *   FAKE_SD_MODE        ready | hang | exit-early | foreign | queue-full | fail-job | die-mid-job |
 *                       ggml-abort (recovers when `--backend cpu` is in the argv) |
 *                       gpu-fault (a Metal address fault in the job's own output, then the job fails;
 *                       the process stays up, as the real one does)
 *   FAKE_SD_ONCE_MARKER path; the mode applies only to the first process that creates the file, every
 *                       later one runs `ready` — so "the next job respawns it and completes" can be shown
 *   FAKE_SD_LOAD_MS     milliseconds before the port is bound (the model "loading")
 *   FAKE_SD_STEP_MS     milliseconds per sampling step (default 40)
 *   FAKE_SD_CANCEL      1 → advertise `cancel_generating` and honour a cancel while generating
 *   FAKE_SD_TILES       n → print a tiled-VAE pass of n tiles before sampling
 *   FAKE_SD_BLANK_SEED  n → a job whose seed is n returns all-black frames (the overflow sd.cpp can
 *                       finish with); other seeds paint as usual, so the same process recovers
 *   FAKE_SD_EXIT_CODE   exit code for `exit-early` (default 6)
 *   FAKE_SD_STDERR      text printed to stderr before an early exit (default: a ggml abort)
 *   FAKE_SD_PID_FILE    path; the pid is appended there on startup
 *   FAKE_SD_ARGV_FILE   path; the argv is written there as JSON on startup
 *   FAKE_SD_ENV_FILE    path; the host switches the core sets (GGML_METAL_TENSOR_DISABLE) as JSON
 *   FAKE_SD_IGNORE_SIGTERM  1 → SIGTERM is ignored (only SIGKILL stops it)
 *   FAKE_SD_MODES       comma-separated `supported_modes` (default `img_gen`; `vid_gen` or
 *                       `img_gen,vid_gen` for a video model)
 *   FAKE_SD_VID_FORMATS what `output_formats_by_mode.vid_gen` lists: `all` (default: webm, webp, avi),
 *                       `no-webm` (a build without libwebm: `vid_gen` then answers 400), or
 *                       `unreported` (the key is absent, as on builds that predate it)
 *
 * A `vid_gen` job runs like an image one (the same loader and step lines, `generating video` in the
 * banner), normalises `video_frames` to the largest 4n+1 at most the request, and completes with
 * `test/fixtures/webm/tiny.webm` as the clip.
 */
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const env = process.env
/** The configured mode, unless a once-marker says an earlier process already played it. */
function configuredMode() {
  const mode = env.FAKE_SD_MODE ?? 'ready'
  if (!env.FAKE_SD_ONCE_MARKER) return mode
  try {
    closeSync(openSync(env.FAKE_SD_ONCE_MARKER, 'wx'))
    return mode
  } catch {
    return 'ready'
  }
}
const port = Number(flag('--listen-port', '0'))
const stepMs = Number(env.FAKE_SD_STEP_MS ?? '40')
const out = (text) => process.stdout.write(text)
const err = (text) => process.stderr.write(text)
const line = (text) => out(`${text}\n`)

if (argv.includes('-h') || argv.includes('--help')) {
  line('usage: sd-server [options]')
  line('  --cfg-scale SCALE                  unconditional guidance scale')
  process.exit(0)
}
// After the help check: the finalize probe must not use up a once-marker.
const mode = configuredMode()
if (env.FAKE_SD_PID_FILE) appendFileSync(env.FAKE_SD_PID_FILE, `${process.pid}\n`)
if (env.FAKE_SD_ARGV_FILE) writeFileSync(env.FAKE_SD_ARGV_FILE, JSON.stringify(argv))
if (env.FAKE_SD_ENV_FILE)
  writeFileSync(
    env.FAKE_SD_ENV_FILE,
    JSON.stringify({ GGML_METAL_TENSOR_DISABLE: env.GGML_METAL_TENSOR_DISABLE ?? null })
  )
if (env.FAKE_SD_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {})

const modes = (env.FAKE_SD_MODES ?? 'img_gen')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)
const vidFormats = env.FAKE_SD_VID_FORMATS ?? 'all'
const onCpu = argv.includes('--backend') && argv[argv.indexOf('--backend') + 1] === 'cpu'
const effectiveMode = mode === 'ggml-abort' && onCpu ? 'ready' : mode

// ── the loader, as sd.cpp prints it with -v ───────────────────────────────────
line(`[INFO   ] stable-diffusion.cpp:200  - loading model from '${flag('--diffusion-model', '')}'`)
line('[INFO   ] model.cpp:1000 - load tensors from model')
// A loader bar with a foreign denominator, which must never move the sampling bar.
out('\r  |####      | 40/100 - 637.50MB/s\x1b[K')
out('\r  |##########| 100/100 - 637.50MB/s\x1b[K\n')

if (effectiveMode === 'exit-early') {
  err(env.FAKE_SD_STDERR ?? "ggml_metal: error: unsupported op 'RMS_NORM'\nGGML_ABORT\n")
  process.exit(Number(env.FAKE_SD_EXIT_CODE ?? '6'))
}
if (effectiveMode === 'hang') setInterval(() => {}, 1000)

// ── a tiny PNG writer: solid colour, filter 0 ─────────────────────────────────
function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}
function png(width, height, seed, { blank = false } = {}) {
  const stride = width * 3
  // Zero-filled: with `blank` the rows stay pure black, which is exactly the frame the core refuses.
  const raw = Buffer.alloc(height * (stride + 1))
  if (!blank)
    for (let y = 0; y < height; y++) {
      const row = y * (stride + 1) + 1
      for (let x = 0; x < width; x++) raw.set([(seed + x) & 255, (seed + y) & 255, 128], row + x * 3)
    }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── jobs ──────────────────────────────────────────────────────────────────────
const WEBM_FIXTURE = fileURLToPath(new URL('../fixtures/webm/tiny.webm', import.meta.url))
const jobs = new Map()
let nextJob = 1
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The steps sd.cpp samples: the whole schedule, or `⌊steps × strength⌋ + 1` with an init image. */
function sampledSteps(body) {
  const steps = Math.max(Number(body.sample_params?.sample_steps ?? 1), 1)
  if (typeof body.init_image !== 'string' || typeof body.strength !== 'number' || body.strength >= 1)
    return steps
  let encoded = Math.trunc(Math.fround(Math.fround(steps) * Math.fround(body.strength)))
  if (encoded === steps) encoded -= 1
  return encoded + 1
}

async function run(job) {
  const { body } = job
  await sleep(30)
  if (job.status !== 'queued') return
  job.status = 'generating'
  const steps = sampledSteps(body)
  const batch = Math.max(Number(body.batch_count ?? 1), 1)
  if (effectiveMode === 'die-mid-job') {
    await sleep(stepMs)
    err(
      'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 13576.00 MiB on device 0: cudaMalloc failed: out of memory\n'
    )
    err('CUDA error: out of memory\n')
    process.exit(1)
  }
  if (effectiveMode === 'ggml-abort') {
    await sleep(stepMs)
    err("ggml_metal_op_encode_impl: error: unsupported op 'RMS_NORM'\n")
    err('GGML_ABORT("unsupported op")\n')
    process.kill(process.pid, 'SIGABRT')
    await sleep(10_000)
  }
  if (effectiveMode === 'gpu-fault') {
    await sleep(stepMs)
    // What Metal prints when a render page-faults; the process outlives it with its backend broken.
    err('ggml_metal_synchronize: error: command buffer 0 failed with status 5\n')
    err('error: Caused GPU Address Fault Error (0000000b:kIOGPUCommandBufferCallbackErrorPageFault)\n')
    // Long enough for the lines to reach the runner before its poll sees the failure.
    await sleep(Math.max(stepMs, 200))
    job.status = 'failed'
    job.error = { code: 'generation_failed', message: 'generate_image returned no results' }
    return
  }
  if (effectiveMode === 'fail-job') {
    await sleep(stepMs)
    line(
      'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 13576.00 MiB on device 0: cudaMalloc failed: out of memory'
    )
    line('[ERROR] stable-diffusion.cpp:5049 - failed to encode init image')
    job.status = 'failed'
    job.error = { code: 'generation_failed', message: 'generate_image returned no results' }
    return
  }
  const tiles = Number(env.FAKE_SD_TILES ?? '0')
  if (tiles > 0) {
    line(`[VERBOSE] tiling.cpp:203  - processing ${tiles} tiles`)
    for (let t = 1; t <= tiles; t++)
      out(`\r|${'='.repeat(t)}${' '.repeat(tiles - t)}| ${t}/${tiles} - 0.10s/it\x1b[K`)
    out('\n')
  }
  for (let image = 1; image <= batch; image++) {
    line(
      job.kind === 'vid_gen'
        ? `[INFO   ] stable-diffusion.cpp:5705 - generating video: ${image}/${batch} - seed ${Number(body.seed ?? 0)}`
        : `[INFO   ] stable-diffusion.cpp:5705 - generating image: ${image}/${batch} - seed ${Number(body.seed ?? 0) + image - 1}`
    )
    for (let step = 1; step <= steps; step++) {
      if (job.status === 'cancelled') return
      await sleep(stepMs)
      const bar = `|${'='.repeat(step)}>${' '.repeat(Math.max(steps - step, 0))}|`
      out(`\r${bar} ${step}/${steps} - ${(stepMs / 1000).toFixed(2)}s/it\x1b[K`)
    }
    out('\n')
  }
  if (job.status === 'cancelled') return
  const width = Number(body.width ?? 64)
  const height = Number(body.height ?? 64)
  const blank = env.FAKE_SD_BLANK_SEED !== undefined && Number(body.seed) === Number(env.FAKE_SD_BLANK_SEED)
  line(`[INFO   ] stable-diffusion.cpp:5800 - decode_first_stage completed`)
  if (job.kind === 'vid_gen') {
    // The largest 4n+1 at most the request, as the engine normalises it.
    const wanted = Math.max(Number(body.video_frames ?? 1), 1)
    const frames = wanted < 1 ? 1 : 1 + Math.floor((wanted - 1) / 4) * 4
    job.result = {
      output_format: 'webm',
      mime_type: 'video/webm',
      fps: Number(body.fps ?? 24),
      frame_count: frames,
      b64_json: readFileSync(WEBM_FIXTURE).toString('base64'),
    }
    job.status = 'completed'
    return
  }
  job.result = {
    images: Array.from({ length: batch }, (_, index) => ({
      index: batch - 1 - index, // out of order on purpose: the runner sorts by index
      b64_json: png(width, height, Number(body.seed ?? 0) + (batch - 1 - index), { blank }).toString(
        'base64'
      ),
    })),
  }
  job.status = 'completed'
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const server = createServer((req, res) => {
  const url = req.url ?? '/'
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    if (req.method === 'GET' && url === '/v1/models')
      return json(res, 200, { data: [{ id: 'fake', object: 'model' }] })
    if (req.method === 'GET' && url === '/sdcpp/v1/capabilities') {
      if (effectiveMode === 'foreign') return json(res, 404, { error: 'not found' })
      const features = { cancel_generating: env.FAKE_SD_CANCEL === '1', cancel_queued: true }
      const body = {
        supported_modes: modes,
        features_by_mode: { img_gen: features },
        defaults_by_mode: { img_gen: { width: 512, height: 512 } },
      }
      if (modes.includes('vid_gen')) {
        body.features_by_mode.vid_gen = features
        body.defaults_by_mode.vid_gen = { width: 768, height: 512, video_frames: 25, fps: 24 }
        if (vidFormats !== 'unreported')
          body.output_formats_by_mode = {
            vid_gen: vidFormats === 'no-webm' ? ['webp', 'avi'] : ['webm', 'webp', 'avi'],
          }
      }
      return json(res, 200, body)
    }
    if (req.method === 'POST' && url === '/sdcpp/v1/img_gen') {
      if (effectiveMode === 'queue-full') return json(res, 429, { error: 'queue full' })
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: 'invalid generation parameters' })
      }
      if (typeof body.prompt !== 'string' || body.prompt === '')
        return json(res, 400, { error: 'invalid generation parameters' })
      const id = `job_${nextJob++}`
      const job = { id, kind: 'img_gen', status: 'queued', body, result: null, error: null }
      jobs.set(id, job)
      void run(job)
      return json(res, 202, { id, kind: 'img_gen', status: 'queued', poll_url: `/sdcpp/v1/jobs/${id}` })
    }
    if (req.method === 'POST' && url === '/sdcpp/v1/vid_gen') {
      if (!modes.includes('vid_gen')) return json(res, 404, { error: 'not found' })
      if (effectiveMode === 'queue-full') return json(res, 429, { error: 'queue full' })
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: 'invalid generation parameters' })
      }
      if (typeof body.prompt !== 'string' || body.prompt === '')
        return json(res, 400, { error: 'invalid generation parameters' })
      if ((body.output_format ?? 'webm') === 'webm' && vidFormats === 'no-webm')
        return json(res, 400, { error: 'webm output is not supported by this build' })
      const id = `job_${nextJob++}`
      const job = { id, kind: 'vid_gen', status: 'queued', body, result: null, error: null }
      jobs.set(id, job)
      void run(job)
      return json(res, 202, { id, kind: 'vid_gen', status: 'queued', poll_url: `/sdcpp/v1/jobs/${id}` })
    }
    const poll = /^\/sdcpp\/v1\/jobs\/([^/]+)$/.exec(url)
    if (req.method === 'GET' && poll) {
      const job = jobs.get(poll[1])
      if (!job) return json(res, 404, { error: 'unknown job' })
      return json(res, 200, {
        id: job.id,
        kind: job.kind,
        status: job.status,
        result: job.result,
        error: job.error,
      })
    }
    const cancel = /^\/sdcpp\/v1\/jobs\/([^/]+)\/cancel$/.exec(url)
    if (req.method === 'POST' && cancel) {
      const job = jobs.get(cancel[1])
      if (!job) return json(res, 404, { error: 'unknown job' })
      if (job.status === 'queued' || (job.status === 'generating' && env.FAKE_SD_CANCEL === '1')) {
        job.status = 'cancelled'
        job.error = { code: 'cancelled', message: 'job cancelled by client' }
      }
      return json(res, 200, { id: job.id, status: job.status })
    }
    json(res, 404, { error: 'not found' })
  })
})

if (effectiveMode !== 'hang') {
  setTimeout(
    () => {
      server.listen(port, '127.0.0.1', () => {
        line(`[INFO   ] server.cpp:100 - listening on 127.0.0.1:${port}`)
      })
    },
    Number(env.FAKE_SD_LOAD_MS ?? '0')
  )
}
