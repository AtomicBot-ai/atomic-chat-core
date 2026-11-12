// What sd.cpp's live tests run on (`node scripts/fetch-live-fixtures.mjs --engine sd-cpp`): this host's
// CPU archive of a release, unpacked alone into its own folder (the live test copies
// ATOMIC_LIVE_SD_ENGINE whole into its data folder, so no model may sit there), the model files of
// the config's `live_models` checked against their sha256 in a folder of their own, shared between
// builds and cached apart from them, and a manifest of the release for the install test
// (ATOMIC_SDCPP_MANIFEST_URL). The manifest and the archive choice are pure; `fetchSdcppFixtures`
// does the downloads. Each takes sd.cpp's release spec; audio.cpp's fetch
// (scripts/lib/audiocpp-fixtures.mjs) and MLX's (scripts/lib/mlx-fixtures.mjs) are the same with
// their own.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { chmod, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { releaseBackendArchives, SDCPP_RELEASE } from './sdcpp-surface.mjs'
import { digestMatches, liveModelDigest } from './live-fixtures.mjs'

/** `sha256:<hex>` → `<hex>`; `undefined` for anything else. */
const digestHex = (digest) => (/^sha256:[0-9a-f]{64}$/.test(digest ?? '') ? digest.slice(7) : undefined)

/**
 * The CPU archive of `platform` (`linux-x64`, `macos-arm64`, …) in a release's `assets`
 * (`{name, size, digest, browser_download_url}`): the backend every host of that platform falls back
 * to. Throws when the contract has none for the platform or the release has none or two.
 */
export function releaseHostArchive(contract, tag, assets, platform, release) {
  const backend = (contract.assets?.core_backends ?? []).find((b) => b.platform === platform && b.cpu)
  if (!backend) throw new Error(`${release.project} ships no CPU build for ${platform}`)
  const names = releaseBackendArchives(
    contract,
    tag,
    assets.map((a) => a.name),
    release
  )[backend.backend]
  if (names.length !== 1)
    throw new Error(
      `${tag} has ${names.length} ${backend.backend} archives${names.length ? `: ${names.join(', ')}` : ''}`
    )
  return { backend: backend.backend, asset: assets.find((a) => a.name === names[0]) }
}

/** sd.cpp's CPU archive of `platform` (`releaseHostArchive`). */
export function sdcppHostArchive(contract, tag, assets, platform) {
  return releaseHostArchive(contract, tag, assets, platform, SDCPP_RELEASE)
}

/**
 * conf's manifest of the engine for `repo`@`tag`, as conf's mirror would write it: every archive a
 * contract backend takes, pinned by its size and the sha256 of the release's digest, downloaded from
 * the release itself (`download_base`). What the install test points the core's manifest URL at
 * (ATOMIC_SDCPP_MANIFEST_URL, ATOMIC_AUDIOCPP_MANIFEST_URL), so the core picks, downloads, checks and
 * probes the candidate as it would for a user.
 */
export function releaseInstallManifest({ contract, tag, repo, assets, updatedAt }, release) {
  const archives = releaseBackendArchives(
    contract,
    tag,
    assets.map((a) => a.name),
    release
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

/** conf's sd.cpp manifest for `repo`@`tag` (`releaseInstallManifest`). */
export function sdcppInstallManifest(input) {
  return releaseInstallManifest(input, SDCPP_RELEASE)
}

/**
 * Where a live model lives under the models folder: by its digest, so two models never collide. A
 * model that is a folder of files (`files`) is the folder `<digest>/<id>`, its files under it.
 */
export const liveModelPath = (modelsDir, model) =>
  Array.isArray(model.files)
    ? join(modelsDir, liveModelDigest(model).slice(0, 16), model.id)
    : join(modelsDir, model.sha256.slice(0, 16), basename(new URL(model.url).pathname))

/** A file of a folder model: a relative path of plain segments, never `..`, so it stays in the folder. */
const MODEL_FILE_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** The files of a live model, each `{url, path, sha256}`: the model itself, or each file of a folder under its `url`. */
export function liveModelFiles(modelsDir, model) {
  const path = liveModelPath(modelsDir, model)
  if (!Array.isArray(model.files)) return [{ url: model.url, path, sha256: model.sha256 }]
  if (!model.url.endsWith('/')) throw new Error(`live model ${model.id}: a folder's url ends with /`)
  return model.files.map((file) => {
    if (!MODEL_FILE_RE.test(file.path)) throw new Error(`live model ${model.id}: bad file path ${file.path}`)
    return { url: new URL(file.path, model.url).href, path: join(path, file.path), sha256: file.sha256 }
  })
}

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
 * Everything one live cell of a release engine needs, under `out`: the archive (reused while it
 * matches the release digest), its tree unpacked into `engine-<tag>/`, the models under `modelsDir`
 * (skipped with `skipModel`), `manifest.json`, and the files the live step and the cell read:
 * `bin-path.txt`, `model-path.txt`, `tag.txt`, `live.json` (the values `live_env` names) and
 * `fixture.json` (with `archive_entries`, what the archive unpacked to). `engine` is the release spec
 * plus the server's name, the executables to mark runnable, the env the engine folder is printed as
 * and what to capture of the server (`captures`: a file under `out` per argv, stdout, a newline,
 * stderr); optionally the argv that prints its version (`versionArgv`, `null` for none), how long a
 * capture may take (`captureTimeoutMs`, 60 s) and the manifest writer (`installManifest`, conf's
 * ggml manifest by default).
 */
export async function fetchReleaseFixtures(
  { out, tag, repo, config, contract, modelsDir, skipModel, token, platform },
  engine
) {
  const api = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
  const headers = { 'user-agent': 'atomic-chat-core-live-fixtures', 'accept': 'application/vnd.github+json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(api, { headers })
  if (!res.ok) throw new Error(`${api} -> ${res.status}`)
  const release = await res.json()
  if (!engine.tagParts(release.tag_name))
    throw new Error(`${release.tag_name} is not an ${engine.project} tag`)
  const { backend, asset } = releaseHostArchive(
    contract,
    release.tag_name,
    release.assets ?? [],
    platform,
    engine
  )
  console.log(`using ${engine.project} ${release.tag_name} (${backend}) from ${repo}`)

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
  const server = await findFile(unpacked, exe(engine.server))
  if (!server) throw new Error(`no ${exe(engine.server)} inside ${asset.name}`)
  const engineDir = dirname(server)
  if (process.platform !== 'win32')
    for (const name of engine.executables)
      if (existsSync(join(engineDir, name))) await chmod(join(engineDir, name), 0o755)
  const printed = (argv) => {
    const r = spawnSync(server, argv, {
      cwd: engineDir,
      encoding: 'utf8',
      timeout: engine.captureTimeoutMs ?? 60_000,
    })
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  }
  // An engine without a version flag (MLX: argparse refuses `--version`) records none.
  const versionArgv = engine.versionArgv === undefined ? ['--version'] : engine.versionArgv
  const versionOutput = versionArgv ? printed(versionArgv).trim() : null
  for (const { file, argv } of engine.captures ?? []) await writeFile(join(out, file), printed(argv))

  const models = {}
  const records = []
  if (!skipModel)
    for (const model of config.live_models ?? []) {
      let reused = true
      let bytes = 0
      for (const file of liveModelFiles(modelsDir, model)) {
        reused = (await fetchChecked(file.url, file.path, file.sha256, token)).reused && reused
        bytes += (await stat(file.path)).size
      }
      models[model.id] = liveModelPath(modelsDir, model)
      records.push({ id: model.id, url: model.url, sha256: liveModelDigest(model), bytes, reused })
    }

  const manifest = join(out, 'manifest.json')
  const manifestInput = {
    contract,
    tag: release.tag_name,
    repo,
    assets: release.assets ?? [],
    updatedAt: release.published_at,
  }
  const doc = engine.installManifest
    ? engine.installManifest(manifestInput)
    : releaseInstallManifest(manifestInput, engine)
  await writeFile(manifest, `${JSON.stringify(doc, null, 2)}\n`)
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
        // What the archive unpacked to: the install runs the server from the root of it.
        archive_entries: (await readdir(unpacked)).sort(),
      },
      null,
      2
    )}\n`
  )
  console.log(`${engine.engineEnv}=${engineDir}`)
  for (const [id, path] of Object.entries(models)) console.log(`model ${id}: ${path}`)
}

/** sd.cpp's release spec with what its fetch needs: `sd-server`, beside it `sd-cli`. */
const SDCPP_FIXTURES = {
  ...SDCPP_RELEASE,
  server: 'sd-server',
  executables: ['sd-server', 'sd-cli'],
  engineEnv: 'ATOMIC_LIVE_SD_ENGINE',
}

/** Everything one live cell of sd.cpp needs, under `out` (`fetchReleaseFixtures`). */
export function fetchSdcppFixtures(input) {
  return fetchReleaseFixtures(input, SDCPP_FIXTURES)
}
