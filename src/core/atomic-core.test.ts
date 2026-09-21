import { describe, expect, it, vi } from 'vitest'
import { cores, createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { AtomicCoreError } from '../contracts/index.js'
import { inspectLock } from '../lock/index.js'
import type { ErrorReport } from '../telemetry/index.js'
import { AtomicCore } from './atomic-core.js'

useCoreHarness()

describe('shutdown', () => {
  it('stops the public listener, closes control and releases the lock', async () => {
    const core = await createCore()
    await core.startPublicServer({ port: 0 })
    const controlUrl = core.control.url
    await core.shutdown()
    expect(await inspectLock(data.layout)).toEqual({ kind: 'free' })
    await expect(fetch(`${controlUrl}/atomic/v1/health`)).rejects.toThrow()
    await core.shutdown() // idempotent
  })

  it('rejects new work as soon as shutdown begins', async () => {
    const core = await createCore()
    const stopping = core.shutdown()
    await expect(core.load('llamacpp-upstream', 'late')).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await expect(core.unload('llamacpp-upstream', 'late')).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await expect(core.startPublicServer({ port: 0 })).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await stopping
  })
})

describe('error reporting', () => {
  function recorder() {
    const captured: ErrorReport[] = []
    return {
      captured,
      telemetry: {
        capture: (report: ErrorReport) => captured.push(report),
        state: () => ({ enabled: true, reporting: true, has_user: false, tags: {} }),
        update: () => {},
      },
    }
  }

  it('reports a load that failed in the engine, with the settings it loaded with, and rethrows', async () => {
    const { captured, telemetry } = recorder()
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, errorReporter: telemetry })
    cores.push(core)
    const failure = new AtomicCoreError('LLAMA_CPP_PROCESS_ERROR', 'engine failed', 'GGML_ASSERT(x) failed')
    vi.spyOn(core.runtime('llamacpp-upstream'), 'load').mockRejectedValue(failure)
    vi.spyOn(core.runtime('llamacpp-upstream'), 'autoIncreaseCtx').mockRejectedValue(failure)
    vi.spyOn(core.runtime('llamacpp-upstream'), 'recreateSession').mockRejectedValue(failure)
    await expect(
      core.load('llamacpp-upstream', 'org/m-Q4_K_M', { overrides: { ctx_size: 4096 } })
    ).rejects.toBe(failure)
    expect(captured).toEqual([
      expect.objectContaining({
        source: 'model_load',
        fingerprint: ['model-load-failure', 'llamacpp-upstream', 'LLAMA_CPP_PROCESS_ERROR'],
        tags: expect.objectContaining({ context_length: 4096, quant: 'Q4_K_M' }),
        extra: { engine_errors: 'GGML_ASSERT(x) failed' },
      }),
    ])
    await expect(core.increaseCtx('llamacpp-upstream', 'other')).rejects.toBe(failure)
    await expect(core.recreateSession('llamacpp-upstream', 'third')).rejects.toBe(failure)
    expect(captured).toHaveLength(3)
  })

  it('does not report refusals, and loads without a reporter as before', async () => {
    const { captured, telemetry } = recorder()
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, errorReporter: telemetry })
    cores.push(core)
    await expect(core.load('bogus' as 'mlx', 'm')).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' })
    expect(captured).toEqual([])
    await core.shutdown()

    const plain = await createCore()
    const failure = new AtomicCoreError('OUT_OF_MEMORY', 'oom')
    vi.spyOn(plain.runtime('llamacpp-upstream'), 'load').mockRejectedValue(failure)
    await expect(plain.load('llamacpp-upstream', 'm')).rejects.toBe(failure)
  })
})
