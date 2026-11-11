/**
 * Engine builds through the compiled binary (openspec change `move-sdcpp-mlx-install-to-core`, task
 * 4.4): conf manifests from `file://` overrides, archives from an HTTPS mirror behind a CONNECT
 * proxy, the fake engines inside them.
 *
 *   - sd.cpp: catalog → install → a newer manifest offered as an update → installed while a model is
 *     loaded (unloaded with `engine-updated`, the old build kept) → removed.
 *   - MLX: the installer's build active → a newer one installed → the next load starts it → a restart
 *     with an installer newer still makes the installer's build active and keeps the download.
 *   - audio.cpp: catalog → install from the mirror → the fork's `-a<rev>` build of the same version
 *     offered and installed beside it → the old one removed; conf's bootstrap manifest installed from
 *     upstream `0xShug0/audio.cpp`'s flat `.tar.gz`.
 *
 * No imports from `src/`. POSIX only: the fake engines are shell launchers.
 */
import { execFile } from 'node:child_process'
import { release as osRelease } from 'node:os'
import { promisify } from 'node:util'
import qwen from '../fixtures/fastflowlm/qwen3-candidate.json' with { type: 'json' }
import { flmRelease } from '../helpers/fastflowlm-manifest.js'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext } from '../helpers/compiled-diffusion.js'
import {
  audiocppUpstreamArchive,
  fakeAudiocppServer,
  launcherArchive,
  nodeLauncher,
  startReleaseMirror,
} from '../helpers/engine-builds-mirror.js'
import type { ReleaseMirror } from '../helpers/engine-builds-mirror.js'
import { FAKE_SIDECAR_SCRIPT } from '../helpers/fake-sidecar-server.js'
import { foundryLocalTestPlatform } from '../helpers/foundry-local-host.js'
import { liteRtLmTestPlatform } from '../helpers/litert-lm-host.js'
import { geniexTestEnv, writeFakeGeniexHost } from '../helpers/geniex-host.js'
import { makeZip } from '../helpers/make-zip.js'

const { BIN } = core
const { control, json, waitFor } = sd
const MIRROR = 'https://mirror.atomic.invalid/releases'
/** Every id a host of the CI matrix picks: one archive serves them all. */
const SD_HOST_IDS = ['macos-arm64', 'linux-cpu-x64', 'linux-cpu-arm64', 'linux-vulkan-x64']

let ctx: SdContext
let mirror: ReleaseMirror
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-engine-builds-')
  mirror = await startReleaseMirror()
})
afterEach(async () => {
  await sd.sdCleanup(ctx)
  await mirror.close()
})

const post = (ready: ReadyLine, path: string, body: unknown = {}) =>
  control(ctx, ready, path, { method: 'POST', body: JSON.stringify(body) })

interface Catalog {
  manifest: { tag: string; source: string } | null
  host_backend_id: string | null
  host_download_bytes: number | null
  installed: Array<{ tag: string; backend_id: string; origin: string; active: boolean; removable: boolean }>
  active: { tag: string; origin: string } | null
}

async function sdRelease(tag: string, manifestFile: string) {
  const archive = await launcherArchive(ctx.dataFolder, `sd-${tag}.tar.gz`, {
    'sd-server': nodeLauncher(sd.FAKE_SD, { FAKE_SD_PID_FILE: ctx.pidFile, FAKE_SD_STEP_MS: sd.STEP_MS }),
    'sd-cli': nodeLauncher(sd.FAKE_SD, { FAKE_SD_PID_FILE: ctx.pidFile }),
  })
  mirror.serve(`/releases/${tag}/sd.tar.gz`, archive.body)
  await writeFile(
    manifestFile,
    JSON.stringify({
      tag_name: tag,
      download_base: MIRROR,
      assets: SD_HOST_IDS.map((backend) => ({
        backend,
        name: 'sd.tar.gz',
        sha256: archive.sha256,
        size: archive.size,
      })),
    })
  )
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('sd.cpp builds through the core', () => {
  it('lists, installs, offers and applies an update while a model is loaded, then removes', async () => {
    const manifest = join(ctx.dataFolder, 'sdcpp-manifest.json')
    await sdRelease('master-883-137f740', manifest)
    const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons, [], {
      ATOMIC_SDCPP_MANIFEST_URL: pathToFileURL(manifest).href,
    })
    const proxy = mirror.proxy

    const before = await json<Catalog>(await post(ready, '/engine-builds/sd-cpp/catalog', { force: true }))
    expect(before.manifest).toMatchObject({ tag: 'master-883-137f740', source: 'remote' })
    expect(SD_HOST_IDS).toContain(before.host_backend_id)
    expect(before.installed).toEqual([])
    const host = before.host_backend_id as string

    const events = await sd.collectEvents(ctx, ready)
    const first = await json<{ installed: boolean; build: { tag: string } }>(
      await post(ready, '/engine-builds/sd-cpp/install', { task_id: 'sd-first', proxy })
    )
    expect(first).toMatchObject({ installed: true, build: { tag: 'master-883-137f740', backend_id: host } })
    const oldDir = join(ctx.dataFolder, 'diffusion', 'backends', 'master-883-137f740', host)
    expect(existsSync(join(oldDir, '.atomic-owned'))).toBe(true)
    await waitFor(
      () => events.some((e) => e.event === 'engine-build:changed' && e.data['reason'] === 'install'),
      'engine-build:changed install'
    )
    expect(events.some((e) => e.event === 'download:progress' && e.data['taskId'] === 'sd-first')).toBe(true)
    expect(
      await json(await post(ready, '/engine-builds/sd-cpp/updates', { force: true, proxy }))
    ).toMatchObject({ update_needed: false, current: { tag: 'master-883-137f740', origin: 'downloaded' } })

    // A model runs from the build.
    await sd.configure(ctx, ready)
    const modelFile = await sd.writeSdFile(ctx)
    const loaded = await json<{ pid: number }>(
      await post(ready, '/diffusion/model/load', sd.sdLoadRequest({ diffusionModel: modelFile }))
    )
    const inUse = await control(ctx, ready, `/engine-builds/sd-cpp/master-883-137f740/${host}`, {
      method: 'DELETE',
    })
    expect(inUse.status).toBe(409)
    expect(await inUse.json()).toMatchObject({ error: { code: 'BACKEND_IN_USE' } })

    // conf publishes a newer build: offered, then installed.
    await sdRelease('master-900-abcdef0', manifest)
    expect(
      await json(await post(ready, '/engine-builds/sd-cpp/updates', { force: true, proxy }))
    ).toMatchObject({
      update_needed: true,
      target: { tag: 'master-900-abcdef0', backend_id: host },
    })
    const update = await json(
      await post(ready, '/engine-builds/sd-cpp/install', { task_id: 'sd-update', proxy })
    )
    expect(update).toMatchObject({ installed: true, retired: [], kept_in_use: [] })
    await waitFor(() => sd.stateReasons(events).includes('engine-updated'), 'the engine-updated state event')
    await waitFor(() => !sd.alive(loaded.pid), 'the old server to be gone')
    expect(existsSync(oldDir)).toBe(true)
    expect((await sd.sdStatus(ctx, ready)).install).toMatchObject({ tag: 'master-900-abcdef0' })

    // A rolled-back manifest is neither offered nor installed.
    await sdRelease('master-883-137f740', manifest)
    expect(
      await json(await post(ready, '/engine-builds/sd-cpp/updates', { force: true, proxy }))
    ).toMatchObject({ update_needed: false })
    expect(
      await json(
        await post(ready, '/engine-builds/sd-cpp/install', { task_id: 'sd-back', proxy, force: true })
      )
    ).toMatchObject({ installed: false, reason: 'active-is-newer' })

    // Removal, and the refusals around it.
    const foreign = join(ctx.dataFolder, 'diffusion', 'backends', 'master-1-aaaaaaa', 'hand-made')
    await mkdir(foreign, { recursive: true })
    const unowned = await control(ctx, ready, '/engine-builds/sd-cpp/master-1-aaaaaaa/hand-made', {
      method: 'DELETE',
    })
    expect(unowned.status).toBe(400)
    expect(existsSync(foreign)).toBe(true)
    expect(
      await json(
        await control(ctx, ready, `/engine-builds/sd-cpp/master-900-abcdef0/${host}`, { method: 'DELETE' })
      )
    ).toEqual({ removed: true })
    const after = await json<Catalog>(await post(ready, '/engine-builds/sd-cpp/catalog'))
    expect(after.installed.map((build) => build.tag)).toEqual(['master-883-137f740'])
    expect(mirror.seen.filter((path) => path.endsWith('/sd.tar.gz'))).toEqual([
      '/releases/master-883-137f740/sd.tar.gz',
      '/releases/master-900-abcdef0/sd.tar.gz',
    ])
  }, 120_000)
})

describe.skipIf(!existsSync(BIN) || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'MLX builds through the core',
  () => {
    it('runs the newer of the installer build and the downloaded one, and drops the download an app update outdates', async () => {
      const folder = ctx.dataFolder
      const resources = join(folder, 'resources')
      await mkdir(resources, { recursive: true })
      const bundledArgv = join(folder, 'bundled.argv')
      const downloadedArgv = join(folder, 'downloaded.argv')
      await writeFile(
        join(resources, 'mlx-server'),
        `#!/bin/sh\n${nodeLauncher(FAKE_SIDECAR_SCRIPT, { FAKE_SIDECAR_KIND: 'mlx', FAKE_SIDECAR_ARGV: bundledArgv })}\n`,
        { mode: 0o755 }
      )
      const installerMeta = (publishedAt: string) =>
        writeFile(
          join(resources, 'mlx-server.json'),
          JSON.stringify({ tag: 'mlxvlm-macos-arm64-07ba5a1', published_at: publishedAt })
        )
      await installerMeta('2026-08-28T10:38:38Z')

      const tag = 'mlxvlm-macos-arm64-1234567'
      const archive = await launcherArchive(folder, 'mlx.tar.gz', {
        'mlx-server': nodeLauncher(FAKE_SIDECAR_SCRIPT, {
          FAKE_SIDECAR_KIND: 'mlx',
          FAKE_SIDECAR_ARGV: downloadedArgv,
        }),
      })
      mirror.serve(`/AtomicBot-ai/mlx-vlm/releases/download/${tag}/mlx.tar.gz`, archive.body)
      const manifest = join(folder, 'mlx-manifest.json')
      await writeFile(
        manifest,
        JSON.stringify({
          tag_name: tag,
          upstream_repo: 'AtomicBot-ai/mlx-vlm',
          published_at: '2026-10-02T00:00:00Z',
          assets: [
            { backend: 'macos-arm64', name: 'mlx.tar.gz', sha256: archive.sha256, size: archive.size },
          ],
        })
      )
      const model = join(folder, 'mlx', 'models', 'e2e-mlx')
      await mkdir(model, { recursive: true })
      await writeFile(join(model, 'model.safetensors'), 'weights')
      await writeFile(join(model, 'config.json'), JSON.stringify({ max_position_embeddings: 8192 }))
      await writeFile(
        join(model, 'model.yml'),
        'model_path: mlx/models/e2e-mlx/model.safetensors\nname: e2e-mlx\nsize_bytes: 7\n'
      )

      const env = { ATOMIC_MLX_MANIFEST_URL: pathToFileURL(manifest).href }
      const first = await core.startDaemon(folder, ctx.daemons, ['--resources-dir', resources], env)
      const ready = first.ready
      const catalog = await json<Catalog>(await post(ready, '/engine-builds/mlx/catalog', { force: true }))
      expect(catalog.host_backend_id).toBe('macos-arm64')
      expect(catalog.host_download_bytes).toBe(archive.size)
      expect(catalog.installed).toEqual([
        expect.objectContaining({
          origin: 'bundled',
          removable: false,
          active: true,
          tag: 'mlxvlm-macos-arm64-07ba5a1',
        }),
      ])
      expect(await json(await post(ready, '/engine-builds/mlx/updates', { force: true }))).toMatchObject({
        update_needed: true,
        target: { tag, published_at: '2026-10-02T00:00:00Z' },
      })

      expect(
        await json(
          await post(ready, '/engine-builds/mlx/install', { task_id: 'mlx-update', proxy: mirror.proxy })
        )
      ).toMatchObject({ installed: true, build: { tag, origin: 'downloaded' } })
      const downloadedDir = join(folder, 'mlx', 'backends', tag, 'macos-arm64')
      expect((await json<Catalog>(await post(ready, '/engine-builds/mlx/catalog'))).active).toMatchObject({
        tag,
        origin: 'downloaded',
      })
      const bundledRemoval = await control(
        ctx,
        ready,
        '/engine-builds/mlx/mlxvlm-macos-arm64-07ba5a1/macos-arm64',
        {
          method: 'DELETE',
        }
      )
      expect(bundledRemoval.status).toBe(400)
      expect(existsSync(join(resources, 'mlx-server'))).toBe(true)

      const load = await post(ready, '/models/mlx/e2e-mlx/load')
      expect(load.status, await load.clone().text()).toBe(200)
      expect(existsSync(downloadedArgv)).toBe(true)
      // The installer's build never started: the newer download serves the load.
      expect(existsSync(bundledArgv)).toBe(false)
      expect((await post(ready, '/models/mlx/e2e-mlx/unload')).status).toBe(200)

      // The app updates and brings a newer mlx-server: it is active at the next start, the download stays.
      await post(ready, '/shutdown', { force: true })
      await waitFor(
        () => first.child.exitCode !== null || first.child.signalCode !== null,
        'the first core to exit'
      )
      await installerMeta('2026-11-01T00:00:00Z')
      const second = await core.startDaemon(folder, ctx.daemons, ['--resources-dir', resources], env)
      expect(existsSync(downloadedDir)).toBe(true)
      expect(
        (await json<Catalog>(await post(second.ready, '/engine-builds/mlx/catalog'))).active
      ).toMatchObject({
        origin: 'bundled',
      })
    }, 120_000)
  }
)

/** The Foundry Local archive of every platform: the libraries as plain files, debug symbols included. */
async function foundryArchive(workDir: string) {
  const src = join(workDir, 'foundry-src')
  for (const file of [
    'lib/libfoundry_local.so',
    'lib/libonnxruntime.so',
    'lib/libfoundry_local.so.dbg',
    'lib/foundry_local.pdb',
  ]) {
    await mkdir(join(src, 'lib'), { recursive: true })
    await writeFile(join(src, file), file)
  }
  const out = join(workDir, 'foundry.tgz')
  await tarCreate({ gzip: true, cwd: src, file: out }, ['lib'])
  const body = await readFile(out)
  return { body, sha256: createHash('sha256').update(body).digest('hex'), size: body.length }
}

const FOUNDRY_PLATFORMS = ['win-x64', 'win-arm64', 'macos-arm64', 'linux-x64', 'linux-arm64']
// Where the core does not register Foundry Local (macOS 14, old glibc) there is nothing to install.
const FOUNDRY_HOST = process.platform === 'win32' ? null : foundryLocalTestPlatform()

describe.skipIf(!existsSync(BIN) || FOUNDRY_HOST === null)('Foundry Local builds through the core', () => {
  it('migrates a loaded CPU variant only after staging passes and rolls back without rewriting model files', async () => {
    const folder = ctx.dataFolder
    const platform = FOUNDRY_HOST!
    const archive = await foundryArchive(folder)
    const manifest = join(folder, 'foundry-local-manifest.json')
    const release = (tag: string, api: number, distribution?: string) => ({
      tag,
      published_at: tag === 'v2.1.0' ? '2026-09-30T00:00:00Z' : '2026-11-09T00:00:00Z',
      min_core_version: '0.1.0',
      c_api_version: api,
      ...(distribution ? { distribution } : {}),
      assets: [
        { platform, name: `foundry-local-${platform}.tgz`, size: archive.size, sha256: archive.sha256 },
      ],
    })
    const old = release('v2.1.0', 2)
    const newer = release('v2.4.0', 3, 'atomic-conf')
    const writeManifest = (releases: unknown[]) =>
      writeFile(
        manifest,
        JSON.stringify({ schema_version: 1, upstream_repo: 'microsoft/foundry-local', releases })
      )
    await writeManifest([old])
    mirror.serve(
      `/microsoft/foundry-local/releases/download/v2.1.0/foundry-local-${platform}.tgz`,
      archive.body
    )
    mirror.serve(
      `/AtomicBot-ai/atomic-chat-conf/releases/download/foundry-local-v2.4.0/foundry-local-${platform}.tgz`,
      archive.body
    )
    const fake = fileURLToPath(new URL('../helpers/fake-foundry-host.mjs', import.meta.url))
    const host = join(folder, 'fake-foundry-host')
    const failFlag = join(folder, 'probe.fail')
    const argvFile = join(folder, 'host.jsonl')
    await writeFile(
      host,
      [
        '#!/bin/sh',
        `if [ "$1" = probe ] && [ -f ${JSON.stringify(failFlag)} ]; then echo "missing native dependency" >&2; exit 3; fi`,
        `export FAKE_FOUNDRY_ARGV=${JSON.stringify(argvFile)}`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"`,
      ].join('\n'),
      { mode: 0o755 }
    )
    const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
      ATOMIC_FOUNDRY_LOCAL_MANIFEST_URL: pathToFileURL(manifest).href,
      ATOMIC_FOUNDRY_HOST_TEST_COMMAND: host,
    })
    const install = () =>
      post(ready, '/engine-builds/foundry-local/install', { task_id: 'migration', proxy: mirror.proxy })
    await json(await install())
    const model = join(folder, 'foundry-local', 'models', 'old-cpu')
    await mkdir(model, { recursive: true })
    const files = {
      'genai_config.json': '{}',
      'weights.onnx': 'original model bytes',
      'model.yml':
        'model_path: foundry-local/models/old-cpu\nname: old-cpu\nsize_bytes: 20\nfoundry_local:\n  model_id: old-cpu\n  variant_id: old-cpu\n  execution_provider: cpu\n  device: cpu\n',
    }
    for (const [name, content] of Object.entries(files)) await writeFile(join(model, name), content)
    const runtime = join(folder, 'foundry-local', 'runtime')
    await mkdir(runtime, { recursive: true })
    const legacy = JSON.stringify({ prepared: ['CUDAExecutionProvider'], failures: {}, updated_at: 1 })
    await writeFile(join(runtime, 'accelerators.json'), legacy)
    const load = () => post(ready, '/models/foundry-local/old-cpu/load')
    const first = await json<{ session: { pid: number } }>(await load())
    const publicServer = await json<{ port: number }>(await post(ready, '/server/start', { port: 0 }))
    const answer = async () => {
      const response = await fetch(`http://127.0.0.1:${publicServer.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'old-cpu',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.text()).toContain('data: [DONE]')
    }
    await answer()
    await writeManifest([newer, old])
    await json(await post(ready, '/engine-builds/foundry-local/catalog', { force: true }))
    await writeFile(failFlag, '')
    expect(await (await install()).json()).toMatchObject({ error: { code: 'ENGINE_INSTALL_FAILED' } })
    expect(process.kill(first.session.pid, 0)).toBe(true)
    await answer()
    await rm(failFlag)
    await json(await install())
    expect(() => process.kill(first.session.pid, 0)).toThrow()
    expect((await json<Catalog>(await post(ready, '/engine-builds/foundry-local/catalog'))).active?.tag).toBe(
      'v2.4.0'
    )
    await json(await load())
    await answer()
    await json(await post(ready, '/models/foundry-local/old-cpu/unload'))
    expect(
      await json(
        await control(ctx, ready, `/engine-builds/foundry-local/v2.4.0/${platform}`, { method: 'DELETE' })
      )
    ).toEqual({ removed: true })
    await rm(manifest)
    expect(
      (await json<Catalog>(await post(ready, '/engine-builds/foundry-local/catalog', { force: true }))).active
        ?.tag
    ).toBe('v2.1.0')
    await json(await load())
    await answer()
    const starts = (await readFile(argvFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
      .filter((argv) => argv[0] === 'serve')
    expect(starts.map((argv) => argv[argv.indexOf('--lib') + 1])).toEqual(
      ['v2.1.0', 'v2.4.0', 'v2.1.0'].map((tag) => join(folder, 'foundry-local', 'backends', tag, platform))
    )
    for (const [name, content] of Object.entries(files))
      expect(await readFile(join(model, name), 'utf8')).toBe(content)
    expect(await readFile(join(runtime, 'accelerators.json'), 'utf8')).toBe(legacy)
    expect(mirror.seen.some((path) => /azure/i.test(path))).toBe(false)
  }, 120_000)

  it('installs the host archive from a file:// manifest, checked by the host, and leaves nothing when the host refuses it', async () => {
    const folder = ctx.dataFolder
    const archive = await foundryArchive(folder)
    for (const platform of FOUNDRY_PLATFORMS)
      mirror.serve(
        `/microsoft/foundry-local/releases/download/v2.1.0/foundry-local-${platform}.tgz`,
        archive.body
      )
    const manifest = join(folder, 'foundry-local-manifest.json')
    await writeFile(
      manifest,
      JSON.stringify({
        schema_version: 1,
        upstream_repo: 'microsoft/foundry-local',
        releases: [
          {
            tag: 'v2.1.0',
            published_at: '2026-09-30T00:43:42Z',
            min_core_version: '0.1.0',
            c_api_version: 2,
            assets: FOUNDRY_PLATFORMS.map((platform) => ({
              platform,
              name: `foundry-local-${platform}.tgz`,
              size: archive.size,
              sha256: archive.sha256,
            })),
          },
        ],
      })
    )
    // The host stand-in: records its argv, answers like `foundry-host probe` unless told to fail.
    const argvFile = join(folder, 'host.argv')
    const failFlag = join(folder, 'host.fail')
    const host = join(folder, 'fake-foundry-host')
    await writeFile(
      host,
      [
        '#!/bin/sh',
        `echo "$@" >> ${JSON.stringify(argvFile)}`,
        `if [ -f ${JSON.stringify(failFlag)} ]; then echo "libatomic.so.1: cannot open shared object file" >&2; exit 3; fi`,
        `echo '{"version":"2.1.0","c_api_version":2,"accelerators":[]}'`,
      ].join('\n'),
      { mode: 0o755 }
    )
    const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
      ATOMIC_FOUNDRY_LOCAL_MANIFEST_URL: pathToFileURL(manifest).href,
      ATOMIC_FOUNDRY_HOST_TEST_COMMAND: host,
    })
    const proxy = mirror.proxy

    const catalog = await json<Catalog>(
      await post(ready, '/engine-builds/foundry-local/catalog', { force: true })
    )
    expect(catalog.manifest).toMatchObject({ tag: 'v2.1.0', source: 'remote' })
    expect(catalog.host_backend_id).toBe(FOUNDRY_HOST)
    const platform = catalog.host_backend_id as string

    const installed = await json(
      await post(ready, '/engine-builds/foundry-local/install', { task_id: 'fl-1', proxy })
    )
    expect(installed).toMatchObject({ installed: true, build: { tag: 'v2.1.0', backend_id: platform } })
    const dir = join(folder, 'foundry-local', 'backends', 'v2.1.0', platform)
    expect(existsSync(join(dir, '.atomic-owned'))).toBe(true)
    expect(existsSync(join(dir, 'lib', 'foundry_local.pdb'))).toBe(false)
    expect(existsSync(join(dir, 'lib', 'libfoundry_local.so.dbg'))).toBe(false)
    expect(existsSync(join(dir, 'lib', 'libonnxruntime.so.1'))).toBe(process.platform === 'linux')
    const argv = (await readFile(argvFile, 'utf8')).trim()
    expect(argv).toMatch(
      new RegExp(
        `^probe --lib .*v2\\.1\\.0/${platform}\\.incoming-\\d+ --app-data .*foundry-local/runtime --logs .*foundry-local/logs$`
      )
    )

    // The host refuses a forced reinstall: the install fails with what it printed, the build stays.
    await writeFile(failFlag, '')
    const refused = await post(ready, '/engine-builds/foundry-local/install', {
      task_id: 'fl-2',
      proxy,
      force: true,
    })
    expect(await refused.json()).toMatchObject({
      error: { code: 'ENGINE_INSTALL_FAILED', details: expect.stringContaining('libatomic.so.1') },
    })
    expect((await readdir(join(folder, 'foundry-local', 'backends', 'v2.1.0'))).sort()).toEqual([platform])
    expect(existsSync(join(dir, '.atomic-owned'))).toBe(true)
  }, 120_000)
})

const LITERT_PLATFORMS = ['macos-arm64', 'linux-x64', 'linux-arm64', 'win-x64']
const LITERT_HOST = process.platform === 'win32' ? null : liteRtLmTestPlatform()
const LITERT_LIBRARY: Record<string, string> = {
  'macos-arm64': 'liblitert-lm.dylib',
  'linux-x64': 'liblitert-lm.so',
  'linux-arm64': 'liblitert-lm.so',
  'win-x64': 'litert-lm.dll',
}

describe.skipIf(!existsSync(BIN) || LITERT_HOST === null)(
  'LiteRT-LM builds through the core (task 4.4)',
  () => {
    it('installs the host wheel from a file:// manifest, checked by litert-host probe, and leaves nothing when the host refuses it', async () => {
      const folder = ctx.dataFolder
      const assets = LITERT_PLATFORMS.map((platform) => {
        const name = `litert_lm_api-0.18.1-py3-none-${platform}.whl`
        const body = makeZip([
          { name: 'litert_lm/__init__.py', data: Buffer.from('py') },
          { name: `litert_lm/${LITERT_LIBRARY[platform]}`, data: Buffer.from('lib'), mode: 0o777 },
          { name: 'litert_lm_api-0.18.1.dist-info/RECORD', data: Buffer.from('record') },
        ])
        mirror.serve(`/packages/aa/${name}`, body)
        return {
          platform,
          url: `https://files.pythonhosted.org/packages/aa/${name}`,
          name,
          size: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
        }
      })
      const manifest = join(folder, 'litert-lm-manifest.json')
      await writeFile(
        manifest,
        JSON.stringify({
          schema_version: 1,
          releases: [
            {
              version: '0.18.1',
              published_at: '2026-10-19T22:44:33Z',
              min_core_version: '0.1.0',
              abi: 1,
              assets,
            },
          ],
        })
      )
      // The host stand-in: records its argv, answers like `litert-host probe` unless told to fail.
      const argvFile = join(folder, 'host.argv')
      const failFlag = join(folder, 'host.fail')
      const host = join(folder, 'fake-litert-host')
      await writeFile(
        host,
        [
          '#!/bin/sh',
          `echo "$@" >> ${JSON.stringify(argvFile)}`,
          `if [ -f ${JSON.stringify(failFlag)} ]; then echo "dlopen: liblitert-lm.so: wrong ELF class" >&2; exit 3; fi`,
          `echo '{"version":"0.18.1","abi":1,"backends":["cpu","gpu"]}'`,
        ].join('\n'),
        { mode: 0o755 }
      )
      const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
        ATOMIC_LITERT_LM_MANIFEST_URL: pathToFileURL(manifest).href,
        ATOMIC_LITERT_HOST_TEST_COMMAND: host,
      })
      const proxy = mirror.proxy

      const catalog = await json<Catalog>(
        await post(ready, '/engine-builds/litert-lm/catalog', { force: true })
      )
      expect(catalog.manifest).toMatchObject({ tag: '0.18.1', source: 'remote' })
      expect(catalog.host_backend_id).toBe(LITERT_HOST)
      const platform = catalog.host_backend_id as string

      const installed = await json(
        await post(ready, '/engine-builds/litert-lm/install', { task_id: 'lr-1', proxy })
      )
      expect(installed).toMatchObject({ installed: true, build: { tag: '0.18.1', backend_id: platform } })
      const dir = join(folder, 'litert-lm', 'backends', '0.18.1', platform)
      expect(existsSync(join(dir, '.atomic-owned'))).toBe(true)
      expect(await readdir(join(dir, 'lib'))).toEqual([LITERT_LIBRARY[platform]])
      expect(existsSync(join(dir, 'litert_lm'))).toBe(false)
      expect((await readFile(argvFile, 'utf8')).trim()).toMatch(
        new RegExp(`^probe --lib .*0\\.18\\.1/${platform}\\.incoming-\\d+$`)
      )

      // The host refuses a forced reinstall: the install fails with what it printed, the build stays.
      await writeFile(failFlag, '')
      const refused = await post(ready, '/engine-builds/litert-lm/install', {
        task_id: 'lr-2',
        proxy,
        force: true,
      })
      expect(await refused.json()).toMatchObject({
        error: { code: 'ENGINE_INSTALL_FAILED', details: expect.stringContaining('wrong ELF class') },
      })
      expect((await readdir(join(folder, 'litert-lm', 'backends', '0.18.1'))).sort()).toEqual([platform])
      expect(existsSync(join(dir, '.atomic-owned'))).toBe(true)
    }, 120_000)
  }
)

describe.skipIf(!existsSync(BIN) || LITERT_HOST === null)(
  'LiteRT-LM OpenVINO through the core (task 6.4)',
  () => {
    it('offers OpenVINO on an Intel NPU, prepares it with progress, unpacks only its libs, and does not download twice', async () => {
      const folder = ctx.dataFolder
      const platform = LITERT_HOST as string
      const libName = `litert_lm_api-0.18.1-py3-none-${platform}.whl`
      const lib = makeZip([{ name: `litert_lm/${LITERT_LIBRARY[platform]}`, data: Buffer.from('lib') }])
      mirror.serve(`/packages/lr/${libName}`, lib)
      const ovName = 'openvino-2026.4.1-22982-cp312-cp312-win_amd64.whl'
      const ov = makeZip([
        { name: 'openvino/__init__.py', data: Buffer.from('py') },
        { name: 'openvino/libs/openvino.dll', data: Buffer.from('ov'.repeat(50_000)) },
        { name: 'openvino/libs/openvino_intel_npu_plugin.dll', data: Buffer.from('npu') },
      ])
      mirror.serve(`/packages/ov/${ovName}`, ov)
      const pin = (body: Buffer) => ({
        size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
      const manifest = join(folder, 'litert-lm-manifest.json')
      await writeFile(
        manifest,
        JSON.stringify({
          schema_version: 1,
          releases: [
            {
              version: '0.18.1',
              published_at: '2026-10-19T22:44:33Z',
              min_core_version: '0.1.0',
              abi: 1,
              assets: [
                {
                  platform,
                  url: `https://files.pythonhosted.org/packages/lr/${libName}`,
                  name: libName,
                  ...pin(lib),
                },
              ],
              accelerators: [
                {
                  id: 'openvino',
                  platform: 'win-x64',
                  version: '2026.4.1',
                  url: `https://files.pythonhosted.org/packages/ov/${ovName}`,
                  name: ovName,
                  ...pin(ov),
                },
              ],
            },
          ],
        })
      )
      const host = join(folder, 'fake-litert-host')
      await writeFile(host, `#!/bin/sh\necho '{"version":"0.18.1","abi":1,"backends":["cpu","gpu"]}'\n`, {
        mode: 0o755,
      })
      const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
        ATOMIC_LITERT_LM_MANIFEST_URL: pathToFileURL(manifest).href,
        ATOMIC_LITERT_HOST_TEST_COMMAND: host,
        ATOMIC_LITERT_LM_TEST_NPU: 'intel-lnl',
      })
      const proxy = mirror.proxy
      const accelerators = async () =>
        json<{
          npu: string | null
          accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
        }>(await control(ctx, ready, '/runtimes/litert-lm/accelerators'))
      expect(await accelerators()).toMatchObject({ npu: null, accelerators: [] })
      expect(
        await json(await post(ready, '/engine-builds/litert-lm/install', { task_id: 'lr-1', proxy }))
      ).toMatchObject({
        installed: true,
      })
      expect(await accelerators()).toMatchObject({
        npu: 'intel-lnl',
        accelerators: [
          { name: 'openvino', device: 'npu', version: '2026.4.1', size_bytes: ov.length, prepared: false },
        ],
      })

      const events = await sd.collectEvents(ctx, ready)
      expect(await json(await post(ready, '/runtimes/litert-lm/accelerators/prepare', { proxy }))).toEqual({
        accelerators: [{ name: 'openvino', prepared: true }],
      })
      await waitFor(
        () =>
          events.some(
            (e) => e.event === 'litert-lm:accelerators' && (e.data as { stage: string }).stage === 'done'
          ),
        'done'
      )
      const steps = events
        .filter((e) => e.event === 'litert-lm:accelerators')
        .map((e) => e.data as { stage: string })
      expect(steps[0]).toEqual({ accelerator: 'openvino', stage: 'started', fraction: 0 })
      expect(steps.some((step) => step.stage === 'downloading')).toBe(true)
      expect(steps.at(-1)).toEqual({ accelerator: 'openvino', stage: 'done', fraction: 1 })
      const dir = join(folder, 'litert-lm', 'accelerators', 'openvino', '2026.4.1')
      expect((await readdir(dir)).sort()).toEqual([
        '.atomic-owned',
        'openvino.dll',
        'openvino_intel_npu_plugin.dll',
      ])
      expect((await accelerators()).accelerators[0]?.prepared).toBe(true)

      const downloads = () => mirror.seen.filter((path) => path.startsWith('/packages/ov/')).length
      expect(downloads()).toBe(1)
      await post(ready, '/runtimes/litert-lm/accelerators/prepare', { proxy })
      expect(downloads()).toBe(1)
    }, 120_000)
  }
)

const FAKE_FOUNDRY_HOST = fileURLToPath(new URL('../helpers/fake-foundry-host.mjs', import.meta.url))

describe.skipIf(!existsSync(BIN) || FOUNDRY_HOST === null)(
  'Foundry Local accelerators through the core (task 6.4)',
  () => {
    it('probes the active build, prepares with progress and a partial failure, and probes again after an install', async () => {
      const folder = ctx.dataFolder
      const archive = await foundryArchive(folder)
      const manifest = join(folder, 'foundry-local-manifest.json')
      const publish = async (tag: string, publishedAt: string) => {
        for (const platform of FOUNDRY_PLATFORMS)
          mirror.serve(
            `/microsoft/foundry-local/releases/download/${tag}/foundry-local-${platform}.tgz`,
            archive.body
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
                assets: FOUNDRY_PLATFORMS.map((platform) => ({
                  platform,
                  name: `foundry-local-${platform}.tgz`,
                  size: archive.size,
                  sha256: archive.sha256,
                })),
              },
            ],
          })
        )
      }
      // The host stand-in: the protocol of `foundry-host` (probe, prepare), CUDA failing to prepare.
      const argvFile = join(folder, 'host-argv.jsonl')
      const host = join(folder, 'fake-foundry-host')
      await writeFile(
        host,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_FOUNDRY_HOST)} "$@"\n`,
        {
          mode: 0o755,
        }
      )
      await publish('v2.1.0', '2026-09-30T00:43:42Z')
      const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
        ATOMIC_FOUNDRY_LOCAL_MANIFEST_URL: pathToFileURL(manifest).href,
        ATOMIC_FOUNDRY_HOST_TEST_COMMAND: host,
        FAKE_FOUNDRY_ARGV: argvFile,
        FAKE_FOUNDRY_EPS: 'WebGpuExecutionProvider,CUDAExecutionProvider',
        FAKE_FOUNDRY_FAIL: 'CUDAExecutionProvider',
      })
      const proxy = mirror.proxy
      const accelerators = async (force = false) =>
        json<{
          build: string | null
          accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
        }>(await control(ctx, ready, `/runtimes/foundry-local/accelerators${force ? '?force=1' : ''}`))
      const probes = async () =>
        (await readFile(argvFile, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .filter((line) => (JSON.parse(line) as { argv: string[] }).argv[0] === 'probe').length

      // Nothing installed: nothing probed.
      expect(await accelerators()).toMatchObject({ build: null, accelerators: [] })
      expect(await probes()).toBe(0)

      const installed = await json(
        await post(ready, '/engine-builds/foundry-local/install', { task_id: 'fl-1', proxy })
      )
      expect(installed, JSON.stringify(installed)).toMatchObject({ installed: true })
      const platform = (installed as { build: { backend_id: string } }).build.backend_id
      const afterInstallCheck = await probes()
      const first = await accelerators()
      expect(first).toMatchObject({
        build: `v2.1.0/${platform}`,
        accelerators: [
          { name: 'WebGpuExecutionProvider', prepared: false },
          { name: 'CUDAExecutionProvider', prepared: false },
        ],
      })
      await accelerators()
      expect(await probes()).toBe(afterInstallCheck + 1)

      const events = await sd.collectEvents(ctx, ready)
      const prepared = await json(await post(ready, '/runtimes/foundry-local/accelerators/prepare', {}))
      expect(prepared).toEqual({
        accelerators: [
          { name: 'WebGpuExecutionProvider', prepared: true },
          {
            name: 'CUDAExecutionProvider',
            prepared: false,
            reason: expect.stringContaining('libcublasLt.so.12'),
          },
        ],
      })
      await waitFor(
        () => events.filter((e) => e.event === 'foundry-local:accelerators').length >= 5,
        'five foundry-local:accelerators events'
      )
      expect(events.filter((e) => e.event === 'foundry-local:accelerators').map((e) => e.data)).toEqual([
        { accelerator: 'WebGpuExecutionProvider', stage: 'started', fraction: 0 },
        { accelerator: 'WebGpuExecutionProvider', stage: 'downloading', fraction: 0.5 },
        { accelerator: 'WebGpuExecutionProvider', stage: 'done', fraction: 1 },
        { accelerator: 'CUDAExecutionProvider', stage: 'started', fraction: 0 },
        {
          accelerator: 'CUDAExecutionProvider',
          stage: 'failed',
          fraction: null,
          reason: expect.stringContaining('libcublasLt'),
        },
      ])
      expect((await accelerators()).accelerators).toEqual([
        expect.objectContaining({ name: 'WebGpuExecutionProvider', prepared: true }),
        expect.objectContaining({
          name: 'CUDAExecutionProvider',
          prepared: false,
          reason: expect.stringContaining('libcublasLt'),
        }),
      ])
      const busyFree = await probes()

      // conf publishes a newer release; installing it makes it active, and the next request probes it.
      await publish('v2.2.0', '2026-10-30T00:00:00Z')
      // As a client does: re-read the manifest (it is kept an hour), then install what it offers.
      expect(
        await json(await post(ready, '/engine-builds/foundry-local/catalog', { force: true }))
      ).toMatchObject({
        manifest: { tag: 'v2.2.0' },
      })
      expect(
        await json(await post(ready, '/engine-builds/foundry-local/install', { task_id: 'fl-2', proxy }))
      ).toMatchObject({
        installed: true,
        build: { tag: 'v2.2.0' },
      })
      const afterSecondCheck = await probes()
      expect(afterSecondCheck).toBe(busyFree + 1)
      const upgraded = await accelerators()
      expect(upgraded).toMatchObject({
        build: `v2.2.0/${platform}`,
        accelerators: [
          { name: 'WebGpuExecutionProvider', prepared: false },
          { name: 'CUDAExecutionProvider', prepared: false },
        ],
      })
      expect(upgraded.accelerators[1]).not.toHaveProperty('reason')
      expect(await probes()).toBe(afterSecondCheck + 1)

      await json(
        await post(ready, '/runtimes/foundry-local/accelerators/prepare', {
          accelerators: ['WebGpuExecutionProvider'],
        })
      )
      expect(await accelerators()).toMatchObject({
        build: `v2.2.0/${platform}`,
        accelerators: [
          { name: 'WebGpuExecutionProvider', prepared: true },
          { name: 'CUDAExecutionProvider', prepared: false },
        ],
      })
    }, 120_000)
  }
)

// ---------------------------------------------------------------------------------------------
// GenieX (change add-geniex-runtime, task 4.4)
// ---------------------------------------------------------------------------------------------

const GENIEX_MIRROR = 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex'

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')(
  'GenieX builds through the core (task 4.4)',
  () => {
    it('installs lib/** of the SDK zip from a file:// manifest, checked by geniex-host probe whose devices it records, and leaves nothing when the host refuses it', async () => {
      const folder = ctx.dataFolder
      const name = 'geniex-sdk-windows-arm64-v0.9.3.zip'
      const body = makeZip([
        { name: 'sdk-windows-arm64/lib/geniex.dll', data: Buffer.from('core') },
        { name: 'sdk-windows-arm64/lib/llama_cpp/geniex_plugin.dll', data: Buffer.from('plugin') },
        { name: 'sdk-windows-arm64/lib/llama_cpp/libggml-htp-v73.so', data: Buffer.from('htp') },
        { name: 'sdk-windows-arm64/lib/qairt/htp-files/libQnnHtpV73Skel.so', data: Buffer.from('skel') },
        { name: 'sdk-windows-arm64/bin/geniex-bench.exe', data: Buffer.from('bench') },
        { name: 'sdk-windows-arm64/include/geniex.h', data: Buffer.from('h') },
      ])
      mirror.serve(`/qai-hub-geniex/${name}`, body)
      const manifest = join(folder, 'geniex-manifest.json')
      await writeFile(
        manifest,
        JSON.stringify({
          schema_version: 1,
          releases: [
            {
              version: '0.9.3',
              published_at: '2026-10-19T23:09:06Z',
              min_core_version: '0.1.0',
              abi: 1,
              notes_url: 'https://github.com/qualcomm/GenieX/releases/tag/v0.9.3',
              assets: [
                {
                  platform: 'win-arm64',
                  url: `${GENIEX_MIRROR}/${name}`,
                  name,
                  size: body.length,
                  sha256: createHash('sha256').update(body).digest('hex'),
                },
              ],
            },
          ],
        })
      )
      // The host stand-in: records its argv, answers like `geniex-host probe` unless told to fail.
      const argvFile = join(folder, 'host.argv')
      const failFlag = join(folder, 'host.fail')
      const host = join(folder, 'fake-geniex-host')
      await writeFile(
        host,
        [
          '#!/bin/sh',
          `echo "$@" >> ${JSON.stringify(argvFile)}`,
          `if [ -f ${JSON.stringify(failFlag)} ]; then echo "LoadLibraryW geniex.dll: error 126" >&2; exit 3; fi`,
          `echo '{"version":"0.9.3","abi":1,"plugins":["llama_cpp","qairt"],"devices":["HTP0","GPUOpenCL","CPU"]}'`,
        ].join('\n'),
        { mode: 0o755 }
      )
      const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
        ATOMIC_GENIEX_MANIFEST_URL: pathToFileURL(manifest).href,
        ...geniexTestEnv(host),
      })
      const proxy = mirror.proxy

      const catalog = await json<Catalog>(await post(ready, '/engine-builds/geniex/catalog', { force: true }))
      expect(catalog.manifest).toMatchObject({ tag: '0.9.3', source: 'remote' })
      expect(catalog.host_backend_id).toBe('win-arm64')

      const installed = await json(
        await post(ready, '/engine-builds/geniex/install', { task_id: 'gx-1', proxy })
      )
      expect(installed).toMatchObject({ installed: true, build: { tag: '0.9.3', backend_id: 'win-arm64' } })
      const dir = join(folder, 'geniex', 'backends', '0.9.3', 'win-arm64')
      expect(existsSync(join(dir, '.atomic-owned'))).toBe(true)
      expect((await readdir(dir)).sort()).toEqual(['.atomic-owned', 'install.json', 'lib'])
      expect((await readdir(join(dir, 'lib'))).sort()).toEqual(['geniex.dll', 'llama_cpp', 'qairt'])
      expect(existsSync(join(dir, 'lib', 'qairt', 'htp-files', 'libQnnHtpV73Skel.so'))).toBe(true)
      expect(existsSync(join(dir, 'sdk-windows-arm64'))).toBe(false)
      expect(JSON.parse(await readFile(join(dir, 'install.json'), 'utf8'))).toMatchObject({
        tag: '0.9.3',
        abi: 1,
        libraryVersion: '0.9.3',
        devices: ['HTP0', 'GPUOpenCL', 'CPU'],
      })
      expect((await readFile(argvFile, 'utf8')).trim()).toMatch(
        /^probe --lib .*0\.9\.3\/win-arm64\.incoming-\d+$/
      )

      // The host refuses a forced reinstall: the install fails with what it printed, the build stays.
      await writeFile(failFlag, '')
      const refused = await post(ready, '/engine-builds/geniex/install', {
        task_id: 'gx-2',
        proxy,
        force: true,
      })
      expect(await refused.json()).toMatchObject({
        error: { code: 'ENGINE_INSTALL_FAILED', details: expect.stringContaining('error 126') },
      })
      expect((await readdir(join(folder, 'geniex', 'backends', '0.9.3'))).sort()).toEqual(['win-arm64'])
      expect(existsSync(join(dir, '.atomic-owned'))).toBe(true)
    }, 120_000)

    it('registers the provider only with the chip stand-in, and never on this machine by itself', async () => {
      const folder = ctx.dataFolder
      const host = await writeFakeGeniexHost(join(folder, 'fake-geniex-host'))
      const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
        ATOMIC_GENIEX_HOST_TEST_COMMAND: host,
      })
      const versions = await json<{ engines: Array<{ engine: string }> }>(
        await post(ready, '/engines/versions', {})
      )
      expect(versions.engines.map((entry) => entry.engine)).not.toContain('geniex')
      const catalog = await post(ready, '/engine-builds/geniex/catalog', {})
      expect(await json<Catalog>(catalog)).toMatchObject({
        host_backend_id: null,
        host_reason: expect.stringMatching(/Windows arm64 only/),
      })
    }, 60_000)
  }
)

// ---------------------------------------------------------------------------------------------
// audio.cpp
// ---------------------------------------------------------------------------------------------

/** Every id a host of the CI matrix picks; the fake answers as a Metal build, so a CPU build passes anywhere. */
const AUDIO_HOST_IDS = ['macos-arm64', 'linux-cpu-x64', 'linux-cpu-arm64', 'linux-vulkan-x64']
/** conf's bootstrap manifest has no arm64 Linux build: upstream publishes none. */
const AUDIO_BOOTSTRAP_HOST = !(process.platform === 'linux' && process.arch === 'arm64')
const AUDIOCPP_STAGING = fileURLToPath(
  new URL('../fixtures/audiocpp/conf/audiocpp-manifest.staging.json', import.meta.url)
)

/** What `install.json` says the build was made for. */
const AUDIO_KIND: Record<string, string> = {
  'macos-arm64': 'metal',
  'linux-cpu-x64': 'cpu',
  'linux-cpu-arm64': 'cpu',
  'linux-vulkan-x64': 'vulkan',
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('audio.cpp builds through the core', () => {
  async function audioRelease(tag: string, manifestFile: string) {
    const archive = await launcherArchive(ctx.dataFolder, `audio-${tag}.tar.gz`, {
      audiocpp_server: fakeAudiocppServer(),
    })
    mirror.serve(`/releases/${tag}/audio.tar.gz`, archive.body)
    await writeFile(
      manifestFile,
      JSON.stringify({
        upstream_repo: 'AtomicBot-ai/audio.cpp',
        tag_name: tag,
        download_base: MIRROR,
        assets: AUDIO_HOST_IDS.map((backend) => ({
          backend,
          name: 'audio.tar.gz',
          sha256: archive.sha256,
          size: archive.size,
        })),
      })
    )
  }

  it('lists, installs, offers the fork build of the same version as an update, keeps both and removes the old one', async () => {
    const folder = ctx.dataFolder
    const manifest = join(folder, 'audiocpp-manifest.json')
    await audioRelease('v0.9.3', manifest)
    const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
      ATOMIC_AUDIOCPP_MANIFEST_URL: pathToFileURL(manifest).href,
    })
    const proxy = mirror.proxy

    const before = await json<Catalog>(await post(ready, '/engine-builds/audio-cpp/catalog', { force: true }))
    expect(before.manifest).toMatchObject({ tag: 'v0.9.3', source: 'remote' })
    expect(AUDIO_HOST_IDS).toContain(before.host_backend_id)
    expect(before.host_download_bytes).toBeGreaterThan(0)
    expect(before.installed).toEqual([])

    const events = await sd.collectEvents(ctx, ready)
    const first = await json<{ installed: boolean; build: { tag: string; backend_id: string } }>(
      await post(ready, '/engine-builds/audio-cpp/install', { task_id: 'audio-first', proxy })
    )
    expect(first).toMatchObject({ installed: true, build: { tag: 'v0.9.3', origin: 'downloaded' } })
    // A Vulkan host walks down to the CPU build: the fake carries no Vulkan backend.
    const host = first.build.backend_id
    expect(AUDIO_HOST_IDS).toContain(host)
    const oldDir = join(folder, 'audio', 'backends', 'v0.9.3', host)
    expect((await readdir(oldDir)).sort()).toEqual(['.atomic-owned', 'audiocpp_server', 'install.json'])
    expect(JSON.parse(await readFile(join(oldDir, 'install.json'), 'utf8'))).toMatchObject({
      tag: 'v0.9.3',
      backendId: host,
      backend: AUDIO_KIND[host],
      engine: 'audio-cpp',
    })
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.event === 'engine-build:changed' &&
            e.data['engine'] === 'audio-cpp' &&
            e.data['reason'] === 'install'
        ),
      'engine-build:changed install for audio-cpp'
    )
    expect(events.some((e) => e.event === 'download:progress' && e.data['taskId'] === 'audio-first')).toBe(
      true
    )
    expect(
      await json(await post(ready, '/engine-builds/audio-cpp/updates', { force: true, proxy }))
    ).toMatchObject({ update_needed: false, current: { tag: 'v0.9.3', backend_id: host } })

    // conf publishes the fork's build of the same version: newer, offered, installed beside the old one.
    await audioRelease('v0.9.3-a1b2c3d4', manifest)
    expect(
      await json(await post(ready, '/engine-builds/audio-cpp/updates', { force: true, proxy }))
    ).toMatchObject({ update_needed: true, target: { tag: 'v0.9.3-a1b2c3d4' } })
    expect(
      await json(await post(ready, '/engine-builds/audio-cpp/install', { task_id: 'audio-update', proxy }))
    ).toMatchObject({ installed: true, build: { tag: 'v0.9.3-a1b2c3d4', backend_id: host } })
    const catalog = await json<Catalog>(await post(ready, '/engine-builds/audio-cpp/catalog'))
    expect(catalog.active).toMatchObject({ tag: 'v0.9.3-a1b2c3d4', origin: 'downloaded' })
    expect(catalog.installed.map((build) => [build.tag, build.active, build.removable])).toEqual([
      ['v0.9.3-a1b2c3d4', true, true],
      ['v0.9.3', false, true],
    ])

    // Removal of the old build; a folder the core did not mark is refused.
    const foreign = join(folder, 'audio', 'backends', 'v0.9.0', 'hand-made')
    await mkdir(foreign, { recursive: true })
    const unowned = await control(ctx, ready, '/engine-builds/audio-cpp/v0.9.0/hand-made', {
      method: 'DELETE',
    })
    expect(unowned.status).toBe(400)
    expect(existsSync(foreign)).toBe(true)
    expect(
      await json(await control(ctx, ready, `/engine-builds/audio-cpp/v0.9.3/${host}`, { method: 'DELETE' }))
    ).toEqual({ removed: true })
    expect(existsSync(oldDir)).toBe(false)
    const after = await json<Catalog>(await post(ready, '/engine-builds/audio-cpp/catalog'))
    expect(after.installed.map((build) => build.tag)).toEqual(['v0.9.3-a1b2c3d4'])
    expect(mirror.seen.filter((path) => path.endsWith('/audio.tar.gz'))).toEqual([
      '/releases/v0.9.3/audio.tar.gz',
      '/releases/v0.9.3-a1b2c3d4/audio.tar.gz',
    ])
  }, 120_000)

  it.skipIf(!AUDIO_BOOTSTRAP_HOST)(
    "installs from conf's bootstrap manifest: upstream 0xShug0/audio.cpp's flat .tar.gz, its tools/ and model_specs/ kept",
    async () => {
      const folder = ctx.dataFolder
      const staging = JSON.parse(await readFile(AUDIOCPP_STAGING, 'utf8')) as {
        upstream_repo: string
        tag_name: string
        assets: Array<{ backend: string; name: string; sha256: string; size: number }>
      }
      expect(staging).toMatchObject({ upstream_repo: '0xShug0/audio.cpp', tag_name: 'v0.9.3' })
      expect(staging).not.toHaveProperty('download_base')
      // Each upstream name serves one archive of upstream's layout, pinned by its own hash.
      const archive = await audiocppUpstreamArchive(folder, 'upstream.tar.gz')
      for (const asset of staging.assets)
        mirror.serve(`/0xShug0/audio.cpp/releases/download/v0.9.3/${asset.name}`, archive.body)
      const manifest = join(folder, 'audiocpp-manifest.staging.json')
      await writeFile(
        manifest,
        JSON.stringify({
          ...staging,
          assets: staging.assets.map((asset) => ({ ...asset, sha256: archive.sha256, size: archive.size })),
        })
      )
      const { ready } = await core.startDaemon(folder, ctx.daemons, [], {
        ATOMIC_AUDIOCPP_MANIFEST_URL: pathToFileURL(manifest).href,
      })

      const catalog = await json<Catalog>(
        await post(ready, '/engine-builds/audio-cpp/catalog', { force: true })
      )
      expect(catalog.manifest).toMatchObject({ tag: 'v0.9.3', source: 'remote' })
      const installed = await json<{ installed: boolean; build: { backend_id: string } }>(
        await post(ready, '/engine-builds/audio-cpp/install', {
          task_id: 'audio-bootstrap',
          proxy: mirror.proxy,
        })
      )
      expect(installed).toMatchObject({ installed: true, build: { tag: 'v0.9.3' } })
      const host = installed.build.backend_id
      const name = staging.assets.find((asset) => asset.backend === host)?.name as string
      expect(name).toMatch(/\.tar\.gz$/)
      expect(mirror.seen).toEqual([`/0xShug0/audio.cpp/releases/download/v0.9.3/${name}`])
      const dir = join(folder, 'audio', 'backends', 'v0.9.3', host)
      expect((await readdir(dir)).sort()).toEqual([
        '.atomic-owned',
        'LICENSE',
        'audiocpp_cli',
        'audiocpp_server',
        'install.json',
        'model_specs',
        'tools',
      ])
    },
    120_000
  )

  it('answers "no manifest" for audio.cpp when the source has none, and installs nothing', async () => {
    const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons, [], {
      ATOMIC_AUDIOCPP_MANIFEST_URL: pathToFileURL(join(ctx.dataFolder, 'missing.json')).href,
    })
    expect(await json(await post(ready, '/engine-builds/audio-cpp/catalog', { force: true }))).toMatchObject({
      engine: 'audio-cpp',
      manifest: null,
      manifest_error: expect.stringMatching(/^audio\.cpp manifest from file:/),
      host_backend_id: null,
      host_reason: 'The audio.cpp manifest is unavailable.',
      installed: [],
    })
    const install = await post(ready, '/engine-builds/audio-cpp/install', { task_id: 'audio-none' })
    expect(await install.json()).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } })
  }, 60_000)
})

it.skipIf(!existsSync(BIN))(
  'installs FastFlowLM only on a supported host and only after the archive confirms local-only identity',
  async () => {
    const release = flmRelease()
    const manifest = join(ctx.dataFolder, 'flm.json')
    const supported =
      process.arch === 'x64' &&
      (process.platform === 'linux' ||
        (process.platform === 'win32' && Number(osRelease().split('.')[2]) >= 22000))
    const asset = release.assets[process.platform === 'win32' ? 0 : 1]!
    const id = JSON.stringify({
      upstream_commit: release.upstream_commit,
      atomic_revision: 1,
      local_only_protocol: 1,
    })
    if (supported) {
      let body: Buffer
      if (process.platform === 'win32') {
        // The inbox .NET Framework compiler supplies a tiny real PE program on Windows.
        const source = join(ctx.dataFolder, 'Probe.cs')
        const exe = join(ctx.dataFolder, 'flm.exe')
        await writeFile(
          source,
          'class Probe { static int Main(string[] a) { if (string.Join(" ", a) != "atomic-capabilities --json") return 3; System.Console.WriteLine(' +
            JSON.stringify(id) +
            '); return 0; } }'
        )
        await promisify(execFile)(
          join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
          ['/nologo', '/out:' + exe, source]
        )
        body = makeZip([{ name: 'flm.exe', data: await readFile(exe) }])
      } else {
        body = (
          await launcherArchive(ctx.dataFolder, 'test-flm.tar.gz', {
            flm: `[ "$*" = 'atomic-capabilities --json' ] || exit 3\necho '${id}'`,
          })
        ).body
      }
      asset.sha256 = createHash('sha256').update(body).digest('hex')
      asset.size = body.length
      mirror.serve(new URL(asset.url).pathname, body)
    }
    await writeFile(manifest, JSON.stringify({ schema_version: 1, releases: [release] }))
    const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons, [], {
      ATOMIC_FASTFLOWLM_MANIFEST_URL: pathToFileURL(manifest).href,
      ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL: pathToFileURL(join(ctx.dataFolder, 'missing-env.json'))
        .href,
    })
    const plan = await post(ready, '/runtimes/fastflowlm/probe', {})
    expect(await json(plan)).toMatchObject({ status: 'blocked', packages: [], changes: [] })
    expect((await post(ready, '/runtimes/fastflowlm/probe', { runtime_account: 'root' })).status).toBe(400)
    const facts = await json<{ ready: boolean; blockers: string[]; engine_version: string | null }>(
      await control(ctx, ready, '/runtimes/fastflowlm/accelerators')
    )
    expect(facts).toMatchObject({ ready: false, engine_version: null })
    expect(facts.blockers.length).toBeGreaterThan(0)
    if (!supported) expect(facts.blockers).toContain('platform-unsupported')
    const check = () => post(ready, '/models/fastflowlm/check', { descriptor: qwen.definition })
    expect(await json(await check())).toMatchObject({
      verdict:
        supported && !facts.blockers.includes('xdna2-not-found')
          ? 'engine-not-installed'
          : 'platform-unsupported',
      metadata: null,
    })
    expect(
      await json(await post(ready, '/models/fastflowlm/check', { model_id: qwen.definition.variant_id }))
    ).toMatchObject({ verdict: 'invalid-installation' })
    expect(existsSync(join(ctx.dataFolder, 'fastflowlm', 'models', qwen.definition.variant_id))).toBe(false)
    const catalog = await json<Catalog>(await post(ready, '/engine-builds/fastflowlm/catalog'))
    expect(catalog.manifest?.tag).toBe(release.version)
    expect(catalog.host_backend_id).toBe(supported ? asset.platform : null)
    const response = await post(ready, '/engine-builds/fastflowlm/install', {
      task_id: 'flm-engine',
      proxy: mirror.proxy,
    })
    if (!supported) {
      expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_BACKEND' } })
      expect(mirror.seen).toEqual([])
      return
    }
    expect(await json(response)).toMatchObject({
      installed: true,
      build: { tag: release.version, backend_id: asset.platform },
    })
    expect((await json<Catalog>(await post(ready, '/engine-builds/fastflowlm/catalog'))).active?.tag).toBe(
      release.version
    )
    expect(await json(await check())).toMatchObject({
      verdict: facts.blockers.includes('xdna2-not-found') ? 'platform-unsupported' : 'environment-not-ready',
    })
    expect(mirror.seen).toEqual([new URL(asset.url).pathname])
  }
)
