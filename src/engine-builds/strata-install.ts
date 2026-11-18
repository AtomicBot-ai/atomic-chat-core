import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { Build } from './engines.js'
import { parseStrataManifest, strataBuildKey } from './strata-manifest.js'
import type { StrataRelease, StrataVariant } from './strata-manifest.js'

const invalid = (reason: string): never => {
  throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'Invalid Strata bundle: ' + reason)
}
const safe = (path: unknown): path is string =>
  typeof path === 'string' &&
  /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(path) &&
  path
    .split('/')
    .every(
      (p) =>
        p &&
        p !== '.' &&
        p !== '..' &&
        !p.endsWith('.') &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
    )
async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function regular(root: string, path: string) {
  const abs = join(root, path),
    info = await lstat(abs)
  if (!info.isFile() || relative(await realpath(root), await realpath(abs)) !== path.split('/').join(sep))
    invalid('redirected or nonregular file ' + path)
  return info
}

/** Hash the manifest before interpreting it, then every payload; extra executable files are refused. */
export async function verifyStrataBundle(
  dir: string,
  release: StrataRelease,
  variant: StrataVariant,
  installed = false
): Promise<void> {
  const info = await regular(dir, 'bundle.json')
  if (info.size > 16 * 1024 * 1024) invalid('oversized inventory')
  const content = await readFile(join(dir, 'bundle.json'))
  if (createHash('sha256').update(content).digest('hex') !== variant.bundle.bundle_manifest_sha256)
    invalid('inventory hash')
  const bundle = JSON.parse(content.toString('utf8'))
  if (
    bundle.schema_version !== 1 ||
    bundle.release_id !== release.release_id ||
    bundle.variant !== variant.id ||
    bundle.platform !== variant.platform ||
    bundle.preparation_abi !== release.preparation_abi ||
    bundle.adapter_contract_version !== release.adapter_contract_version ||
    bundle.python !== variant.bundle.python ||
    !Array.isArray(bundle.files)
  )
    invalid('inventory identity')
  const links = new Map<string, string>()
  const paths = new Set<string>(),
    folded = new Set<string>()
  let bytes = 0
  for (const file of bundle.files) {
    if (
      !file ||
      !safe(file.path) ||
      ['bundle.json', 'install.json', '.atomic-owned'].includes(file.path) ||
      folded.has(file.path.toLowerCase())
    )
      invalid('payload inventory')
    paths.add(file.path)
    folded.add(file.path.toLowerCase())
    if ('link' in file) {
      if (
        !safe(file.link) ||
        file.link.includes('/') ||
        !(await lstat(join(dir, file.path))).isSymbolicLink() ||
        (await readlink(join(dir, file.path))) !== file.link
      )
        invalid('unsafe payload link')
      links.set(file.path, file.link)
      continue
    }
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.executable !== 'boolean'
    )
      invalid('payload inventory')
    bytes += file.size
    if (!Number.isSafeInteger(bytes) || bytes > variant.bundle.unpacked_bytes)
      invalid('unpacked size exceeds manifest')
    if (
      (await regular(dir, file.path)).size !== file.size ||
      (await hashFile(join(dir, file.path))) !== file.sha256
    )
      invalid('payload hash/size ' + file.path)
    if (!installed && file.executable) await chmod(join(dir, file.path), 0o755)
  }
  for (const [path, target] of links) {
    const destination = dirname(path) + '/' + target
    if (!paths.has(destination) || links.has(destination))
      invalid('link does not target an inventoried regular file')
    await regular(dir, destination)
  }
  for (const id of variant.components) {
    const c = release.components.find((c) => c.id === id)!
    const root = variant.bundle.component_roots[c.kind]!
    for (const path of c.executable_paths)
      if (!paths.has(root + '/' + path)) invalid('missing component executable')
  }
  if (!paths.has(variant.bundle.python)) invalid('missing bundled Python')
  async function walk(prefix: string) {
    for (const item of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const path = prefix ? prefix + '/' + item.name : item.name
      if (installed && (path === '.atomic-owned' || path === 'install.json') && item.isFile()) continue
      if (item.isDirectory()) await walk(path)
      else if ((!item.isFile() && !links.has(path)) || (path !== 'bundle.json' && !paths.has(path)))
        invalid('unlisted file ' + path)
    }
  }
  await walk('')
}

/** The record keeps the complete pinned release for offline load; it is not a new manifest source. */
export async function writeStrataBuild(
  dir: string,
  release: StrataRelease,
  variant: StrataVariant,
  installedAtMs: number
): Promise<void> {
  await writeFile(join(dir, '.atomic-owned'), 'atomic-chat\n', { flag: 'wx', mode: 0o600 })
  await writeFile(
    join(dir, 'install.json'),
    JSON.stringify({ release, variant_id: variant.id, installed_at_ms: installedAtMs }),
    { flag: 'wx', mode: 0o600 }
  )
}

export async function readStrataBuilds(root: string, coreVersion: string): Promise<Build[]> {
  const result: Build[] = []
  for (const tag of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!tag.isDirectory() || !strataBuildKey(tag.name)) continue
    for (const variant of await readdir(join(root, tag.name), { withFileTypes: true })) {
      if (!variant.isDirectory() || !safe(variant.name)) continue
      const dir = join(root, tag.name, variant.name)
      try {
        await regular(dir, '.atomic-owned')
        await regular(dir, 'install.json')
        const row = JSON.parse(await readFile(join(dir, 'install.json'), 'utf8'))
        const release = parseStrataManifest({ schema_version: 1, releases: [row.release] }, coreVersion)
          .releases[0]!
        const selected = release.variants.find((v) => v.id === row.variant_id)
        if (
          !selected ||
          selected.id !== variant.name ||
          release.release_id !== tag.name ||
          !Number.isSafeInteger(row.installed_at_ms)
        )
          continue
        // Check the inventory binding offline without hashing the whole runtime on every list request.
        await regular(dir, 'bundle.json')
        const python = join(dir, selected.bundle.python)
        const pythonInfo = await lstat(python)
        if (pythonInfo.isSymbolicLink()) {
          const target = await readlink(python)
          if (!safe(target) || target.includes('/')) continue
          await regular(dir, dirname(selected.bundle.python) + '/' + target)
        } else await regular(dir, selected.bundle.python)
        if ((await hashFile(join(dir, 'bundle.json'))) !== selected.bundle.bundle_manifest_sha256) continue
        result.push({
          tag: tag.name,
          backend_id: selected.id,
          origin: 'downloaded',
          dir,
          installed_at_ms: row.installed_at_ms,
          published_at: null,
          immutable_sha256: selected.bundle.sha256,
          min_core_version: release.minimum_core_version,
          strata: { release, variant: selected },
        })
      } catch {
        /* A corrupt or incompatible record is not an installed build. */
      }
    }
  }
  return result
}

/** The caller supplies the data root so symlinked parents cannot redirect build writes. */
export async function assertStrataBuildPath(dataRoot: string, path: string): Promise<void> {
  const { canonicalizeExistingPrefix } = await import('../downloads/index.js')
  const rest = relative(join(dataRoot, 'strata/backends'), resolve(path))
  if (!rest || rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest))
    invalid('outside Strata build root')
  const expected = resolve(await canonicalizeExistingPrefix(dataRoot), relative(dataRoot, path))
  if (relative(expected, await canonicalizeExistingPrefix(path)) !== '') invalid('redirected build path')
  const existing = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (existing && !(await lstat(join(path, '.atomic-owned')).catch(() => null))?.isFile())
    invalid('unowned replacement target')
}
