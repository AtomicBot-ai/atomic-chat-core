import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { AtomicCoreError } from '../contracts/index.js'
import { selectStrataDevice } from '../runtime/strata/index.js'
import { CORE_VERSION } from '../version.js'
import type { EngineDescriptor } from './engines.js'
import type { StrataManifest } from './strata-manifest.js'
import { readStrataBuilds, verifyStrataBundle, writeStrataBuild } from './strata-install.js'
import { compareBuilds } from './order.js'
const run = promisify(execFile)

export const strataDescriptor: EngineDescriptor<StrataManifest> = {
  release(manifest) {
    const r = manifest.releases[0]
    return r
      ? { tag: r.release_id, published_at: null, min_core_version: r.minimum_core_version, strataRelease: r }
      : null
  },
  async hostChoice(ctx, manifest) {
    const unavailable = (reason: string) => ({ backend_id: null, ladder: [], reason })
    const release = manifest?.releases[0]
    if (!release) return unavailable('No Strata bundles have been published.')
    if (!ctx.strataHardware) return unavailable('Strata hardware requirements have not been checked.')
    const selection = selectStrataDevice(release, await ctx.strataHardware())
    if (!selection.variant) return unavailable(selection.reason)
    return { backend_id: selection.variant.id, ladder: [selection.variant.id], reason: null }
  },
  archives(manifest, backendId) {
    const b = manifest.releases[0]?.variants.find((v) => v.id === backendId)?.bundle
    return b
      ? [
          {
            url: b.url,
            name: basename(new URL(b.url).pathname),
            size: b.size,
            unpackedBytes: b.unpacked_bytes,
            sha256: b.sha256,
          },
        ]
      : []
  },
  async probe(dir, ctx, backendId, info, signal) {
    const release = info?.strataRelease,
      variant = release?.variants.find((v) => v.id === backendId)
    if (!release || !variant)
      throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'Missing Strata bundle identity.')
    await verifyStrataBundle(dir, release, variant)
    if (ctx.hostProbe) return ctx.hostProbe(dir)
    const systemRoot = ctx.env?.SystemRoot ?? ctx.env?.SYSTEMROOT ?? 'C:\\Windows'
    const env =
      ctx.platform === 'win32'
        ? { SystemRoot: systemRoot, PATH: join(systemRoot, 'System32') }
        : { PATH: '/usr/bin:/bin' }
    const python = join(dir, variant.bundle.python)
    // Isolated Python ignores user site packages and inherited Python variables. Imports never install.
    const control = release.components.find((c) => c.kind === 'control' && variant.components.includes(c.id))!
    const imports = [
      ...new Set([
        'jinja2',
        'yaml',
        'regex',
        'psutil',
        'requests',
        'numpy',
        'PIL',
        'gguf',
        ...control.python_modules!,
      ]),
    ]
    if (imports.some((m) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(m)))
      throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'Invalid Strata Python module name.')
    const script =
      'import importlib,json,sys; sys.path.insert(0,sys.argv[2]); [importlib.import_module(m) for m in json.loads(sys.argv[1])]; print(sys.version.split()[0])'
    const result = await run(
      python,
      ['-I', '-B', '-c', script, JSON.stringify(imports), join(dir, 'control/third_party/llama.cpp/gguf-py')],
      { env, cwd: dir, signal, timeout: 30000, maxBuffer: 128 * 1024, windowsHide: true }
    )
    if (result.stdout.trim() !== control.python_version)
      throw new AtomicCoreError(
        'ENGINE_INSTALL_FAILED',
        'Packaged Python version differs from Strata manifest.'
      )
    for (const id of variant.components) {
      const c = release.components.find((c) => c.id === id)!
      if (c.kind === 'control') {
        const probe = await run(
          python,
          [
            '-I',
            '-B',
            '-c',
            'import sys; sys.path.insert(0,sys.argv[1]); from strata_control.atomic_owner import OWNER_CONTRACT; assert OWNER_CONTRACT == 3, "Atomic external-owner contract unavailable"; import strata_cli; print(strata_cli.version())',
            join(dir, 'control'),
          ],
          { env, cwd: dir, signal, timeout: 30000, maxBuffer: 128 * 1024, windowsHide: true }
        )
        if (probe.stdout.trim() !== c.version)
          throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'Control version differs from Strata manifest.')
      } else {
        const binary = join(dir, variant.bundle.component_roots[c.kind]!, c.executable_paths[0]!)
        const probe = await run(binary, ['--version'], {
          env,
          cwd: dir,
          signal,
          timeout: 30000,
          maxBuffer: 128 * 1024,
          windowsHide: true,
        })
        if (!(probe.stdout + probe.stderr).includes(c.version))
          throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'Compute version differs from Strata manifest.')
      }
    }
  },
  async record(dir, info) {
    const release = info.strataRelease,
      variant = release?.variants.find((v) => v.id === info.backendId)
    if (!release || !variant)
      throw new AtomicCoreError('ENGINE_INSTALL_FAILED', 'Missing Strata install identity.')
    await writeStrataBuild(dir, release, variant, info.installedAtMs)
  },
  builds: (ctx) => readStrataBuilds(ctx.root, CORE_VERSION),
  active: (builds) => [...builds].sort((a, b) => compareBuilds('strata', b, a))[0],
}
