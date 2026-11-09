import { canonicalJson, documentFields, DOCUMENT_SEMVER } from '../../environment/index.js'

export type FlmPlatform = 'linux' | 'windows'
const f = documentFields('FastFlowLM environment')
const digest = /^[a-f0-9]{64}$/
const version4 = /^\d+\.\d+\.\d+\.\d+$/
const build = /^flm-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-r[1-9]\d*$/
const token = /^[a-z0-9-]+$/

function object(value: unknown, at: string, keys: string) {
  const row = f.object(value, at)
  f.known(row, at, keys.split(' '))
  return row
}
function text(value: unknown, re: RegExp, at: string) {
  const str = f.text(value, at)
  if (!re.test(str) || str.trim() !== str) f.fail('invalid ' + at)
  return str
}
function one<const T extends string>(value: unknown, allowed: readonly T[], at: string): T {
  if (!allowed.includes(value as T)) f.fail('unsupported ' + at)
  return value as T
}
function rows<T>(value: unknown, at: string, read: (v: unknown) => T) {
  const list = f.list(value, at)
  if (!list.length) f.fail('empty ' + at)
  return list.map(read)
}
function cleanPath(path: string) {
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) f.fail('unsafe dependency path')
  return path
}
function linuxRecipe(r: Record<string, unknown>) {
  const platforms = rows(r.platforms, 'platforms', (v) => {
    const p = object(v, 'platform', 'os distribution version arch kernel_release')
    return {
      os: one(p.os, ['linux'], 'os'),
      distribution: one(p.distribution, ['ubuntu'], 'distribution'),
      version: one(p.version, ['24.04', '26.04'], 'Ubuntu version'),
      arch: one(p.arch, ['x64'], 'arch'),
      kernel_release: text(p.kernel_release, /^[0-9][0-9A-Za-z.+_-]+$/, 'kernel_release'),
    }
  })
  const sources = rows(r.sources, 'sources', (v) => {
    const s = object(v, 'source', 'id url suite component signing_fingerprint')
    const suite = text(s.suite, /^(noble|resolute)(-updates|-security)?$/, 'suite')
    if (!platforms.every((p) => suite.split('-')[0] === (p.version === '24.04' ? 'noble' : 'resolute')))
      f.fail('source suite differs from platform')
    return {
      id: text(s.id, token, 'source id'),
      url: one(
        s.url,
        [
          'https://ppa.launchpadcontent.net/lemonade-team/stable/ubuntu/',
          'https://archive.ubuntu.com/ubuntu/',
          'https://security.ubuntu.com/ubuntu/',
        ],
        'repository'
      ),
      suite,
      component: one(s.component, ['main', 'restricted', 'universe', 'multiverse'], 'component'),
      signing_fingerprint: text(s.signing_fingerprint, /^[A-F0-9]{40}$/, 'signing fingerprint'),
    }
  })
  f.unique(
    sources.map((s) => s.id),
    'sources',
    'source'
  )
  const packages = rows(r.packages, 'packages', (v) => {
    const p = object(v, 'package', 'name version architecture source path size sha256')
    const source = text(p.source, token, 'package source')
    if (!sources.some((s) => s.id === source)) f.fail('unknown package source')
    return {
      name: text(p.name, /^[a-z0-9][a-z0-9+.-]*$/, 'package name'),
      version: text(p.version, /^[0-9A-Za-z.+:~_-]+$/, 'package version'),
      architecture: one(p.architecture, ['amd64', 'all'], 'package architecture'),
      source,
      path: cleanPath(text(p.path, /^pool\/[A-Za-z0-9.+~_/-]+\.deb$/, 'package path')),
      size: f.bytes(p.size, 'package size', 1),
      sha256: text(p.sha256, digest, 'package SHA-256'),
    }
  })
  f.unique(
    packages.map((p) => p.name),
    'packages',
    'package'
  )
  const xrt = one(r.xrt, ['bundled', 'system'], 'XRT')
  if (xrt === 'system' && !packages.some((p) => p.name === 'libxrt-npu2'))
    f.fail('missing XRT plugin package')
  return {
    action: one(r.action, ['linux.install-amd-npu'], 'action'),
    platforms,
    sources,
    packages,
    xrt,
    firmware_version: text(r.firmware_version, version4, 'firmware version'),
    memlock_bytes: f.bytes(r.memlock_bytes, 'memlock_bytes', 1),
  }
}
function windowsRecipe(r: Record<string, unknown>) {
  const platforms = rows(r.platforms, 'platforms', (v) => {
    const p = object(v, 'platform', 'os version arch')
    return {
      os: one(p.os, ['windows'], 'os'),
      version: one(p.version, ['11'], 'Windows version'),
      arch: one(p.arch, ['x64'], 'arch'),
    }
  })
  const d = object(r.driver, 'driver', 'kind version url size sha256 signer catalog_sha256')
  const kind = one(d.kind, ['windows-update-cab', 'amd-installer'], 'driver kind')
  const url = text(
    d.url,
    kind === 'windows-update-cab'
      ? /^https:\/\/catalog\.s\.download\.windowsupdate\.com\/c\/msdownload\/update\/driver\/[A-Za-z0-9._~+/-]+\.cab$/
      : /^https:\/\/download\.amd\.com\/[A-Za-z0-9._~+/-]+$/,
    'driver URL'
  )
  cleanPath(url.slice(url.indexOf('/', 8) + 1))
  return {
    action: one(r.action, ['windows.install-amd-npu'], 'action'),
    platforms,
    driver: {
      kind,
      url,
      version: text(d.version, version4, 'driver version'),
      size: f.bytes(d.size, 'driver size', 1),
      sha256: text(d.sha256, digest, 'driver SHA-256'),
      signer: one(
        d.signer,
        ['Advanced Micro Devices, Inc.', 'Microsoft Windows Hardware Compatibility Publisher'],
        'signer'
      ),
      catalog_sha256: text(d.catalog_sha256, digest, 'catalog SHA-256'),
    },
  }
}
function recipe(value: unknown, os: FlmPlatform) {
  const common = 'recipe_id revision min_core_version hardware qualification platforms action'
  const r = object(
    value,
    'recipe',
    common + (os === 'linux' ? ' sources packages firmware_version xrt memlock_bytes' : ' driver')
  )
  const h = object(r.hardware, 'hardware', 'npu_generation pci_device_ids')
  const q = object(r.qualification, 'qualification', 'build_version evidence')
  const e = object(q.evidence, 'qualification evidence', 'url size sha256')
  const tag = text(q.build_version, build, 'qualified build')
  const url = f.text(e.url, 'evidence URL')
  const base = 'https://github.com/AtomicBot-ai/atomic-chat-core/releases/download/' + tag + '/'
  if (
    !url.startsWith(base) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.slice(base.length)) ||
    url.trim() !== url
  )
    f.fail('invalid qualification evidence URL')
  const fields = {
    recipe_id: text(r.recipe_id, new RegExp('^fastflowlm-' + os + '-[a-z0-9][a-z0-9.-]*$'), 'recipe id'),
    revision: f.bytes(r.revision, 'revision', 1),
    min_core_version: text(r.min_core_version, DOCUMENT_SEMVER, 'minimum core version'),
    hardware: {
      npu_generation: one(h.npu_generation, ['xdna2'], 'generation'),
      pci_device_ids: rows(h.pci_device_ids, 'PCI devices', (id) =>
        text(id, /^1022:[a-f0-9]{4}$/, 'PCI device')
      ),
    },
    qualification: {
      build_version: tag,
      evidence: {
        url,
        size: f.bytes(e.size, 'evidence size', 1),
        sha256: text(e.sha256, digest, 'evidence SHA-256'),
      },
    },
  }
  return { ...fields, ...(os === 'linux' ? linuxRecipe(r) : windowsRecipe(r)) }
}

export function parseEnvironment(value: unknown, os: FlmPlatform) {
  const d = object(value, 'manifest', '$schema schema_version engine platform manifest_id recipes')
  if (d.schema_version !== 1 || d.engine !== 'fastflowlm' || d.platform !== os)
    f.fail('unsupported schema, engine or platform')
  const recipes = f.list(d.recipes, 'recipes').map((r) => recipe(r, os))
  f.unique(
    recipes.map((r) => r.recipe_id + '@' + r.revision),
    'recipes',
    'recipe revision'
  )
  const targets = recipes.flatMap((r) =>
    r.platforms.flatMap((p) => r.hardware.pci_device_ids.map((id) => canonicalJson([p, id])))
  )
  f.unique(targets, 'recipes', 'qualified platform and device')
  return {
    ...(d.$schema === undefined ? {} : { $schema: f.text(d.$schema, '$schema') }),
    schema_version: 1,
    engine: 'fastflowlm',
    platform: os,
    manifest_id: text(d.manifest_id, new RegExp('^fastflowlm-' + os + '-r[1-9][0-9]*$'), 'manifest id'),
    recipes,
  }
}
export type FlmManifest = ReturnType<typeof parseEnvironment>
export type FlmRecipe = FlmManifest['recipes'][number]
