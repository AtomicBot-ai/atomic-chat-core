import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flmFacts, flmBuild } from '../../../test/helpers/flm-environment.js'
import { writeFlmInstallation } from '../../../test/helpers/fastflowlm-installation.js'
import { dataLayout } from '../../config/index.js'
import { AsyncMutex } from '../../diffusion/index.js'
import { ProcessJournal } from '../../lock/index.js'
import { FastFlowLmRegistry } from '../../models/index.js'
import { spawnAndAwaitReady } from '../shared/index.js'
import { FastFlowLmRuntime } from './runtime.js'

let root: string, cache: string, id: string, runtime: FastFlowLmRuntime, journal: ProcessJournal
let takeFirstPort = false
const events: string[] = []
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'flm-runtime-')))
  const layout = dataLayout(root)
  cache = layout.provider('fastflowlm').cacheDir!
  const model = await writeFlmInstallation(root)
  id = model.metadata.variant_id
  journal = await ProcessJournal.open(layout)
  events.length = 0
  takeFirstPort = false
  runtime = new FastFlowLmRuntime({
    registry: new FastFlowLmRegistry(layout),
    cache,
    dataRoot: root,
    journal,
    instanceId: 'owner',
    platform: 'linux',
    env: { HF_TOKEN: 'must-be-stripped', FLM_BACKEND: 'gpu' },
    trustedHosts: [],
    settings: async () => ({}),
    resolveBuild: async () => ({ tag: flmBuild, dir: join(root, 'build') }),
    probe: async () => flmFacts([]),
    assertLoadable: async () => {},
    lock: new AsyncMutex(),
    emit: (name) => events.push(name),
    spawn: (spec, opts) => {
      expect(spec.exe).toBe(join(root, 'build', 'flm-real'))
      if (takeFirstPort) {
        takeFirstPort = false
        return spawnAndAwaitReady(
          { ...spec, exe: process.execPath, args: ['-e', 'console.error("EADDRINUSE");process.exit(1)'] },
          opts
        )
      }
      return spawnAndAwaitReady(
        { ...spec, exe: process.execPath, args: [resolve('test/helpers/fake-fastflowlm.mjs'), ...spec.args] },
        opts
      )
    },
  })
})
afterEach(async () => {
  await runtime.shutdown()
  await rm(root, { recursive: true, force: true })
})
async function load() {
  const pending = runtime.load(id, { timeoutSecs: 10 })
  let dir = ''
  await vi.waitFor(async () => {
    dir = join(
      cache,
      (await readdir(cache)).find((s) => s.startsWith('session-'))!
    )
    expect(existsSync(join(dir, 'listened'))).toBe(true)
  })
  expect(runtime.list()).toEqual([])
  expect(journal.list()).toMatchObject([{ model_id: id }])
  await writeFile(join(dir, 'ready'), '')
  const s = await pending,
    base = 'http://127.0.0.1:' + s.port,
    headers = { 'authorization': 'Bearer ' + s.api_key, 'content-type': 'application/json' }
  const chat = (text: string, stream = false, signal?: AbortSignal) =>
    fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: text }], stream }),
      ...(signal ? { signal } : {}),
    })
  return { s, base, headers, chat, dir }
}
it('publishes only after the selected model loads, protects its gateway, maps both chat formats and confirms unload', async () => {
  const { s, base, headers, chat } = await load()
  expect((await fetch(base + '/v1/models')).status).toBe(401)
  expect((await fetch(base + '/api/pull', { method: 'POST', headers })).status).toBe(404)
  expect(await (await fetch(base + '/v1/models', { headers })).json()).toMatchObject({ data: [{ id }] })
  expect(await (await chat('hi')).json()).toMatchObject({ model: id, usage: { completion_tokens: 1 } })
  expect(await (await chat('hi', true)).text()).toContain('"model":"' + id + '"')
  expect(await runtime.engineHost().inUse()).toEqual([join(root, 'build')])
  expect(await runtime.unload(id)).toEqual({ success: true })
  expect(journal.list()).toEqual([])
  expect(() => process.kill(s.pid!, 0)).toThrow()
})
it.each([true, false])('releases the active generation after disconnect (stream=%s)', async (stream) => {
  const { chat, dir } = await load(),
    controller = new AbortController()
  const pending = chat('hold', stream, controller.signal)
    .then((r) => r.text())
    .catch(() => {})
  await vi.waitFor(() => expect(existsSync(join(dir, 'generating'))).toBe(true))
  controller.abort()
  await pending
  expect(await (await chat('next')).json()).toMatchObject({ model: id })
  expect(events).not.toContain('session:died')
})
it('kills only its own hung worker after cancellation and can reload the model', async () => {
  const { chat, dir } = await load(),
    controller = new AbortController()
  const pending = chat('hang', false, controller.signal).catch(() => {})
  await vi.waitFor(() => expect(existsSync(join(dir, 'generating'))).toBe(true))
  controller.abort()
  await pending
  await vi.waitFor(() => expect(events).toContain('session:died'), { timeout: 7000 })
  expect(runtime.list()).toEqual([])
  expect((await load()).s.model_id).toBe(id)
}, 15000)
it('cancels a load waiting behind an engine change without starting it later', async () => {
  let release!: () => void
  const held = runtime.engineHost().exclusive(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const abort = new AbortController()
  const waiting = runtime.load(id, { signal: abort.signal })
  abort.abort()
  try {
    await expect(waiting).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
  } finally {
    release()
    await held
  }
  expect(journal.list()).toEqual([])
})

it('retries a bind failure on a new process and removes the failed PID from the journal', async () => {
  takeFirstPort = true
  const { s, chat } = await load()
  expect(journal.list().map((r) => r.pid)).toEqual([s.pid])
  await chat('crash').catch(() => {})
  await vi.waitFor(() => expect(events).toContain('session:died'))
  expect(runtime.list()).toEqual([])
  expect(journal.list()).toEqual([])
})
it('does not stop an unproven PID or grant mutation while its previous session may be running', async () => {
  await journal.add({
    instance_id: 'previous',
    pid: process.pid,
    process_start_id: null,
    exe: 'old/flm',
    provider: 'fastflowlm',
    model_id: id,
    port: 3000,
    started_at: new Date().toISOString(),
  })
  await expect(runtime.unload(id)).rejects.toMatchObject({ code: 'FASTFLOWLM_DEVICE_BUSY' })
  await expect(runtime.load(id)).rejects.toMatchObject({ code: 'FASTFLOWLM_DEVICE_BUSY' })
  expect(journal.list()).toHaveLength(1)
})
