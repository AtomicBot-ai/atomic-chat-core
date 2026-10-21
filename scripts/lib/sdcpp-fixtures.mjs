// What sd.cpp's live tests run on (`node scripts/fetch-live-fixtures.mjs --engine sd-cpp`): this host's
// CPU archive of a release, unpacked alone into its own folder (the live test copies
// ATOMIC_LIVE_SD_ENGINE whole into its data folder, so no model may sit there), the model files of
// the config's `live_models` checked against their sha256 in a folder of their own, shared between
// builds and cached apart from them, and a manifest of the release for the install test
// (ATOMIC_SDCPP_MANIFEST_URL). The manifest and the archive choice are pure; `fetchSdcppFixtures`
// does the downloads.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { chmod, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { sdcppTagParts } from './engine-pin.mjs'
import { sdcppBackendArchives } from './sdcpp-surface.mjs'
import { digestMatches } from './live-fixtures.mjs'

/** `sha256:<hex>` → `<hex>`; `undefined` for anything else. */
const digestHex = (digest) => (/^sha256:[0-9a-f]{64}$/.test(digest ?? '') ? digest.slice(7) : undefined)

/**
 * The CPU archive of `platform` (`linux-x64`, `macos-arm64`, …) in a release's `assets`
 * (`{name, size, digest, browser_download_url}`): the backend every host of that platform falls back
 * to. Throws when the contract has none for the platform or the release has none or two.
 */
export function sdcppHostArchive(contract, tag, assets, platform) {
  const backend = (contract.assets?.core_backends ?? []).find((b) => b.platform === platform && b.cpu)
  if (!backend) throw new Error(`sd.cpp ships no CPU build for ${platform}`)
  const names = sdcppBackendArchives(
    contract,
    tag,
    assets.map((a) => a.name)
  )[backend.backend]
  if (names.length !== 1)
    throw new Error(
      `${tag} has ${names.length} ${backend.backend} archives${names.length ? `: ${names.join(', ')}` : ''}`
    )
  return { backend: backend.backend, asset: assets.find((a) => a.name === names[0]) }
}

/**
 * conf's sd.cpp manifest for `repo`@`tag`, as conf's mirror would write it: every archive a contract
 * backend takes, pinned by its size and the sha256 of the release's digest, downloaded from the
 * release itself (`download_base`). What the install test points ATOMIC_SDCPP_MANIFEST_URL at, so
 * the core picks, downloads, checks and probes the candidate as it would for a user.
 */
export function sdcppInstallManifest({ contract, tag, repo, assets, updatedAt }) {
  const archives = sdcppBackendArchives(
    contract,
    tag,
    assets.map((a) => a.name)
  )
  const entries = []
  for (const b of contract.assets?.core_backends ?? []) {
    const names = archives[b.backend]
    if (names.length !== 1) continue
    const asset = assets.find((a) => a.name === names[0])
    entries.push({
      backend: b.backend,
      name: asset.name,
      ...(digestHex(asset.digest) ? { sha256: digestHex(asset.digest) } : {}),
      ...(asset.size ? { size: asset.size } : {}),
      ...(b.companion ? { companion: true } : {}),
    })
  }
  return {
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    upstream_repo: repo,
    tag_name: tag,
    download_base: `https://github.com/${repo}/releases/download`,
    assets: entries,
  }
}

/** Where a live model lives under the models folder: by its sha256, so two models never collide. */
export const liveModelPath = (modelsDir, model) =>
  join(modelsDir, model.sha256.slice(0, 16), basename(new URL(model.url).pathname))

async function sha256Of(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function download(url, dest, token) {
  const headers = { 'user-agent': 'atomic-chat-core-live-fixtures' }
  if (token && new URL(url).hostname === 'api.github.com') headers.authorization = `Bearer ${token}`
  const res = await fetch(url, { redirect: 'follow', headers })
  if (!res.ok || !res.body) throw new Error(`${url} -> ${res.status}`)
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  renameSync(part, dest)
}

/** `path` when it is there with `sha256`; otherwise downloaded from `url` and checked. */
async function fetchChecked(url, path, sha256, token) {
  if (existsSync(path) && (await sha256Of(path)) === sha256) return { reused: true }
  console.log(`downloading ${url}`)
  await download(url, path, token)
  const actual = await sha256Of(path)
  if (actual !== sha256) {
    rmSync(path, { force: true })
    throw new Error(`${url}: sha256 ${actual} does not match ${sha256}`)
  }
  return { reused: false }
}

function extract(archive, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const result = archive.endsWith('.zip')
    ? process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`,
          ],
          { stdio: 'inherit' }
        )
      : spawnSync('unzip', ['-o', '-q', archive, '-d', dir], { stdio: 'inherit' })
    : spawnSync('tar', ['-xzf', archive, '-C', dir], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`failed to extract ${archive}`)
}

async function findFile(dir, wanted) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findFile(path, wanted)
      if (found) return found
    } else if (entry.name === wanted) return path
  }
  return undefined
}

/**
 * Everything one live cell of sd.cpp needs, under `out`: the archive (reused while it matches the
 * release digest), its tree unpacked into `engine-<tag>/`, the models under `modelsDir` (skipped with
 * `skipModel`), `manifest.json`, and the files the live step and the cell read: `bin-path.txt`,
 * `model-path.txt`, `tag.txt`, `live.json` (the values `live_env` names) and `fixture.json`.
 */
export async function fetchSdcppFixtures({
  out,
  tag,
  repo,
  config,
  contract,
  modelsDir,
  skipModel,
  token,
  platform,
}) {
  const api = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
  const headers = { 'user-agent': 'atomic-chat-core-live-fixtures', 'accept': 'application/vnd.github+json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(api, { headers })
  if (!res.ok) throw new Error(`${api} -> ${res.status}`)
  const release = await res.json()
  if (!sdcppTagParts(release.tag_name)) throw new Error(`${release.tag_name} is not an sd.cpp tag`)
  const { backend, asset } = sdcppHostArchive(contract, release.tag_name, release.assets ?? [], platform)
  console.log(`using sd.cpp ${release.tag_name} (${backend}) from ${repo}`)

  mkdirSync(out, { recursive: true })
  const archive = join(out, asset.name)
  if (!existsSync(archive) || digestMatches(asset.digest, await sha256Of(archive)) === false) {
    console.log(`downloading ${asset.name}`)
    await download(asset.browser_download_url, archive, token)
  }
  const archiveSha256 = await sha256Of(archive)
  const verified = digestMatches(asset.digest, archiveSha256)
  if (verified === false)
    throw new Error(`${asset.name}: sha256 ${archiveSha256} does not match ${asset.digest}`)

  const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name)
  const unpacked = join(out, `engine-${release.tag_name}`)
  extract(archive, unpacked)
  const server = await findFile(unpacked, exe('sd-server'))
  if (!server) throw new Error(`no ${exe('sd-server')} inside ${asset.name}`)
  const engineDir = dirname(server)
  if (process.platform !== 'win32')
    for (const name of ['sd-server', 'sd-cli'])
      if (existsSync(join(engineDir, name))) await chmod(join(engineDir, name), 0o755)
  const version = spawnSync(server, ['--version'], { cwd: engineDir, encoding: 'utf8', timeout: 60_000 })
  const versionOutput = `${version.stdout ?? ''}\n${version.stderr ?? ''}`.trim()

  const models = {}
  const records = []
  if (!skipModel)
    for (const model of config.live_models ?? []) {
      const path = liveModelPath(modelsDir, model)
      const { reused } = await fetchChecked(model.url, path, model.sha256, token)
      models[model.id] = path
      records.push({
        id: model.id,
        url: model.url,
        sha256: model.sha256,
        bytes: (await stat(path)).size,
        reused,
      })
    }

  const manifest = join(out, 'manifest.json')
  await writeFile(
    manifest,
    `${JSON.stringify(sdcppInstallManifest({ contract, tag: release.tag_name, repo, assets: release.assets ?? [], updatedAt: release.published_at }), null, 2)}\n`
  )
  const main = records[0]
  await writeFile(join(out, 'bin-path.txt'), server)
  if (main) await writeFile(join(out, 'model-path.txt'), models[main.id])
  await writeFile(join(out, 'tag.txt'), release.tag_name)
  await writeFile(
    join(out, 'live.json'),
    `${JSON.stringify({ engine_dir: engineDir, tag: release.tag_name, manifest, models }, null, 2)}\n`
  )
  await writeFile(
    join(out, 'fixture.json'),
    `${JSON.stringify(
      {
        repo,
        tag: release.tag_name,
        prerelease: release.prerelease === true,
        platform: process.platform,
        arch: process.arch,
        backend,
        asset: {
          name: asset.name,
          size: asset.size,
          sha256: archiveSha256,
          digest_verified: verified ?? null,
        },
        model: main ? { url: main.url, sha256: main.sha256, verified: true } : null,
        models: records,
        version_output: versionOutput,
      },
      null,
      2
    )}\n`
  )
  console.log(`ATOMIC_LIVE_SD_ENGINE=${engineDir}`)
  for (const [id, path] of Object.entries(models)) console.log(`model ${id}: ${path}`)
}
