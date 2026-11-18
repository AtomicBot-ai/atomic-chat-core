import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrataRuntime } from './strata-runtime.js'
import type { StrataControlStatus } from './strata-control-plan.js'
import type { GpuClaimHook } from '../shared/index.js'
const ready = { state: 'ready', hostPid: 111, ownerId: 'a'.repeat(32), instanceId: 'b'.repeat(32) } as const
function fixture(logPath?: string) {
  const status = vi.fn(async (): Promise<StrataControlStatus> => ready)
  const stop = vi.fn(async () => true)
  const proof = vi.fn(async () => true)
  const close = vi.fn(async () => {})
  const expose = vi.fn(async () => ({ port: 10300, apiKey: 'gateway-key', close }))
  const start = vi.fn(async () => ({ state: 'starting' as const }))
  const claimGpu = vi.fn<GpuClaimHook>(async (_claim, _signal, granted) => granted?.())
  const runtime = new StrataRuntime({
    prepare: async () => ({
      build: '/build',
      gpuId: 'gpu-1',
      modelPath: '/source/model.gguf',
      timeoutMs: 1_000,
      owner: { start, status, stop },
      ...(logPath ? { logPath } : {}),
      proveHttp: proof,
      expose,
    }),
    pollMs: 1,
    claimGpu,
  })
  return { runtime, status, stop, proof, expose, start, close, claimGpu }
}
it.each([
  {
    name: 'Strata hybrid buffer exhaustion',
    log: "strata-q36: not enough VRAM left for the hybrid experts' buffers and slots (1159 MiB needed, 4 MiB free after the weights, the context and the sessions)",
    expected: { code: 'OUT_OF_MEMORY', details: '1159 MiB needed, 4 MiB free.' },
  },
  {
    name: 'CUDA allocator failure',
    log: 'strata-q36: cudaMalloc(&pd, nb) failed: out of memory (/data/private/model.cc:1018)',
    expected: { code: 'OUT_OF_MEMORY', message: 'Strata ran out of GPU memory while loading the model.' },
  },
  {
    name: 'unrelated crash following a VRAM warning',
    log: 'strata serve: WARNING: not enough VRAM to cache more experts\nError: invalid model metadata',
    expected: { code: 'MODEL_LOAD_FAILED', message: 'Strata stopped before the model was ready.' },
  },
  {
    name: 'missing engine log',
    log: undefined,
    expected: { code: 'MODEL_LOAD_FAILED', message: 'Strata stopped before the model was ready.' },
  },
])('reports the startup error for $name and still releases the GPU', async ({ log, expected }) => {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-strata-load-'))
  try {
    const logPath = join(dir, 'strata.log')
    if (log) await writeFile(logPath, 'startup noise\n'.repeat(10_000) + log)
    const f = fixture(logPath)
    f.status.mockResolvedValueOnce({ state: 'failed' })
    await expect(f.runtime.load('model')).rejects.toMatchObject(expected)
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.runtime.gpuOccupancy()).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('publishes the owner PID and gateway only after Control and HTTP independently report readiness', async () => {
  const f = fixture()
  f.status.mockResolvedValueOnce({ state: 'starting' })
  f.proof.mockResolvedValueOnce(false)
  const a = f.runtime.load('model')
  const b = f.runtime.load('model')
  expect(await a).toMatchObject({ pid: 111, port: 10300, api_key: 'gateway-key', model_id: 'model' })
  expect(await b).toEqual(await a)
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.claimGpu).toHaveBeenCalledWith(
    { model_id: 'model', cards: ['gpu-1'], auxiliary: false, exclusiveCardsOfProvider: true },
    expect.any(AbortSignal),
    expect.any(Function)
  )
  expect(f.status).toHaveBeenCalledTimes(3)
  expect(f.proof).toHaveBeenCalledTimes(2)
  expect(f.expose).toHaveBeenCalledTimes(1)
  await f.runtime.shutdown()
})
it('cancels a queued Strata reload while a different model holds the runtime turn', async () => {
  const f = fixture()
  let notifyAcquired!: () => void
  const acquired = new Promise<void>((resolve) => {
    notifyAcquired = resolve
  })
  let continueLoad!: () => void
  const continuation = new Promise<void>((resolve) => {
    continueLoad = resolve
  })
  f.claimGpu.mockImplementationOnce(async (_claim, _signal, granted) => {
    notifyAcquired()
    await continuation
    granted?.()
  })
  const loading = f.runtime.load('first')
  await acquired
  const abort = new AbortController()
  const queued = f.runtime.load('second', { signal: abort.signal })
  abort.abort()
  try {
    await expect(queued).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(f.start).not.toHaveBeenCalled()
  } finally {
    continueLoad()
    await loading
    await f.runtime.shutdown()
  }
  expect(f.start).toHaveBeenCalledOnce()
})
it('withdraws the session but keeps GPU and build occupancy after an unconfirmed stop', async () => {
  const f = fixture()
  await f.runtime.load('model')
  f.stop.mockResolvedValueOnce(false)
  expect((await f.runtime.unload('model')).success).toBe(false)
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.runtime.findSession('model')).toBeUndefined()
  expect(f.runtime.gpuOccupancy()).toMatchObject([
    { model_id: 'model', cards: ['gpu-1'], state: 'stop-unconfirmed' },
  ])
  expect(await f.runtime.engineHost().inUse()).toEqual(['/build'])
  await expect(f.runtime.load('model')).rejects.toMatchObject({ code: 'GPU_BUSY' })
  expect((await f.runtime.unload('model')).success).toBe(true)
  expect(f.runtime.gpuOccupancy()).toEqual([])
  await f.runtime.shutdown()
})
it('cancels during startup and waits for stop before returning cancellation', async () => {
  const f = fixture()
  const abort = new AbortController()
  f.status.mockImplementationOnce(async () => {
    abort.abort()
    return { state: 'starting' }
  })
  await expect(f.runtime.load('model', { signal: abort.signal })).rejects.toMatchObject({
    code: 'MODEL_LOAD_CANCELLED',
  })
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.expose).not.toHaveBeenCalled()
  expect(f.runtime.gpuOccupancy()).toEqual([])
  await f.runtime.shutdown()
})
