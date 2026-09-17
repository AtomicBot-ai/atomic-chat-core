/**
 * Live checks of the MLX runtime (PLAN.md stage 5) against the app's real `mlx-server` and a real
 * MLX model folder: the argv is accepted, readiness is read from the real log lines, and the model
 * answers. macOS on Apple Silicon only.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_MLX_RESOURCES=/path/to/resources/bin     (holds mlx-server)
 *   ATOMIC_LIVE_MLX_MODEL=/path/to/mlx/model/folder      (config.json + *.safetensors; small)
 */
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { AtomicCore } from '../../src/core.js'

const RESOURCES = process.env['ATOMIC_LIVE_MLX_RESOURCES'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_MLX_MODEL'] ?? ''
const ENABLED =
  process.env['ATOMIC_LIVE'] === '1' && process.platform === 'darwin' && RESOURCES !== '' && MODEL !== ''

let data: TmpDataFolder
let core: AtomicCore

describe.skipIf(!ENABLED)('a real mlx-server', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-mlx-')
    core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, resourcesDir: RESOURCES })
    await core.registry('mlx').write('live-mlx', {
      model_path: MODEL,
      name: basename(MODEL),
      size_bytes: (await stat(join(MODEL, 'config.json'))).size,
    })
  }, 60_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('loads a model folder, answers through the public API and unloads', async () => {
    const session = await core.load('mlx', 'live-mlx', { overrides: { ctx_size: 4096 } })
    expect(session).toMatchObject({ model_id: 'live-mlx', api_key: '' })

    const state = await core.startPublicServer({ port: 0 })
    const answer = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'live-mlx',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    })
    expect(answer.status).toBe(200)
    expect(await core.unload('mlx', 'live-mlx')).toEqual({ success: true })
  }, 600_000)
})
