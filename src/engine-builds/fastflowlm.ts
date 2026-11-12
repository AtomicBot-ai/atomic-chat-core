import { execFile } from 'node:child_process'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { compareVersions } from '../backend/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import { canonicalizeExistingPrefix } from '../downloads/index.js'
import { INSTALL_RECORD, OWNER_MARKER } from '../diffusion/index.js'
import { CORE_VERSION } from '../version.js'
import type { Build, EngineDescriptor, EngineHostPlatform } from './engines.js'
import { fastFlowLmBuildKey, type FastFlowLmManifest, type FastFlowLmRelease } from './fastflowlm-manifest.js'
import { compareBuilds } from './order.js'

export type FastFlowLmIdentity = Pick<
  FastFlowLmRelease,
  'upstream_commit' | 'atomic_revision' | 'local_only_protocol'
>
const run = promisify(execFile)

export function fastFlowLmHostPlatform(host: {
  platform: NodeJS.Platform
  arch: string
  osRelease: string
}): EngineHostPlatform {
  if (host.arch === 'x64') {
    if (host.platform === 'linux') return { platform: 'linux-x64-npu' }
    if (host.platform === 'win32' && Number(host.osRelease.split('.')[2]) >= 22000)
      return { platform: 'win-x64-npu' }
  }
  return { platform: null, reason: 'FastFlowLM needs Windows 11 x64 or Linux x64.' }
}

const selected = (m: FastFlowLmManifest) =>
  m.releases.find(
    (r) => r.local_only_protocol === 1 && compareVersions(r.min_core_version, CORE_VERSION) <= 0
  )
const binaryName = (backend: string) => (backend === 'win-x64-npu' ? 'flm.exe' : 'flm')
const regular = async (path: string) => (await lstat(path).catch(() => null))?.isFile() === true

/** Engine writes cannot follow a redirected tag into a client-owned model tree. */
export async function assertFastFlowLmPath(dataFolder: string, path: string, replacing = false) {
  const root = await canonicalizeExistingPrefix(dataFolder)
  const expected = resolve(root, relative(dataFolder, path))
  if (relative(expected, await canonicalizeExistingPrefix(path)) !== '')
    throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'The FastFlowLM build path is redirected.', path)
  if (
    replacing &&
    (await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })) &&
    !(await regular(join(path, OWNER_MARKER)))
  )
    throw new AtomicCoreError(
      'ENGINE_INSTALL_FAILED',
      'Refusing to replace an unowned FastFlowLM directory.',
      path
    )
}

async function readBuilds(root: string, platform: string | null) {
  const builds: Build[] = []
  if (!platform) return builds
  for (const tag of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const key = fastFlowLmBuildKey(tag.name)
    if (!tag.isDirectory() || !key) continue
    const dir = join(root, tag.name, platform)
    if (
      !(await lstat(dir).catch(() => null))?.isDirectory() ||
      !(await regular(join(dir, OWNER_MARKER))) ||
      !(await regular(join(dir, binaryName(platform)))) ||
      !(await regular(join(dir, INSTALL_RECORD)))
    )
      continue
    try {
      const row = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8'))
      if (
        row.tag === tag.name &&
        row.backendId === platform &&
        row.atomic_revision === key[3] &&
        row.local_only_protocol === 1 &&
        typeof row.upstream_commit === 'string' &&
        /^[0-9a-f]{40}$/.test(row.upstream_commit) &&
        typeof row.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        Number.isSafeInteger(row.installedAtMs)
      )
        builds.push({
          tag: tag.name,
          backend_id: platform,
          origin: 'downloaded',
          dir,
          installed_at_ms: row.installedAtMs,
          published_at: row.publishedAt,
          immutable_sha256: row.sha256,
        })
    } catch {
      /* A damaged record cannot make a build active. */
    }
  }
  return builds
}

export const fastFlowLmDescriptor: EngineDescriptor<FastFlowLmManifest> = {
  release(manifest) {
    const r = selected(manifest)
    return r
      ? {
          tag: r.version,
          published_at: r.published_at,
          flmIdentity: {
            upstream_commit: r.upstream_commit,
            atomic_revision: r.atomic_revision,
            local_only_protocol: r.local_only_protocol,
          },
        }
      : null
  },
  async hostChoice(ctx, manifest) {
    const unavailable = (reason: string) => ({ backend_id: null, ladder: [], reason })
    if (ctx.hostPlatform.platform === null) return unavailable(ctx.hostPlatform.reason)
    if (!manifest) return unavailable('FastFlowLM manifest unavailable.')
    if (!manifest.releases.length) return unavailable('No FastFlowLM builds have been published.')
    if (!selected(manifest))
      return unavailable('No FastFlowLM build supports this core version and local_only_protocol 1.')
    return { backend_id: ctx.hostPlatform.platform, ladder: [ctx.hostPlatform.platform], reason: null }
  },
  archives(manifest, backend) {
    const asset = selected(manifest)?.assets.find((a) => a.platform === backend)
    return asset
      ? [{ url: asset.url, name: basename(asset.url), size: asset.size, sha256: asset.sha256 }]
      : []
  },
  async probe(dir, ctx, backend, release, signal) {
    const binary = resolve(dir, binaryName(backend))
    const expected = release?.flmIdentity
    try {
      if (!expected || !(await regular(binary))) throw new Error('Missing build identity or executable.')
      // The Linux launcher uses system shell utilities. The probe needs no token, model
      // configuration, inherited library search path or device access.
      const systemRoot = ctx.env?.SystemRoot ?? ctx.env?.SYSTEMROOT ?? 'C:\\Windows'
      const env =
        backend === 'win-x64-npu'
          ? { SystemRoot: systemRoot, PATH: join(systemRoot, 'System32') }
          : { PATH: '/usr/bin:/bin' }
      const { stdout } = await run(binary, ['atomic-capabilities', '--json'], {
        cwd: dir,
        env,
        signal,
        windowsHide: true,
        timeout: 15_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      })
      const cap = JSON.parse(stdout)
      if (
        cap.local_only_protocol !== 1 ||
        cap.upstream_commit !== expected.upstream_commit ||
        cap.atomic_revision !== expected.atomic_revision
      )
        throw new Error('Build identity differs from the manifest.')
    } catch (e) {
      throw new AtomicCoreError(
        'FASTFLOWLM_LOCAL_ONLY_MISMATCH',
        'FastFlowLM did not confirm the required local-only build.',
        String(e)
      )
    }
  },
  async record(dir, info) {
    await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n', { flag: 'wx' })
    await writeFile(
      join(dir, INSTALL_RECORD),
      JSON.stringify({
        tag: info.tag,
        backendId: info.backendId,
        installedAtMs: info.installedAtMs,
        publishedAt: info.publishedAt,
        sha256: info.sha256,
        ...info.flmIdentity,
      }),
      { flag: 'wx' }
    )
  },
  builds: (ctx) => readBuilds(ctx.root, ctx.hostPlatform.platform),
  active: (builds) =>
    builds.reduce<Build | undefined>(
      (best, b) => (!best || compareBuilds('fastflowlm', b, best) > 0 ? b : best),
      undefined
    ),
}
