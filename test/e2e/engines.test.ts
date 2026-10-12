/**
 * The `/engines` layer through the compiled binary (change `unify-engine-lifecycle`, task 4.3):
 *
 *   - versions over the fixture mirror: the llama.cpp manifest and an sd.cpp manifest from `file://`;
 *   - a llama.cpp update applied by the core while a model runs from the fake `llama-server`: the
 *     model is unloaded, `version_backend` moves, the old pack goes;
 *   - another installed pack made active while a model runs;
 *   - a pack a session still runs from refused on both removal routes;
 *   - a managed engine reinstalled on the fake Linux host: a newer descriptor offered, the removal
 *     runs without asking, the setup that follows waits for consent.
 *
 * No imports from `src/`. POSIX only: the fake engines and the fake Linux machine are shell launchers.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startBackendInstallFixture } from '../helpers/backend-install-e2e.js'
import type { InstallFixture } from '../helpers/backend-install-e2e.js'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import {
  DESCRIPTOR_ID,
  DESCRIPTOR_URL,
  fakeManagedHost,
  readyState,
  REQUIRED_DISK_BYTES,
} from '../helpers/fake-managed-host.js'
import type { FakeManagedHost } from '../helpers/fake-managed-host.js'

const { BIN } = core
const POSIX = process.platform !== 'win32'
// No provider publishes a Linux arm64 build the fixture could name.
const NO_BUILD_FOR_HOST = process.arch === 'arm64' && process.platform === 'linux'
const VLLM_DESCRIPTOR_URL = new URL('../fixtures/runtimes/vllm.json', import.meta.url).href

let dataFolder: string
let managedRoot: string
let host: FakeManagedHost | undefined
const daemons: ChildProcess[] = []
const fixtures: InstallFixture[] = []
const streams: AbortController[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-engines-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-engines-'))
  host = undefined
})
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort()
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
  if (host !== undefined) {
    await host.close()
    await rm(host.dir, { recursive: true, force: true, maxRetries: 3 })
  }
  await rm(dataFolder, { recursive: true, force: true, maxRetries: 3 })
  await rm(managedRoot, { recursive: true, force: true, maxRetries: 3 })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, init)
const send = (ready: ReadyLine, method: string, path: string, body?: unknown) =>
  control(ready, path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

interface Build {
  version: string
  variant: string
  origin: string
  active: boolean
  in_use: boolean
  removable: boolean
  not_removable_reason?: string
}
interface Entry {
  engine: string
  kind: string
  active_choice: string
  builds: Build[]
  active: { version: string; variant: string } | null
  latest: { version: string; variant: string } | null
  update: { needed: boolean; target: { version: string; variant: string } | null; apply: string }
  source: string | null
  error: { code: string } | null
}
interface Operation {
  operation_id: string
  request_id: string
  kind: string
  phase: string
  revision: number
  plan_digest: string | null
  error: { code: string; message: string } | null
}

async function versions(ready: ReadyLine, body: unknown): Promise<Entry[]> {
  const res = await send(ready, 'POST', '/engines/versions', body)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { engines: Entry[] }).engines
}

/** The event stream as the desktop's relay reads it: names and payloads, as they arrive. */
async function events(ready: ReadyLine): Promise<Array<{ event: string; data: unknown }>> {
  const controller = new AbortController()
  streams.push(controller)
  const res = await control(ready, '/events', { signal: controller.signal })
  const seen: Array<{ event: string; data: unknown }> = []
  void (async () => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let pending = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        pending += decoder.decode(value, { stream: true })
        const frames = pending.split('\n\n')
        pending = frames.pop() ?? ''
        for (const frame of frames) {
          const event = /^event: (.*)$/m.exec(frame)?.[1]
          const data = /^data: (.*)$/m.exec(frame)?.[1]
          if (event && data) seen.push({ event, data: JSON.parse(data) as unknown })
        }
      }
    } catch {
      // Aborted in afterEach.
    }
  })()
  return seen
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 15_000,
  state: () => unknown = () => undefined
): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  expect(await check(), `${what} ${JSON.stringify(await state())}`).toBe(true)
}

// ---------------------------------------------------------------------------------------------
// llama.cpp
// ---------------------------------------------------------------------------------------------

describe.skipIf(!existsSync(BIN) || !POSIX || NO_BUILD_FOR_HOST)('llama.cpp through /engines', () => {
  let fixture: InstallFixture

  /** A daemon on a CPU host with `version_backend` set, two fake packs and one model. */
  async function start(packs: string[], selected: string, env: NodeJS.ProcessEnv = {}): Promise<ReadyLine> {
    fixture = await startBackendInstallFixture(dataFolder)
    fixtures.push(fixture)
    for (const version of packs)
      await core.writeFakeBackend(dataFolder, {}, { version, backend: fixture.backend })
    await core.writeModel(dataFolder, 'demo')
    const { ready } = await core.startDaemon(dataFolder, daemons, [], env)
    expect(
      (await send(ready, 'PUT', '/hardware/override', { gpus: [], cpu_extensions: ['avx', 'avx2'] })).status
    ).toBe(200)
    const chosen = await send(ready, 'PATCH', '/settings/llamacpp-upstream', {
      values: { version_backend: `${selected}/${fixture.backend}`, fit: false },
    })
    expect(chosen.status, await chosen.clone().text()).toBe(200)
    return ready
  }

  const load = async (ready: ReadyLine) => {
    const res = await send(ready, 'POST', '/models/llamacpp-upstream/demo/load', {})
    expect(res.status, await res.clone().text()).toBe(200)
  }
  const sessions = async (ready: ReadyLine) =>
    (
      (await (await control(ready, '/sessions')).json()) as { sessions: Array<{ model_id: string }> }
    ).sessions.map((s) => s.model_id)
  const versionBackend = async (ready: ReadyLine) =>
    (
      (await (await control(ready, '/settings/llamacpp-upstream')).json()) as {
        values: Record<string, unknown>
      }
    ).values['version_backend']

  it('answers versions over the mirror and applies the update while a model runs', async () => {
    const sdManifest = join(dataFolder, 'sdcpp-manifest.json')
    await writeFile(
      sdManifest,
      JSON.stringify({
        tag_name: 'master-901-abcdef0',
        download_base: 'https://mirror.atomic.invalid/releases',
        assets: ['macos-arm64', 'linux-cpu-x64', 'linux-vulkan-x64'].map((backend) => ({
          backend,
          name: 'sd.tar.gz',
          sha256: 'a'.repeat(64),
          size: 1,
        })),
      })
    )
    const ready = await start(['b6325'], 'b6325', {
      ATOMIC_SDCPP_MANIFEST_URL: pathToFileURL(sdManifest).href,
    })
    await load(ready)
    const seen = await events(ready)

    const before = await versions(ready, { proxy: fixture.proxy, app_version: '99.0.0' })
    const upstream = before.find((entry) => entry.engine === 'llamacpp-upstream')
    expect(upstream).toMatchObject({
      kind: 'llamacpp',
      active_choice: 'client',
      active: { version: 'b6325', variant: fixture.backend },
      update: { needed: true, target: { version: 'b99999', variant: fixture.backend }, apply: 'swap' },
      source: 'remote',
      error: null,
    })
    expect(upstream?.builds).toEqual([
      expect.objectContaining({
        version: 'b6325',
        active: true,
        in_use: true,
        not_removable_reason: 'active',
      }),
    ])
    expect(before.find((entry) => entry.engine === 'sd-cpp')).toMatchObject({
      kind: 'engine-build',
      active_choice: 'core',
      latest: { version: 'master-901-abcdef0' },
      source: 'remote',
    })
    expect(before.some((entry) => entry.engine === 'mlx')).toBe(process.platform === 'darwin')

    const update = await send(ready, 'POST', '/engines/llamacpp-upstream/update', {
      task_id: 'engine-update-llamacpp-upstream-b99999',
      proxy: fixture.proxy,
    })
    expect(update.status, await update.clone().text()).toBe(200)
    expect(await update.json()).toEqual({
      updated: true,
      active: { version: 'b99999', variant: fixture.backend },
      retired: [],
      kept_in_use: [],
    })
    expect(await sessions(ready)).toEqual([])
    expect(await versionBackend(ready)).toBe(`b99999/${fixture.backend}`)
    expect(existsSync(join(dataFolder, 'llamacpp-upstream', 'backends', 'b6325', fixture.backend))).toBe(true)
    await eventually(
      () =>
        seen.some(
          (frame) =>
            frame.event === 'engine:changed' &&
            JSON.stringify(frame.data) === JSON.stringify({ engine: 'llamacpp-upstream', reason: 'update' })
        ),
      'engine:changed {update} reached the stream'
    )
    expect(
      seen.some(
        (frame) =>
          frame.event === 'settings:changed' && (frame.data as { key: string }).key === 'version_backend'
      )
    ).toBe(true)
    // Nothing newer now: the offer is gone.
    const after = await versions(ready, { proxy: fixture.proxy })
    expect(after.find((entry) => entry.engine === 'llamacpp-upstream')?.update.needed).toBe(false)
  })

  it('makes another installed pack active while a model runs, keeping both', async () => {
    const ready = await start(['b6325', 'b6300'], 'b6325')
    await load(ready)
    const res = await send(
      ready,
      'POST',
      `/engines/llamacpp-upstream/builds/b6300/${fixture.backend}/activate`
    )
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual({
      activated: true,
      active: { version: 'b6300', variant: fixture.backend },
    })
    expect(await sessions(ready)).toEqual([])
    expect(await versionBackend(ready)).toBe(`b6300/${fixture.backend}`)
    for (const version of ['b6300', 'b6325'])
      expect(existsSync(join(dataFolder, 'llamacpp-upstream', 'backends', version, fixture.backend))).toBe(
        true
      )
  })

  it('refuses to remove a pack a session still runs from, on both routes', async () => {
    const ready = await start(['b6325', 'b6300'], 'b6325')
    await load(ready)
    // The selection moves without an unload: the running session keeps b6325 busy.
    await send(ready, 'PATCH', '/settings/llamacpp-upstream', {
      values: { version_backend: `b6300/${fixture.backend}` },
    })
    const engines = await send(ready, 'DELETE', `/engines/llamacpp-upstream/builds/b6325/${fixture.backend}`)
    expect(engines.status).toBe(409)
    expect(((await engines.json()) as { error: { code: string } }).error.code).toBe('BACKEND_IN_USE')
    const backends = await send(ready, 'DELETE', `/backends/llamacpp-upstream/b6325/${fixture.backend}`)
    expect(backends.status).toBe(409)
    const active = await send(ready, 'DELETE', `/engines/llamacpp-upstream/builds/b6300/${fixture.backend}`)
    expect(active.status).toBe(400)
    expect(((await active.json()) as { error: { details?: string } }).error.details).toBe('active')
    expect(existsSync(join(dataFolder, 'llamacpp-upstream', 'backends', 'b6325', fixture.backend))).toBe(true)

    expect((await send(ready, 'POST', '/models/llamacpp-upstream/demo/unload', {})).status).toBe(200)
    const removed = await send(ready, 'DELETE', `/engines/llamacpp-upstream/builds/b6325/${fixture.backend}`)
    expect(await removed.json()).toEqual({ removed: true })
  })
})

// ---------------------------------------------------------------------------------------------
// A managed engine
// ---------------------------------------------------------------------------------------------

describe.skipIf(!existsSync(BIN) || !POSIX)('a managed engine reinstalled through /engines', () => {
  const TARGET = { kind: 'runtime' as const, installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' }
  const NEWER = 'tensorrt-llm-1.2.1-r3'

  const startManaged = (descriptorUrl: string) =>
    core.startDaemon(dataFolder, daemons, [], {
      ATOMIC_CORE_MANAGED_ROOT: managedRoot,
      ...(host?.env ?? {}),
      ATOMIC_RUNTIME_DESCRIPTOR_URL: descriptorUrl,
      ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM: VLLM_DESCRIPTOR_URL,
    })
  const get = async (ready: ReadyLine, id: string): Promise<Operation> =>
    (await (await control(ready, `/environments/operations/${id}`)).json()) as Operation
  const operations = async (ready: ReadyLine): Promise<Operation[]> =>
    ((await (await control(ready, '/snapshot')).json()) as { environment_operations: Operation[] })
      .environment_operations

  it('offers the newer descriptor, removes without asking and begins the setup, which waits for consent', async () => {
    host = await fakeManagedHost(readyState())
    const first = await startManaged(DESCRIPTOR_URL)
    // Installed by the ordinary setup the user consents to.
    const begun = (await (
      await send(first.ready, 'POST', '/environments/default/operations', {
        request_id: 'req-1',
        target: TARGET,
        kind: 'setup',
        descriptor_id: DESCRIPTOR_ID,
      })
    ).json()) as Operation
    await eventually(
      async () => (await get(first.ready, begun.operation_id)).phase === 'awaiting-consent',
      'asks'
    )
    const asking = await get(first.ready, begun.operation_id)
    await send(first.ready, 'POST', `/environments/operations/${begun.operation_id}/resume`, {
      expected_revision: asking.revision,
      approved_plan_digest: asking.plan_digest,
    })
    await eventually(async () => (await get(first.ready, begun.operation_id)).phase === 'ready', 'installed')

    // conf publishes a newer release of the same engine; the next core reads it.
    for (const daemon of daemons.splice(0)) {
      const exited = new Promise((resolve) => daemon.once('exit', resolve))
      daemon.kill('SIGKILL')
      await exited
    }
    const newer = join(dataFolder, `${NEWER}.json`)
    const published = JSON.parse(readFileSync(fileURLToPath(DESCRIPTOR_URL), 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(newer, JSON.stringify({ ...published, descriptor_id: NEWER }))
    const { ready } = await startManaged(pathToFileURL(newer).href)
    const seen = await events(ready)

    const entry = (await versions(ready, { app_version: '99.0.0' })).find((e) => e.engine === 'tensorrt-llm')
    expect(entry).toMatchObject({
      kind: 'managed',
      active_choice: 'core',
      active: { version: DESCRIPTOR_ID, variant: 'linux/amd64' },
      update: { needed: true, target: { version: NEWER, variant: 'linux/amd64' }, apply: 'reinstall' },
    })

    // The fake machine never gives an image's space back on `docker rmi`; a real removal would.
    await writeFile(join(host.dir, 'free-disk-bytes'), String(4 * REQUIRED_DISK_BYTES))
    const update = await send(ready, 'POST', '/engines/tensorrt-llm/update', {
      request_id: 'upd-1',
      app_version: '99.0.0',
    })
    expect(update.status, await update.clone().text()).toBe(202)
    const { operation_id: removal } = (await update.json()) as { operation_id: string }
    await eventually(async () => (await get(ready, removal)).phase === 'removed', 'removed without consent')

    let setup: Operation | undefined
    await eventually(
      async () => {
        setup = (await operations(ready)).find((operation) => operation.request_id === 'upd-1:setup')
        return setup?.phase === 'awaiting-consent'
      },
      'the setup that follows waits for consent',
      15_000,
      () => operations(ready)
    )
    expect(setup).toMatchObject({ kind: 'setup' })
    await eventually(
      () =>
        seen.some(
          (frame) =>
            frame.event === 'engine:changed' &&
            JSON.stringify(frame.data) === JSON.stringify({ engine: 'tensorrt-llm', reason: 'reinstall' })
        ),
      'engine:changed {reinstall} reached the stream'
    )
    // The installation is gone until the user approves the new release.
    const after = (await versions(ready, { app_version: '99.0.0' })).find((e) => e.engine === 'tensorrt-llm')
    expect(after).toMatchObject({ builds: [], active: null, latest: { version: NEWER } })
  })
})
