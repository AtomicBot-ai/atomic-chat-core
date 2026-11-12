/**
 * Live checks of the MLX runtime (PLAN.md stage 5) against a real `mlx-server` and a real MLX model
 * folder: `--help` knows every flag and choice the core passes, the argv is accepted, readiness is
 * read from the real log lines, the model answers, and a json_schema response_format comes back as
 * JSON that follows the schema (the frozen build bundles its structured-output engine whole). macOS on
 * Apple Silicon only. The engine candidate check (`engine=mlx`) runs it on the candidate and the pin
 * with SmolLM2-135M-Instruct 8-bit (`live_models` in .github/engine-candidate/mlx.json, 141 MB).
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_MLX_RESOURCES=/path/to/resources/bin     (holds mlx-server)
 *   ATOMIC_LIVE_MLX_MODEL=/path/to/mlx/model/folder      (config.json + *.safetensors; small)
 */
import { spawnSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseMlxHelp } from '../../scripts/lib/mlx-surface.mjs'
import { MLX_SERVER_BINARY } from '../../src/engine-builds/index.js'
import { buildMlxServerArgs } from '../../src/runtime/mlx/args.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { AtomicCore } from '../../src/core/index.js'

const RESOURCES = process.env['ATOMIC_LIVE_MLX_RESOURCES'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_MLX_MODEL'] ?? ''
const ENABLED =
  process.env['ATOMIC_LIVE'] === '1' && process.platform === 'darwin' && RESOURCES !== '' && MODEL !== ''

/** The drafter kinds and KV schemes settings can pick, each as buildMlxServerArgs passes it. */
const DRAFT_KINDS = ['dflash', 'mtp', 'eagle3']
const KV_SCHEMES = ['uniform', 'turboquant']

let data: TmpDataFolder
let core: AtomicCore
let port: number

/** `POST /v1/chat/completions` on the core's public listener, as a client of the loaded model. */
async function chat(body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'live-mlx', temperature: 0, ...body }),
  })
  const text = await response.text()
  expect(response.status, text).toBe(200)
  return JSON.parse(text) as { choices: Array<{ message: { content?: string | null } }> }
}

describe.skipIf(!ENABLED)('a real mlx-server', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-mlx-')
    core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, resourcesDir: RESOURCES })
    await core.registry('mlx').write('live-mlx', {
      model_path: MODEL,
      name: basename(MODEL),
      size_bytes: (await stat(join(MODEL, 'config.json'))).size,
    })
    port = (await core.startPublicServer({ port: 0 })).port as number
  }, 60_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('answers --help with every flag and choice the core passes', () => {
    // The first run of a freshly unpacked onefile is scanned by Gatekeeper (MLX_PROBE_TIMEOUT_MS).
    const help = spawnSync(join(RESOURCES, MLX_SERVER_BINARY), ['--help'], {
      cwd: RESOURCES,
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(help.status, `${help.error?.message ?? ''}${help.stderr}`).toBe(0)
    const parsed = parseMlxHelp(`${help.stdout}\n${help.stderr}`)
    expect(parsed.usage, 'argparse’s usage line, the install probe’s marker').toBe(true)
    // Every argv a load can start the server with: a drafter of each kind, each KV scheme.
    const argvs = DRAFT_KINDS.flatMap((draft_kind) =>
      KV_SCHEMES.map((kv_quant_scheme) =>
        buildMlxServerArgs(
          '/models/m',
          8080,
          {
            ctx_size: 4096,
            draft_model_path: '/models/d',
            block_size: 16,
            draft_kind,
            kv_bits: 4,
            kv_quant_scheme,
          },
          () => false
        )
      )
    )
    const passed = [...new Set(argvs.flatMap((argv) => argv.filter((a) => a.startsWith('--'))))]
    expect(passed).toContain('--draft-kind')
    expect(passed).toContain('--kv-quant-scheme')
    expect(
      passed.filter((flag) => !parsed.flags.includes(flag)),
      'flags the build does not know'
    ).toEqual([])
    for (const flag of ['--draft-kind', '--kv-quant-scheme']) {
      const values = [...new Set(argvs.map((argv) => argv[argv.indexOf(flag) + 1] as string))]
      expect(
        values.filter((value) => !parsed.choices[flag]?.includes(value)),
        `${flag} values the build refuses`
      ).toEqual([])
    }
  }, 130_000)

  it('loads a model folder, answers through the public API and unloads', async () => {
    const session = await core.load('mlx', 'live-mlx', { overrides: { ctx_size: 4096 } })
    expect(session).toMatchObject({ model_id: 'live-mlx', api_key: '' })
    try {
      const answer = await chat({ max_tokens: 8, messages: [{ role: 'user', content: 'Say hi.' }] })
      expect(typeof answer.choices[0]?.message.content).toBe('string')
    } finally {
      expect(await core.unload('mlx', 'live-mlx')).toEqual({ success: true })
    }
  }, 600_000)

  it('answers a json_schema response_format with JSON that follows the schema', async () => {
    // A build whose structured-output engine is missing from the bundle generates unconstrained text:
    // a 135M model then answers prose, not this object.
    await core.load('mlx', 'live-mlx', { overrides: { ctx_size: 4096 } })
    try {
      const answer = await chat({
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
          },
        },
      })
      const content = answer.choices[0]?.message.content ?? ''
      let parsed: unknown
      expect(() => (parsed = JSON.parse(content)), content).not.toThrow()
      expect(parsed, content).toMatchObject({ word: expect.any(String) })
    } finally {
      expect(await core.unload('mlx', 'live-mlx')).toEqual({ success: true })
    }
  }, 600_000)
})
