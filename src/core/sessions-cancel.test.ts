/**
 * Cancelling a load, where the races are: `LocalSessions` against a runtime the test controls for
 * the orderings a real process cannot be made to hit on demand, then a real core with a backend
 * that never becomes ready for the whole path down to the killed child.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../test/helpers/fake-backend-pack.js'
import { createCore, data as coreData, useCoreHarness } from '../../test/helpers/core-harness.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { CoreClient } from '../client/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import type { SessionInfo, UnloadResult } from '../contracts/index.js'
import { ExternalSessions } from '../runtime/index.js'
import type { LocalLoadOptions, LocalRuntime } from '../runtime/index.js'
import { LocalSessions, unknownProvider } from './sessions.js'
import type { CoreLoadOptions } from './types.js'

const info = (model_id: string, pid = 4242): SessionInfo => ({
  pid,
  port: 3456,
  model_id,
  model_path: `/models/${model_id}.gguf`,
  is_embedding: false,
  api_key: 'k',
})

/** A runtime whose load the test holds open and settles by hand. */
class GatedRuntime implements LocalRuntime {
  readonly sessions = new Map<string, SessionInfo>()
  readonly loads: Array<{ modelId: string; opts: LocalLoadOptions }> = []
  readonly unloads: string[] = []
  unloadResult: UnloadResult = { success: true }
  /** What a load does once it is asked for; defaults to honouring the cancel signal. */
  onLoad: (modelId: string, opts: LocalLoadOptions) => Promise<SessionInfo> = (modelId, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal?.addEventListener(
        'abort',
        () => reject(new AtomicCoreError('MODEL_LOAD_CANCELLED', 'The model load was cancelled.')),
        { once: true }
      )
    })

  list = () => [...this.sessions.values()]
  findSession = (modelId: string) => this.sessions.get(modelId)
  getLoadedModels = () => [...this.sessions.keys()]
  isLoading = () => false
  load(modelId: string, opts: LocalLoadOptions = {}): Promise<SessionInfo> {
    this.loads.push({ modelId, opts })
    return this.onLoad(modelId, opts)
  }
  async unload(modelId: string): Promise<UnloadResult> {
    this.unloads.push(modelId)
    if (this.unloadResult.success) this.sessions.delete(modelId)
    return this.unloadResult
  }
  autoIncreaseCtx = async () => ({ ok: false as const, reason: 'not-loaded' as const })
  recreateSession = async () => ({ ok: false as const, reason: 'not-loaded' as const })
  shutdown = async () => {}
}

describe('LocalSessions.cancelLoad', () => {
  let data: TmpDataFolder
  let runtime: GatedRuntime
  let sessions: LocalSessions

  beforeEach(async () => {
    data = await makeTmpDataFolder('atomic-core-sessions-cancel-')
    runtime = new GatedRuntime()
    const runtimes = new Map<'llamacpp-upstream', LocalRuntime>([['llamacpp-upstream', runtime]])
    sessions = new LocalSessions({
      layout: data.layout,
      instanceId: 'instance-under-test',
      runtimes,
      externalSessions: new ExternalSessions({ emit: () => {} }),
      runtime: (provider) => {
        const found = runtimes.get(provider as 'llamacpp-upstream')
        if (!found) throw unknownProvider(provider, runtimes.keys())
        return found
      },
      assertRunning: () => {},
      increaseCtx: async () => ({ ok: false, reason: 'not-loaded' }),
      recreateSession: async () => ({ ok: false, reason: 'not-loaded' }),
    })
  })
  afterEach(() => data.cleanup())

  const claims = () => readdir(data.layout.core.modelClaims).catch(() => [] as string[])
  const reached = async (count: number) => {
    const deadline = Date.now() + 2000
    while (runtime.loads.length < count) {
      if (Date.now() > deadline)
        throw new Error(`the runtime saw ${runtime.loads.length} loads, not ${count}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('answers false when nothing is pending, and refuses a provider this core does not offer', () => {
    expect(sessions.cancelLoad('llamacpp-upstream', 'idle')).toBe(false)
    expect(() => sessions.cancelLoad('mlx', 'idle')).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_FOUND' })
    )
  })

  it('rejects the load in flight and releases its claim', async () => {
    const load = sessions.acquire('llamacpp-upstream', 'm', {})
    await reached(1)
    expect(await claims()).toHaveLength(1)
    expect(sessions.cancelLoad('llamacpp-upstream', 'm')).toBe(true)
    await expect(load).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(await claims()).toEqual([])
    // The cancel is spent with the load it was aimed at.
    expect(sessions.cancelLoad('llamacpp-upstream', 'm')).toBe(false)
  })

  it('rejects every acquire waiting on the same model; the queued one never claims or loads', async () => {
    const first = sessions.acquire('llamacpp-upstream', 'm', {})
    const queued = sessions.acquire('llamacpp-upstream', 'm', {})
    await reached(1)
    expect(sessions.cancelLoad('llamacpp-upstream', 'm')).toBe(true)
    await expect(first).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    await expect(queued).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(runtime.loads).toHaveLength(1)
    expect(await claims()).toEqual([])
  })

  it('never cancels the load that follows a cancelled one', async () => {
    const cancelled = sessions.acquire('llamacpp-upstream', 'm', {})
    await reached(1)
    sessions.cancelLoad('llamacpp-upstream', 'm')
    await expect(cancelled).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })

    runtime.onLoad = async (modelId) => {
      const session = info(modelId)
      runtime.sessions.set(modelId, session)
      return session
    }
    await expect(sessions.acquire('llamacpp-upstream', 'm', {})).resolves.toMatchObject({
      session: { model_id: 'm' },
      created: true,
    })
    expect(runtime.loads[1]?.opts.signal?.aborted).toBe(false)
  })

  it('lets a cancel that raced readiness win while the answer is undecided: unloads, releases, rejects', async () => {
    runtime.onLoad = async (modelId) => {
      const session = info(modelId)
      runtime.sessions.set(modelId, session)
      // The engine reported ready; the cancel lands before the acquire has answered.
      expect(sessions.cancelLoad('llamacpp-upstream', modelId)).toBe(true)
      return session
    }
    await expect(sessions.acquire('llamacpp-upstream', 'm', {})).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    expect(runtime.unloads).toEqual(['m'])
    expect(runtime.findSession('m')).toBeUndefined()
    expect(await claims()).toEqual([])
  })

  it('keeps the claim when the process it cancelled would not stop', async () => {
    runtime.unloadResult = { success: false, error: 'EPERM' }
    runtime.onLoad = async (modelId) => {
      const session = info(modelId)
      runtime.sessions.set(modelId, session)
      sessions.cancelLoad('llamacpp-upstream', modelId)
      return session
    }
    await expect(sessions.acquire('llamacpp-upstream', 'm', {})).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    // A live process still holds the model: releasing the claim would let a second copy load.
    expect(runtime.findSession('m')).toBeDefined()
    expect(await claims()).toHaveLength(1)
  })

  it('answers false once the load has answered, so the caller unloads instead', async () => {
    runtime.onLoad = async (modelId) => {
      const session = info(modelId)
      runtime.sessions.set(modelId, session)
      return session
    }
    await sessions.acquire('llamacpp-upstream', 'm', {})
    expect(sessions.cancelLoad('llamacpp-upstream', 'm')).toBe(false)
    expect(runtime.findSession('m')).toBeDefined()
  })

  it('lets a queued unload run once the load ahead of it was cancelled', async () => {
    const load = sessions.acquire('llamacpp-upstream', 'm', {})
    await reached(1)
    const unload = sessions.unload('llamacpp-upstream', 'm')
    sessions.cancelLoad('llamacpp-upstream', 'm')
    await expect(load).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    await expect(unload).resolves.toEqual({ success: true })
  })

  it("uses the core's own signal, whatever a request body carried under that name", async () => {
    const load = sessions.acquire('llamacpp-upstream', 'm', {
      signal: 'not-a-signal',
    } as unknown as CoreLoadOptions)
    await reached(1)
    expect(runtime.loads[0]?.opts.signal).toBeInstanceOf(AbortSignal)
    sessions.cancelLoad('llamacpp-upstream', 'm')
    await expect(load).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
  })

  it('keeps models independent: cancelling one leaves another loading', async () => {
    const a = sessions.acquire('llamacpp-upstream', 'a', {})
    const b = sessions.acquire('llamacpp-upstream', 'b', {})
    await reached(2)
    expect(sessions.cancelLoad('llamacpp-upstream', 'a')).toBe(true)
    await expect(a).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(runtime.loads.find((l) => l.modelId === 'b')?.opts.signal?.aborted).toBe(false)
    sessions.cancelLoad('llamacpp-upstream', 'b')
    await expect(b).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
  })
})

describe.skipIf(!CAN_INSTALL_FAKE_BACKEND)('cancelling a load through a real core', () => {
  useCoreHarness()

  const pidsIn = async (file: string): Promise<number[]> =>
    (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number)
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('stops a backend that never becomes ready: 409 to the loader, the child killed, nothing left behind', async () => {
    const core = await createCore()
    await coreData.writeModel('Owner/Huge-GGUF')
    const pidFile = join(coreData.root, 'pids')
    await installFakeBackend(coreData.layout, { mode: 'hang', pidFile })
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })

    expect(await client.cancelModelLoad('llamacpp-upstream', 'Owner/Huge-GGUF')).toBe(false)

    const load = client.loadModel('llamacpp-upstream', 'Owner/Huge-GGUF')
    const outcome = load.then(
      () => 'loaded',
      (error: unknown) => error
    )
    // The app retries while its load request is still travelling; so does this.
    const deadline = Date.now() + 5000
    while ((await pidsIn(pidFile)).length === 0) {
      if (Date.now() > deadline) throw new Error('the backend never started')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const [pid] = (await pidsIn(pidFile)) as [number]
    expect(alive(pid)).toBe(true)

    expect(await client.cancelModelLoad('llamacpp-upstream', 'Owner/Huge-GGUF')).toBe(true)
    expect(await outcome).toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
      message: 'The model load was cancelled.',
    })
    expect(alive(pid)).toBe(false)
    expect(core.sessions()).toEqual([])
    expect(await readdir(coreData.layout.core.modelClaims).catch(() => [])).toEqual([])
    expect(await client.cancelModelLoad('llamacpp-upstream', 'Owner/Huge-GGUF')).toBe(false)

    // The cancel was aimed at that load only: with a backend that answers, the model loads.
    await installFakeBackend(coreData.layout, { pidFile })
    await expect(client.loadModel('llamacpp-upstream', 'Owner/Huge-GGUF')).resolves.toMatchObject({
      model_id: 'Owner/Huge-GGUF',
    })
  })
})
