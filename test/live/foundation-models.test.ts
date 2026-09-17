/**
 * Foundation Models smoke (PLAN.md stage 5) against the app's real `foundation-models-server` on
 * macOS 26 with Apple Intelligence: availability is read from the binary itself, and where the model
 * is available it starts, answers on its own port with its key, and stops. Where it is not, the load
 * must fail with the plugin's classified error rather than a timeout.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_FM_RESOURCES=/path/to/resources/bin     (holds foundation-models-server)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { AtomicCore } from '../../src/core.js'
import type { FoundationModelsRuntime } from '../../src/runtime/foundation-models/index.js'

const RESOURCES = process.env['ATOMIC_LIVE_FM_RESOURCES'] ?? ''
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && process.platform === 'darwin' && RESOURCES !== ''

let data: TmpDataFolder
let core: AtomicCore

describe.skipIf(!ENABLED)('the real Foundation Models server', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-fm-')
    core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, resourcesDir: RESOURCES })
  })

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('reports availability, and starts and answers exactly when available', async () => {
    const runtime = core.runtime('foundation-models') as FoundationModelsRuntime
    const availability = await runtime.checkAvailability(true)
    expect([
      'available',
      'notEligible',
      'appleIntelligenceNotEnabled',
      'modelNotReady',
      'unavailable',
    ]).toContain(availability)
    if (availability !== 'available') {
      // A reason the server names is classified, and reported at once rather than after a timeout.
      const started = Date.now()
      await expect(core.load('foundation-models', 'apple/on-device')).rejects.toMatchObject({
        code:
          availability === 'unavailable'
            ? expect.stringMatching(/PROCESS_ERROR|SERVER_START_FAILED/)
            : 'FOUNDATION_MODELS_UNAVAILABLE',
      })
      expect(Date.now() - started).toBeLessThan(30_000)
      expect(core.sessions()).toEqual([])
      return
    }
    const session = await core.load('foundation-models', 'apple/on-device')
    const answer = await fetch(`http://127.0.0.1:${session.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${session.api_key}` },
      body: JSON.stringify({ model: 'apple/on-device', messages: [{ role: 'user', content: 'Say hi.' }] }),
    })
    expect(answer.status).toBe(200)
    expect(await core.unload('foundation-models', 'apple/on-device')).toEqual({ success: true })
  }, 180_000)
})
