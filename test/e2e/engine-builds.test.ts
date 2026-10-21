/**
 * Engine builds through the compiled binary (openspec change `move-sdcpp-mlx-install-to-core`, task
 * 4.4): conf manifests from `file://` overrides, archives from an HTTPS mirror behind a CONNECT
 * proxy, the fake engines inside them.
 *
 *   - sd.cpp: catalog → install → a newer manifest offered as an update → installed while a model is
 *     loaded (unloaded with `engine-updated`, the old build kept) → removed.
 *   - MLX: the installer's build active → a newer one installed → the next load starts it → a restart
 *     with an installer newer still makes the installer's build active and keeps the download.
 *
 * No imports from `src/`. POSIX only: the fake engines are shell launchers.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext } from '../helpers/compiled-diffusion.js'
import { launcherArchive, nodeLauncher, startReleaseMirror } from '../helpers/engine-builds-mirror.js'
import type { ReleaseMirror } from '../helpers/engine-builds-mirror.js'
import { FAKE_SIDECAR_SCRIPT } from '../helpers/fake-sidecar-server.js'
import { foundryLocalTestPlatform } from '../helpers/foundry-local-host.js'
import { liteRtLmTestPlatform } from '../helpers/litert-lm-host.js'
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
        `echo '{"c_api_version":2,"accelerators":[]}'`,
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
      expect(await accelerators()).toMatchObject({
        build: `v2.2.0/${platform}`,
        accelerators: [
          expect.objectContaining({ name: 'WebGpuExecutionProvider', prepared: true }),
          expect.anything(),
        ],
      })
      expect(await probes()).toBe(afterSecondCheck + 1)
    }, 120_000)
  }
)
