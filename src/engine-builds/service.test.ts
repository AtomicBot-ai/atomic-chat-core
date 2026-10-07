import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FixtureHttpServer } from '../../test/helpers/fixture-http-server.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents, EngineBuildId } from '../contracts/index.js'
import { Downloader } from '../downloads/index.js'
import type { DownloaderEventName } from '../downloads/index.js'
import type { HardwareFacts } from '../hardware/index.js'
import { parseMlxManifest, parseSdcppManifest } from './manifest.js'
import type { ManifestRead, MlxManifest, SdcppManifest } from './manifest.js'
import { EngineBuildsService, parseEngineBuildId } from './service.js'
import type { EngineHost } from './service.js'

/** Real child processes (the probes): under a loaded machine a first exec of a fresh script is slow. */
vi.setConfig({ testTimeout: 20_000 })

const POSIX = process.platform !== 'win32'
const server = new FixtureHttpServer()
const MIRROR = 'https://mirror.test/releases'

beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-engine-builds-')
  server.files.clear()
  server.requests.length = 0
})
afterEach(() => data.cleanup())

const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

/** A `.tar.gz` holding executable shell scripts. */
async function archive(name: string, scripts: Record<string, string>): Promise<Buffer> {
  const dir = join(data.root, 'archive-src', name)
  await mkdir(dir, { recursive: true })
  for (const [file, body] of Object.entries(scripts)) {
    await writeFile(join(dir, file), `#!/bin/sh\n${body}\n`)
    await chmod(join(dir, file), 0o755)
  }
  const out = join(data.root, 'archive-src', `${name}.tar.gz`)
  await tarCreate({ gzip: true, cwd: dir, file: out }, Object.keys(scripts))
  return readFile(out)
}

const SD_OK = {
  'sd-server': 'echo stable-diffusion.cpp',
  'sd-cli': 'echo "stable-diffusion.cpp usage: --cfg-scale"',
}
const SD_BROKEN = {
  'sd-server': 'exit 1',
  'sd-cli': 'echo "error while loading shared libraries: libvulkan.so.1" >&2; exit 127',
}
const MLX_OK = { 'mlx-server': 'echo "usage: mlx-server [-h] [--host HOST]"' }
const MLX_BROKEN = { 'mlx-server': 'echo "Library not loaded: @rpath/libmlx.dylib" >&2; exit 134' }

interface Served {
  name: string
  body: Buffer
  sha256?: string
  delayMs?: number
}

/** Serve archives under `/releases/<tag>/<name>` and describe them as a manifest asset each. */
function serve(tag: string, files: Record<string, Served>) {
  for (const file of Object.values(files))
    server.files.set(`/releases/${tag}/${file.name}`, {
      body: file.body,
      ...(file.delayMs ? { delayMs: file.delayMs } : {}),
    })
  return Object.entries(files).map(([backend, file]) => ({
    backend,
    name: file.name,
    sha256: file.sha256 ?? sha(file.body),
    size: file.body.length,
  }))
}

function sdManifest(tag: string, assets: ReturnType<typeof serve>): SdcppManifest {
  return parseSdcppManifest({ tag_name: tag, download_base: MIRROR, assets })
}

function mlxManifest(tag: string, publishedAt: string, assets: ReturnType<typeof serve>): MlxManifest {
  // Served from the same fixture origin: `mlxAssetUrl` is github.com/<repo>/releases/download/…
  return parseMlxManifest({
    tag_name: tag,
    upstream_repo: 'AtomicBot-ai/mlx-vlm',
    published_at: publishedAt,
    assets,
  })
}

const LINUX_VULKAN: Pick<HardwareFacts, 'osType' | 'arch' | 'cpuExtensions' | 'gpus'> = {
  osType: 'linux',
  arch: 'x86_64',
  cpuExtensions: [],
  gpus: [
    {
      name: 'Radeon',
      vendor: 'AMD',
      total_memory: 8192,
      uuid: 'gpu-0',
      driver_version: '',
      nvidia_info: null,
      vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '1.3', device_id: 1 },
    } as never,
  ],
}
const MAC_ARM = { osType: 'macos', arch: 'arm64', cpuExtensions: [], gpus: [] }

class FakeHost implements EngineHost {
  readonly calls: string[] = []
  used: string[] = []
  private tail: Promise<unknown> = Promise.resolve()
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn)
    this.tail = run.catch(() => {})
    return run
  }
  inUse(): Promise<string[]> {
    return Promise.resolve([...this.used])
  }
  activate(dir: string, replaced: boolean): Promise<void> {
    this.calls.push(`activate ${dir} ${String(replaced)}`)
    return Promise.resolve()
  }
}

function harness(
  opts: { facts?: typeof LINUX_VULKAN | typeof MAC_ARM; space?: number; resourcesDir?: string } = {}
) {
  const manifests: {
    'sd-cpp': ManifestRead<SdcppManifest>
    'mlx': ManifestRead<MlxManifest>
  } = {
    'sd-cpp': { manifest: null, source: null, fetched_at: null, error: 'offline' },
    'mlx': { manifest: null, source: null, fetched_at: null, error: 'offline' },
  }
  const events: Array<{ name: string; payload: unknown }> = []
  const changed: Array<CoreEvents['engine-build:changed']> = []
  const rewrite: typeof fetch = (input, init) => {
    const url = String(input)
      .replace(MIRROR, server.url('/releases'))
      .replace('https://github.com/AtomicBot-ai/mlx-vlm/releases/download', server.url('/releases'))
    return fetch(url, init)
  }
  const downloader = new Downloader({
    dataFolder: data.root,
    platform: 'linux',
    fetch: rewrite,
    availableSpace: async () => undefined,
    sleep: async () => {},
    emit: <K extends DownloaderEventName>(name: K, payload: CoreEvents[K]) => events.push({ name, payload }),
  })
  const hosts: Record<EngineBuildId, FakeHost> = { 'sd-cpp': new FakeHost(), 'mlx': new FakeHost() }
  let clock = 1_000
  const service = new EngineBuildsService({
    dataFolder: data.root,
    roots: { 'sd-cpp': data.layout.diffusion.backendsDir, 'mlx': data.layout.provider('mlx').backendsDir },
    failedBackendsFile: join(data.layout.diffusion.root, 'failed-backends.json'),
    resourcesDir: opts.resourcesDir,
    platform: 'linux',
    downloader,
    manifests: {
      'sd-cpp': { read: async () => manifests['sd-cpp'] },
      'mlx': { read: async () => manifests.mlx },
    },
    hardware: async () => opts.facts ?? LINUX_VULKAN,
    hosts,
    availableSpace: async () => opts.space,
    emit: (_name, payload) => changed.push(payload),
    now: () => (clock += 1),
  })
  const setSd = (manifest: SdcppManifest) => {
    manifests['sd-cpp'] = { manifest, source: 'remote', fetched_at: 1, error: null }
  }
  const setMlx = (manifest: MlxManifest) => {
    manifests.mlx = { manifest, source: 'remote', fetched_at: 1, error: null }
  }
  return { service, downloader, events, changed, hosts, setSd, setMlx, manifests }
}

const ls = (dir: string) => readdir(dir).catch(() => [] as string[])
const archiveRequests = () =>
  server.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/releases/'))

describe('parseEngineBuildId', () => {
  it('knows sd-cpp and mlx only', () => {
    expect(parseEngineBuildId('mlx')).toBe('mlx')
    expect(() => parseEngineBuildId('llamacpp')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    )
  })
})

describe.skipIf(!POSIX)('EngineBuildsService.install (task 3.1)', () => {
  it('downloads, checks, probes, marks and renames an sd.cpp build into place, then activates it', async () => {
    const h = harness()
    const tag = 'master-900-aaaaaaa'
    h.setSd(
      sdManifest(
        tag,
        serve(tag, { 'linux-vulkan-x64': { name: 'sd-vulkan.tar.gz', body: await archive('v', SD_OK) } })
      )
    )

    const result = await h.service.install('sd-cpp', { task_id: 'diffusion-backend-x' })

    const dir = join(data.layout.diffusion.backendsDir, tag, 'linux-vulkan-x64')
    expect(result).toEqual({
      installed: true,
      build: { tag, backend_id: 'linux-vulkan-x64', origin: 'downloaded' },
      retired: [],
      kept_in_use: [],
    })
    expect((await ls(dir)).sort()).toEqual(['.atomic-owned', 'install.json', 'sd-cli', 'sd-server'])
    expect(JSON.parse(await readFile(join(dir, 'install.json'), 'utf8'))).toMatchObject({
      tag,
      backendId: 'linux-vulkan-x64',
      backend: 'vulkan',
      engine: 'sd-cpp',
    })
    // Nothing but the build is left beside it: no staging, no archive.
    expect(await ls(join(data.layout.diffusion.backendsDir, tag))).toEqual(['linux-vulkan-x64'])
    expect(h.hosts['sd-cpp'].calls).toEqual([`activate ${dir} false`])
    expect(h.changed).toEqual([{ engine: 'sd-cpp', reason: 'install' }])
    expect(
      h.events.some(
        (e) =>
          e.name === 'download:progress' && (e.payload as { taskId: string }).taskId === 'diffusion-backend-x'
      )
    ).toBe(true)
  })

  it('installs MLX the same way, recording the release date', async () => {
    const h = harness({ facts: MAC_ARM })
    const tag = 'mlxvlm-macos-arm64-1234567'
    h.setMlx(
      mlxManifest(
        tag,
        '2026-10-02T00:00:00Z',
        serve(tag, { 'macos-arm64': { name: 'mlx.tar.gz', body: await archive('m', MLX_OK) } })
      )
    )

    const result = await h.service.install('mlx', { task_id: 'mlx-install' })

    const dir = join(data.layout.provider('mlx').backendsDir, tag, 'macos-arm64')
    expect(result.installed).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'install.json'), 'utf8'))).toMatchObject({
      tag,
      backendId: 'macos-arm64',
      publishedAt: '2026-10-02T00:00:00Z',
    })
    expect(await h.service.resolveMlxBinary()).toBe(join(dir, 'mlx-server'))
  })

  it('refuses a tampered archive: removed, nothing unpacked, ENGINE_INSTALL_FAILED', async () => {
    const h = harness()
    const tag = 'master-900-aaaaaaa'
    h.setSd(
      sdManifest(
        tag,
        serve(tag, {
          'linux-vulkan-x64': { name: 'sd.tar.gz', body: await archive('v', SD_OK), sha256: '0'.repeat(64) },
        })
      )
    )

    await expect(h.service.install('sd-cpp', { task_id: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      message: expect.stringMatching(/does not match the manifest/),
    })
    expect(await ls(join(data.layout.diffusion.backendsDir, tag))).toEqual([])
    expect(h.hosts['sd-cpp'].calls).toEqual([])
    expect(h.changed).toEqual([])
  })

  it('fails with the probe output when the last build on the ladder does not run, keeping the active build', async () => {
    const h = harness({ facts: MAC_ARM })
    const tag = 'mlxvlm-macos-arm64-1234567'
    h.setMlx(
      mlxManifest(
        tag,
        '2026-10-02T00:00:00Z',
        serve(tag, { 'macos-arm64': { name: 'mlx.tar.gz', body: await archive('m', MLX_BROKEN) } })
      )
    )

    const error = await h.service.install('mlx', { task_id: 't' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AtomicCoreError)
    expect(error).toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: expect.stringMatching(/Library not loaded/),
    })
    expect(await ls(join(data.layout.provider('mlx').backendsDir, tag))).toEqual([])
    expect(await h.service.resolveMlxBinary()).toBeUndefined()
  })

  it('walks down the ladder when a build unpacks but fails its probe, and remembers it', async () => {
    const h = harness()
    const tag = 'master-900-aaaaaaa'
    h.setSd(
      sdManifest(
        tag,
        serve(tag, {
          'linux-vulkan-x64': { name: 'sd-vulkan.tar.gz', body: await archive('v', SD_BROKEN) },
          'linux-cpu-x64': { name: 'sd-cpu.tar.gz', body: await archive('c', SD_OK) },
        })
      )
    )

    const result = await h.service.install('sd-cpp', { task_id: 'one-task' })

    expect(result).toMatchObject({
      installed: true,
      build: { backend_id: 'linux-cpu-x64' },
      failed_backend_ids: ['linux-vulkan-x64'],
    })
    expect(await ls(join(data.layout.diffusion.backendsDir, tag))).toEqual(['linux-cpu-x64'])
    expect(
      JSON.parse(await readFile(join(data.layout.diffusion.root, 'failed-backends.json'), 'utf8'))
    ).toEqual([`${tag}/linux-vulkan-x64`])
    const progress = h.events
      .filter((e) => e.name === 'download:progress')
      .map((e) => (e.payload as { taskId: string }).taskId)
    expect(new Set(progress)).toEqual(new Set(['one-task']))
    expect((await h.service.catalog('sd-cpp')).host_backend_id).toBe('linux-cpu-x64')
  })

  it('does not walk down on a bad hash: that is not "this build does not run here"', async () => {
    const h = harness()
    const tag = 'master-900-aaaaaaa'
    h.setSd(
      sdManifest(
        tag,
        serve(tag, {
          'linux-vulkan-x64': {
            name: 'sd-vulkan.tar.gz',
            body: await archive('v', SD_OK),
            sha256: '0'.repeat(64),
          },
          'linux-cpu-x64': { name: 'sd-cpu.tar.gz', body: await archive('c', SD_OK) },
        })
      )
    )
    await expect(h.service.install('sd-cpp', { task_id: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
    })
    expect(await ls(join(data.layout.diffusion.backendsDir, tag))).toEqual([])
  })

  it('stops on a cancel mid-download, removes the staging and leaves the installed build alone', async () => {
    const h = harness()
    const old = 'master-883-137f740'
    h.setSd(
      sdManifest(
        old,
        serve(old, { 'linux-vulkan-x64': { name: 'sd.tar.gz', body: await archive('o', SD_OK) } })
      )
    )
    await h.service.install('sd-cpp', { task_id: 'first' })

    const tag = 'master-900-aaaaaaa'
    h.setSd(
      sdManifest(
        tag,
        serve(tag, {
          'linux-vulkan-x64': { name: 'sd.tar.gz', body: await archive('n', SD_OK), delayMs: 2_000 },
        })
      )
    )
    const install = h.service.install('sd-cpp', { task_id: 'second' }).catch((e: unknown) => e)
    await waitFor(() => archiveRequests().some((r) => r.path.startsWith(`/releases/${tag}/`)))
    expect(h.downloader.cancel('second')).toBe(true)

    expect(await install).toMatchObject({ code: 'CANCELLED' })
    expect(await ls(join(data.layout.diffusion.backendsDir, tag))).toEqual([])
    expect(await ls(join(data.layout.diffusion.backendsDir, old))).toEqual(['linux-vulkan-x64'])
    expect((await h.service.catalog('sd-cpp')).active).toMatchObject({ tag: old })
  })

  it('answers installed: false for the same build without force, and reinstalls it with force', async () => {
    const h = harness()
    const tag = 'master-900-aaaaaaa'
    h.setSd(
      sdManifest(
        tag,
        serve(tag, { 'linux-vulkan-x64': { name: 'sd.tar.gz', body: await archive('v', SD_OK) } })
      )
    )
    await h.service.install('sd-cpp', { task_id: 't1' })
    const before = archiveRequests().length

    expect(await h.service.install('sd-cpp', { task_id: 't2' })).toMatchObject({
      installed: false,
      reason: 'already-installed',
    })
    expect(archiveRequests()).toHaveLength(before)

    expect(await h.service.install('sd-cpp', { task_id: 't3', force: true })).toMatchObject({
      installed: true,
    })
    const dir = join(data.layout.diffusion.backendsDir, tag, 'linux-vulkan-x64')
    expect(h.hosts['sd-cpp'].calls.at(-1)).toBe(`activate ${dir} true`)
    expect(await ls(join(data.layout.diffusion.backendsDir, tag))).toEqual(['linux-vulkan-x64'])
  })

  it('never installs a build older than the active one, force or not', async () => {
    const h = harness()
    const newer = 'master-900-aaaaaaa'
    h.setSd(
      sdManifest(
        newer,
        serve(newer, { 'linux-vulkan-x64': { name: 'sd.tar.gz', body: await archive('n', SD_OK) } })
      )
    )
    await h.service.install('sd-cpp', { task_id: 't1' })
    const older = 'master-883-137f740'
    h.setSd(
      sdManifest(
        older,
        serve(older, { 'linux-vulkan-x64': { name: 'sd.tar.gz', body: await archive('o', SD_OK) } })
      )
    )
    const before = archiveRequests().length

    for (const force of [false, true])
      expect(await h.service.install('sd-cpp', { task_id: 't', force })).toEqual({
        installed: false,
        reason: 'active-is-newer',
        build: { tag: older, backend_id: 'linux-vulkan-x64', origin: 'downloaded' },
        retired: [],
        kept_in_use: [],
      })
    expect(archiveRequests()).toHaveLength(before)
    expect(await ls(join(data.layout.diffusion.backendsDir, newer))).toEqual(['linux-vulkan-x64'])
  })

  it('refuses a second install of the same engine while one runs', async () => {
    const h = harness()
    const tag = 'master-900-aaaaaaa'
    h.setSd(
      sdManifest(
        tag,
        serve(tag, {
          'linux-vulkan-x64': { name: 'sd.tar.gz', body: await archive('v', SD_OK), delayMs: 300 },
        })
      )
    )
    const first = h.service.install('sd-cpp', { task_id: 'a' })
    await expect(h.service.install('sd-cpp', { task_id: 'b' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
    })
    expect((await first).installed).toBe(true)
  })

  it('downloads nothing when the manifest is unavailable, the disk is too small or the build is unpinned', async () => {
    const offline = harness()
    await expect(offline.service.install('mlx', { task_id: 't' })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    })

    const small = harness({ space: 10 })
    const tag = 'master-900-aaaaaaa'
    small.setSd(
      sdManifest(
        tag,
        serve(tag, { 'linux-vulkan-x64': { name: 'sd.tar.gz', body: await archive('v', SD_OK) } })
      )
    )
    await expect(small.service.install('sd-cpp', { task_id: 't' })).rejects.toMatchObject({
      code: 'BACKEND_INSUFFICIENT_DISK_SPACE',
    })

    const unpinned = harness()
    unpinned.setSd(
      parseSdcppManifest({
        tag_name: tag,
        download_base: MIRROR,
        assets: [{ backend: 'linux-vulkan-x64', name: 'sd.tar.gz' }],
      })
    )
    await expect(unpinned.service.install('sd-cpp', { task_id: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      message: expect.stringMatching(/does not pin/),
    })
    expect(archiveRequests()).toEqual([])
  })

  it('activates under the load lock, then keeps a build a session still runs from and retires it on the next install', async () => {
    const h = harness()
    const install = async (tag: string) => {
      h.setSd(
        sdManifest(
          tag,
          serve(tag, { 'linux-vulkan-x64': { name: `${tag}.tar.gz`, body: await archive(tag, SD_OK) } })
        )
      )
      return h.service.install('sd-cpp', { task_id: tag })
    }
    const dirOf = (tag: string) => join(data.layout.diffusion.backendsDir, tag, 'linux-vulkan-x64')
    await install('master-883-137f740')
    // A server whose exit could not be confirmed still runs from master-883.
    h.hosts['sd-cpp'].used = [dirOf('master-883-137f740')]

    const second = await install('master-900-aaaaaaa')
    expect(second).toMatchObject({
      retired: [],
      kept_in_use: [{ tag: 'master-883-137f740', backend_id: 'linux-vulkan-x64', origin: 'downloaded' }],
    })
    expect(await ls(data.layout.diffusion.backendsDir)).toEqual(['master-883-137f740', 'master-900-aaaaaaa'])
    const catalog = await h.service.catalog('sd-cpp')
    expect(catalog.installed.map((b) => [b.tag, b.in_use, b.active])).toEqual(
      expect.arrayContaining([
        ['master-883-137f740', true, false],
        ['master-900-aaaaaaa', false, true],
      ])
    )

    h.hosts['sd-cpp'].used = []
    expect(await install('master-901-bbbbbbb')).toMatchObject({
      retired: expect.arrayContaining([
        { tag: 'master-883-137f740', backend_id: 'linux-vulkan-x64', origin: 'downloaded' },
        { tag: 'master-900-aaaaaaa', backend_id: 'linux-vulkan-x64', origin: 'downloaded' },
      ]),
      kept_in_use: [],
    })
    expect(await ls(data.layout.diffusion.backendsDir)).toEqual(['master-901-bbbbbbb'])
  })

  it('refuses a host no build fits', async () => {
    const h = harness({ facts: { osType: 'macos', arch: 'x86_64', cpuExtensions: [], gpus: [] } })
    const tag = 'mlxvlm-macos-arm64-1234567'
    h.setMlx(
      mlxManifest(
        tag,
        '2026-10-02T00:00:00Z',
        serve(tag, { 'macos-arm64': { name: 'mlx.tar.gz', body: await archive('m', MLX_OK) } })
      )
    )
    await expect(h.service.install('mlx', { task_id: 't' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_BACKEND',
      message: expect.stringMatching(/Apple Silicon/),
    })
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('MLX from two origins (task 3.3)', () => {
  const resources = () => join(data.root, 'resources')
  async function bundle(meta?: { tag: string; published_at: string }): Promise<void> {
    await mkdir(resources(), { recursive: true })
    await writeFile(join(resources(), 'mlx-server'), 'bin')
    if (meta) await writeFile(join(resources(), 'mlx-server.json'), JSON.stringify(meta))
  }
  async function download(tag: string, publishedAt: string): Promise<string> {
    const dir = join(data.layout.provider('mlx').backendsDir, tag, 'macos-arm64')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'mlx-server'), 'bin')
    await writeFile(join(dir, '.atomic-owned'), 'atomic-chat\n')
    await writeFile(
      join(dir, 'install.json'),
      JSON.stringify({ tag, backendId: 'macos-arm64', sha256: null, installedAtMs: 1, publishedAt })
    )
    return dir
  }
  const AUG = { tag: 'mlxvlm-macos-arm64-07ba5a1', published_at: '2026-08-28T10:38:38Z' }

  it.each([
    ['only the installer', async (): Promise<void> => bundle(AUG), 'bundled'],
    [
      'only a download',
      async (): Promise<void> => void (await download('mlxvlm-macos-arm64-aaaaaaa', '2026-09-10T00:00:00Z')),
      'downloaded',
    ],
    [
      'a newer download',
      async () => {
        await bundle(AUG)
        await download('mlxvlm-macos-arm64-aaaaaaa', '2026-10-02T00:00:00Z')
      },
      'downloaded',
    ],
    [
      'a newer installer',
      async () => {
        await bundle({ ...AUG, published_at: '2026-10-02T00:00:00Z' })
        await download('mlxvlm-macos-arm64-aaaaaaa', '2026-09-10T00:00:00Z')
      },
      'bundled',
    ],
    [
      'a tie, which the installer wins',
      async () => {
        await bundle(AUG)
        await download('mlxvlm-macos-arm64-aaaaaaa', AUG.published_at)
      },
      'bundled',
    ],
    [
      'an installer without metadata, older than any download',
      async () => {
        await bundle()
        await download('mlxvlm-macos-arm64-aaaaaaa', '2000-01-01T00:00:00Z')
      },
      'downloaded',
    ],
    ['nothing', async () => {}, null],
  ] as const)('resolves %s', async (_name, setup, origin) => {
    await setup()
    const h = harness({ facts: MAC_ARM, resourcesDir: resources() })
    const binary = await h.service.resolveMlxBinary()
    if (origin === null) expect(binary).toBeUndefined()
    else if (origin === 'bundled') expect(binary).toBe(join(resources(), 'mlx-server'))
    else
      expect(binary).toBe(
        join(
          data.layout.provider('mlx').backendsDir,
          'mlxvlm-macos-arm64-aaaaaaa',
          'macos-arm64',
          'mlx-server'
        )
      )
  })

  it('lists the installer build as active and not removable, and refuses to remove it', async () => {
    await bundle(AUG)
    const h = harness({ facts: MAC_ARM, resourcesDir: resources() })
    const catalog = await h.service.catalog('mlx')
    expect(catalog.installed).toEqual([
      {
        tag: AUG.tag,
        backend_id: 'macos-arm64',
        origin: 'bundled',
        installed_at_ms: null,
        published_at: AUG.published_at,
        removable: false,
        in_use: false,
        active: true,
      },
    ])
    expect(catalog.active).toMatchObject({ origin: 'bundled' })
    await expect(h.service.remove('mlx', AUG.tag, 'macos-arm64')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('at start removes the downloads no newer than the installer, and says so', async () => {
    await bundle({ ...AUG, published_at: '2026-10-02T00:00:00Z' })
    const older = await download('mlxvlm-macos-arm64-aaaaaaa', '2026-09-10T00:00:00Z')
    const same = await download('mlxvlm-macos-arm64-bbbbbbb', '2026-10-02T00:00:00Z')
    const h = harness({ facts: MAC_ARM, resourcesDir: resources() })
    await h.service.startupCleanup()
    expect(await ls(data.layout.provider('mlx').backendsDir)).toEqual([])
    expect(h.changed).toEqual([{ engine: 'mlx', reason: 'startup-cleanup' }])
    expect([older, same].length).toBe(2)
    expect(await h.service.resolveMlxBinary()).toBe(join(resources(), 'mlx-server'))
  })

  it('at start keeps a download newer than the installer, and reports nothing when nothing went', async () => {
    await bundle(AUG)
    await download('mlxvlm-macos-arm64-aaaaaaa', '2026-10-02T00:00:00Z')
    const h = harness({ facts: MAC_ARM, resourcesDir: resources() })
    await h.service.startupCleanup()
    expect(await ls(data.layout.provider('mlx').backendsDir)).toEqual(['mlxvlm-macos-arm64-aaaaaaa'])
    expect(h.changed).toEqual([])
  })
})

describe('startup cleanup of sd.cpp', () => {
  it('removes the builds a session kept on the last install, and the leftovers of an interrupted one', async () => {
    const root = data.layout.diffusion.backendsDir
    const build = async (tag: string, installedAtMs: number) => {
      const dir = join(root, tag, 'linux-vulkan-x64')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'sd-server'), 'bin')
      await writeFile(join(dir, '.atomic-owned'), 'atomic-chat\n')
      await writeFile(
        join(dir, 'install.json'),
        JSON.stringify({
          tag,
          backendId: 'linux-vulkan-x64',
          backend: 'vulkan',
          engine: 'sd-cpp',
          sha256: null,
          installedAtMs,
        })
      )
      return dir
    }
    await build('master-883-137f740', 1)
    const active = await build('master-900-aaaaaaa', 2)
    await mkdir(`${active}.incoming-5`, { recursive: true })
    await mkdir(`${active}.incoming-5.download`, { recursive: true })
    await mkdir(join(root, 'master-900-aaaaaaa', 'foreign'), { recursive: true })
    const h = harness()
    await h.service.startupCleanup()
    expect(await ls(root)).toEqual(['master-900-aaaaaaa'])
    expect((await ls(join(root, 'master-900-aaaaaaa'))).sort()).toEqual(['foreign', 'linux-vulkan-x64'])
    expect(h.changed).toEqual([{ engine: 'sd-cpp', reason: 'startup-cleanup' }])
  })
})

describe.skipIf(!POSIX)('EngineBuildsService.remove (task 3.4)', () => {
  async function installed(h: ReturnType<typeof harness>, tag: string) {
    h.setSd(
      sdManifest(
        tag,
        serve(tag, { 'linux-vulkan-x64': { name: `${tag}.tar.gz`, body: await archive(tag, SD_OK) } })
      )
    )
    await h.service.install('sd-cpp', { task_id: tag })
    return join(data.layout.diffusion.backendsDir, tag, 'linux-vulkan-x64')
  }

  it('removes a downloaded build under the load lock and says so', async () => {
    const h = harness()
    await installed(h, 'master-900-aaaaaaa')
    const order: string[] = []
    const host = h.hosts['sd-cpp']
    const exclusive = host.exclusive.bind(host)
    host.exclusive = <T>(fn: () => Promise<T>) => {
      order.push('lock')
      return exclusive(fn)
    }
    expect(await h.service.remove('sd-cpp', 'master-900-aaaaaaa', 'linux-vulkan-x64')).toEqual({
      removed: true,
    })
    expect(order).toEqual(['lock'])
    expect(await ls(data.layout.diffusion.backendsDir)).toEqual([])
    expect(h.changed.at(-1)).toEqual({ engine: 'sd-cpp', reason: 'uninstall' })
  })

  it('refuses a build in use, a folder it did not mark and anything outside its root; a missing build is removed: false', async () => {
    const h = harness()
    const dir = await installed(h, 'master-900-aaaaaaa')
    h.hosts['sd-cpp'].used = [dir]
    await expect(h.service.remove('sd-cpp', 'master-900-aaaaaaa', 'linux-vulkan-x64')).rejects.toMatchObject({
      code: 'BACKEND_IN_USE',
    })
    expect(await ls(join(data.layout.diffusion.backendsDir, 'master-900-aaaaaaa'))).toEqual([
      'linux-vulkan-x64',
    ])

    await mkdir(join(data.layout.diffusion.backendsDir, 'master-1-aaaaaaa', 'hand-made'), { recursive: true })
    await expect(h.service.remove('sd-cpp', 'master-1-aaaaaaa', 'hand-made')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(h.service.remove('sd-cpp', '..', 'models')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    const before = h.changed.length
    expect(await h.service.remove('mlx', 'mlxvlm-macos-arm64-0000000', 'macos-arm64')).toEqual({
      removed: false,
    })
    expect(h.changed).toHaveLength(before)
  })
})
