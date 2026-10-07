/**
 * Engine builds through the compiled binary (openspec change `move-sdcpp-mlx-install-to-core`, task
 * 4.4): conf manifests from `file://` overrides, archives from an HTTPS mirror behind a CONNECT
 * proxy, the fake engines inside them.
 *
 *   - sd.cpp: catalog → install → a newer manifest offered as an update → installed while a model is
 *     loaded (unloaded with `engine-updated`, the old build retired) → removed.
 *   - MLX: the installer's build active → a newer one installed → the next load starts it → a restart
 *     with an installer newer still removes the download.
 *
 * No imports from `src/`. POSIX only: the fake engines are shell launchers.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext } from '../helpers/compiled-diffusion.js'
import { launcherArchive, nodeLauncher, startReleaseMirror } from '../helpers/engine-builds-mirror.js'
import type { ReleaseMirror } from '../helpers/engine-builds-mirror.js'
import { FAKE_SIDECAR_SCRIPT } from '../helpers/fake-sidecar-server.js'

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
    const update = await json<{ retired: Array<{ tag: string }> }>(
      await post(ready, '/engine-builds/sd-cpp/install', { task_id: 'sd-update', proxy })
    )
    expect(update).toMatchObject({
      installed: true,
      retired: [{ tag: 'master-883-137f740', backend_id: host, origin: 'downloaded' }],
      kept_in_use: [],
    })
    await waitFor(() => sd.stateReasons(events).includes('engine-updated'), 'the engine-updated state event')
    await waitFor(() => !sd.alive(loaded.pid), 'the old server to be gone')
    expect(existsSync(oldDir)).toBe(false)
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
    expect(after.installed).toEqual([])
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

      // The app updates and brings a newer mlx-server: the download goes at the next start.
      await post(ready, '/shutdown', { force: true })
      await waitFor(
        () => first.child.exitCode !== null || first.child.signalCode !== null,
        'the first core to exit'
      )
      await installerMeta('2026-11-01T00:00:00Z')
      const second = await core.startDaemon(folder, ctx.daemons, ['--resources-dir', resources], env)
      expect(existsSync(downloadedDir)).toBe(false)
      expect(
        (await json<Catalog>(await post(second.ready, '/engine-builds/mlx/catalog'))).active
      ).toMatchObject({
        origin: 'bundled',
      })
    }, 120_000)
  }
)
