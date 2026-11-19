import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { StrataRuntime } from './strata-runtime.js'
import type { StrataControlStatus } from './strata-control-plan.js'
import type { GpuClaimHook } from '../shared/index.js'
const ready = { state: 'ready', hostPid: 111, ownerId: 'a'.repeat(32), instanceId: 'b'.repeat(32) } as const
function fixture(logPath?: string, monitorPollMs?: number) {
  const status = vi.fn(async (): Promise<StrataControlStatus> => ready)
  const stop = vi.fn(async () => true)
  const httpHealth = vi.fn(async (): Promise<string | undefined> => undefined)
  const emit = vi.fn()
  const log = vi.fn()
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
      httpHealthFailure: httpHealth,
      expose,
    }),
    pollMs: 1,
    ...(monitorPollMs === undefined ? {} : { monitorPollMs }),
    claimGpu,
    emit,
    log,
  })
  return { runtime, status, stop, httpHealth, expose, start, close, claimGpu, emit, log }
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
  f.httpHealth.mockResolvedValueOnce('Strata telemetry returned HTTP 503.')
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
  expect(f.httpHealth).toHaveBeenCalledTimes(2)
  expect(f.expose).toHaveBeenCalledTimes(1)
  await f.runtime.shutdown()
})

it('keeps the gateway open during health failures and resets the count after recovery', async () => {
  const f = fixture(undefined, 1)
  const throttle = 'Strata telemetry returned HTTP 503.'
  const timeout = 'Strata telemetry timed out after 2000 ms.'
  const session = await f.runtime.load('model')
  try {
    f.httpHealth
      .mockResolvedValueOnce(throttle)
      .mockResolvedValueOnce(timeout)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(throttle)
    await vi.waitFor(() => expect(f.log).toHaveBeenCalledTimes(5))
    expect(f.log.mock.calls).toEqual([
      ['warn', `Strata model health check 1/3 failed. ${throttle}`],
      ['warn', `Strata model health check 2/3 failed. ${timeout}`],
      ['info', 'Strata model health check recovered after 2 failure(s).'],
      ['warn', `Strata model health check 1/3 failed. ${throttle}`],
      ['info', 'Strata model health check recovered after 1 failure(s).'],
    ])
    expect(f.runtime.findSession('model')).toEqual(session)
    expect(f.emit).toHaveBeenCalledOnce()
    expect(f.close).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  } finally {
    await f.runtime.shutdown()
  }
})

it('withdraws the session after three consecutive failures and reports their causes', async () => {
  const f = fixture(undefined, 1)
  await f.runtime.load('model')
  try {
    f.status
      .mockRejectedValueOnce(
        new AtomicCoreError('MODEL_LOAD_FAILED', 'Strata Control command failed.', 'unavailable')
      )
      .mockResolvedValueOnce({ ...ready, instanceId: 'c'.repeat(32) })
    f.httpHealth.mockResolvedValueOnce('Strata telemetry returned HTTP 503.')
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce())
    expect(f.runtime.findSession('model')).toBeUndefined()
    expect(f.runtime.gpuOccupancy()).toEqual([])
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.log.mock.calls).toEqual([
      ['warn', 'Strata model health check 1/3 failed. Strata Control command failed (unavailable).'],
      ['warn', 'Strata model health check 2/3 failed. Strata Control instance ID did not match.'],
      ['warn', 'Strata model health check 3/3 failed. Strata telemetry returned HTTP 503.'],
    ])
    expect(f.emit).toHaveBeenLastCalledWith('session:died', {
      provider: 'strata',
      model_id: 'model',
      pid: 111,
      exit_code: null,
      signal: null,
      message: 'Strata model health check 3/3 failed. Strata telemetry returned HTTP 503.',
    })
  } finally {
    await f.runtime.shutdown()
  }
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
