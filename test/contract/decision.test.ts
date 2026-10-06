/**
 * The decision engine's wire contract as the core reads it, and the public passthrough.
 *
 * Two halves. The examples of the fork's `DECISION.md` (copied into `test/fixtures/decision/`) must pass
 * every reader the core applies to a real answer, so a field the engine documents cannot be refused
 * here. And `/v1/systemone` / `/v1/router/score` on the public server must reach a real decision
 * process (the fake engine in decision mode, spawned by the real module) byte for byte: the fake
 * answers with the SHA-256 of the body it received, which must be the SHA-256 of the body the client
 * sent, including the spellings a JavaScript round trip would change.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DecisionService } from '../../src/decision/index.js'
import {
  engineErrorOf,
  isRouterScoreBody,
  isSystemoneBody,
  judgeDecisionEndpoint,
  outcomeFromAnswer,
  parseDecideRequest,
  parseScoreRequest,
  wireDecision,
} from '../../src/decision/index.js'
import { DECISION_CHECKPOINT_FILES } from '../../src/models/index.js'
import { PublicServer } from '../../src/server/public/index.js'
import { SettingsStore } from '../../src/settings/index.js'
import { fakeDecisionSpawn } from '../helpers/fake-llama-server.js'
import { buildGguf } from '../helpers/gguf-builder.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'

const examples = JSON.parse(
  readFileSync(new URL('../fixtures/decision/engine-examples.json', import.meta.url), 'utf8')
) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe(`contract: decision engine examples (${examples['source'].file}, API ${examples['source'].api_version})`, () => {
  it('accepts the documented answers as results', () => {
    const systemone = outcomeFromAnswer(
      200,
      JSON.stringify(examples['systemone_response']),
      1,
      isSystemoneBody
    )
    expect(systemone.unavailable).toBe(false)
    const router = outcomeFromAnswer(200, JSON.stringify(examples['router_response']), 1, isRouterScoreBody)
    expect(router.unavailable === false && router.result.scores[0]?.p_success).toBe(0.9412)
  })

  it('builds the documented requests from the control API bodies unchanged', () => {
    const { model: _model, ...systemone } = examples['systemone_request']
    expect(parseDecideRequest(systemone)).toEqual(systemone)
    expect(parseScoreRequest(examples['router_request'])).toEqual(examples['router_request'])
  })

  it('reads the error envelope with its reason and path', () => {
    const { status, body } = examples['error_envelope']
    expect(engineErrorOf(status, JSON.stringify(body))).toEqual(body.error)
  })

  it('passes the readiness chain on the documented /v1/models and /props', () => {
    const verdict = judgeDecisionEndpoint(
      { status: 200, text: JSON.stringify(examples['models']) },
      { status: 200, text: JSON.stringify(examples['props']) }
    )
    expect(verdict).toMatchObject({ kind: 'ready', capabilities: ['decision', 'systemone', 'router_score'] })
    expect(verdict.kind === 'ready' && verdict.props.limits?.max_card_tokens).toBe(384)
    expect(examples['health']).toMatchObject({ ok: true })
  })
})

describe('contract: the public decision routes pass bytes through', () => {
  let data: TmpDataFolder
  let service: DecisionService
  let server: PublicServer

  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-decision-contract-')
    await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    await writeFile(join(data.root, 'tiny-laya.gguf'), 'GGUF')
    const settings = await SettingsStore.open(data.layout.core.settings)
    service = wireDecision({
      layout: data.layout,
      settings,
      journal: { add: async () => {}, remove: async () => {} },
      instanceId: 'contract',
      emit: () => {},
      log: () => {},
      overrides: { probe: async () => true, spawn: fakeDecisionSpawn() },
    })
    await service.configure({ enabled: true, model_path: 'tiny-laya.gguf' })
    await service.load()
    server = await PublicServer.start(
      {
        findLocal: () => undefined,
        listLocal: () => [],
        providers: () => new Map(),
        increaseCtx: async () => ({ ok: false }),
        decision: service.publicBackend(),
      },
      { host: '127.0.0.1', port: 0, apiKey: 'public-key' }
    )
  })

  afterAll(async () => {
    await server?.close()
    await service?.shutdown()
    await data?.cleanup()
  })

  const post = (path: string, body: string) =>
    fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer public-key' },
      body,
    })
  const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

  it.each([
    [
      '/systemone',
      // `1.0`, an integer past 2^53, number-like keys out of order, non-ASCII, no `model`.
      '{"state":{"amount":1.0,"order":12345678901234567890,"note":"счёт ×2"},"questions":{"2":{"type":"noul","instructions":"Refund?"},"1":{"type":"choice","instructions":"Topic?","criteria":{"10":"x","9":null}}}}',
    ],
    [
      '/router/score',
      JSON.stringify(examples['router_request'])
        .replace('"passed":188', '"passed":188 ')
        .replace('{"task"', '{ "task"'),
    ],
  ])('%s reaches the engine byte for byte', async (path, body) => {
    const res = await post(path, body)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-fake-body-sha256')).toBe(sha(body))
    expect(res.headers.get('x-fake-body-bytes')).toBe(String(Buffer.byteLength(body)))
    const answer = (await res.json()) as Record<string, unknown>
    expect(path === '/systemone' ? isSystemoneBody(answer) : isRouterScoreBody(answer)).toBe(true)
  })

  it("lets the engine judge the body: invalid JSON gets the engine's own MALFORMED_JSON", async () => {
    const res = await post('/systemone', '{"state": 1,')
    expect(res.status).toBe(400)
    expect(res.headers.get('x-fake-body-sha256')).toBe(sha('{"state": 1,'))
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe('MALFORMED_JSON')
  })

  it('answers 503 once the module is turned off', async () => {
    await service.configure({ enabled: false })
    const res = await post('/router/score', JSON.stringify(examples['router_request']))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 503, reason: 'UNAVAILABLE' } })
  })
})

describe('contract: a laya checkpoint folder is converted once into the core cache', () => {
  let data: TmpDataFolder
  let service: DecisionService

  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-decision-checkpoint-')
    await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    const folder = join(data.root, 'decision', 'models', 'laya-multilingual')
    for (const file of DECISION_CHECKPOINT_FILES) {
      await mkdir(dirname(join(folder, file)), { recursive: true })
      await writeFile(join(folder, file), '{}')
    }
    const settings = await SettingsStore.open(data.layout.core.settings)
    service = wireDecision({
      layout: data.layout,
      settings,
      journal: { add: async () => {}, remove: async () => {} },
      instanceId: 'contract',
      emit: () => {},
      log: () => {},
      overrides: { probe: async () => true, spawn: fakeDecisionSpawn() },
    })
  })

  afterAll(async () => {
    await service?.shutdown()
    await data?.cleanup()
  })

  const cacheDir = () => join(data.root, 'decision', 'gguf-cache')

  it('converts on the first start, hits the cache on the next, and keeps one entry per model', async () => {
    await service.configure({ enabled: true, model_path: 'decision/models/laya-multilingual' })
    const first = (await service.load()).props
    expect(first).toMatchObject({
      model_id: 'laya-multilingual',
      source: 'checkpoint-dir',
      checkpoint: { cache_dir: cacheDir(), outtype: 'f16', cache_hit: false },
    })
    expect(first?.cache_path?.startsWith(cacheDir())).toBe(true)

    await service.unload()
    expect((await service.load()).props?.checkpoint).toMatchObject({ cache_hit: true, convert_ms: 0 })

    await service.configure({ convert_type: 'f32' })
    const f32 = (await service.load()).props?.checkpoint
    expect(f32).toMatchObject({ outtype: 'f32', cache_hit: false })
    await vi.waitFor(async () => expect(await readdir(cacheDir())).toEqual([f32?.key]))

    await service.configure({ model_path: '' })
    await vi.waitFor(async () => expect(await readdir(cacheDir())).toEqual([]))
  })
})

describe('contract: an upstream decision GGUF runs on stock llama.cpp at its floor', () => {
  let data: TmpDataFolder
  let service: DecisionService
  let server: PublicServer
  let argvFile: string

  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-decision-upstream-')
    argvFile = join(data.root, 'argv.jsonl')
    // A fork build (which must not be picked), an upstream build below the floor, and one above it.
    await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    await data.writeBackend('llamacpp-upstream', 'b11344', 'macos-arm64')
    await data.writeBackend('llamacpp-upstream', 'b11436', 'macos-arm64')
    const folder = join(data.root, 'decision', 'models', 'julia-1')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'Julia-1-Q8_0.gguf'),
      buildGguf({
        metadata: {
          'general.architecture': 'modern-bert',
          'modern-bert.decision.type': 'laya',
          'modern-bert.context_length': 8192,
        },
        tensors: [],
      })
    )
    const settings = await SettingsStore.open(data.layout.core.settings)
    service = wireDecision({
      layout: data.layout,
      settings,
      journal: { add: async () => {}, remove: async () => {} },
      instanceId: 'contract',
      emit: () => {},
      log: () => {},
      overrides: {
        probe: async () => {
          throw new Error('upstream has no flag to probe')
        },
        spawn: fakeDecisionSpawn({ decision: { upstream: true }, argvFile }),
      },
    })
    await service.configure({
      enabled: true,
      model_path: 'decision/models/julia-1/Julia-1-Q8_0.gguf',
      model_id: 'julia-1',
      ctx_size: 1024,
    })
    await service.load()
    server = await PublicServer.start(
      {
        findLocal: () => undefined,
        listLocal: () => [],
        providers: () => new Map(),
        increaseCtx: async () => ({ ok: false }),
        decision: service.publicBackend(),
      },
      { host: '127.0.0.1', port: 0, apiKey: 'public-key' }
    )
  })

  afterAll(async () => {
    await server?.close()
    await service?.shutdown()
    await data?.cleanup()
  })

  const post = (path: string, body: string) =>
    fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer public-key' },
      body,
    })

  it('picks the newest upstream build and starts it without --decision, the prompt in one ubatch', async () => {
    expect(service.getStatus()).toMatchObject({
      state: 'ready',
      engine: { dialect: 'upstream', provider: 'llamacpp-upstream', version_backend: 'b11436/macos-arm64' },
      props: { endpoints: ['/v1/systemone'], model_id: 'julia-1' },
    })
    const [record] = (await readFile(argvFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(record.argv).not.toContain('--decision')
    expect(record.argv).toEqual(
      expect.arrayContaining(['-a', 'julia-1', '-c', '1024', '-b', '1024', '-ub', '1024'])
    )
  })

  it('passes /systemone through byte for byte and answers the router with 501', async () => {
    const body =
      '{"state":"Charged twice for #4471","questions":{"refund":{"type":"noul","instructions":"Refund?"}}}'
    const res = await post('/systemone', body)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-fake-body-sha256')).toBe(createHash('sha256').update(body).digest('hex'))
    expect(isSystemoneBody(await res.json())).toBe(true)
    const router = await post('/router/score', JSON.stringify(examples['router_request']))
    expect(router.status).toBe(501)
    expect(await router.json()).toMatchObject({ error: { reason: 'UNSUPPORTED_ENDPOINT' } })
  })

  it('is unsupported with the build to update to when no upstream build reaches the floor', async () => {
    const older = await makeTmpDataFolder('atomic-core-decision-upstream-old-')
    try {
      await older.writeBackend('llamacpp-upstream', 'b11344', 'macos-arm64')
      await mkdir(join(older.root, 'm'), { recursive: true })
      await writeFile(
        join(older.root, 'm', 'lev.gguf'),
        buildGguf({
          metadata: { 'general.architecture': 'qwen35', 'qwen35.decision.type': 'lev' },
          tensors: [],
        })
      )
      const settings = await SettingsStore.open(older.layout.core.settings)
      const stale = wireDecision({
        layout: older.layout,
        settings,
        journal: { add: async () => {}, remove: async () => {} },
        instanceId: 'contract',
        emit: () => {},
        log: () => {},
        overrides: { spawn: fakeDecisionSpawn({ decision: { upstream: true } }) },
      })
      try {
        await stale.configure({ enabled: true, model_path: 'm/lev.gguf' })
        await expect(stale.load()).rejects.toMatchObject({
          code: 'DECISION_ENGINE_UNSUPPORTED',
          message:
            'No installed llama.cpp build can run the decision model. Update llama.cpp to b11370 or newer.',
        })
        expect(stale.getStatus().state).toBe('unsupported')
      } finally {
        await stale.shutdown()
      }
    } finally {
      await older.cleanup()
    }
  })
})
