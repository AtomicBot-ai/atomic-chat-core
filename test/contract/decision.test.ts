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
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { PublicServer } from '../../src/server/public/index.js'
import { SettingsStore } from '../../src/settings/index.js'
import { fakeDecisionSpawn } from '../helpers/fake-llama-server.js'
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
