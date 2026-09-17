#!/usr/bin/env node
// Fetch what `test/live` needs: a real `llama-server` for this platform and a small GGUF.
// Used by CI (and by hand) so the live suite has something to run against.
//
//   node scripts/fetch-live-fixtures.mjs --out /tmp/live
//
// Writes <out>/bin-path.txt and <out>/model-path.txt, which the caller exports as
// ATOMIC_LIVE_UPSTREAM_BIN / ATOMIC_LIVE_UPSTREAM_MODEL. Override the sources with
// ATOMIC_LIVE_RELEASE_TAG, ATOMIC_LIVE_ASSET (exact asset name) or ATOMIC_LIVE_MODEL_URL.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outIndex = process.argv.indexOf('--out')
const OUT = outIndex > -1 ? process.argv[outIndex + 1] : join(process.cwd(), '.live-fixtures')
mkdirSync(OUT, { recursive: true })

const MODEL_URL =
  process.env.ATOMIC_LIVE_MODEL_URL ??
  'https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories15M-q4_0.gguf'

/**
 * Release asset for this platform, in the naming llama.cpp actually publishes (macOS and Linux ship
 * `.tar.gz`, Windows `.zip`) — the same mapping `src/backend/catalog/archive.ts` encodes.
 */
function assetPattern() {
  if (process.env.ATOMIC_LIVE_ASSET) return new RegExp(`^${escape(process.env.ATOMIC_LIVE_ASSET)}$`)
  if (process.platform === 'win32')
    return process.arch === 'arm64'
      ? /^llama-b\d+-bin-win-cpu-arm64\.zip$/
      : /^llama-b\d+-bin-win-cpu-x64\.zip$/
  if (process.platform === 'darwin')
    return process.arch === 'arm64'
      ? /^llama-b\d+-bin-macos-arm64\.tar\.gz$/
      : /^llama-b\d+-bin-macos-x64\.tar\.gz$/
  return process.arch === 'arm64'
    ? /^llama-b\d+-bin-ubuntu-arm64\.tar\.gz$/
    : /^llama-b\d+-bin-ubuntu-x64\.tar\.gz$/
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'atomic-chat-core-live-fixtures' } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, bytes)
  return bytes.length
}

function extract(archive, dir) {
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

const tag = process.env.ATOMIC_LIVE_RELEASE_TAG
const pattern = assetPattern()
// `releases/latest` is not the binary build: llama.cpp tags those `bNNNN` and marks something else
// as latest, so walk the recent releases newest-first until one carries an asset for this platform.
const releases = tag
  ? [await json(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`)]
  : await json('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30')
let release
let asset
for (const candidate of releases) {
  const found = (candidate.assets ?? []).find((a) => pattern.test(a.name))
  if (found) {
    release = candidate
    asset = found
    break
  }
}
if (!asset) throw new Error(`no asset matching ${pattern} in the last ${releases.length} releases`)
console.log(`using llama.cpp ${release.tag_name}`)

const archive = join(OUT, asset.name)
if (!existsSync(archive)) {
  console.log(`downloading ${asset.name} (${release.tag_name})`)
  await download(asset.browser_download_url, archive)
}
const extracted = join(OUT, 'backend')
extract(archive, extracted)
const server = findServer(extracted)
if (process.platform !== 'win32') chmodSync(server, 0o755)

const model = join(OUT, 'live-model.gguf')
if (!existsSync(model)) {
  console.log(`downloading ${MODEL_URL}`)
  const size = await download(MODEL_URL, model)
  console.log(`model is ${(size / 1024 / 1024).toFixed(1)} MiB`)
}

writeFileSync(join(OUT, 'bin-path.txt'), server)
writeFileSync(join(OUT, 'model-path.txt'), model)
console.log(`ATOMIC_LIVE_UPSTREAM_BIN=${server}`)
console.log(`ATOMIC_LIVE_UPSTREAM_MODEL=${model}`)
