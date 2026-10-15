#!/usr/bin/env node
// The surface diff of an upstream llama.cpp candidate against the build this core runs today (the
// pin): `-h`, `--version` and the invocations core makes, the release's archives, and the upstream
// history in between, held to the engine contract. Writes report.json (schema
// atomic-engine-surface-report v1), report.md, inputs.json (everything gathered, to rebuild the
// report with --inputs), watched.patch and both help screens into --out.
//
//   node scripts/engine-surface-diff.mjs --candidate b11617 [--repo ggml-org/llama.cpp]
//     [--pin auto|none|bN] [--pin-repo <repo>] [--conf <dir> | --conf-ref main]
//     [--contract <path>] [--out .engine-check/surface] [--cache .engine-check/cache]
//     [--fail-on break|error|warn] [--skip-upstream]
//   node scripts/engine-surface-diff.mjs --candidate-bin <llama-server> [--pin-bin <llama-server>] …
//   node scripts/engine-surface-diff.mjs --inputs <inputs.json> [--out …]
//
// --repo: any repo publishing ggml-org's asset names (AtomicBot-ai/atomic-chat-conf for the signed
// mirror). --pin auto takes conf's release list (the newest approved release this core version
// runs, on linux-x64); the pin's binary comes from --pin-repo, by default the candidate's repo when
// it has the tag, else ggml-org. A local --candidate-bin is tagged b<build> from its --version;
// when its commit is not in ggml-org/llama.cpp (a fork, a local branch) the upstream checks say
// "diff unavailable" and the rest still run. Exit 0 unless the tool itself fails (2) or the
// report reaches --fail-on (1). GITHUB_TOKEN / GH_TOKEN lift the API rate limit.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_RELEASE_REPO } from './lib/live-fixtures.mjs'
import { resolvePins, PIN_PLATFORMS } from './lib/engine-pin.mjs'
import {
  buildReport,
  countStrings,
  MIRROR_WHITELIST,
  parseBinaryVersion,
  parseGitLog,
  parseMirrorWhitelist,
  parseNumstat,
  renderMarkdown,
  SURFACE_INPUTS_SCHEMA,
  versionCommit,
} from './lib/engine-surface.mjs'
import {
  coreIdentity,
  fetchBuild,
  git,
  githubJson,
  githubRelease,
  hostPlatform,
  loadConf,
  ROOT,
  run,
  runInvocations,
  sha256File,
} from './lib/engine-io.mjs'

const SEVERITY_ORDER = ['warn', 'error', 'break']
const isTag = (v) => /^b\d+$/.test(v)

export async function main(argv = process.argv.slice(2)) {
  const { values: opts } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'candidate': { type: 'string' },
      'candidate-bin': { type: 'string' },
      'repo': { type: 'string', default: DEFAULT_RELEASE_REPO },
      'pin': { type: 'string', default: 'auto' },
      'pin-bin': { type: 'string' },
      'pin-repo': { type: 'string' },
      'conf': { type: 'string' },
      'conf-ref': { type: 'string', default: 'main' },
      'contract': { type: 'string', default: join(ROOT, 'test/fixtures/llamacpp/engine-contract.json') },
      'out': { type: 'string', default: '.engine-check/surface' },
      'cache': { type: 'string', default: '.engine-check/cache' },
      'fail-on': { type: 'string' },
      'skip-upstream': { type: 'boolean', default: false },
      'inputs': { type: 'string' },
    },
  })
  if (!opts.inputs && !opts.candidate === !opts['candidate-bin'])
    throw new Error('give one of --candidate bN or --candidate-bin <llama-server> (or --inputs)')
  if (opts.candidate && !isTag(opts.candidate)) throw new Error(`--candidate must look like b11617`)
  if (!['auto', 'none'].includes(opts.pin) && !isTag(opts.pin)) throw new Error('--pin is auto, none or bN')
  if (opts['fail-on'] && !SEVERITY_ORDER.includes(opts['fail-on']))
    throw new Error('--fail-on is break, error or warn')

  const contractText = readFileSync(opts.contract, 'utf8')
  const contract = JSON.parse(contractText)
  const out = resolve(opts.out)
  mkdirSync(out, { recursive: true })

  let inputs
  if (opts.inputs) inputs = JSON.parse(readFileSync(opts.inputs, 'utf8'))
  else {
    const gathered = await gather(contract, opts)
    inputs = gathered.inputs
    if (gathered.patch !== undefined) writeFileSync(join(out, 'watched.patch'), gathered.patch)
  }
  writeFileSync(join(out, 'inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`)
  if (inputs.candidate?.help_text) writeFileSync(join(out, 'help-candidate.txt'), inputs.candidate.help_text)
  if (inputs.pin?.help_text) writeFileSync(join(out, 'help-pin.txt'), inputs.pin.help_text)

  const report = buildReport(contract, inputs, {
    now: new Date().toISOString(),
    contractSha256: createHash('sha256').update(contractText).digest('hex'),
  })
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(out, 'report.md'), renderMarkdown(report))
  const c = report.counts
  console.log(
    `surface ${report.inputs.candidate?.tag ?? 'local'} vs ${report.inputs.pin?.tag ?? 'no pin'}: ` +
      `${report.status} (${c.break} break, ${c.warn} warn, ${c.info} info, ${c.error} error) → ${join(out, 'report.md')}`
  )
  const failOn = opts['fail-on']
  if (failOn) {
    const reached = SEVERITY_ORDER.slice(SEVERITY_ORDER.indexOf(failOn))
    if (reached.includes(report.status)) return 1
  }
  return 0
}

async function gather(contract, opts) {
  const cache = resolve(opts.cache)
  const platform = hostPlatform()
  const core = coreIdentity()
  const conf = await loadConf(opts.conf ? { dir: resolve(opts.conf) } : { ref: opts['conf-ref'] })
  for (const error of conf.errors) console.warn(`conf: ${error}`)
  const fromConf = conf.mirrorSource === undefined ? undefined : parseMirrorWhitelist(conf.mirrorSource)
  const whitelist = fromConf
    ? { source: 'conf', entries: fromConf }
    : { source: 'core-copy', entries: MIRROR_WHITELIST }

  const capture = (side, bin) => {
    const invocations = runInvocations(bin, contract.invocations ?? [])
    const output = (flag) => invocations.find((i) => i.argv.join(' ') === flag)?.output
    side.help_text = output('-h')
    side.version_output = output('--version')
    side.invocations = invocations.map(({ output: text, ...rest }) =>
      rest.status === 0 ? rest : { ...rest, output: text.slice(-2000) }
    )
    side.build = side.version_output === undefined ? null : (parseBinaryVersion(side.version_output) ?? null)
    side.commit = side.version_output === undefined ? null : (versionCommit(side.version_output) ?? null)
  }

  const localSide = (bin) => {
    const path = resolve(bin)
    const side = { source: 'bin', repo: null, platform, binary: { name: basename(path), path } }
    try {
      side.binary.sha256 = sha256File(path)
      capture(side, path)
      side.tag = side.build ? `b${side.build}` : null
    } catch (error) {
      side.capture_error = error.message
    }
    side.assets = null
    return side
  }

  const releaseSide = async (tag, repo) => {
    const side = { tag, repo, source: 'release', platform }
    try {
      const release = await githubRelease(repo, tag)
      if (!release) side.assets_error = `${repo} has no release ${tag}`
      else {
        side.assets = (release.assets ?? []).map((a) => a.name).sort()
        side.release = {
          published_at: release.published_at ?? null,
          commit: /^[0-9a-f]{40}$/.test(release.target_commitish ?? '') ? release.target_commitish : null,
        }
      }
    } catch (error) {
      side.assets_error = error.message
    }
    try {
      const build = fetchBuild({
        tag,
        repo,
        out: join(cache, repo.replace('/', '__'), tag, platform),
        model: false,
      })
      const asset = build.fixture.asset
      side.binary = { name: asset.name, sha256: asset.sha256, digest_verified: asset.digest_verified }
      capture(side, build.bin)
    } catch (error) {
      side.capture_error = error.message
    }
    return side
  }

  const candidate = opts['candidate-bin']
    ? localSide(opts['candidate-bin'])
    : await releaseSide(opts.candidate, opts.repo)

  let pin = null
  let resolution
  if (opts['pin-bin']) {
    pin = localSide(opts['pin-bin'])
    resolution = { source: 'bin', tag: pin.tag }
  } else if (opts.pin === 'none') resolution = { source: 'none', tag: null }
  else {
    let tag = opts.pin
    if (opts.pin === 'auto') {
      const pins = resolvePins({
        releases: conf.releases,
        manifest: conf.manifest,
        coreVersion: core.version,
      })
      tag =
        pins.per_platform['linux-x64']?.tag ??
        PIN_PLATFORMS.map((p) => pins.per_platform[p.platform]?.tag).find((t) => t) ??
        null
      resolution = { ...pins, tag }
    } else resolution = { source: 'override', tag }
    if (tag) {
      const candidateRepo = candidate.repo ?? DEFAULT_RELEASE_REPO
      const repo =
        opts['pin-repo'] ??
        (candidateRepo !== DEFAULT_RELEASE_REPO && (await githubRelease(candidateRepo, tag).catch(() => null))
          ? candidateRepo
          : DEFAULT_RELEASE_REPO)
      pin = await releaseSide(tag, repo)
    }
  }

  const upstreamRepo = contract.upstream?.repo ?? DEFAULT_RELEASE_REPO
  const { upstream, patch } = opts['skip-upstream']
    ? { upstream: { available: false, reason: 'skipped (--skip-upstream)' } }
    : await upstreamDiff(contract, candidate, pin, upstreamRepo, join(cache, 'llama.cpp.git'))

  return {
    inputs: {
      schema: SURFACE_INPUTS_SCHEMA,
      schema_version: 1,
      core,
      conf: { ref: conf.ref, sha: conf.sha, ...(conf.dir ? { dir: conf.dir } : {}) },
      candidate,
      pin,
      pin_resolution: resolution,
      whitelist,
      upstream,
    },
    patch,
  }
}

/** A side's upstream commit: the release's own when it is an upstream release, else what --version names. */
const commitOf = (side, upstreamRepo) =>
  (side.repo === upstreamRepo ? side.release?.commit : null) ?? side.commit ?? null

async function upstreamDiff(contract, candidate, pin, upstreamRepo, gitDir) {
  if (!pin) return { upstream: { available: false, reason: 'no pin to compare with' } }
  const base = commitOf(pin, upstreamRepo)
  const head = commitOf(candidate, upstreamRepo)
  if (!base || !head)
    return { upstream: { available: false, reason: `the ${base ? 'candidate' : 'pin'} names no commit` } }
  try {
    return gitDiff(contract, { base, head, candidate, pin, upstreamRepo, gitDir })
  } catch (error) {
    if (error.notUpstream) return { upstream: { available: false, reason: error.message } }
    console.warn(`upstream git failed (${error.message}); trying the compare API`)
    try {
      return { upstream: await compareApi(contract, base, head, upstreamRepo) }
    } catch (apiError) {
      return {
        upstream: { available: false, reason: `git: ${error.message}; compare API: ${apiError.message}` },
      }
    }
  }
}

/**
 * A blobless, shallow clone of upstream holding both commits; only the watched files' blobs are
 * fetched, in one batch. Reused across runs from the cache.
 */
function gitDiff(contract, { base, head, candidate, pin, upstreamRepo, gitDir }) {
  const watched = (contract.upstream?.watched_paths ?? []).map((w) => w.path)
  // History from two days before the older release: enough for `log base..head` either way round.
  const dates = [pin, candidate].map((s) => Date.parse(s.release?.published_at ?? '')).filter((d) => d > 0)
  const since = new Date(dates.length > 0 ? Math.min(...dates) : Date.now() - 90 * 86_400_000)
  since.setUTCDate(since.getUTCDate() - 2)
  const refs = ['+refs/heads/master:refs/remotes/origin/master']
  for (const side of [pin, candidate])
    if (side.repo === upstreamRepo && side.tag) refs.push(`+refs/tags/${side.tag}:refs/tags/${side.tag}`)
  const fetch = () =>
    git(gitDir, [
      'fetch',
      '-q',
      '--filter=blob:none',
      `--shallow-since=${since.toISOString().slice(0, 10)}`,
      '--no-tags',
      'origin',
      ...refs,
    ])
  const init = () => {
    rmSync(gitDir, { recursive: true, force: true })
    mkdirSync(gitDir, { recursive: true })
    git(gitDir, ['init', '-q', '--bare'])
    git(gitDir, ['remote', 'add', 'origin', `https://github.com/${upstreamRepo}.git`])
  }
  if (!existsSync(join(gitDir, 'HEAD'))) init()
  try {
    fetch()
  } catch {
    init()
    fetch()
  }
  const resolveCommit = (rev, side) => {
    const r = run('git', ['rev-parse', '--verify', '-q', `${rev}^{commit}`], {
      cwd: gitDir,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    })
    if (r.status === 0) return r.stdout.trim()
    const error = new Error(`${side} commit ${rev} is not in ${upstreamRepo} (a fork or a local build?)`)
    error.notUpstream = true
    throw error
  }
  const baseSha = resolveCommit(base, 'the pin')
  const headSha = resolveCommit(head, 'the candidate')

  // Blobs of the watched files at both ends, in one request instead of one per file.
  const oids = new Set(
    [baseSha, headSha].flatMap((rev) =>
      git(gitDir, ['ls-tree', '-r', '--object-only', rev, '--', ...watched])
        .split('\n')
        .filter(Boolean)
    )
  )
  const check = run('git', ['cat-file', '--batch-check'], {
    cwd: gitDir,
    input: [...oids].join('\n'),
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  })
  const missing = check.stdout
    .split('\n')
    .filter((l) => l.endsWith(' missing'))
    .map((l) => l.split(' ')[0])
  if (missing.length > 0)
    git(gitDir, [
      '-c',
      'fetch.negotiationAlgorithm=noop',
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      '--filter=blob:none',
      'origin',
      ...missing,
    ])

  const commits = parseGitLog(
    git(gitDir, ['log', '--format=%x1e%H%x09%s', '--name-only', `${baseSha}..${headSha}`])
  )
  const stats = parseNumstat(git(gitDir, ['diff', '--numstat', baseSha, headSha, '--', ...watched]))
  const present = new Set(
    git(gitDir, ['ls-tree', '-r', '--name-only', headSha, '--', ...watched])
      .split('\n')
      .filter(Boolean)
  )
  const upstream = {
    available: true,
    method: 'git',
    base: baseSha,
    head: headSha,
    commits,
    watched: watched.map((path) => {
      const stat = stats.find((s) => s.path === path)
      return {
        path,
        exists: present.has(path),
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      }
    }),
  }
  if (Array.isArray(contract.strings) && contract.strings.length > 0) {
    // The watched files at both ends (their blobs are here already), counted the way core matches.
    const files = (rev) =>
      Object.fromEntries(
        watched
          .map((path) => [path, run('git', ['show', `${rev}:${path}`], { cwd: gitDir })])
          .filter(([, r]) => r.status === 0)
          .map(([path, r]) => [path, r.stdout])
      )
    const pinCounts = countStrings(contract, files(baseSha))
    const headCounts = countStrings(contract, files(headSha))
    upstream.strings = Object.fromEntries(
      Object.keys(headCounts).map((id) => [id, { pin: pinCounts[id] ?? 0, candidate: headCounts[id] }])
    )
  }
  return { upstream, patch: git(gitDir, ['diff', baseSha, headSha, '--', ...watched]) }
}

/** GitHub's compare API: at most 250 commits and 300 files, and no files per commit. */
async function compareApi(contract, base, head, upstreamRepo) {
  const data = await githubJson(`/repos/${upstreamRepo}/compare/${base}...${head}`)
  const files = data.files ?? []
  const commits = (data.commits ?? []).map((c) => ({ sha: c.sha, subject: c.commit.message.split('\n')[0] }))
  return {
    available: true,
    method: 'compare-api',
    base: data.base_commit?.sha ?? base,
    head: data.commits?.at(-1)?.sha ?? head,
    truncated: (data.total_commits ?? commits.length) > commits.length || files.length >= 300,
    total_commits: data.total_commits ?? commits.length,
    commits: commits.reverse(),
    watched: (contract.upstream?.watched_paths ?? []).map(({ path }) => {
      const file = files.find((f) => f.filename === path)
      return {
        path,
        exists: file?.status !== 'removed',
        additions: file?.additions ?? 0,
        deletions: file?.deletions ?? 0,
      }
    }),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message)
      process.exit(2)
    }
  )
}
