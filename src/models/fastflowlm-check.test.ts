import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dataLayout } from '../config/index.js'
import candidate from '../../test/fixtures/fastflowlm/qwen3-candidate.json' with { type: 'json' }
import { writeFlmInstallation } from '../../test/helpers/fastflowlm-installation.js'
import { FastFlowLmRegistry } from './fastflowlm.js'
import { checkFastFlowLmModel } from './fastflowlm-check.js'
let root: string, registry: FastFlowLmRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'flm-check-'))
  registry = new FastFlowLmRegistry(dataLayout(root))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})
const host = (
  supported = true,
  tag: string | null = 'flm-1.0.11-r1',
  ready = true,
  blockers: string[] = []
) =>
  vi.fn(async () => ({
    engine_version: tag,
    ready,
    reason: ready ? null : 'xrt-device-unavailable',
    blockers: supported ? blockers : ['platform-unsupported'],
  }))
it.each([
  [host(false), 'platform-unsupported'],
  [host(true, null, false, ['xdna2-not-found']), 'platform-unsupported'],
  [host(true, null), 'engine-not-installed'],
  [host(true, 'flm-1.0.10-r9'), 'requires-newer-engine'],
  [host(true, 'flm-1.0.11-r1', false), 'environment-not-ready'],
  [host(), 'ok'],
] as const)(
  'checks descriptors before download and never creates a model directory',
  async (machine, verdict) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await checkFastFlowLmModel({ descriptor: candidate.definition }, registry, machine)).toMatchObject(
      { verdict, metadata: null, requirements: { minimum_flm_version: 'flm-1.0.11-r1' } }
    )
    expect(await readdir(root)).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  }
)
it('compares the native model format and Atomic revision separately', async () => {
  const newer = await writeFlmInstallation(root, { flm_version: '1.0.12', max_position_embeddings: 32768 })
  for (const body of [{ model_id: newer.metadata.variant_id }, { path: newer.dir }])
    expect(await checkFastFlowLmModel(body, registry, host())).toMatchObject({
      verdict: 'requires-newer-engine',
      requirements: { minimum_flm_version: 'flm-1.0.12-r1' },
      metadata: newer.metadata,
    })
  expect(
    await checkFastFlowLmModel(
      { descriptor: { ...candidate.definition, minimum_flm_version: 'flm-1.0.11-r2' } },
      registry,
      host()
    )
  ).toMatchObject({ verdict: 'requires-newer-engine' })
})
it.each([
  { flm_version: '0.9.22', max_position_embeddings: 32768, vision_model_weight: '../../outside.q4nx' },
  { flm_version: '0.9.22', max_position_embeddings: 32768, audio_model_weight: 'unplanned.q4nx' },
  { flm_version: '0.9.21', max_position_embeddings: 32768 },
  { flm_version: '1.0.foo', max_position_embeddings: 32768 },
  { flm_version: '0.9.22', max_position_embeddings: 2048 },
])('rejects incompatible local config %j', async (config) => {
  const { dir } = await writeFlmInstallation(root, config)
  expect(await checkFastFlowLmModel({ path: dir }, registry, host())).toMatchObject({
    verdict: 'invalid-installation',
  })
})
it('distinguishes malformed requests from invalid descriptors and installations', async () => {
  for (const body of [{}, null, { path: 42 }, { path: root, model_id: 'x' }])
    await expect(checkFastFlowLmModel(body, registry, host())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  for (const body of [{ descriptor: {} }, { model_id: 'absent' }])
    expect(await checkFastFlowLmModel(body, registry, host())).toMatchObject({
      verdict: 'invalid-installation',
      metadata: null,
    })
})
