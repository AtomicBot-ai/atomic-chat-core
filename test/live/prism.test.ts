/**
 * Live checks of the PrismML provider (`atomic-prism`) against a real PrismML-Eng/llama.cpp build and
 * a real Bonsai GGUF — the engine candidate check of the fork (.github/engine-candidate/atomic-prism.json).
 * The fake backend cannot prove that a fork build passes the install gate, accepts the argv core
 * emits for it, or runs the PQ2_0 tensors stock llama.cpp refuses.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_PRISM_BIN=/path/to/llama-server       (from a llama-prism-<tag>-bin-<platform> archive)
 *   ATOMIC_LIVE_PRISM_MODEL=/path/to/Bonsai-PQ2_0.gguf (Ternary-Bonsai-1.7B-PQ2_0.gguf in CI)
 *   ATOMIC_LIVE_PRISM_TAG=prism-b10787-73bfe6c         (the release tag; the pack is installed under it)
 *
 * The binary is installed under its real tag and this host's CPU pack id, so the build gates in
 * `planLlamaArgs` see the upstream build the fork is cut from, as they do for a user.
 */
import { readFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { installUpstreamPack, readVersion } from '../helpers/live-llamacpp.js'
import { checkHelp, parseLlamaHelp } from '../../scripts/lib/llama-help.mjs'
import type { ContractLike } from '../../scripts/lib/llama-help.mjs'
import { AtomicCore } from '../../src/core/index.js'
import { determinePrismSupportedBackends, normalizeFeatures, prismTagBuild } from '../../src/backend/index.js'
import { verifyPrismBackendBinary } from '../../src/backend/install/service.js'
import { osTypeOf, rustArch } from '../../src/hardware/facts.js'
import { runHelp } from '../../src/runtime/llamacpp/probe.js'

const BIN = process.env['ATOMIC_LIVE_PRISM_BIN'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_PRISM_MODEL'] ?? ''
const TAG = process.env['ATOMIC_LIVE_PRISM_TAG'] ?? ''
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && BIN !== '' && MODEL !== '' && TAG !== ''

const MODEL_ID = 'live/bonsai'

let data: TmpDataFolder
let core: AtomicCore
let backend: string
let exe: string
const build = prismTagBuild(TAG) ?? 0
const log: string[] = []

/** The argv of the last `llama-server` core started for the Bonsai model, as core logged it. */
function lastArgv(): string[] {
  const line = log.filter((l) => l.startsWith('starting ') && l.includes(`atomic-prism/${MODEL_ID}:`)).at(-1)
  expect(line, 'core logs the argv of every llama-server it starts').toBeDefined()
  return (line ?? '').slice((line ?? '').indexOf(': ') + 2).split(' ')
}

describe.skipIf(!ENABLED)('a real PrismML build', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-prism-')
    // This host's CPU pack, the one the candidate check fetched: macos-arm64, linux-cpu-x64, win-cpu-x64.
    const [id] = determinePrismSupportedBackends(
      osTypeOf(process.platform),
      rustArch(process.arch),
      normalizeFeatures(null)
    )
    if (id === undefined) throw new Error(`PrismML builds nothing for ${process.platform}-${process.arch}`)
    backend = id
    exe = await installUpstreamPack(data.layout.provider('atomic-prism').backendsDir, BIN, TAG, backend)

    const modelDir = join(data.layout.provider('atomic-prism').modelsDir, MODEL_ID)
    await mkdir(modelDir, { recursive: true })
    core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      logger: (_level, message) => log.push(message),
    })
    await core.registry('atomic-prism').write(MODEL_ID, {
      model_path: MODEL,
      name: 'bonsai',
      size_bytes: (await stat(MODEL)).size,
      embedding: false,
    })
    // The pack a user who installed this build runs: pinned, as the install leaves it.
    await core.settings.update('atomic-prism', { version_backend: `${TAG}/${backend}` })
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('reports the build its tag names', async () => {
    expect(build, `${TAG} is a PrismML release tag`).toBeGreaterThan(0)
    const { output, build: reported } = await readVersion(exe)
    expect(reported, `--version must report the build of ${TAG}:\n${output}`).toBe(build)
    // The install gate itself: a pack that fails it is never published to the user.
    await verifyPrismBackendBinary(dirname(dirname(dirname(exe))), TAG, process.platform)
  }, 180_000)

  it('knows every flag and value core emits for its build (-h against the engine contract)', async () => {
    const contract = JSON.parse(
      readFileSync(new URL('../fixtures/llamacpp/engine-contract.json', import.meta.url), 'utf8')
    ) as ContractLike
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
    )
    const { output } = await runHelp(exe, env, dirname(exe), { timeoutMs: 60_000 })
    const findings = checkHelp(contract, build, parseLlamaHelp(output))
    expect(findings.filter((f) => f.severity === 'break' || f.severity === 'error')).toEqual([])
  }, 120_000)

  it('loads a Bonsai model on atomic-prism, answers a completion and unloads', async () => {
    const session = await core.load('atomic-prism', MODEL_ID, { overrides: { ctx_size: 512 } })
    expect(session.pid).toBeGreaterThan(0)

    // What core forces on the fork: no speculative decoding, no multi-GPU split.
    const argv = lastArgv().join(' ')
    expect(argv).not.toMatch(/--spec-type|--model-draft|--split-mode/)

    const state = await core.startPublicServer({ port: 0 })
    const answer = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    })
    expect(answer.status, await answer.clone().text()).toBe(200)
    const body = (await answer.json()) as { choices: Array<{ message: { content?: string } }> }
    expect(body.choices).toHaveLength(1)

    expect(await core.unload('atomic-prism', MODEL_ID)).toEqual({ success: true })
  }, 600_000)
})
