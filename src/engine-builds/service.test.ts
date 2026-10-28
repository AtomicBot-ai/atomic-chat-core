import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
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
import { makeZip } from '../../test/helpers/make-zip.js'
import { OWNER_MARKER } from '../diffusion/install.js'
import { writeLiteRtLmInstallRecord } from './litert-lm.js'
import { writeGeniexInstallRecord } from './geniex.js'
import type { EngineProbeFacts } from './engines.js'
import {
  parseFoundryLocalManifest,
  parseGeniexManifest,
  parseLiteRtLmManifest,
  parseMlxManifest,
  parseSdcppManifest,
} from './manifest.js'
import type {
  FoundryLocalManifest,
  GeniexManifest,
  LiteRtLmManifest,
  ManifestRead,
  MlxManifest,
  SdcppManifest,
} from './manifest.js'
import type { FoundryLocalHostPlatform, LiteRtLmHostPlatform } from './select.js'
import type { GeniexHostPlatform } from '../runtime/geniex/chip.js'
import { EngineBuildsService, IDLE_ENGINE_HOST, parseEngineBuildId } from './service.js'
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
  opts: {
    facts?: typeof LINUX_VULKAN | typeof MAC_ARM
    space?: number
    resourcesDir?: string
    platform?: NodeJS.Platform
    foundryLocalHost?: FoundryLocalHostPlatform
    foundryProbe?: (dir: string) => Promise<void>
    liteRtLmHost?: LiteRtLmHostPlatform
    liteRtLmProbe?: (dir: string) => Promise<void>
    geniexHost?: GeniexHostPlatform
    /** The `geniex-host probe` stand-in: what the core's prober returns, as `hostProbes.geniex` does. */
    geniexProbe?: (dir: string) => Promise<EngineProbeFacts | void>
  } = {}
) {
  const manifests: {
    'sd-cpp': ManifestRead<SdcppManifest>
    'mlx': ManifestRead<MlxManifest>
    'foundry-local': ManifestRead<FoundryLocalManifest>
    'litert-lm': ManifestRead<LiteRtLmManifest>
    'geniex': ManifestRead<GeniexManifest>
  } = {
    'sd-cpp': { manifest: null, source: null, fetched_at: null, error: 'offline' },
    'mlx': { manifest: null, source: null, fetched_at: null, error: 'offline' },
    'foundry-local': { manifest: null, source: null, fetched_at: null, error: 'offline' },
    'litert-lm': { manifest: null, source: null, fetched_at: null, error: 'offline' },
    'geniex': { manifest: null, source: null, fetched_at: null, error: 'offline' },
  }
  const events: Array<{ name: string; payload: unknown }> = []
  const changed: Array<CoreEvents['engine-build:changed']> = []
  const engineChanged: Array<CoreEvents['engine:changed']> = []
  const rewrite: typeof fetch = (input, init) => {
    const url = String(input)
      .replace(MIRROR, server.url('/releases'))
      .replace('https://github.com/AtomicBot-ai/mlx-vlm/releases/download', server.url('/releases'))
      .replace('https://github.com/microsoft/foundry-local/releases/download', server.url('/releases'))
      .replace('https://files.pythonhosted.org/packages', server.url('/releases'))
      .replace(
        'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex',
        server.url('/releases')
      )
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
  const hosts: Record<EngineBuildId, FakeHost> = {
    'sd-cpp': new FakeHost(),
    'mlx': new FakeHost(),
    'foundry-local': new FakeHost(),
    'litert-lm': new FakeHost(),
    'geniex': new FakeHost(),
  }
  let clock = 1_000
  const service = new EngineBuildsService({
    dataFolder: data.root,
    roots: {
      'sd-cpp': data.layout.diffusion.backendsDir,
      'mlx': data.layout.provider('mlx').backendsDir,
      'foundry-local': FOUNDRY_ROOT(),
      'litert-lm': LITERT_ROOT(),
      'geniex': GENIEX_ROOT(),
    },
    failedBackendsFile: join(data.layout.diffusion.root, 'failed-backends.json'),
    resourcesDir: opts.resourcesDir,
    platform: opts.platform ?? 'linux',
    downloader,
    manifests: {
      'sd-cpp': { read: async () => manifests['sd-cpp'] },
      'mlx': { read: async () => manifests.mlx },
      'foundry-local': { read: async () => manifests['foundry-local'] },
      'litert-lm': { read: async () => manifests['litert-lm'] },
      'geniex': { read: async () => manifests.geniex },
    },
    hostPlatforms: {
      'foundry-local': opts.foundryLocalHost ?? { platform: 'linux-x64' },
      'litert-lm': opts.liteRtLmHost ?? { platform: 'linux-x64' },
      'geniex': opts.geniexHost ?? { platform: 'win-arm64', chip: 'x-elite' },
    },
    hostProbes: {
      ...(opts.geniexProbe ? { geniex: opts.geniexProbe } : {}),
    },
    probe: {
      ...(opts.foundryProbe ? { 'foundry-local': opts.foundryProbe } : {}),
      ...(opts.liteRtLmProbe ? { 'litert-lm': opts.liteRtLmProbe } : {}),
    },
    hardware: async () => opts.facts ?? LINUX_VULKAN,
    hosts,
    availableSpace: async () => opts.space,
    emit: (name, payload) =>
      name === 'engine-build:changed'
        ? changed.push(payload as CoreEvents['engine-build:changed'])
        : engineChanged.push(payload as CoreEvents['engine:changed']),
    now: () => (clock += 1),
  })
  const setSd = (manifest: SdcppManifest) => {
    manifests['sd-cpp'] = { manifest, source: 'remote', fetched_at: 1, error: null }
  }
  const setMlx = (manifest: MlxManifest) => {
    manifests.mlx = { manifest, source: 'remote', fetched_at: 1, error: null }
  }
  const setFoundry = (manifest: FoundryLocalManifest) => {
    manifests['foundry-local'] = { manifest, source: 'remote', fetched_at: 1, error: null }
  }
  const setLiteRtLm = (manifest: LiteRtLmManifest) => {
    manifests['litert-lm'] = { manifest, source: 'remote', fetched_at: 1, error: null }
  }
  const setGeniex = (manifest: GeniexManifest) => {
    manifests.geniex = { manifest, source: 'remote', fetched_at: 1, error: null }
  }
  return {
    service,
    downloader,
    events,
    changed,
    engineChanged,
    hosts,
    setSd,
    setMlx,
    setFoundry,
    setLiteRtLm,
    setGeniex,
    manifests,
  }
}

const FOUNDRY_ROOT = () => join(data.root, 'foundry-local', 'backends')
const LITERT_ROOT = () => join(data.root, 'litert-lm', 'backends')
const GENIEX_ROOT = () => join(data.root, 'geniex', 'backends')

/** A Foundry Local archive: the libraries as plain files, plus the debug symbols Microsoft ships. */
async function foundryArchive(name: string, files: Record<string, string>): Promise<Buffer> {
  const dir = join(data.root, 'archive-src', name)
  for (const [file, body] of Object.entries(files)) {
    await mkdir(join(dir, file, '..'), { recursive: true })
    await writeFile(join(dir, file), body)
  }
  const out = join(data.root, 'archive-src', `${name}.tgz`)
  await tarCreate({ gzip: true, cwd: dir, file: out }, ['include', 'lib'])
  return readFile(out)
}

const FOUNDRY_LINUX = {
  'include/foundry_local/foundry_local_c.h': '#define FOUNDRY_LOCAL_API_VERSION 2',
  'lib/libfoundry_local.so': 'so',
  'lib/libfoundry_local.so.dbg': 'debug',
  'lib/libonnxruntime.so': 'ort',
  'lib/libonnxruntime-genai.so': 'genai',
  'lib/foundry_local.pdb': 'pdb',
  'lib/libfoundry_local.dylib.dSYM/Contents/Info.plist': 'plist',
}

function foundryManifest(
  releases: Array<{
    tag: string
    published_at: string
    c_api_version?: number
    assets: ReturnType<typeof serve>
  }>
): FoundryLocalManifest {
  return parseFoundryLocalManifest(
    {
      schema_version: 1,
      upstream_repo: 'microsoft/foundry-local',
      releases: releases.map((release) => ({
        tag: release.tag,
        published_at: release.published_at,
        min_core_version: '0.1.0',
        c_api_version: release.c_api_version ?? 2,
        assets: release.assets.map(({ backend, ...asset }) => ({ platform: backend, ...asset })),
      })),
    },
    { coreVersion: '9.9.9', cApiVersions: [2, 3] }
  )
}

const ls = (dir: string) => readdir(dir).catch(() => [] as string[])
const archiveRequests = () =>
  server.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/releases/'))

describe('IDLE_ENGINE_HOST', () => {
  it('runs what it is handed, holds nothing and activates nothing', async () => {
    expect(await IDLE_ENGINE_HOST.exclusive(async () => 7)).toBe(7)
    expect(await IDLE_ENGINE_HOST.inUse()).toEqual([])
    await expect(IDLE_ENGINE_HOST.activate('/x', false)).resolves.toBeUndefined()
  })
})

describe('parseEngineBuildId', () => {
  it('knows sd-cpp, mlx, foundry-local and litert-lm only', () => {
    expect(parseEngineBuildId('mlx')).toBe('mlx')
    expect(parseEngineBuildId('foundry-local')).toBe('foundry-local')
    expect(parseEngineBuildId('litert-lm')).toBe('litert-lm')
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

  it('activates under the load lock and deletes no other build, used or not', async () => {
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
    expect(second).toMatchObject({ retired: [], kept_in_use: [] })
    expect(await ls(data.layout.diffusion.backendsDir)).toEqual(['master-883-137f740', 'master-900-aaaaaaa'])
    const catalog = await h.service.catalog('sd-cpp')
    expect(catalog.installed.map((b) => [b.tag, b.in_use, b.active])).toEqual(
      expect.arrayContaining([
        ['master-883-137f740', true, false],
        ['master-900-aaaaaaa', false, true],
      ])
    )

    h.hosts['sd-cpp'].used = []
    expect(await install('master-901-bbbbbbb')).toMatchObject({ retired: [], kept_in_use: [] })
    expect(await ls(data.layout.diffusion.backendsDir)).toEqual([
      'master-883-137f740',
      'master-900-aaaaaaa',
      'master-901-bbbbbbb',
    ])
    expect((await h.service.catalog('sd-cpp')).active).toMatchObject({ tag: 'master-901-bbbbbbb' })
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

describe('EngineBuildsService.catalog host_download_bytes', () => {
  const PIN = '0'.repeat(64)
  const WIN_CUDA: typeof LINUX_VULKAN = {
    osType: 'windows',
    arch: 'x86_64',
    cpuExtensions: [],
    gpus: [
      {
        name: 'GeForce',
        vendor: 'NVIDIA',
        total_memory: 8192,
        uuid: 'gpu-0',
        driver_version: '560.94',
        nvidia_info: { index: 0, compute_capability: '8.9' },
        vulkan_info: null,
      } as never,
    ],
  }

  it('sizes the MLX build this host would install with nothing installed, which the update check does not', async () => {
    const h = harness({ facts: MAC_ARM })
    h.setMlx(
      mlxManifest('mlxvlm-macos-arm64-1234567', '2026-10-02T00:00:00Z', [
        { backend: 'macos-arm64', name: 'mlx.tar.gz', sha256: PIN, size: 210_000_000 },
      ])
    )
    expect(await h.service.catalog('mlx')).toMatchObject({
      host_backend_id: 'macos-arm64',
      host_download_bytes: 210_000_000,
      installed: [],
      active: null,
    })
    expect(await h.service.checkUpdates('mlx')).toEqual({ update_needed: false, current: null, target: null })
  })

  it('counts the cudart companion with the Windows CUDA build of sd.cpp', async () => {
    const h = harness({ facts: WIN_CUDA })
    h.setSd(
      parseSdcppManifest({
        tag_name: 'master-900-aaaaaaa',
        download_base: MIRROR,
        assets: [
          { backend: 'win-cuda12-x64', name: 'sd-cuda.zip', sha256: PIN, size: 300 },
          { backend: 'win-cudart-cu12', name: 'cudart.zip', sha256: PIN, size: 200, companion: true },
          { backend: 'win-cpu-x64', name: 'sd-cpu.zip', sha256: PIN, size: 50 },
        ],
      })
    )
    expect(await h.service.catalog('sd-cpp')).toMatchObject({
      host_backend_id: 'win-cuda12-x64',
      host_download_bytes: 500,
    })
  })

  it('is null without a manifest, without a host build, or when the manifest leaves a size out', async () => {
    expect(await harness().service.catalog('mlx')).toMatchObject({
      manifest: null,
      host_backend_id: null,
      host_download_bytes: null,
    })

    const intel = harness({ facts: { osType: 'macos', arch: 'x86_64', cpuExtensions: [], gpus: [] } })
    intel.setMlx(
      mlxManifest('mlxvlm-macos-arm64-1234567', '2026-10-02T00:00:00Z', [
        { backend: 'macos-arm64', name: 'mlx.tar.gz', sha256: PIN, size: 210_000_000 },
      ])
    )
    expect(await intel.service.catalog('mlx')).toMatchObject({
      host_backend_id: null,
      host_download_bytes: null,
    })

    const unsized = harness()
    unsized.setSd(
      parseSdcppManifest({
        tag_name: 'master-900-aaaaaaa',
        download_base: MIRROR,
        assets: [{ backend: 'linux-vulkan-x64', name: 'sd.tar.gz', sha256: PIN }],
      })
    )
    expect(await unsized.service.catalog('sd-cpp')).toMatchObject({
      host_backend_id: 'linux-vulkan-x64',
      host_download_bytes: null,
    })
  })
})

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
      details: 'bundled',
    })
  })

  it('at start keeps the downloads no newer than the installer, which stays the active build', async () => {
    await bundle({ ...AUG, published_at: '2026-10-02T00:00:00Z' })
    await download('mlxvlm-macos-arm64-aaaaaaa', '2026-09-10T00:00:00Z')
    await download('mlxvlm-macos-arm64-bbbbbbb', '2026-10-02T00:00:00Z')
    const h = harness({ facts: MAC_ARM, resourcesDir: resources() })
    await h.service.startupCleanup()
    expect(await ls(data.layout.provider('mlx').backendsDir)).toEqual([
      'mlxvlm-macos-arm64-aaaaaaa',
      'mlxvlm-macos-arm64-bbbbbbb',
    ])
    expect(h.changed).toEqual([])
    expect(await h.service.resolveMlxBinary()).toBe(join(resources(), 'mlx-server'))
  })

  it('does not install a build as recent as the installer one: the installer would still run', async () => {
    await bundle(AUG)
    const h = harness({ facts: MAC_ARM, resourcesDir: resources() })
    const tag = 'mlxvlm-macos-arm64-abcdef0'
    h.setMlx(
      mlxManifest(
        tag,
        AUG.published_at,
        serve(tag, { 'macos-arm64': { name: 'mlx.tar.gz', body: await archive('m', MLX_OK) } })
      )
    )
    expect(await h.service.install('mlx', { task_id: 't', force: true })).toMatchObject({
      installed: false,
      reason: 'already-installed',
      build: { origin: 'bundled' },
    })
    expect(archiveRequests()).toEqual([])
    expect(h.hosts.mlx.calls).toEqual([])
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
  it('clears the leftovers of an interrupted install without reporting a change', async () => {
    const leftover = join(
      data.layout.diffusion.backendsDir,
      'master-900-aaaaaaa',
      'linux-vulkan-x64.incoming-7'
    )
    await mkdir(leftover, { recursive: true })
    const h = harness()
    await h.service.startupCleanup()
    expect(await ls(join(data.layout.diffusion.backendsDir, 'master-900-aaaaaaa'))).toEqual([])
    expect(h.changed).toEqual([])
  })

  it('removes the leftovers of an interrupted install and never a build', async () => {
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
    expect(await ls(root)).toEqual(['master-883-137f740', 'master-900-aaaaaaa'])
    expect((await ls(join(root, 'master-900-aaaaaaa'))).sort()).toEqual(['foreign', 'linux-vulkan-x64'])
    expect(h.changed).toEqual([])
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

  it('says every install and removal on engine:changed too, with the same reason; the start removes no build to say', async () => {
    const h = harness()
    const first = await installed(h, 'master-883-aaaaaaa')
    h.hosts['sd-cpp'].used = [first]
    const second = await installed(h, 'master-900-bbbbbbb')
    h.hosts['sd-cpp'].used = []
    await h.service.startupCleanup()
    await h.service.remove('sd-cpp', 'master-900-bbbbbbb', 'linux-vulkan-x64')
    expect(second).toContain('master-900-bbbbbbb')
    expect(h.engineChanged).toEqual(h.changed)
    expect(h.engineChanged.map((event) => event.reason)).toEqual(['install', 'install', 'uninstall'])
  })

  it('refuses the active build when the caller asks, with the reason in details', async () => {
    const h = harness()
    await installed(h, 'master-900-aaaaaaa')
    await expect(
      h.service.remove('sd-cpp', 'master-900-aaaaaaa', 'linux-vulkan-x64', { refuseActive: true })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', details: 'active' })
    expect(await ls(join(data.layout.diffusion.backendsDir, 'master-900-aaaaaaa'))).toEqual([
      'linux-vulkan-x64',
    ])
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

describe.skipIf(!POSIX)('Foundry Local builds (task 4.5)', () => {
  it('installs the host archive: debug symbols gone, the Linux soname added, probed in staging, then activated', async () => {
    const probed: string[] = []
    const h = harness({
      foundryProbe: async (dir) => {
        probed.push(dir)
        // The probe runs against the fixed tree, before it takes the target's place.
        expect(await readlink(join(dir, 'lib', 'libonnxruntime.so.1'))).toBe('libonnxruntime.so')
      },
    })
    h.setFoundry(
      foundryManifest([
        {
          tag: 'v2.1.0',
          published_at: '2026-09-30T00:43:42Z',
          assets: serve('v2.1.0', {
            'linux-x64': {
              name: 'foundry-local-linux-x64.tgz',
              body: await foundryArchive('fl', FOUNDRY_LINUX),
            },
          }),
        },
      ])
    )

    const result = await h.service.install('foundry-local', { task_id: 'foundry-local-engine' })

    const dir = join(FOUNDRY_ROOT(), 'v2.1.0', 'linux-x64')
    expect(result).toMatchObject({ installed: true, build: { tag: 'v2.1.0', backend_id: 'linux-x64' } })
    expect(probed).toEqual([expect.stringMatching(/linux-x64\.incoming-\d+$/)])
    expect((await ls(join(dir, 'lib'))).sort()).toEqual([
      'libfoundry_local.so',
      'libonnxruntime-genai.so',
      'libonnxruntime.so',
      'libonnxruntime.so.1',
    ])
    expect((await lstat(join(dir, 'lib', 'libonnxruntime.so.1'))).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'install.json'), 'utf8'))).toMatchObject({
      tag: 'v2.1.0',
      backendId: 'linux-x64',
      publishedAt: '2026-09-30T00:43:42Z',
      cApiVersion: 2,
    })
    expect(h.hosts['foundry-local'].calls).toEqual([`activate ${dir} false`])
    const catalog = await h.service.catalog('foundry-local')
    expect(catalog.manifest).toMatchObject({ tag: 'v2.1.0', published_at: '2026-09-30T00:43:42Z' })
    expect(catalog.active).toMatchObject({ tag: 'v2.1.0', backend_id: 'linux-x64', removable: true })
  })

  it('adds no soname off Linux and keeps one the archive already has', async () => {
    const mac = harness({
      platform: 'darwin',
      foundryLocalHost: { platform: 'macos-arm64' },
      foundryProbe: async () => {},
    })
    mac.setFoundry(
      foundryManifest([
        {
          tag: 'v2.1.0',
          published_at: '2026-09-30T00:43:42Z',
          assets: serve('v2.1.0', {
            'macos-arm64': {
              name: 'foundry-local-osx-arm64.tgz',
              body: await foundryArchive('mac', FOUNDRY_LINUX),
            },
          }),
        },
      ])
    )
    await mac.service.install('foundry-local', { task_id: 't-mac' })
    expect(await ls(join(FOUNDRY_ROOT(), 'v2.1.0', 'macos-arm64', 'lib'))).not.toContain(
      'libonnxruntime.so.1'
    )

    const linux = harness({ foundryProbe: async () => {} })
    linux.setFoundry(
      foundryManifest([
        {
          tag: 'v2.2.0',
          published_at: '2026-10-30T00:00:00Z',
          assets: serve('v2.2.0', {
            'linux-x64': {
              name: 'foundry-local-linux-x64.tgz',
              body: await foundryArchive('own-soname', {
                ...FOUNDRY_LINUX,
                'lib/libonnxruntime.so.1': 'real ort',
              }),
            },
          }),
        },
      ])
    )
    await linux.service.install('foundry-local', { task_id: 't-linux' })
    expect(
      await readFile(join(FOUNDRY_ROOT(), 'v2.2.0', 'linux-x64', 'lib', 'libonnxruntime.so.1'), 'utf8')
    ).toBe('real ort')
  })

  it('leaves nothing behind for a tampered archive or a failed probe', async () => {
    const tampered = harness({ foundryProbe: async () => {} })
    tampered.setFoundry(
      foundryManifest([
        {
          tag: 'v2.1.0',
          published_at: '2026-09-30T00:43:42Z',
          assets: serve('v2.1.0', {
            'linux-x64': {
              name: 'foundry-local-linux-x64.tgz',
              body: await foundryArchive('t', FOUNDRY_LINUX),
              sha256: 'e'.repeat(64),
            },
          }),
        },
      ])
    )
    await expect(tampered.service.install('foundry-local', { task_id: 't1' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
    })
    expect(await ls(join(FOUNDRY_ROOT(), 'v2.1.0'))).toEqual([])

    const broken = harness({
      foundryProbe: async () => {
        throw new AtomicCoreError(
          'ENGINE_INSTALL_FAILED',
          'The Foundry Local library does not load on this computer.',
          'libatomic.so.1: cannot open shared object file'
        )
      },
    })
    broken.setFoundry(
      foundryManifest([
        {
          tag: 'v2.1.0',
          published_at: '2026-09-30T00:43:42Z',
          assets: serve('v2.1.0', {
            'linux-x64': {
              name: 'foundry-local-linux-x64.tgz',
              body: await foundryArchive('b', FOUNDRY_LINUX),
            },
          }),
        },
      ])
    )
    await expect(broken.service.install('foundry-local', { task_id: 't2' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: expect.stringContaining('libatomic.so.1'),
    })
    expect(await ls(join(FOUNDRY_ROOT(), 'v2.1.0'))).toEqual([])
    expect((await broken.service.catalog('foundry-local')).installed).toEqual([])
  })

  it('makes the newest build by release date active, skipping one this core does not speak', async () => {
    const h = harness({ foundryProbe: async () => {} })
    for (const [tag, published, cApi] of [
      ['v2.0.0', '2026-08-01T00:00:00Z', 2],
      ['v2.1.0', '2026-09-30T00:43:42Z', 2],
    ] as const) {
      h.setFoundry(
        foundryManifest([
          {
            tag,
            published_at: published,
            c_api_version: cApi,
            assets: serve(tag, {
              'linux-x64': {
                name: 'foundry-local-linux-x64.tgz',
                body: await foundryArchive(tag, FOUNDRY_LINUX),
              },
            }),
          },
        ])
      )
      await h.service.install('foundry-local', { task_id: `t-${tag}` })
    }
    expect((await h.service.catalog('foundry-local')).active).toMatchObject({ tag: 'v2.1.0' })
    // What the Foundry Local runtime and accelerators start their host from (task 6.4).
    expect(await h.service.activeDir('foundry-local')).toBe(join(FOUNDRY_ROOT(), 'v2.1.0', 'linux-x64'))
    expect(await harness().service.activeDir('mlx')).toBeUndefined()

    // A newer build whose record names a C API this core no longer binds is never the active one.
    const newer = join(FOUNDRY_ROOT(), 'v3.0.0', 'linux-x64')
    await mkdir(newer, { recursive: true })
    await writeFile(join(newer, '.atomic-owned'), 'atomic-chat\n')
    await mkdir(join(newer, 'lib'), { recursive: true })
    await writeFile(join(newer, 'lib', 'libfoundry_local.so'), 'so')
    await writeFile(
      join(newer, 'install.json'),
      JSON.stringify({
        tag: 'v3.0.0',
        backendId: 'linux-x64',
        sha256: null,
        installedAtMs: 5,
        publishedAt: '2026-12-01T00:00:00Z',
        cApiVersion: 99,
      })
    )
    const catalog = await h.service.catalog('foundry-local')
    expect(catalog.installed.map((build) => build.tag).sort()).toEqual(['v2.0.0', 'v2.1.0', 'v3.0.0'])
    expect(catalog.active).toMatchObject({ tag: 'v2.1.0' })
  })

  it('offers nothing on a host without a Foundry Local archive, saying why', async () => {
    const h = harness({
      foundryLocalHost: { platform: null, reason: 'Foundry Local needs macOS 15 or newer.' },
    })
    h.setFoundry(
      foundryManifest([
        {
          tag: 'v2.1.0',
          published_at: '2026-09-30T00:43:42Z',
          assets: serve('v2.1.0', {
            'linux-x64': {
              name: 'foundry-local-linux-x64.tgz',
              body: await foundryArchive('n', FOUNDRY_LINUX),
            },
          }),
        },
      ])
    )
    expect(await h.service.catalog('foundry-local')).toMatchObject({
      host_backend_id: null,
      host_reason: 'Foundry Local needs macOS 15 or newer.',
    })
    await expect(h.service.install('foundry-local', { task_id: 't' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_BACKEND',
    })
  })
})

const LITERT_WHEEL = 'litert_lm_api-0.18.1-py3-none-manylinux_2_27_x86_64.whl'
const litertWheel = (): Buffer =>
  makeZip([
    { name: 'litert_lm/__init__.py', data: Buffer.from('py') },
    { name: 'litert_lm/liblitert-lm.so', data: Buffer.from('so'), mode: 0o777 },
    { name: 'litert_lm_api-0.18.1.dist-info/RECORD', data: Buffer.from('record') },
  ])

/** Serve one wheel per release under `/releases/<version>/` and describe the releases as conf does. */
function litertManifest(
  releases: Array<{ version: string; published_at: string; body: Buffer; sha256?: string }>
): LiteRtLmManifest {
  return parseLiteRtLmManifest(
    {
      schema_version: 1,
      releases: releases.map((release) => {
        server.files.set(`/releases/${release.version}/${LITERT_WHEEL}`, { body: release.body })
        return {
          version: release.version,
          published_at: release.published_at,
          min_core_version: '0.1.0',
          abi: 1,
          assets: [
            {
              platform: 'linux-x64',
              url: `https://files.pythonhosted.org/packages/${release.version}/${LITERT_WHEEL}`,
              name: LITERT_WHEEL,
              size: release.body.length,
              sha256: release.sha256 ?? sha(release.body),
            },
          ],
        }
      }),
    },
    { coreVersion: '9.9.9', abis: [1] }
  )
}

describe('LiteRT-LM builds (task 4.4)', () => {
  it('installs the host wheel: native files under lib/, probed in staging, recorded with its ABI, activated', async () => {
    const probed: string[] = []
    const h = harness({ liteRtLmProbe: async (dir) => void probed.push(dir) })
    h.setLiteRtLm(
      litertManifest([{ version: '0.18.1', published_at: '2026-10-19T22:44:33Z', body: litertWheel() }])
    )

    const result = await h.service.install('litert-lm', { task_id: 'litert-lm-engine' })

    const dir = join(LITERT_ROOT(), '0.18.1', 'linux-x64')
    expect(result).toMatchObject({ installed: true, build: { tag: '0.18.1', backend_id: 'linux-x64' } })
    expect(probed).toEqual([expect.stringMatching(/linux-x64\.incoming-\d+$/)])
    expect((await ls(dir)).sort()).toEqual([OWNER_MARKER, 'install.json', 'lib'].sort())
    expect(await ls(join(dir, 'lib'))).toEqual(['liblitert-lm.so'])
    expect(JSON.parse(await readFile(join(dir, 'install.json'), 'utf8'))).toMatchObject({
      tag: '0.18.1',
      backendId: 'linux-x64',
      publishedAt: '2026-10-19T22:44:33Z',
      abi: 1,
    })
    expect(h.hosts['litert-lm'].calls).toEqual([`activate ${dir} false`])
    const catalog = await h.service.catalog('litert-lm')
    expect(catalog.manifest).toMatchObject({ tag: '0.18.1', published_at: '2026-10-19T22:44:33Z' })
    expect(catalog.active).toMatchObject({ tag: '0.18.1', backend_id: 'linux-x64', removable: true })
  })

  it('refuses a wheel whose sha256 differs from conf and leaves nothing behind, unprobed', async () => {
    const probed: string[] = []
    const h = harness({ liteRtLmProbe: async (dir) => void probed.push(dir) })
    h.setLiteRtLm(
      litertManifest([
        {
          version: '0.18.1',
          published_at: '2026-10-19T22:44:33Z',
          body: litertWheel(),
          sha256: 'a'.repeat(64),
        },
      ])
    )
    await expect(h.service.install('litert-lm', { task_id: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
    })
    expect(probed).toEqual([])
    expect(await ls(join(LITERT_ROOT(), '0.18.1'))).toEqual([])
  })

  it('deletes the staging tree when the probe fails, the error carrying what the host printed', async () => {
    const h = harness({
      liteRtLmProbe: async () => {
        throw new AtomicCoreError(
          'ENGINE_INSTALL_FAILED',
          'litert-host probe failed.',
          'dlopen: no such file'
        )
      },
    })
    h.setLiteRtLm(
      litertManifest([{ version: '0.18.1', published_at: '2026-10-19T22:44:33Z', body: litertWheel() }])
    )
    await expect(h.service.install('litert-lm', { task_id: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: 'dlopen: no such file',
    })
    expect(await ls(join(LITERT_ROOT(), '0.18.1'))).toEqual([])
    expect(h.hosts['litert-lm'].calls).toEqual([])
  })

  it('activates the newest build by published_at among those whose ABI this core binds', async () => {
    const h = harness()
    const make = async (version: string, publishedAt: string, abi: number) => {
      const dir = join(LITERT_ROOT(), version, 'linux-x64')
      await mkdir(join(dir, 'lib'), { recursive: true })
      await writeFile(join(dir, 'lib', 'liblitert-lm.so'), 'so')
      await writeLiteRtLmInstallRecord(dir, {
        tag: version,
        backendId: 'linux-x64',
        sha256: null,
        installedAtMs: 1,
        publishedAt,
        abi,
      })
    }
    await make('0.17.0', '2026-08-01T00:00:00Z', 1)
    await make('0.18.1', '2026-10-19T22:44:33Z', 1)
    await make('0.19.0', '2026-12-01T00:00:00Z', 2)
    const catalog = await h.service.catalog('litert-lm')
    expect(catalog.installed.map((build) => build.tag).sort()).toEqual(['0.17.0', '0.18.1', '0.19.0'])
    expect(catalog.active).toMatchObject({ tag: '0.18.1' })
  })

  it('offers nothing on a host without a LiteRT-LM wheel, saying why', async () => {
    const h = harness({ liteRtLmHost: { platform: null, reason: 'LiteRT-LM runs on Windows x64 only.' } })
    h.setLiteRtLm(
      litertManifest([{ version: '0.18.1', published_at: '2026-10-19T22:44:33Z', body: litertWheel() }])
    )
    const catalog = await h.service.catalog('litert-lm')
    expect(catalog).toMatchObject({
      host_backend_id: null,
      host_reason: 'LiteRT-LM runs on Windows x64 only.',
    })
  })
})

// ---------------------------------------------------------------------------------------------
// GenieX (change add-geniex-runtime, task 4.4)
// ---------------------------------------------------------------------------------------------

const GENIEX_ZIP = (version: string) => `geniex-sdk-windows-arm64-v${version}.zip`
const geniexSdk = (): Buffer =>
  makeZip([
    { name: 'sdk-windows-arm64/lib/geniex.dll', data: Buffer.from('core') },
    { name: 'sdk-windows-arm64/lib/llama_cpp/geniex_plugin.dll', data: Buffer.from('plugin') },
    { name: 'sdk-windows-arm64/lib/llama_cpp/libggml-htp-v73.so', data: Buffer.from('htp') },
    { name: 'sdk-windows-arm64/bin/geniex-bench.exe', data: Buffer.from('bench') },
    { name: 'sdk-windows-arm64/include/geniex.h', data: Buffer.from('h') },
  ])

/** Serve one zip per release under `/releases/<version>/` and describe the releases as conf does. */
function geniexManifest(
  releases: Array<{ version: string; published_at: string; body: Buffer; sha256?: string; abi?: number }>
): GeniexManifest {
  return parseGeniexManifest(
    {
      schema_version: 1,
      releases: releases.map((release) => {
        server.files.set(`/releases/${release.version}/${GENIEX_ZIP(release.version)}`, {
          body: release.body,
        })
        return {
          version: release.version,
          published_at: release.published_at,
          min_core_version: '0.1.0',
          abi: release.abi ?? 1,
          assets: [
            {
              platform: 'win-arm64',
              url: `https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex/${release.version}/${GENIEX_ZIP(release.version)}`,
              name: GENIEX_ZIP(release.version),
              size: release.body.length,
              sha256: release.sha256 ?? sha(release.body),
            },
          ],
        }
      }),
    },
    { coreVersion: '9.9.9', abis: [1] }
  )
}

describe('GenieX builds (task 4.4)', () => {
  it('installs the SDK: lib/** under the build, probed in staging, recorded with its ABI and the devices the probe found, activated', async () => {
    const probed: string[] = []
    const h = harness({
      geniexProbe: async (dir) => {
        probed.push(dir)
        return { libraryVersion: '0.9.3', devices: ['HTP0', 'GPUOpenCL', 'CPU'] }
      },
    })
    h.setGeniex(
      geniexManifest([{ version: '0.9.3', published_at: '2026-10-19T23:09:06Z', body: geniexSdk() }])
    )

    const result = await h.service.install('geniex', { task_id: 'geniex-engine' })

    const dir = join(GENIEX_ROOT(), '0.9.3', 'win-arm64')
    expect(result).toMatchObject({ installed: true, build: { tag: '0.9.3', backend_id: 'win-arm64' } })
    expect(probed).toEqual([expect.stringMatching(/win-arm64\.incoming-\d+$/)])
    expect((await ls(dir)).sort()).toEqual([OWNER_MARKER, 'install.json', 'lib'].sort())
    expect((await ls(join(dir, 'lib'))).sort()).toEqual(['geniex.dll', 'llama_cpp'])
    expect(JSON.parse(await readFile(join(dir, 'install.json'), 'utf8'))).toMatchObject({
      tag: '0.9.3',
      backendId: 'win-arm64',
      publishedAt: '2026-10-19T23:09:06Z',
      abi: 1,
      libraryVersion: '0.9.3',
      devices: ['HTP0', 'GPUOpenCL', 'CPU'],
    })
    expect(h.hosts.geniex.calls).toEqual([`activate ${dir} false`])
    const catalog = await h.service.catalog('geniex')
    expect(catalog.manifest).toMatchObject({ tag: '0.9.3', published_at: '2026-10-19T23:09:06Z' })
    expect(catalog.active).toMatchObject({ tag: '0.9.3', backend_id: 'win-arm64', removable: true })
  })

  it('refuses a zip whose sha256 differs from conf and leaves nothing behind, unprobed', async () => {
    const probed: string[] = []
    const h = harness({ geniexProbe: async (dir) => void probed.push(dir) })
    h.setGeniex(
      geniexManifest([
        { version: '0.9.3', published_at: '2026-10-19T23:09:06Z', body: geniexSdk(), sha256: 'a'.repeat(64) },
      ])
    )
    await expect(h.service.install('geniex', { task_id: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
    })
    expect(probed).toEqual([])
    expect(await ls(join(GENIEX_ROOT(), '0.9.3'))).toEqual([])
  })

  it('deletes the staging tree when the probe fails, the error carrying what the host printed', async () => {
    const h = harness({
      geniexProbe: async () => {
        throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'geniex-host probe failed.', 'LoadLibraryW: 126')
      },
    })
    h.setGeniex(
      geniexManifest([{ version: '0.9.3', published_at: '2026-10-19T23:09:06Z', body: geniexSdk() }])
    )
    await expect(h.service.install('geniex', { task_id: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: 'LoadLibraryW: 126',
    })
    expect(await ls(join(GENIEX_ROOT(), '0.9.3'))).toEqual([])
    expect(h.hosts.geniex.calls).toEqual([])
  })

  it('refuses to install without a host of its own to probe with', async () => {
    const h = harness()
    h.setGeniex(
      geniexManifest([{ version: '0.9.3', published_at: '2026-10-19T23:09:06Z', body: geniexSdk() }])
    )
    await expect(h.service.install('geniex', { task_id: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      message: expect.stringMatching(/no GenieX host/),
    })
    expect(await ls(join(GENIEX_ROOT(), '0.9.3'))).toEqual([])
  })

  it('activates the newest build by published_at among those whose ABI this core binds', async () => {
    const h = harness()
    const make = async (version: string, publishedAt: string, abi: number) => {
      const dir = join(GENIEX_ROOT(), version, 'win-arm64')
      await mkdir(join(dir, 'lib'), { recursive: true })
      await writeFile(join(dir, 'lib', 'geniex.dll'), 'dll')
      await writeGeniexInstallRecord(dir, {
        tag: version,
        backendId: 'win-arm64',
        sha256: null,
        installedAtMs: 1,
        publishedAt,
        abi,
        libraryVersion: version,
        devices: ['CPU'],
      })
    }
    await make('0.9.2', '2026-09-01T00:00:00Z', 1)
    await make('0.9.3', '2026-10-19T23:09:06Z', 1)
    await make('0.10.0', '2026-12-01T00:00:00Z', 2)
    const catalog = await h.service.catalog('geniex')
    expect(catalog.installed.map((build) => build.tag).sort()).toEqual(['0.10.0', '0.9.2', '0.9.3'])
    expect(catalog.active).toMatchObject({ tag: '0.9.3' })
    expect(await h.service.activeDir('geniex')).toBe(join(GENIEX_ROOT(), '0.9.3', 'win-arm64'))
  })

  it('offers nothing on a host without a Snapdragon X, saying why', async () => {
    const h = harness({
      geniexHost: { platform: null, reason: 'GenieX runs on Windows arm64 only, not darwin arm64.' },
    })
    h.setGeniex(
      geniexManifest([{ version: '0.9.3', published_at: '2026-10-19T23:09:06Z', body: geniexSdk() }])
    )
    expect(await h.service.catalog('geniex')).toMatchObject({
      host_backend_id: null,
      host_reason: 'GenieX runs on Windows arm64 only, not darwin arm64.',
    })
    expect(parseEngineBuildId('geniex')).toBe('geniex')
  })
})
