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
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startBackendInstallFixture } from '../helpers/backend-install-e2e.js'
import type { InstallFixture } from '../helpers/backend-install-e2e.js'
import * as core from '../helpers/compiled-core.js'
import { startReleaseMirror } from '../helpers/engine-builds-mirror.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import { foundryLocalTestPlatform } from '../helpers/foundry-local-host.js'
import { liteRtLmTestPlatform } from '../helpers/litert-lm-host.js'
import { geniexTestEnv, writeFakeGeniexHost } from '../helpers/geniex-host.js'
import { makeZip } from '../helpers/make-zip.js'
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
const SGLANG_DESCRIPTOR_URL = new URL('../fixtures/runtimes/sglang.json', import.meta.url).href

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
      ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG: SGLANG_DESCRIPTOR_URL,
    })
  const get = async (ready: ReadyLine, id: string): Promise<Operation> =>
    (await (await control(ready, `/environments/operations/${id}`)).json()) as Operation
  const operations = async (ready: ReadyLine): Promise<Operation[]> =>
    ((await (await control(ready, '/snapshot')).json()) as { environment_operations: Operation[] })
      .environment_operations

  it('/engines/versions lists every managed engine of the host, SGLang last, each with its own latest release', async () => {
    host = await fakeManagedHost(readyState())
    const { ready } = await startManaged(DESCRIPTOR_URL)
    const managed = (await versions(ready, { app_version: '99.0.0' })).filter(
      (entry) => entry.kind === 'managed'
    )
    expect(managed.map((entry) => entry.engine)).toEqual(['tensorrt-llm', 'vllm', 'sglang'])
    const sglangId = (
      JSON.parse(readFileSync(fileURLToPath(SGLANG_DESCRIPTOR_URL), 'utf8')) as { descriptor_id: string }
    ).descriptor_id
    expect(managed.find((entry) => entry.engine === 'sglang')).toMatchObject({
      active_choice: 'core',
      builds: [],
      active: null,
      latest: { version: sglangId },
      update: { apply: 'reinstall' },
    })
  })

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

// ---------------------------------------------------------------------------------------------
// Foundry Local (change add-foundry-local, task 4.6)
// ---------------------------------------------------------------------------------------------

const FAKE_FOUNDRY_HOST = fileURLToPath(new URL('../helpers/fake-foundry-host.mjs', import.meta.url))
// The compiled core registers Foundry Local only where the platform rule holds; Windows needs a .cmd host.
const FOUNDRY_PLATFORM = process.platform === 'win32' ? null : foundryLocalTestPlatform()
const ALL_FOUNDRY_PLATFORMS = ['win-x64', 'win-arm64', 'macos-arm64', 'linux-x64', 'linux-arm64']

describe.skipIf(!existsSync(BIN) || FOUNDRY_PLATFORM === null)('Foundry Local through /engines', () => {
  it('lists, installs and updates the build, and never removes the one a model runs from', async () => {
    const mirror = await startReleaseMirror()
    try {
      const src = join(dataFolder, 'foundry-src')
      await mkdir(join(src, 'lib'), { recursive: true })
      await writeFile(join(src, 'lib', 'libfoundry_local.so'), 'so')
      await writeFile(join(src, 'lib', 'libfoundry_local.dylib'), 'dylib')
      await tarCreate({ gzip: true, cwd: src, file: join(dataFolder, 'fl.tgz') }, ['lib'])
      const body = await readFile(join(dataFolder, 'fl.tgz'))
      const sha256 = createHash('sha256').update(body).digest('hex')
      const manifest = join(dataFolder, 'foundry-local-manifest.json')
      const publish = async (tag: string, publishedAt: string) => {
        for (const platform of ALL_FOUNDRY_PLATFORMS)
          mirror.serve(
            `/microsoft/foundry-local/releases/download/${tag}/foundry-local-${platform}.tgz`,
            body
          )
        await writeFile(
          manifest,
          JSON.stringify({
            schema_version: 1,
            upstream_repo: 'microsoft/foundry-local',
            releases: [
              {
                tag,
                published_at: publishedAt,
                min_core_version: '0.1.0',
                c_api_version: 2,
                assets: ALL_FOUNDRY_PLATFORMS.map((platform) => ({
                  platform,
                  name: `foundry-local-${platform}.tgz`,
                  size: body.length,
                  sha256,
                })),
              },
            ],
          })
        )
      }
      const host = join(dataFolder, 'fake-foundry-host')
      await writeFile(
        host,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_FOUNDRY_HOST)} "$@"\n`,
        {
          mode: 0o755,
        }
      )
      await publish('v2.1.0', '2026-09-30T00:43:42Z')
      const { ready } = await core.startDaemon(dataFolder, daemons, [], {
        ATOMIC_FOUNDRY_LOCAL_MANIFEST_URL: pathToFileURL(manifest).href,
        ATOMIC_FOUNDRY_HOST_TEST_COMMAND: host,
      })
      const proxy = mirror.proxy
      const entry = async (force = false) =>
        (await versions(ready, { force, proxy })).find(
          (candidate) => candidate.engine === 'foundry-local'
        ) as Entry
      const platform = FOUNDRY_PLATFORM as string

      expect(await entry(true)).toMatchObject({
        kind: 'engine-build',
        active_choice: 'core',
        builds: [],
        active: null,
        latest: { version: 'v2.1.0', variant: platform },
      })
      const installed = await send(ready, 'POST', '/engines/foundry-local/update', {
        task_id: 'fl-engines-1',
        proxy,
      })
      expect(await installed.json()).toMatchObject({
        updated: true,
        active: { version: 'v2.1.0', variant: platform },
      })

      // A model runs from the build.
      const model = join(dataFolder, 'foundry-local', 'models', 'e2e-fl-cpu')
      await mkdir(model, { recursive: true })
      await writeFile(join(model, 'genai_config.json'), '{}')
      await writeFile(
        join(model, 'model.yml'),
        'model_path: foundry-local/models/e2e-fl-cpu\nname: e2e-fl-cpu\nsize_bytes: 1\nfoundry_local:\n  model_id: m\n  variant_id: e2e-fl-cpu\n  execution_provider: cpu\n  device: cpu\n'
      )
      const loaded = await send(ready, 'POST', '/models/foundry-local/e2e-fl-cpu/load', {})
      expect(loaded.status, await loaded.clone().text()).toBe(200)
      expect((await entry()).builds).toEqual([
        expect.objectContaining({
          version: 'v2.1.0',
          variant: platform,
          active: true,
          in_use: true,
          removable: false,
          not_removable_reason: 'active',
        }),
      ])
      const viaEngines = await send(ready, 'DELETE', `/engines/foundry-local/builds/v2.1.0/${platform}`)
      expect(viaEngines.status).toBe(400)
      expect(((await viaEngines.json()) as { error: { details?: string } }).error.details).toBe('active')
      const viaBuilds = await send(ready, 'DELETE', `/engine-builds/foundry-local/v2.1.0/${platform}`)
      expect(viaBuilds.status).toBe(409)
      expect(((await viaBuilds.json()) as { error: { code: string } }).error.code).toBe('BACKEND_IN_USE')
      expect(existsSync(join(dataFolder, 'foundry-local', 'backends', 'v2.1.0', platform))).toBe(true)

      // conf publishes v2.2.0: offered, installed; the model running from v2.1.0 is unloaded by it.
      await publish('v2.2.0', '2026-10-30T00:00:00Z')
      expect((await entry(true)).update).toMatchObject({
        needed: true,
        target: { version: 'v2.2.0', variant: platform },
      })
      const updated = await send(ready, 'POST', '/engines/foundry-local/update', {
        task_id: 'fl-engines-2',
        proxy,
      })
      expect(await updated.json()).toMatchObject({ updated: true, active: { version: 'v2.2.0' } })
      expect(
        ((await (await control(ready, '/sessions')).json()) as { sessions: unknown[] }).sessions
      ).toEqual([])
      const removed = await send(ready, 'DELETE', `/engines/foundry-local/builds/v2.1.0/${platform}`)
      expect(await removed.json()).toEqual({ removed: true })
      expect((await entry()).builds.map((build) => build.version)).toEqual(['v2.2.0'])
    } finally {
      await mirror.close()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------
// LiteRT-LM (change add-litert-lm-runtime, task 4.5)
// ---------------------------------------------------------------------------------------------

const FAKE_LITERT_HOST = fileURLToPath(new URL('../helpers/fake-litert-host.mjs', import.meta.url))
const LITERT_PLATFORM = process.platform === 'win32' ? null : liteRtLmTestPlatform()
const ALL_LITERT_PLATFORMS = ['macos-arm64', 'linux-x64', 'linux-arm64', 'win-x64']
const LITERT_LIBRARY: Record<string, string> = {
  'macos-arm64': 'liblitert-lm.dylib',
  'linux-x64': 'liblitert-lm.so',
  'linux-arm64': 'liblitert-lm.so',
  'win-x64': 'litert-lm.dll',
}

describe.skipIf(!existsSync(BIN) || LITERT_PLATFORM === null)('LiteRT-LM through /engines', () => {
  it('lists, installs and updates the build, and never removes the one a model runs from', async () => {
    const mirror = await startReleaseMirror()
    try {
      const manifest = join(dataFolder, 'litert-lm-manifest.json')
      const releases: unknown[] = []
      const publish = async (version: string, publishedAt: string) => {
        const assets = ALL_LITERT_PLATFORMS.map((platform) => {
          const name = `litert_lm_api-${version}-py3-none-${platform}.whl`
          const body = makeZip([
            { name: `litert_lm/${LITERT_LIBRARY[platform]}`, data: Buffer.from(version) },
          ])
          mirror.serve(`/packages/${version}/${name}`, body)
          return {
            platform,
            url: `https://files.pythonhosted.org/packages/${version}/${name}`,
            name,
            size: body.length,
            sha256: createHash('sha256').update(body).digest('hex'),
          }
        })
        releases.unshift({ version, published_at: publishedAt, min_core_version: '0.1.0', abi: 1, assets })
        await writeFile(manifest, JSON.stringify({ schema_version: 1, releases }))
      }
      const host = join(dataFolder, 'fake-litert-host')
      await writeFile(
        host,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_LITERT_HOST)} "$@"\n`,
        {
          mode: 0o755,
        }
      )
      await publish('0.18.1', '2026-10-19T22:44:33Z')
      const { ready } = await core.startDaemon(dataFolder, daemons, [], {
        ATOMIC_LITERT_LM_MANIFEST_URL: pathToFileURL(manifest).href,
        ATOMIC_LITERT_HOST_TEST_COMMAND: host,
      })
      const proxy = mirror.proxy
      const entry = async (force = false) =>
        (await versions(ready, { force, proxy })).find(
          (candidate) => candidate.engine === 'litert-lm'
        ) as Entry
      const platform = LITERT_PLATFORM as string

      expect(await entry(true)).toMatchObject({
        kind: 'engine-build',
        active_choice: 'core',
        builds: [],
        active: null,
        latest: { version: '0.18.1', variant: platform },
      })
      const installed = await send(ready, 'POST', '/engines/litert-lm/update', {
        task_id: 'lr-engines-1',
        proxy,
      })
      expect(await installed.json()).toMatchObject({
        updated: true,
        active: { version: '0.18.1', variant: platform },
      })

      // A model runs from the build.
      const model = join(dataFolder, 'litert-lm', 'models', 'e2e-lr-cpu')
      await mkdir(model, { recursive: true })
      await writeFile(join(model, 'm.litertlm'), 'litertlm')
      await writeFile(
        join(model, 'model.yml'),
        `model_path: litert-lm/models/e2e-lr-cpu/m.litertlm\nname: e2e-lr-cpu\nsize_bytes: 8\nlitert_lm:\n  model_id: m\n  variant_id: e2e-lr-cpu\n  backend: cpu\n  repo: o/r\n  revision: ${'a'.repeat(40)}\n  file: m.litertlm\n  tools: false\n  reasoning: false\n  vision: false\n  source: huggingface\n`
      )
      const loaded = await send(ready, 'POST', '/models/litert-lm/e2e-lr-cpu/load', {})
      expect(loaded.status, await loaded.clone().text()).toBe(200)
      expect((await entry()).builds).toEqual([
        expect.objectContaining({
          version: '0.18.1',
          variant: platform,
          active: true,
          in_use: true,
          removable: false,
          not_removable_reason: 'active',
        }),
      ])
      const viaEngines = await send(ready, 'DELETE', `/engines/litert-lm/builds/0.18.1/${platform}`)
      expect(viaEngines.status).toBe(400)
      expect(((await viaEngines.json()) as { error: { details?: string } }).error.details).toBe('active')
      const viaBuilds = await send(ready, 'DELETE', `/engine-builds/litert-lm/0.18.1/${platform}`)
      expect(viaBuilds.status).toBe(409)
      expect(((await viaBuilds.json()) as { error: { code: string } }).error.code).toBe('BACKEND_IN_USE')
      expect(existsSync(join(dataFolder, 'litert-lm', 'backends', '0.18.1', platform))).toBe(true)

      // conf publishes 0.18.2: offered, installed; the model running from 0.18.1 is unloaded by it.
      await publish('0.18.2', '2026-11-01T00:00:00Z')
      expect((await entry(true)).update).toMatchObject({
        needed: true,
        target: { version: '0.18.2', variant: platform },
      })
      const updated = await send(ready, 'POST', '/engines/litert-lm/update', {
        task_id: 'lr-engines-2',
        proxy,
      })
      expect(await updated.json()).toMatchObject({ updated: true, active: { version: '0.18.2' } })
      expect(
        ((await (await control(ready, '/sessions')).json()) as { sessions: unknown[] }).sessions
      ).toEqual([])
      const removed = await send(ready, 'DELETE', `/engines/litert-lm/builds/0.18.1/${platform}`)
      expect(await removed.json()).toEqual({ removed: true })
      expect((await entry()).builds.map((build) => build.version)).toEqual(['0.18.2'])
    } finally {
      await mirror.close()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------
// GenieX (change add-geniex-runtime, task 4.5)
// ---------------------------------------------------------------------------------------------

const GENIEX_MIRROR = 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex'

describe.skipIf(!existsSync(BIN) || !POSIX)('GenieX through /engines', () => {
  it('lists, installs and updates the build on a Snapdragon X host, and never removes the active one', async () => {
    const mirror = await startReleaseMirror()
    try {
      const manifest = join(dataFolder, 'geniex-manifest.json')
      const releases: unknown[] = []
      const publish = async (version: string, publishedAt: string) => {
        const name = `geniex-sdk-windows-arm64-v${version}.zip`
        const body = makeZip([{ name: 'sdk-windows-arm64/lib/geniex.dll', data: Buffer.from(version) }])
        mirror.serve(`/qai-hub-geniex/${name}`, body)
        releases.unshift({
          version,
          published_at: publishedAt,
          min_core_version: '0.1.0',
          abi: 1,
          notes_url: `https://github.com/qualcomm/GenieX/releases/tag/v${version}`,
          assets: [
            {
              platform: 'win-arm64',
              url: `${GENIEX_MIRROR}/${name}`,
              name,
              size: body.length,
              sha256: createHash('sha256').update(body).digest('hex'),
            },
          ],
        })
        await writeFile(manifest, JSON.stringify({ schema_version: 1, releases }))
      }
      const host = await writeFakeGeniexHost(join(dataFolder, 'fake-geniex-host'))
      await publish('0.9.3', '2026-10-19T23:09:06Z')
      const { ready } = await core.startDaemon(dataFolder, daemons, [], {
        ATOMIC_GENIEX_MANIFEST_URL: pathToFileURL(manifest).href,
        ...geniexTestEnv(host),
      })
      const proxy = mirror.proxy
      const entry = async (force = false) =>
        (await versions(ready, { force, proxy })).find((candidate) => candidate.engine === 'geniex') as Entry

      expect(await entry(true)).toMatchObject({
        kind: 'engine-build',
        active_choice: 'core',
        builds: [],
        active: null,
        latest: { version: '0.9.3', variant: 'win-arm64' },
      })
      const installed = await send(ready, 'POST', '/engines/geniex/update', {
        task_id: 'gx-engines-1',
        proxy,
      })
      expect(await installed.json()).toMatchObject({
        updated: true,
        active: { version: '0.9.3', variant: 'win-arm64' },
      })
      expect((await entry()).builds).toEqual([
        expect.objectContaining({
          version: '0.9.3',
          variant: 'win-arm64',
          active: true,
          removable: false,
          not_removable_reason: 'active',
        }),
      ])
      // A model runs from the build: in use, and refused on both routes.
      const model = join(dataFolder, 'geniex', 'models', 'e2e-gx-cpu')
      await mkdir(model, { recursive: true })
      await writeFile(join(model, 'm.gguf'), 'gguf')
      await writeFile(
        join(model, 'model.yml'),
        `model_path: geniex/models/e2e-gx-cpu/m.gguf\nname: e2e-gx-cpu\nsize_bytes: 4\ngeniex:\n  model_id: m\n  variant_id: e2e-gx-cpu\n  plugin: llama_cpp\n  backend: cpu\n  repo: o/r\n  revision: ${'a'.repeat(40)}\n  file: m.gguf\n  context_length: 4096\n  tools: false\n  reasoning: false\n  vision: false\n  source: huggingface\n`
      )
      const loaded = await send(ready, 'POST', '/models/geniex/e2e-gx-cpu/load', {})
      expect(loaded.status, await loaded.clone().text()).toBe(200)
      expect((await entry()).builds).toEqual([
        expect.objectContaining({
          version: '0.9.3',
          variant: 'win-arm64',
          active: true,
          in_use: true,
          removable: false,
          not_removable_reason: 'active',
        }),
      ])
      const viaEngines = await send(ready, 'DELETE', '/engines/geniex/builds/0.9.3/win-arm64')
      expect(viaEngines.status).toBe(400)
      expect(((await viaEngines.json()) as { error: { details?: string } }).error.details).toBe('active')
      const viaBuilds = await send(ready, 'DELETE', '/engine-builds/geniex/0.9.3/win-arm64')
      expect(viaBuilds.status).toBe(409)
      expect(((await viaBuilds.json()) as { error: { code: string } }).error.code).toBe('BACKEND_IN_USE')
      expect(existsSync(join(dataFolder, 'geniex', 'backends', '0.9.3', 'win-arm64'))).toBe(true)

      // conf publishes 0.9.4: offered, installed; the model running from 0.9.3 is unloaded by it, and 0.9.3 is then removable.
      await publish('0.9.4', '2026-11-01T00:00:00Z')
      expect((await entry(true)).update).toMatchObject({
        needed: true,
        target: { version: '0.9.4', variant: 'win-arm64' },
      })
      const updated = await send(ready, 'POST', '/engines/geniex/update', { task_id: 'gx-engines-2', proxy })
      expect(await updated.json()).toMatchObject({ updated: true, active: { version: '0.9.4' } })
      expect(
        ((await (await control(ready, '/sessions')).json()) as { sessions: unknown[] }).sessions
      ).toEqual([])
      const removed = await send(ready, 'DELETE', '/engines/geniex/builds/0.9.3/win-arm64')
      expect(await removed.json()).toEqual({ removed: true })
      expect((await entry()).builds.map((build) => build.version)).toEqual(['0.9.4'])
    } finally {
      await mirror.close()
    }
  }, 120_000)
})
