#!/usr/bin/env node
// Fetch what `test/live` needs: a real `llama-server` for this platform and a small GGUF.
// Used by CI (and by hand) so the live suite has something to run against.
//
//   node scripts/fetch-live-fixtures.mjs --out /tmp/live [--tag b11617] [--repo ggml-org/llama.cpp]
//     [--skip-model] [--capture]
//
// --tag picks a release (default: the newest one with this platform's CPU asset); --repo any GitHub
// repo publishing ggml-org's asset names, e.g. AtomicBot-ai/atomic-chat-conf for the signed mirror.
// Env: ATOMIC_LIVE_RELEASE_TAG, ATOMIC_LIVE_RELEASE_REPO, ATOMIC_LIVE_ASSET (exact asset name),
// ATOMIC_LIVE_MODEL_URL (+ ATOMIC_LIVE_MODEL_SHA256), GITHUB_TOKEN / GH_TOKEN for the API.
//
// Writes into <out>: bin-path.txt and model-path.txt (exported as ATOMIC_LIVE_UPSTREAM_BIN /
// ATOMIC_LIVE_UPSTREAM_MODEL), tag.txt (ATOMIC_LIVE_UPSTREAM_TAG) and fixture.json, which records
// what was tested: repo, tag, asset and model hashes, and the binary's `--version` output.
// --capture also writes help.txt, version.txt and list-devices.txt: what `-h`, `--version` and
// `--list-devices` print (stdout, a newline, stderr — the shape `runHelp` reads), for the fixtures
// under test/fixtures/llamacpp/ and the surface diff. --skip-model leaves the GGUF out.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assetPatternFor, DEFAULT_RELEASE_REPO, digestMatches, pickRelease } from './lib/live-fixtures.mjs'

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index > -1 ? process.argv[index + 1] : undefined
}

const OUT = resolve(arg('--out') ?? '.live-fixtures')
const TAG = arg('--tag') ?? process.env.ATOMIC_LIVE_RELEASE_TAG
const REPO = arg('--repo') ?? process.env.ATOMIC_LIVE_RELEASE_REPO ?? DEFAULT_RELEASE_REPO
const DEFAULT_MODEL_URL =
  'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories15M-q4_0.gguf'
const DEFAULT_MODEL_SHA256 = '66967fbece6dbe97886593fdbb73589584927e29119ec31f08090732d1861739'
const MODEL_URL = process.env.ATOMIC_LIVE_MODEL_URL ?? DEFAULT_MODEL_URL
const MODEL_SHA256 =
  process.env.ATOMIC_LIVE_MODEL_SHA256 ?? (MODEL_URL === DEFAULT_MODEL_URL ? DEFAULT_MODEL_SHA256 : undefined)
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const SKIP_MODEL = process.argv.includes('--skip-model')
const CAPTURE = process.argv.includes('--capture')

mkdirSync(OUT, { recursive: true })

async function json(url) {
  const headers = { 'user-agent': 'atomic-chat-core-live-fixtures', 'accept': 'application/vnd.github+json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

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

function findServer(dir) {
  const wanted = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) stack.push(path)
      else if (name === wanted) return path
    }
  }
  throw new Error(`no ${wanted} inside ${dir}`)
}

const pattern = assetPatternFor(process.platform, process.arch, process.env.ATOMIC_LIVE_ASSET)
const api = `https://api.github.com/repos/${REPO}/releases`
const releases = TAG ? [await json(`${api}/tags/${TAG}`)] : await json(`${api}?per_page=30`)
const picked = pickRelease(releases, pattern)
if (!picked) throw new Error(`no asset matching ${pattern} in ${releases.length} release(s) of ${REPO}`)
const { release, asset } = picked
console.log(`using llama.cpp ${release.tag_name} from ${REPO}`)

// A cached archive is reused only while it still matches the release's digest.
const archive = join(OUT, asset.name)
if (!existsSync(archive) || digestMatches(asset.digest, sha256Of(archive)) === false) {
  console.log(`downloading ${asset.name}`)
  await download(asset.browser_download_url, archive)
}
const archiveSha256 = sha256Of(archive)
const verified = digestMatches(asset.digest, archiveSha256)
if (verified === false)
  throw new Error(`${asset.name}: sha256 ${archiveSha256} does not match ${asset.digest}`)

const extracted = join(OUT, `backend-${release.tag_name}`)
extract(archive, extracted)
const server = findServer(extracted)
if (process.platform !== 'win32') chmodSync(server, 0o755)
/** What `server <args>` prints: stdout, a newline, stderr. */
const printed = (args) => {
  const result = spawnSync(server, args, { cwd: dirname(server), encoding: 'utf8', timeout: 60_000 })
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}
const versionOutput = printed(['--version']).trim()
if (CAPTURE) {
  writeFileSync(join(OUT, 'help.txt'), printed(['-h']))
  writeFileSync(join(OUT, 'version.txt'), printed(['--version']))
  writeFileSync(join(OUT, 'list-devices.txt'), printed(['--list-devices']))
}

let model
let modelSha256
if (!SKIP_MODEL) {
  model = join(OUT, 'live-model.gguf')
  if (!existsSync(model) || (MODEL_SHA256 && sha256Of(model) !== MODEL_SHA256)) {
    console.log(`downloading ${MODEL_URL}`)
    await download(MODEL_URL, model)
  }
  modelSha256 = sha256Of(model)
  if (MODEL_SHA256 && modelSha256 !== MODEL_SHA256)
    throw new Error(`${MODEL_URL}: sha256 ${modelSha256} does not match ${MODEL_SHA256}`)
}

writeFileSync(join(OUT, 'bin-path.txt'), server)
if (model) writeFileSync(join(OUT, 'model-path.txt'), model)
writeFileSync(join(OUT, 'tag.txt'), release.tag_name)
writeFileSync(
  join(OUT, 'fixture.json'),
  JSON.stringify(
    {
      repo: REPO,
      tag: release.tag_name,
      prerelease: release.prerelease === true,
      platform: process.platform,
      arch: process.arch,
      asset: { name: asset.name, size: asset.size, sha256: archiveSha256, digest_verified: verified ?? null },
      model: model ? { url: MODEL_URL, sha256: modelSha256, verified: MODEL_SHA256 !== undefined } : null,
      version_output: versionOutput,
    },
    null,
    2
  ) + '\n'
)
console.log(`ATOMIC_LIVE_UPSTREAM_BIN=${server}`)
if (model) console.log(`ATOMIC_LIVE_UPSTREAM_MODEL=${model}`)
console.log(`ATOMIC_LIVE_UPSTREAM_TAG=${release.tag_name}`)
