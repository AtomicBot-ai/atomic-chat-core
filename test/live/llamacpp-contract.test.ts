/**
 * The live contract probe: what a real `llama-server` prints and answers, against the `strings` and
 * `routes` of the engine contract (test/fixtures/llamacpp/engine-contract.json). The argv half of the
 * contract is checked by `llamacpp.test.ts`; this half is the text core matches and the HTTP surface it
 * calls, which only a real build can confirm.
 *
 * It loads the small model through core (so the argv, env and API key are production's), collects every
 * engine line through `backendOutput`, calls each route on the session, provokes the failures core
 * classifies (a file that is not a GGUF, a truncated one, an unknown architecture, a known one without
 * its keys, an unknown flag) and a context overflow, and runs `--list-devices`. Only a `break` the
 * contract expected and did not see fails a test; everything else is drift, recorded in
 * `<ATOMIC_LIVE_REPORT_DIR>/observed.json` for the surface report and for the fixes that follow.
 *
 * Opt in exactly like llamacpp.test.ts:
 *   ATOMIC_LIVE=1 ATOMIC_LIVE_UPSTREAM_BIN=… ATOMIC_LIVE_UPSTREAM_MODEL=… [ATOMIC_LIVE_UPSTREAM_TAG=bN]
 *   [ATOMIC_LIVE_REPORT_DIR=dir]
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import {
  hostUpstreamBackendId,
  installUpstreamPack,
  liveUpstreamTag,
  readVersion,
} from '../helpers/live-llamacpp.js'
import { buildGguf } from '../helpers/gguf-builder.js'
import { CONTRACT_ROUTES, CONTRACT_STRINGS } from '../helpers/llamacpp-engine-strings.js'
import type { ContractRoute } from '../helpers/llamacpp-engine-strings.js'
import { breaks, drift, judgeRoute, judgeStrings, stableLine } from '../helpers/llamacpp-observed.js'
import type { ObservedRoute, ObservedString, RouteAnswers } from '../helpers/llamacpp-observed.js'
import { AtomicCore } from '../../src/core/index.js'
import { AtomicCoreError } from '../../src/contracts/index.js'
import type { LlamacppConfig, SessionInfo } from '../../src/contracts/index.js'
import { parseBuildNumber } from '../../src/backend/version.js'
import { parseDeviceOutput } from '../../src/runtime/llamacpp/devices.js'
import { isInconclusive } from '../../src/runtime/llamacpp/runtime-device.js'
import { isContextLimitError } from '../../src/server/public/errors.js'

const run = promisify(execFile)
const BIN = process.env['ATOMIC_LIVE_UPSTREAM_BIN'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_UPSTREAM_MODEL'] ?? ''
const REPORT_DIR = process.env['ATOMIC_LIVE_REPORT_DIR'] ?? ''
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && BIN !== '' && MODEL !== ''
const PROVIDER = 'llamacpp-upstream'
/** Small enough that the overflow prompt below never fits, whatever the model was trained for. */
const BASE: Partial<LlamacppConfig> = { ctx_size: 256, fit: false }

let data: TmpDataFolder
let core: AtomicCore
let tag: string
let build: number
let exe: string
/** Every line every engine printed, by model id. */
const lines = new Map<string, string[]>()
const bodies: string[] = []
const listDevices: string[] = []
const answers = new Map<string, RouteAnswers>()
const scenarios: Record<string, unknown> = {}
/**
 * The answers a stand-in has to give to pass for this build: no timestamps, paths or ports, so a
 * Linux run's section is what `test/fixtures/llamacpp/observed/` keeps for the fake server's test.
 */
const golden: Record<string, unknown> = {}

function linesOf(model: string): string[] {
  return lines.get(model) ?? []
}

async function addModel(id: string, path: string, size: number): Promise<void> {
  const dir = join(data.layout.provider(PROVIDER).modelsDir, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'model.yml'),
    `model_path: ${path.split('\\').join('/')}\nname: ${id}\nsize_bytes: ${size}\nmodel_size_bytes: ${size}\n`
  )
}

/** A file core would hand to the engine, in the model's own folder. */
async function addFile(id: string, bytes: Buffer): Promise<void> {
  const dir = join(data.layout.provider(PROVIDER).modelsDir, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'model.gguf')
  await writeFile(path, bytes)
  await addModel(id, path, bytes.length)
}

async function call(
  session: SessionInfo,
  method: 'GET' | 'POST',
  path: string,
  options: { key?: string | null; body?: unknown } = {}
): Promise<{ status: number; contentType: string | null; text: string }> {
  const key = options.key === undefined ? session.api_key : options.key
  const res = await fetch(`http://127.0.0.1:${session.port}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, contentType: res.headers.get('content-type'), text }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The `data:` payloads of an SSE body; `[DONE]` stays a string. */
function events(text: string): unknown[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice('data: '.length))
    .map((p) => (p === '[DONE]' ? p : json(p)))
}

/** A request body each forwarded route accepts. */
function bodyFor(route: ContractRoute): unknown {
  if (route.method === 'GET') return undefined
  if (route.id === 'embeddings') return { input: 'hi' }
  if (route.id === 'completions') return { prompt: 'Once upon a time', max_tokens: 4 }
  if (route.id === 'systemone') return { question: 'hi', options: ['a', 'b'] }
  return { model: 'probe', max_tokens: 4, messages: [{ role: 'user', content: 'Say hi.' }] }
}

/** Load a model that must fail, and return the error core classified. */
async function failedLoad(
  model: string,
  overrides: Partial<LlamacppConfig> = BASE
): Promise<AtomicCoreError> {
  const before = linesOf(model).length
  const error = await core.load(PROVIDER, model, { overrides }).then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error, `${model} must not load`).toBeInstanceOf(AtomicCoreError)
  const coded = error as AtomicCoreError
  scenarios[`load.${model}`] = {
    code: coded.code,
    message: coded.message,
    engine_lines: linesOf(model).slice(before).slice(-8),
  }
  return coded
}

function judge(): { strings: ObservedString[]; routes: ObservedRoute[] } {
  return {
    strings: judgeStrings(CONTRACT_STRINGS, {
      'log': [...lines.values()].flat(),
      'http': bodies,
      'list-devices': listDevices,
    }),
    routes: CONTRACT_ROUTES.map((r) => judgeRoute(r, answers.get(r.id), build)),
  }
}

function writeObserved(strings: ObservedString[], routes: ObservedRoute[]): void {
  if (REPORT_DIR === '') return
  const observed = {
    schema: 'atomic-engine-observed',
    schema_version: 1,
    engine: PROVIDER,
    tag,
    build,
    host: { platform: process.platform, arch: process.arch, backend: hostUpstreamBackendId() },
    generated_at: new Date().toISOString(),
    breaks: breaks(strings, routes),
    drift: drift(strings, routes),
    golden,
    strings,
    routes,
    scenarios,
  }
  mkdirSync(REPORT_DIR, { recursive: true })
  const path = join(REPORT_DIR, 'observed.json')
  writeFileSync(`${path}.tmp`, `${JSON.stringify(observed, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

describe.skipIf(!ENABLED)('a real llama.cpp backend against the engine contract', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-contract-')
    tag = await liveUpstreamTag(BIN)
    build = parseBuildNumber(tag) ?? 0
    exe = await installUpstreamPack(data.layout.provider(PROVIDER).backendsDir, BIN, tag)
    scenarios['version'] = (await readVersion(exe)).output.trim()
    golden['version'] = scenarios['version']

    const model = readFileSync(MODEL)
    await addModel('live', MODEL, model.length)
    // Not a GGUF at all; a real one cut before its tensor data (an interrupted download); an
    // architecture no build knows; a known architecture without the keys it requires.
    await addFile('probe-junk', Buffer.from('this is not a gguf file\n'.repeat(256)))
    await addFile('probe-truncated', model.subarray(0, Math.floor(model.length * 0.6)))
    const tensors = [{ name: 'token_embd.weight', type: 0, dims: [8, 8], bitsPerWeight: 32 }]
    await addFile(
      'probe-unknown-arch',
      buildGguf({
        metadata: { 'general.architecture': 'atomic-probe-arch', 'general.name': 'probe' },
        tensors,
      })
    )
    await addFile(
      'probe-no-hparams',
      buildGguf({ metadata: { 'general.architecture': 'llama', 'general.name': 'probe' }, tensors })
    )

    core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      // The probe fails loads on purpose: none of them is worth an error report.
      telemetry: false,
      backendOutput: ({ model, line }) => {
        const list = lines.get(model) ?? []
        list.push(line)
        lines.set(model, list)
      },
    })
  }, 120_000)

  afterAll(async () => {
    // Written even when a test failed half way: what the probe saw so far is the evidence.
    if (core !== undefined) {
      const { strings, routes } = judge()
      writeObserved(strings, routes)
      const off = drift(strings, routes)
      if (off.length > 0)
        console.warn(
          `llama.cpp ${tag} differs from the engine contract:\n${off.map((d) => `  ${d.severity.padEnd(5)} ${d.verdict.padEnd(8)} ${d.kind} ${d.id}`).join('\n')}`
        )
    }
    await core?.shutdown()
    await data?.cleanup()
  })

  it('serves the routes and fields core reads, behind the session key', async () => {
    const session = await core.load(PROVIDER, 'live', { overrides: BASE })
    expect(session.api_key, 'core starts every session with LLAMA_API_KEY').not.toBe('')
    const startup = linesOf('live')
    scenarios['startup'] = {
      ready_lines: startup.filter((l) => /listening|slots are idle|main loop/i.test(l)),
      runtime_device: core.llamacpp().getRuntimeDeviceInfo('live'),
      runtime_device_inconclusive: (() => {
        const info = core.llamacpp().getRuntimeDeviceInfo('live')
        return info === undefined ? null : isInconclusive(info)
      })(),
      line_count: startup.length,
    }
    golden['startup_head'] = startup.slice(0, 2).map(stableLine)
    const ready = startup.find((l) => l.toLowerCase().includes('listening on'))
    golden['ready_line'] = ready === undefined ? null : stableLine(ready)

    // The key: /health is public, everything else answers 401 without the right bearer.
    const health = await call(session, 'GET', '/health', { key: null })
    const noKey = await call(session, 'GET', '/v1/models', { key: null })
    const wrongKey = await call(session, 'GET', '/v1/models', { key: 'not-the-key' })
    scenarios['auth'] = {
      health_without_key: health.status,
      models_without_key: { status: noKey.status, body: json(noKey.text) ?? noKey.text },
      models_with_wrong_key: wrongKey.status,
    }
    golden['unauthorized'] = { status: noKey.status, body: json(noKey.text) ?? noKey.text }
    expect(health.status).toBe(200)
    expect(noKey.status, 'LLAMA_API_KEY must lock the session').toBe(401)

    for (const route of CONTRACT_ROUTES) {
      if (route.min_build !== undefined && build < route.min_build) continue
      const res = await call(session, route.method, route.path, { body: bodyFor(route) })
      answers.set(route.id, { status: res.status, plain: json(res.text) })
      scenarios[`route.${route.id}`] = {
        status: res.status,
        content_type: res.contentType,
        body: res.text.slice(0, 600),
      }
      if (res.status >= 400)
        golden[`refused.${route.id}`] = { status: res.status, body: json(res.text) ?? res.text }
    }

    const stream = await call(session, 'POST', '/v1/chat/completions', {
      body: { stream: true, max_tokens: 4, messages: [{ role: 'user', content: 'Say hi.' }] },
    })
    const chat = answers.get('chat-completions')
    if (chat) chat.stream = events(stream.text)
    scenarios['stream'] = { status: stream.status, tail: stream.text.split('\n').filter(Boolean).slice(-2) }

    const judgedRoutes = CONTRACT_ROUTES.map((r) => judgeRoute(r, answers.get(r.id), build))
    expect(breaks([], judgedRoutes)).toEqual([])
  }, 300_000)

  it('refuses a prompt larger than the context in words isContextLimitError knows', async () => {
    const session = await core.load(PROVIDER, 'live', { overrides: BASE })
    const res = await call(session, 'POST', '/v1/chat/completions', {
      body: { max_tokens: 4, messages: [{ role: 'user', content: 'hello world '.repeat(400) }] },
    })
    const body = json(res.text)
    const chat = answers.get('chat-completions') ?? {}
    chat['context-overflow'] = body
    answers.set('chat-completions', chat)
    const lower = res.text.toLowerCase()
    scenarios['context_overflow'] = {
      status: res.status,
      body: body ?? res.text,
      is_context_limit_error: isContextLimitError(res.status, res.text),
      matched_core_literal: lower.includes('the request exceeds the available context size'),
      matched_upstream_type: lower.includes('exceed_context_size_error'),
    }
    golden['context_overflow'] = { status: res.status, body: body ?? res.text }
    expect(isContextLimitError(res.status, res.text), `${res.status} ${res.text}`).toBe(true)
    expect(await core.unload(PROVIDER, 'live')).toEqual({ success: true })
  }, 300_000)

  it('serves /metrics only to a session started with expose_metrics', async () => {
    const session = await core.load(PROVIDER, 'live', { overrides: { ...BASE, expose_metrics: true } })
    const res = await call(session, 'GET', '/metrics')
    answers.set('metrics', { status: res.status })
    const without = scenarios['route.metrics']
    scenarios['metrics'] = {
      without_flag: without,
      with_flag: {
        status: res.status,
        content_type: res.contentType,
        head: res.text.split('\n').slice(0, 3),
      },
    }
    golden['metrics_with_flag'] = { status: res.status, content_type: res.contentType }
    expect(res.status).toBeGreaterThan(0)
    expect(await core.unload(PROVIDER, 'live')).toEqual({ success: true })
  }, 300_000)

  it('classifies a file that is not a GGUF as MODEL_FILE_CORRUPT', async () => {
    expect((await failedLoad('probe-junk')).code).toBe('MODEL_FILE_CORRUPT')
  }, 120_000)

  it('classifies a truncated GGUF as MODEL_FILE_CORRUPT', async () => {
    expect((await failedLoad('probe-truncated')).code).toBe('MODEL_FILE_CORRUPT')
  }, 120_000)

  it('classifies an architecture the build does not know as MODEL_ARCH_NOT_SUPPORTED', async () => {
    expect((await failedLoad('probe-unknown-arch')).code).toBe('MODEL_ARCH_NOT_SUPPORTED')
  }, 120_000)

  it('records how a known architecture without its keys and an unknown flag fail', async () => {
    // Recorded, not asserted: warn-level strings, judged with the rest at the end.
    await failedLoad('probe-no-hparams')
    const flag = '--atomic-probe-unknown-flag'
    const error = await failedLoad('live', { ...BASE, extra_args: flag })
    scenarios['unknown_flag'] = {
      code: error.code,
      message: error.message,
      upstream_line: linesOf('live').find((l) => l.includes(flag)) ?? null,
    }
    const line = linesOf('live').find((l) => l.includes(flag))
    golden['unknown_flag_line'] = line === undefined ? null : stableLine(line)
  }, 120_000)

  it('lists devices in the shape parseDeviceOutput reads', async () => {
    const { stdout, stderr } = await run(exe, ['--list-devices'], { cwd: dirname(exe), timeout: 60_000 })
    listDevices.push(...stdout.split('\n'))
    golden['list_devices_header'] = stdout.split('\n')[0]?.trim() ?? null
    scenarios['list_devices'] = { stdout: stdout.trim(), stderr_tail: stderr.trim().split('\n').slice(-3) }
    const devices = parseDeviceOutput(stdout)
    scenarios['list_devices_parsed'] = devices
    expect(Array.isArray(devices)).toBe(true)
  }, 60_000)

  it('prints every string the contract expects at break', () => {
    const { strings, routes } = judge()
    expect(breaks(strings, routes)).toEqual([])
  })
})
