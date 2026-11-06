import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkAptSimulation,
  firmwareLink,
  verifyAptRecord,
  type LinuxNpuTarget,
  type NpuPackage,
} from './linux-amd-npu.js'
import { lemonadePpa } from '../../runtime/fastflowlm/environment/index.js'
import { dearmorPublicKey, primaryKeyFingerprints } from './openpgp.js'

export type NpuRun = (exe: string, args: string[]) => Promise<string>
const archiveKeyring = '/usr/share/keyrings/ubuntu-archive-keyring.gpg'

/** All apt state and repository declarations belong to this invocation; system sources are never edited. */
export async function stageNpuPackages(
  target: LinuxNpuTarget,
  packages: NpuPackage[],
  stage: string,
  revision: string,
  run: NpuRun,
  fetchKey: typeof fetch
) {
  const files: string[] = []
  for (const source of target.recipe.sources) {
    const wanted = packages.filter((p) => p.source === source.id)
    if (!wanted.length) continue
    const dir = join(stage, 'source-' + source.id),
      lists = join(dir, 'lists')
    await mkdir(lists, { recursive: true, mode: 0o755 })
    let keyring = archiveKeyring
    if (source.url === lemonadePpa) {
      const key = await fetchKey(
        'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x' + source.signing_fingerprint,
        { redirect: 'error', signal: AbortSignal.timeout(30000) }
      )
      if (!key.ok) throw Error('Cannot obtain the pinned repository signing key.')
      const bytes = dearmorPublicKey(await key.text())
      if (primaryKeyFingerprints(bytes).join() !== source.signing_fingerprint)
        throw Error('Wrong repository signing fingerprint.')
      keyring = join(dir, 'archive.gpg')
      await writeFile(keyring, bytes, { mode: 0o644, flag: 'wx' })
    }
    const sources = join(dir, 'npu.sources')
    await writeFile(
      sources,
      `Types: deb\nURIs: ${source.url}\nSuites: ${source.suite}\nComponents: ${source.component}\nArchitectures: amd64\nSigned-By: ${keyring} ${source.signing_fingerprint}\n\n`,
      { flag: 'wx' }
    )
    const opts = [
      '-o',
      'Dir::Etc::sourcelist=' + sources,
      '-o',
      'Dir::Etc::sourceparts=-',
      '-o',
      'Dir::State::lists=' + lists,
      '-o',
      'Dir::State::status=/dev/null',
      '-o',
      'Dir::Cache::pkgcache=',
      '-o',
      'Dir::Cache::srcpkgcache=',
      '-o',
      'Acquire::AllowInsecureRepositories=false',
      '-o',
      'APT::Update::Error-Mode=any',
    ]
    await run('/usr/bin/apt-get', [...opts, 'update'])
    for (const pkg of wanted) {
      verifyAptRecord(await run('/usr/bin/apt-cache', [...opts, 'show', pkg.name + '=' + pkg.version]), pkg)
      const file = join(stage, pkg.name + '.deb')
      await run('/usr/lib/apt/apt-helper', [
        'download-file',
        source.url + pkg.path,
        file,
        'SHA256:' + pkg.sha256,
      ])
      const meta = await run('/usr/bin/dpkg-deb', [
        '--show',
        '--showformat=${Package}\t${Version}\t${Architecture}',
        file,
      ])
      if (meta.trim() !== [pkg.name, pkg.version, pkg.architecture].join('\t'))
        throw Error('Package control identity mismatch: ' + pkg.name)
      if (pkg.name === 'amdxdna-dkms') {
        const contents = await run('/usr/bin/dpkg-deb', ['--contents', file])
        if (!firmwareLink(contents, revision, target.recipe.firmware_version))
          throw Error('Package firmware does not match the selected NPU revision and version.')
      }
      if (pkg.name === 'libxrt2' || pkg.name === 'libxrt-npu2') {
        const inventory = (await run('/usr/bin/dpkg-deb', ['--contents', file]))
          .split('\n')
          .map((l) => l.split(' -> ')[0]!)
        const libs =
          pkg.name === 'libxrt2' ? ['libxrt_core.so.2', 'libxrt_coreutil.so.2'] : ['libxrt_driver_xdna.so.2']
        if (!libs.every((name) => inventory.some((l) => l.endsWith('/' + name))))
          throw Error('System XRT package does not provide the qualified ABI 2 libraries.')
      }
      files.push(file)
    }
  }
  const options = [
    '--no-download',
    '--no-remove',
    '--no-install-recommends',
    '-o',
    'Dir::Etc::sourcelist=/dev/null',
    '-o',
    'Dir::Etc::sourceparts=-',
    '-o',
    'Dir::Cache::pkgcache=',
    '-o',
    'Dir::Cache::srcpkgcache=',
  ]
  checkAptSimulation(await run('/usr/bin/apt-get', [...options, '--simulate', 'install', ...files]), packages)
  // dpkg has no resolver. Even if the machine changes after simulation, it can only unpack these files.
  return files
}
