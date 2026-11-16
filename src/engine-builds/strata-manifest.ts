import { isDeepStrictEqual } from 'node:util'
import type { StrataFamily } from '../contracts/index.js'

export type StrataPlatform = 'windows-x64' | 'linux-x64' | 'macos-arm64' | 'linux-arm64-spark'
export type StrataComputeBackend = 'cuda12' | 'cuda13' | 'hip' | 'metal' | 'sycl'
export interface StrataHostRequirement {
  os: 'windows' | 'linux' | 'macos'
  arch: 'x64' | 'arm64'
  minimum_os_version: string
  cpu_features: string[]
  gpu_vendor: 'nvidia' | 'amd' | 'intel' | 'apple'
  gpu_architectures: string[]
  minimum_driver?: string
  device_family?: string
  distribution?: string
  minimum_glibc?: string
  excluded_device_families?: string[]
}
export interface StrataBlob {
  url: string
  sha256: string
  size: number
  unpacked_bytes: number
  archive: 'tar.gz' | 'zip'
}
export interface StrataComponent extends StrataBlob {
  id: string
  kind: 'control' | 'qwen' | 'deepseek'
  version: string
  platform: StrataPlatform
  backend?: StrataComputeBackend
  executable_paths: string[]
  source_revision: string
  notices: Array<{ name: string; license: string; url: string; sha256: string }>
  python_version?: string
  python_modules?: string[]
  structured_output?: boolean
}
export interface StrataVariant {
  id: string
  platform: StrataPlatform
  backend: StrataComputeBackend
  host: StrataHostRequirement
  components: string[]
  families: StrataFamily[]
  qualification: { status: 'upstream-supported' | 'atomic-qualified'; urls: string[] }
  family_gpu_architectures?: { deepseek41: string[] }
  bundle: StrataBlob & {
    bundle_manifest_sha256: string
    python: string
    component_roots: { control: 'control'; qwen: 'components/qwen'; deepseek?: 'components/deepseek' }
  }
}
export interface StrataRelease {
  release_id: string
  engine_version: string
  minimum_core_version: string
  adapter_contract_version: 1
  preparation_abi: 'strata-v1'
  control_versions: string[]
  components: StrataComponent[]
  variants: StrataVariant[]
}
export interface StrataManifest {
  schema_version: 1
  releases: StrataRelease[]
}
const matrix = {
  'windows-x64': { os: 'windows', arch: 'x64', backends: ['cuda12', 'cuda13', 'hip'] },
  'linux-x64': { os: 'linux', arch: 'x64', backends: ['cuda12', 'cuda13', 'hip', 'sycl'] },
  'macos-arm64': { os: 'macos', arch: 'arm64', backends: ['metal'] },
  'linux-arm64-spark': { os: 'linux', arch: 'arm64', backends: ['cuda13'] },
} as const
const vendors = { cuda12: 'nvidia', cuda13: 'nvidia', hip: 'amd', metal: 'apple', sycl: 'intel' }
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const version = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(v) &&
  v.split('.').every((n) => Number(n) <= 0xffffffff)
const id = (v: unknown) => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(v)
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0
const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
function check(v: unknown, field: string): asserts v {
  if (!v) throw new Error('Invalid Strata manifest: ' + field)
}
function object(
  v: unknown,
  required: string[],
  optional: string[] = []
): asserts v is Record<string, unknown> {
  check(
    record(v) &&
      required.every((k) => Object.hasOwn(v, k)) &&
      Object.keys(v).every((k) => required.includes(k) || optional.includes(k)),
    'object fields'
  )
}
function strings(v: unknown, empty = false): asserts v is string[] {
  check(
    Array.isArray(v) && (empty || v.length > 0) && v.every(text) && new Set(v).size === v.length,
    'string list'
  )
}
function https(v: unknown) {
  if (typeof v !== 'string' || !/^https:\/\/[^\s?#]+$/.test(v)) return false
  try {
    const u = new URL(v)
    return !u.username && !u.password
  } catch {
    return false
  }
}
function safePath(v: unknown) {
  return (
    typeof v === 'string' &&
    /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(v) &&
    v
      .split('/')
      .every(
        (p) =>
          p &&
          p !== '.' &&
          p !== '..' &&
          !p.endsWith('.') &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
      )
  )
}
function blob(v: Record<string, unknown>) {
  check(
    https(v.url) &&
      digest(v.sha256) &&
      positive(v.size) &&
      positive(v.unpacked_bytes) &&
      ['tar.gz', 'zip'].includes(String(v.archive)),
    'archive identity'
  )
}
const blobKeys = ['url', 'sha256', 'size', 'unpacked_bytes', 'archive']
const compare = (a: string, b: string) => {
  const aa = a.split('.').map(Number),
    bb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const d = (aa[i] ?? 0) - (bb[i] ?? 0)
    if (d) return d
  }
  return 0
}
export function strataBuildKey(tag: string): number[] | null {
  const m = /^strata-(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?-r([1-9]\d*)$/.exec(tag)
  const key = m?.slice(1).map((n) => Number(n ?? 0))
  return key?.every(Number.isSafeInteger) ? key : null
}

/** Validate the production contract, including cross-component compatibility. Candidates are not installs. */
export function parseStrataManifest(raw: unknown, coreVersion: string): StrataManifest {
  object(raw, ['schema_version', 'releases'], ['$schema'])
  check(
    raw.schema_version === 1 && Array.isArray(raw.releases) && version(coreVersion),
    'schema/core version'
  )
  const releaseIds = new Set<string>()
  for (const r of raw.releases) {
    object(r, [
      'release_id',
      'engine_version',
      'minimum_core_version',
      'adapter_contract_version',
      'preparation_abi',
      'control_versions',
      'components',
      'variants',
    ])
    check(
      typeof r.release_id === 'string' && strataBuildKey(r.release_id) && !releaseIds.has(r.release_id),
      'duplicate/invalid release'
    )
    releaseIds.add(r.release_id)
    check(
      version(r.engine_version) &&
        r.release_id.startsWith(`strata-${r.engine_version}-r`) &&
        version(r.minimum_core_version) &&
        compare(r.minimum_core_version, coreVersion) <= 0 &&
        r.adapter_contract_version === 1 &&
        r.preparation_abi === 'strata-v1',
      'unsupported version/ABI'
    )
    strings(r.control_versions)
    check(r.control_versions.every(version), 'Control versions')
    check(
      Array.isArray(r.components) && r.components.length && Array.isArray(r.variants) && r.variants.length,
      'components/variants'
    )
    const components = new Map<string, StrataComponent>()
    for (const c of r.components) {
      object(
        c,
        ['id', 'kind', 'version', 'platform', ...blobKeys, 'executable_paths', 'source_revision', 'notices'],
        ['backend', 'python_version', 'python_modules', 'structured_output']
      )
      check(
        typeof c.id === 'string' &&
          id(c.id) &&
          !components.has(c.id) &&
          ['control', 'qwen', 'deepseek'].includes(String(c.kind)) &&
          typeof c.platform === 'string' &&
          Object.hasOwn(matrix, c.platform) &&
          version(c.version) &&
          typeof c.source_revision === 'string' &&
          /^[a-f0-9]{40}$/.test(c.source_revision),
        'component identity'
      )
      blob(c)
      strings(c.executable_paths)
      check(c.executable_paths.every(safePath), 'executable path')
      check(Array.isArray(c.notices) && c.notices.length, 'notices')
      for (const n of c.notices) {
        object(n, ['name', 'license', 'url', 'sha256'])
        check(text(n.name) && text(n.license) && https(n.url) && digest(n.sha256), 'notice')
      }
      if (c.kind === 'control') {
        check(
          r.control_versions.includes(c.version) &&
            c.backend === undefined &&
            version(c.python_version) &&
            typeof c.structured_output === 'boolean',
          'Control identity'
        )
        strings(c.python_modules)
        check(
          !c.structured_output ||
            ['jsonschema', 'referencing', 'rpds', 'attrs', 'jsonschema_specifications'].every((m) =>
              (c.python_modules as string[]).includes(m)
            ),
          'complete JSON Schema validator'
        )
      } else
        check(
          c.version === r.engine_version &&
            typeof c.backend === 'string' &&
            Object.hasOwn(vendors, c.backend) &&
            c.python_version === undefined &&
            c.python_modules === undefined &&
            c.structured_output === undefined,
          'compute identity'
        )
      components.set(c.id, c as unknown as StrataComponent)
    }
    const variants = new Set<string>(),
      used = new Set<string>()
    for (const v of r.variants) {
      object(
        v,
        ['id', 'platform', 'backend', 'host', 'components', 'families', 'qualification', 'bundle'],
        ['family_gpu_architectures']
      )
      check(
        typeof v.id === 'string' &&
          id(v.id) &&
          safePath(v.id) &&
          !variants.has(v.id) &&
          typeof v.platform === 'string' &&
          Object.hasOwn(matrix, v.platform) &&
          typeof v.backend === 'string' &&
          Object.hasOwn(vendors, v.backend),
        'variant identity'
      )
      variants.add(v.id)
      const host = v.host
      object(
        host,
        ['os', 'arch', 'minimum_os_version', 'cpu_features', 'gpu_vendor', 'gpu_architectures'],
        ['minimum_driver', 'device_family', 'distribution', 'minimum_glibc', 'excluded_device_families']
      )
      const platform = matrix[v.platform as StrataPlatform]
      check(
        host.os === platform.os &&
          host.arch === platform.arch &&
          (platform.backends as readonly string[]).includes(v.backend) &&
          host.gpu_vendor === vendors[v.backend as StrataComputeBackend] &&
          text(host.minimum_os_version),
        'OS/CPU/GPU matrix'
      )
      strings(host.cpu_features, host.arch !== 'x64')
      strings(host.gpu_architectures)
      for (const key of ['minimum_driver', 'device_family', 'distribution', 'minimum_glibc'])
        check(host[key] === undefined || text(host[key]), 'host bound')
      if (host.excluded_device_families !== undefined) strings(host.excluded_device_families)
      check(!v.backend.startsWith('cuda') || text(host.minimum_driver), 'CUDA driver floor')
      check(
        v.platform !== 'linux-arm64-spark' ||
          (host.device_family === 'dgx-spark' && isDeepStrictEqual(host.gpu_architectures, ['sm_121'])),
        'Spark identity'
      )
      check(
        v.backend !== 'metal' || Number(String(host.minimum_os_version).split('.')[0]) >= 15,
        'macOS floor'
      )
      strings(v.families)
      check(
        v.families.every((f) => ['qwen38', 'qwen36', 'deepseek41'].includes(f)),
        'family'
      )
      check(
        !v.families.includes('qwen36') ||
          (!['metal', 'sycl'].includes(v.backend) && v.platform !== 'linux-arm64-spark'),
        'Qwen3.6 backend'
      )
      check(!v.families.includes('deepseek41') || !['sycl', 'cuda12'].includes(v.backend), 'DeepSeek backend')
      if (v.family_gpu_architectures !== undefined) {
        object(v.family_gpu_architectures, ['deepseek41'])
        strings(v.family_gpu_architectures.deepseek41)
        check(
          v.family_gpu_architectures.deepseek41.every((a) =>
            (host.gpu_architectures as string[]).includes(a)
          ),
          'family GPU architectures'
        )
      }
      if (v.families.includes('deepseek41') && v.backend === 'cuda13' && host.arch === 'x64') {
        const arches = record(v.family_gpu_architectures)
          ? (v.family_gpu_architectures.deepseek41 as string[])
          : host.gpu_architectures
        check(
          arches.every((a) => ['sm_86', 'sm_89', 'sm_120'].includes(a)),
          'DeepSeek CUDA architectures'
        )
      }
      if (v.families.includes('deepseek41') && v.backend === 'hip') {
        const expected =
          host.os === 'windows' ? ['strix-halo', 'gfx1151'] : ['radeon-ai-pro-r9700', 'gfx1201']
        check(
          host.device_family === expected[0] && isDeepStrictEqual(host.gpu_architectures, [expected[1]]),
          'DeepSeek HIP family'
        )
      }
      strings(v.components)
      const selected = v.components.map((id) => {
        const c = components.get(id)
        check(
          c && c.platform === v.platform && (c.kind === 'control' || c.backend === v.backend),
          'incompatible component'
        )
        used.add(id)
        return c
      })
      const roles = selected.map((c) => c.kind)
      check(
        new Set(roles).size === roles.length &&
          roles.includes('control') &&
          (!v.families.some((f) => f.startsWith('qwen')) || roles.includes('qwen')) &&
          (!v.families.includes('deepseek41') || roles.includes('deepseek')),
        'missing/duplicate role'
      )
      object(v.qualification, ['status', 'urls'])
      strings(v.qualification.urls)
      check(
        ['upstream-supported', 'atomic-qualified'].includes(String(v.qualification.status)) &&
          v.qualification.urls.every(https),
        'evidence'
      )
      const b = v.bundle
      object(b, [...blobKeys, 'bundle_manifest_sha256', 'python', 'component_roots'])
      blob(b)
      check(
        digest(b.bundle_manifest_sha256) &&
          b.python ===
            (v.platform === 'windows-x64' ? 'control/python/python.exe' : 'control/python/bin/python3'),
        'bundled Python'
      )
      object(b.component_roots, roles)
      for (const role of roles)
        check(
          b.component_roots[role] === (role === 'control' ? role : 'components/' + role),
          'component root'
        )
    }
    check(used.size === components.size, 'unused component')
  }
  const result = structuredClone(raw) as unknown as StrataManifest
  result.releases.sort((a, b) => {
    const aa = strataBuildKey(a.release_id)!,
      bb = strataBuildKey(b.release_id)!
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return bb[i]! - aa[i]!
    return 0
  })
  return result
}

export function checkStrataImmutability(previous: StrataManifest, next: StrataManifest): void {
  for (const r of next.releases) {
    const old = previous.releases.find((p) => p.release_id === r.release_id)
    if (old && !isDeepStrictEqual(old, r))
      throw new Error('Immutable Strata release changed: ' + r.release_id)
  }
}
