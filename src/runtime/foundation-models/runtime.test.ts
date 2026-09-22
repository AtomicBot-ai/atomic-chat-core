import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fakeSidecarSpawn } from '../../../test/helpers/fake-sidecar-server.js'
import type { FakeSidecarOptions } from '../../../test/helpers/fake-sidecar-server.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ProcessJournal } from '../../lock/index.js'
import { generateApiKey } from '../shared/index.js'
import { APPLE_MODEL_ID, AVAILABILITY_TTL_MS, FoundationModelsRuntime } from './runtime.js'
import type { FoundationModelsRuntimeOptions } from './runtime.js'

let data: TmpDataFolder
let journal: ProcessJournal
let events: Array<{ name: string; payload: Record<string, unknown> }>
const runtimes: FoundationModelsRuntime[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-fm-')
  journal = await ProcessJournal.open(data.layout)
  events = []
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.shutdown().catch(() => {})))
  await data.cleanup()
})

function runtime(
  fake: Partial<FakeSidecarOptions> = {},
  extra: Partial<FoundationModelsRuntimeOptions> = {}
) {
  const r = new FoundationModelsRuntime({
    instanceId: 'test-instance',
    resourcesDir: '/resources/bin',
    journal,
    emit: (name, payload) => events.push({ name, payload: payload as Record<string, unknown> }),
    exists: () => true,
    spawn: fakeSidecarSpawn({ kind: 'fm', ...fake }),
    ...extra,
  })
  runtimes.push(r)
  return r
}

describe('FoundationModelsRuntime', () => {
  it('starts the server with a port and the extension key, and serves the on-device model', async () => {
    const argvFile = join(data.root, 'argv.jsonl')
    const r = runtime({ argvFile })
    const session = await r.load(APPLE_MODEL_ID)

    expect(session).toMatchObject({ model_id: APPLE_MODEL_ID, model_path: '', is_embedding: false })
    expect(session.api_key).toBe(generateApiKey(APPLE_MODEL_ID, session.port, 'JanFoundationModels'))
    const argv = JSON.parse((await readFile(argvFile, 'utf8')).trim()) as string[]
    expect(argv).toEqual(['--port', String(session.port), '--api-key', session.api_key])

    const res = await fetch(`http://127.0.0.1:${session.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${session.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: APPLE_MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(journal.list().map((record) => [record.provider, record.pid])).toEqual([
      ['foundation-models', session.pid],
    ])
    expect(events.map((e) => e.name)).toEqual(['session:started'])
  })

  it('answers a second load with the running session and joins a load in flight', async () => {
    const r = runtime({ delayMs: 150 })
    const [a, b] = await Promise.all([r.load(APPLE_MODEL_ID), r.load(APPLE_MODEL_ID)])
    expect(a.pid).toBe(b.pid)
    expect((await r.load(APPLE_MODEL_ID)).pid).toBe(a.pid)
    expect(r.getLoadedModels()).toEqual([APPLE_MODEL_ID])
  })

  it('refuses any other model id with the extension wording', async () => {
    await expect(runtime().load('apple/other')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      message: "Foundation Models extension only supports model 'apple/on-device', got 'apple/other'",
    })
  })

  it('fails at the reason line without waiting for the exit', async () => {
    const r = runtime({ mode: 'error-line', reason: 'Device is not eligible for Apple Intelligence' })
    await expect(r.load(APPLE_MODEL_ID)).rejects.toMatchObject({
      code: 'FOUNDATION_MODELS_UNAVAILABLE',
      message: 'This device is not eligible for Apple Intelligence.',
    })
    expect(r.list()).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('reports an early exit and a timeout with the plugin codes', async () => {
    await expect(runtime({ mode: 'exit-2' }).load(APPLE_MODEL_ID)).rejects.toMatchObject({
      code: 'SERVER_START_FAILED',
    })
    await expect(runtime({ mode: 'hang' }).load(APPLE_MODEL_ID, { timeoutSecs: 0.3 })).rejects.toMatchObject({
      code: 'SERVER_START_TIMED_OUT',
      message: 'Foundation Models server did not become ready within 0.3 seconds.',
    })
  })

  it('refuses to start without the binary, and rejects a nonsensical timeout', async () => {
    await expect(runtime({}, { exists: () => false }).load(APPLE_MODEL_ID)).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
      message: `foundation-models-server binary not found at: ${join('/resources/bin', 'foundation-models-server')}`,
    })
    await expect(runtime({}, { resourcesDir: undefined }).load(APPLE_MODEL_ID)).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
    await expect(runtime().load(APPLE_MODEL_ID, { timeoutSecs: 0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('kills a server that is still coming up when the user cancels', async () => {
    const argvFile = join(data.root, 'argv.jsonl')
    const r = runtime({ mode: 'hang', argvFile })
    const cancel = new AbortController()
    const load = r.load(APPLE_MODEL_ID, { signal: cancel.signal })
    // The fake records its argv on startup: the file appearing means the child is running.
    while ((await readFile(argvFile, 'utf8').catch(() => '')) === '')
      await new Promise((resolve) => setTimeout(resolve, 10))

    cancel.abort()
    await expect(load).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
      message: 'The model load was cancelled.',
    })
    expect(r.list()).toEqual([])
    expect(r.isLoading(APPLE_MODEL_ID)).toBe(false)
    expect(journal.list()).toEqual([])
    expect(events).toEqual([])
    // A cancel is aimed at one load: the next one starts clean.
    await expect(r.load(APPLE_MODEL_ID, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
  })

  // Windows has no signals: a killed process there exits with code 1 and no signal to name.
  it.skipIf(process.platform === 'win32')('drops a session whose server died and says so', async () => {
    const r = runtime()
    const session = await r.load(APPLE_MODEL_ID)
    process.kill(session.pid, 'SIGKILL')
    await expect.poll(() => r.list().length).toBe(0)
    await expect.poll(() => events.some((e) => e.name === 'session:died')).toBe(true)
    expect(events.find((e) => e.name === 'session:died')?.payload).toMatchObject({
      provider: 'foundation-models',
      pid: session.pid,
      signal: 'SIGKILL',
      message: 'The Foundation Models server was stopped by signal SIGKILL.',
    })
    await expect.poll(() => journal.list().length).toBe(0)
  })

  it('unloads, succeeds for a model that is not loaded, and recreates on request', async () => {
    const r = runtime()
    await expect(r.unload(APPLE_MODEL_ID)).resolves.toEqual({ success: true })
    expect(await r.recreateSession(APPLE_MODEL_ID)).toEqual({ ok: false, reason: 'not-loaded' })
    const first = await r.load(APPLE_MODEL_ID)
    const recreated = await r.recreateSession(APPLE_MODEL_ID)
    expect(recreated.ok && recreated.session.pid).not.toBe(first.pid)
    expect(await r.autoIncreaseCtx(APPLE_MODEL_ID)).toEqual({ ok: false, reason: 'unsupported' })
    expect(await r.unload(APPLE_MODEL_ID)).toEqual({ success: true })
    expect(await r.autoIncreaseCtx(APPLE_MODEL_ID)).toEqual({ ok: false, reason: 'not-loaded' })
    expect(events.filter((e) => e.name === 'session:unloaded')).toHaveLength(2)
  })

  it('stops its servers on shutdown and refuses work afterwards', async () => {
    const r = runtime()
    const session = await r.load(APPLE_MODEL_ID)
    await r.shutdown()
    expect(r.list()).toEqual([])
    expect(() => process.kill(session.pid, 0)).toThrow()
    await expect(r.load(APPLE_MODEL_ID)).rejects.toMatchObject({ code: 'CORE_NOT_RUNNING' })
  })

  it('checks availability through --check, caches it for 30 minutes, and never caches a missing binary', async () => {
    let now = 1_000
    let calls = 0
    let present = true
    const r = runtime(
      {},
      {
        now: () => now,
        exists: () => present,
        runCheck: async () => {
          calls++
          return calls === 1 ? 'appleIntelligenceNotEnabled\n' : '  '
        },
      }
    )
    expect(await r.checkAvailability()).toBe('appleIntelligenceNotEnabled')
    now += AVAILABILITY_TTL_MS - 1
    expect(await r.checkAvailability()).toBe('appleIntelligenceNotEnabled')
    expect(calls).toBe(1)
    now += 1
    expect(await r.checkAvailability()).toBe('unavailable')
    expect(await r.checkAvailability(true)).toBe('unavailable')
    expect(calls).toBe(3)
    present = false
    expect(await r.checkAvailability(true)).toBe('binaryNotFound')
  })

  it.skipIf(process.platform === 'win32')('runs the real --check through the binary', async () => {
    const script = join(data.root, 'foundation-models-server')
    const { writeFile, chmod } = await import('node:fs/promises')
    await writeFile(script, `#!/bin/sh\necho modelNotReady\n`)
    await chmod(script, 0o755)
    const r = new FoundationModelsRuntime({ instanceId: 'x', resourcesDir: data.root })
    runtimes.push(r)
    expect(await r.checkAvailability()).toBe('modelNotReady')
    await chmod(script, 0o644)
    await expect(r.checkAvailability(true)).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})
