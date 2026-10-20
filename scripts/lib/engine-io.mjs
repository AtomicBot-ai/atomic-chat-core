// The I/O half of the engine candidate scripts (scripts/engine-surface-diff.mjs,
// scripts/engine-candidate.mjs): the GitHub API, conf at one commit, this core's identity, and a
// llama.cpp build fetched and run. The decisions live in engine-pin.mjs, engine-surface.mjs and
// engine-results.mjs, which take what this returns as data.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePins, resolvePrismPins } from './engine-pin.mjs'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const CONF_REPO = 'AtomicBot-ai/atomic-chat-conf'
export const CONF_FILES = {
  releases: 'backends/llamacpp-upstream-releases.json',
  manifest: 'backends/manifest.json',
  mirror: '.github/scripts/mirror.mjs',
  prism: 'backends/atomic-prism-manifest.json',
}

const TOKEN = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN

/**
 * `.github/engine-candidate/<engine>.json`: where the engine's builds live, the platforms and live
 * tests of its check, and how it differs from upstream llama.cpp. A core without the file does not
 * check that engine: the orchestrator looks for it on a core release before it asks for a check.
 */
export function engineConfig(engine) {
  const path = join(ROOT, '.github/engine-candidate', `${engine}.json`)
  if (!/^[a-z0-9-]+$/.test(engine) || !existsSync(path))
    throw new Error(`this core does not check ${engine} (no .github/engine-candidate/${engine}.json)`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * The contract a build of the engine is held to: the config's `contract` file, named after the
 * engine and with the config's `upstream` (a fork's repo and branch) over the file's. PrismML runs
 * the same `llama-server` surface core drives for upstream, so it shares that contract.
 */
export function engineContract(config) {
  const contract = JSON.parse(readFileSync(join(ROOT, config.contract), 'utf8'))
  return { ...contract, engine: config.engine, upstream: { ...contract.upstream, ...config.upstream } }
}

/** The engine's release tags: `b11617` unless the config names its own (`tag_pattern`). */
export const engineTagRe = (config) => new RegExp(config.tag_pattern ?? '^b\\d+$')

/** The engine's pin per platform, from the conf file core reads it from (`pins` in the config). */
export function enginePins(config, conf, coreVersion) {
  return config.pins === 'prism-manifest'
    ? resolvePrismPins({ manifest: conf.prism, coreVersion })
    : resolvePins({ releases: conf.releases, manifest: conf.manifest, coreVersion })
}

/** `GET https://api.github.com<path>` as JSON; `null` on a 404 when `allow404`. */
export async function githubJson(path, { allow404 = false } = {}) {
  const headers = { 'user-agent': 'atomic-chat-core-engine-check', 'accept': 'application/vnd.github+json' }
  if (TOKEN()) headers.authorization = `Bearer ${TOKEN()}`
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (allow404 && res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}${TOKEN() ? '' : ' (no GITHUB_TOKEN)'}`)
  return res.json()
}

/** A release by tag, `null` when the repo has none. */
export const githubRelease = (repo, tag) =>
  githubJson(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })

/** The newest releases of a repo, newest first. */
export const githubReleases = (repo, perPage = 30) =>
  githubJson(`/repos/${repo}/releases?per_page=${perPage}`)

async function rawText(repo, sha, path) {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`)
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`${repo}@${sha}:${path} -> ${res.status}`)
  return res.text()
}

export function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  }
}

export function git(cwd, args, options = {}) {
  const r = run('git', args, { cwd, ...options })
  if (r.status !== 0)
    throw new Error(`git ${args.slice(0, 3).join(' ')} … failed: ${(r.stderr || r.error || '').trim()}`)
  return r.stdout
}

/**
 * conf's release list, legacy manifest, mirror script and PrismML manifest at one commit: a local
 * checkout (`dir`),
 * or a ref of AtomicBot-ai/atomic-chat-conf resolved to its sha first, so one run reads one version.
 * A file that cannot be read is `undefined` and named in `errors`.
 */
export async function loadConf({ dir, ref }) {
  const conf = { ref: dir ? null : ref, sha: null, errors: [] }
  if (dir) {
    conf.dir = dir
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: dir })
    conf.sha = head.status === 0 ? head.stdout.trim() : null
  } else {
    try {
      conf.sha = (await githubJson(`/repos/${CONF_REPO}/commits/${encodeURIComponent(ref)}`)).sha
    } catch (error) {
      conf.errors.push(`conf ${ref}: ${error.message}`)
      return conf
    }
  }
  const read = async (path) => {
    try {
      if (dir) return existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : undefined
      return await rawText(CONF_REPO, conf.sha, path)
    } catch (error) {
      conf.errors.push(`${path}: ${error.message}`)
      return undefined
    }
  }
  const json = async (path) => {
    const text = await read(path)
    try {
      return text === undefined ? undefined : JSON.parse(text)
    } catch {
      conf.errors.push(`${path}: not JSON`)
      return undefined
    }
  }
  conf.releases = await json(CONF_FILES.releases)
  conf.manifest = await json(CONF_FILES.manifest)
  conf.mirrorSource = await read(CONF_FILES.mirror)
  conf.prism = await json(CONF_FILES.prism)
  return conf
}

/** This checkout: package version and commit (`null` outside git). */
export function coreIdentity() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })
  return { version, sha: head.status === 0 ? head.stdout.trim() : null }
}

/** This host as the pin platforms name it: `linux-x64`, `macos-arm64`, `windows-x64`, … */
export function hostPlatform(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'
  return `${os}-${arch === 'arm64' ? 'arm64' : 'x64'}`
}

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * This host's archive of `repo`@`tag`, unpacked under `out` by scripts/fetch-live-fixtures.mjs
 * (which checks it against the release digest and reuses what is already there), with the GGUF
 * `engine`'s live tests take unless `model` is false.
 */
export function fetchBuild({ tag, repo, out, model = true, engine }) {
  const args = [join(ROOT, 'scripts/fetch-live-fixtures.mjs'), '--out', out, '--tag', tag, '--repo', repo]
  if (engine) args.push('--engine', engine)
  if (!model) args.push('--skip-model')
  const r = spawnSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.status !== 0) throw new Error(`fetch-live-fixtures ${repo}@${tag} exited ${r.status ?? r.signal}`)
  const read = (name) => readFileSync(join(out, name), 'utf8').trim()
  return {
    dir: out,
    bin: read('bin-path.txt'),
    model: model ? read('model-path.txt') : undefined,
    fixture: JSON.parse(read('fixture.json')),
  }
}

/**
 * Run each of `invocations` (the contract's `-h`, `--version`, `--list-devices`) beside the binary's
 * libraries, as core does; the output is stdout, a newline, stderr — the shape `runHelp` reads.
 */
export function runInvocations(bin, invocations, timeoutMs = 60_000) {
  return invocations.map(({ argv }) => {
    const r = run(bin, argv, { cwd: dirname(bin), timeout: timeoutMs })
    return {
      argv,
      status: r.status,
      ...(r.signal ? { signal: r.signal } : {}),
      ...(r.error ? { error: r.error } : {}),
      output: `${r.stdout}\n${r.stderr}`,
    }
  })
}
