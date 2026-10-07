/**
 * Live check of an upstream decision model (ADR 2026-10-06-run-decision-models-on-upstream-llamacpp)
 * against a real ggml-org llama.cpp build (b11370 or newer) and a real upstream decision GGUF: the
 * core picks the upstream pack by its tag, starts it with its own argv, sees `decisions` in
 * `/v1/models`, and the public `/v1/systemone` answers while the router is refused with 501.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_UPSTREAM_DECISION_BIN=/path/to/<llama-bNNNNN>/llama-server   (an upstream release ≥ b11370)
 *   ATOMIC_LIVE_UPSTREAM_DECISION_MODEL=/path/to/Julia-1-Q8_0.gguf            (ggml-org/Julia-1-GGUF, 168 MB)
 *   ATOMIC_LIVE_UPSTREAM_DECISION_TAG=b11436       (optional; the tag the pack is installed under)
 */
import { chmod, cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { AtomicCore } from '../../src/core/index.js'
import { llamaServerExeName } from '../../src/config/index.js'

const BIN = process.env['ATOMIC_LIVE_UPSTREAM_DECISION_BIN'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_UPSTREAM_DECISION_MODEL'] ?? ''
const TAG = process.env['ATOMIC_LIVE_UPSTREAM_DECISION_TAG'] ?? 'b11436'
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && BIN !== '' && MODEL !== ''

/** The backend id this host's upstream build is published under. */
function hostBackend(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64'
  if (process.platform === 'win32') return 'win-cpu-x64'
  return 'ubuntu-x64'
}

let data: TmpDataFolder
let core: AtomicCore

describe.skipIf(!ENABLED)('a real upstream llama.cpp decision model', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-decision-upstream-')
    // The whole folder: llama-server links against the ggml libraries beside it.
    const packDir = join(
      data.layout.provider('llamacpp-upstream').backendsDir,
      TAG,
      hostBackend(),
      'build',
      'bin'
    )
    await mkdir(packDir, { recursive: true })
    await cp(dirname(BIN), packDir, { recursive: true })
    if (process.platform !== 'win32') await chmod(join(packDir, llamaServerExeName(process.platform)), 0o755)
    core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('starts on the upstream pack, answers /v1/systemone and refuses the router', async () => {
    await core.decision.configure({
      enabled: true,
      model_path: MODEL,
      model_id: 'live-decision',
      ctx_size: 1024,
      startup_timeout_secs: 300,
    })
    const status = await core.decision.load()
    expect(status).toMatchObject({
      state: 'ready',
      engine: { dialect: 'upstream', provider: 'llamacpp-upstream' },
      props: { endpoints: ['/v1/systemone'] },
    })

    const server = await core.startPublicServer({ port: 0 })
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const answer = await post('/systemone', {
      state: 'Hi, I was charged twice for my order #4471 and I want a refund.',
      questions: {
        intent: {
          type: 'choice',
          instructions: 'What does the customer want?',
          criteria: { refund: 'wants money back', track: 'wants to know where an order is' },
        },
        angry: { type: 'noul', instructions: 'Is the customer angry?' },
      },
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as { answers: Record<string, Record<string, unknown>> }
    expect(body.answers['intent']).toMatchObject({ choice: 'refund' })
    expect(typeof body.answers['angry']?.['noul']).toBe('number')

    const router = await post('/router/score', { task: 't', criterion: 'c', candidates: [] })
    expect(router.status).toBe(501)

    await core.decision.unload()
  }, 600_000)
})
