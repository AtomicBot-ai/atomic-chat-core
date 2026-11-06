import { isDateTime } from './manifest.js'

export interface FastFlowLmBlob {
  url: string
  size: number
  sha256: string
}
export type FastFlowLmPlatform = 'win-x64-npu' | 'linux-x64-npu'
export interface FastFlowLmRelease {
  version: string
  upstream_commit: string
  atomic_revision: number
  local_only_protocol: number
  min_core_version: string
  published_at: string
  assets: Array<FastFlowLmBlob & { platform: FastFlowLmPlatform }>
  provenance: {
    core_commit: string
    patch_sha256: string
    dependencies_sha256: string
    document: FastFlowLmBlob
  }
}
export interface FastFlowLmManifest {
  schema_version: 1
  releases: FastFlowLmRelease[]
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const digest = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const commit = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

function check(valid: unknown, field: string): asserts valid {
  if (!valid) throw new Error('Invalid FastFlowLM manifest: ' + field)
}

export function fastFlowLmBuildKey(tag: string): number[] | null {
  const parts = /^flm-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-r([1-9]\d*)$/.exec(tag)?.slice(1).map(Number)
  return parts?.every(Number.isSafeInteger) ? parts : null
}

function checkBlob(blob: unknown, version: string, extension: string) {
  check(record(blob) && positive(blob.size) && digest(blob.sha256), 'archive size or SHA-256')
  const base = 'https://github.com/AtomicBot-ai/atomic-chat-core/releases/download/' + version + '/'
  check(typeof blob.url === 'string' && blob.url.startsWith(base), 'immutable release URL')
  const name = blob.url.slice(base.length)
  check(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name.endsWith(extension), 'release filename')
}

export function parseFastFlowLmManifest(data: unknown): FastFlowLmManifest {
  check(
    record(data) && data.schema_version === 1 && Array.isArray(data.releases),
    'schema version or releases'
  )
  let previous: number[] | null = null
  for (const release of data.releases) {
    check(record(release) && typeof release.version === 'string', 'release')
    const key = fastFlowLmBuildKey(release.version)
    check(key && key[3] === release.atomic_revision && commit(release.upstream_commit), 'build identity')
    if (previous) {
      const index = key.findIndex((n, i) => n !== previous![i])
      check(index >= 0 && previous[index]! > key[index]!, 'duplicate or unordered release')
    }
    previous = key
    check(positive(release.local_only_protocol), 'local_only_protocol')
    check(
      typeof release.min_core_version === 'string' &&
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.min_core_version) &&
        release.min_core_version.split('.').every((part) => Number(part) <= 0xffffffff) &&
        isDateTime(release.published_at),
      'core version or date'
    )
    const p = release.provenance
    check(
      record(p) && commit(p.core_commit) && digest(p.patch_sha256) && digest(p.dependencies_sha256),
      'provenance'
    )
    checkBlob(p.document, release.version, '')
    check(Array.isArray(release.assets) && release.assets.length === 2, 'Windows and Linux assets')
    const platforms = new Set<string>()
    for (const asset of release.assets) {
      check(
        record(asset) &&
          (asset.platform === 'win-x64-npu' || asset.platform === 'linux-x64-npu') &&
          !platforms.has(asset.platform),
        'duplicate or unknown platform'
      )
      platforms.add(asset.platform)
      checkBlob(asset, release.version, asset.platform === 'win-x64-npu' ? '.zip' : '.tar.gz')
    }
  }
  return { schema_version: 1, releases: data.releases as FastFlowLmRelease[] }
}
