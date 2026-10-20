#!/usr/bin/env node
// Is a llama.cpp build compatible with this core? The steps of
// .github/workflows/engine-candidate.yml, and the same check on this machine alone. --engine picks
// .github/engine-candidate/<engine>.json: upstream llama.cpp (`llamacpp-upstream`, b-tags from
// ggml-org, pinned by conf's release list) or PrismML's fork (`atomic-prism`, prism-b<N>-<sha7> tags
// from PrismML-Eng/llama.cpp, pinned by conf's PrismML manifest, live tests on a Bonsai GGUF).
//
//   resolve  fix core and conf to one commit each, pick the candidate (the newest complete tag of
//            --repo unless --tag), check its archives are all up, compute the pin per platform and
//            the live matrix; writes resolve.json (and $GITHUB_OUTPUT in CI).
//   live     run the live files on a fetched build (--fixtures, the dir fetch-live-fixtures wrote)
//            and write Vitest's JSON report (--report).
//   cell     turn what a job left behind into one cell: --kind live (fixture.json + the report) or
//            --kind core (step outcomes + reports).
//   results  resolve.json + the surface report + every cell → results.json and results.md;
//            writes `status` to $GITHUB_OUTPUT.
//   local    all of it here, for this host only: `npm run engine:check -- --tag b11617`,
//            `-- --repo AtomicBot-ai/atomic-chat-conf --tag b11463`, `-- --bin <llama-server>`,
//            `-- --tag b10875 --pin b10874 --suites live`,
//            `-- --engine atomic-prism --tag prism-b10787-73bfe6c`. Writes results.json, results.md,
//            report.json and report.md into --out (default .engine-check/); exit 0 only on pass.
//
// CI passes its inputs as env (ENGINE, TAG, REPO, CANDIDATE_ID, CORE_REF, PIN, CONF_REF, SUITES);
// flags win over env; an empty REPO is the engine's own (`default_repo`). GITHUB_TOKEN / GH_TOKEN
// lift the API rate limit.
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  candidateCompleteness,
  MIRROR_WHITELIST,
  parseBinaryVersion,
  parseMirrorWhitelist,
  versionCommit,
} from './lib/engine-surface.mjs'
import {
  buildResults,
  CANDIDATE_ID_RE,
  coreCell,
  liveCell,
  renderResultsMarkdown,
  RESOLVE_SCHEMA,
} from './lib/engine-results.mjs'
import {
  coreIdentity,
  engineConfig,
  engineContract,
  enginePins,
  engineTagRe,
  fetchBuild,
  githubRelease,
  githubReleases,
  hostPlatform,
  loadConf,
  ROOT,
  run,
  sha256File,
} from './lib/engine-io.mjs'

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const readJsonIf = (path) => (path && existsSync(path) ? readJson(path) : undefined)
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
/** The prefix of the env the engine's live files read: `<prefix>_BIN`, `_MODEL`, `_TAG`. */
const liveEnvPrefix = (config) => config.live_env_prefix ?? 'ATOMIC_LIVE_UPSTREAM'

/** `key=value` lines for later steps; multi-line values never occur (JSON is one line). */
function githubOutput(values) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  appendFileSync(
    file,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join('')
  )
}

/** Files under protected paths that `sha` changes against origin/main: someone loosening the check. */
function protectedChanges(config, sha) {
  if (!sha) return null
  const base = run('git', ['merge-base', 'origin/main', sha], { cwd: ROOT })
  if (base.status !== 0) return null
  const diff = run('git', ['diff', '--name-only', base.stdout.trim(), sha, '--', ...config.protected_paths], {
    cwd: ROOT,
  })
  return diff.status === 0 ? diff.stdout.split('\n').filter(Boolean).sort() : null
}

/**
 * Everything one run is about, fixed once: core and conf commits, the candidate and whether its
 * archives are all up, the pin per platform, and the live cells to run. `bin` is a local binary
 * instead of a release (local runs only); `platforms` the platforms this run covers.
 */
async function resolveRun({
  engine,
  tag,
  repo,
  candidateId,
  coreRef,
  pin,
  confRef,
  confDir,
  suites,
  bin,
  platforms,
}) {
  const config = engineConfig(engine)
  const contract = engineContract(config)
  const tagRe = engineTagRe(config)
  const isTag = (v) => tagRe.test(v ?? '')
  const defaultRepo = config.default_repo
  const errors = []
  if (!CANDIDATE_ID_RE.test(candidateId)) throw new Error(`candidate_id must match ${CANDIDATE_ID_RE}`)
  if (!['all', 'live'].includes(suites)) throw new Error('suites is all or live')
  if (tag && !isTag(tag)) throw new Error(`tag must match ${tagRe} for ${engine}`)
  if (pin && !['auto', 'none'].includes(pin) && !isTag(pin))
    throw new Error(`pin is auto, none or a tag matching ${tagRe}`)

  const core = coreIdentity()
  const conf = await loadConf(confDir ? { dir: confDir } : { ref: confRef })
  errors.push(...conf.errors)
  // conf mirrors upstream builds only: a fork that core downloads from its own releases has no whitelist.
  const whitelist =
    config.mirror === false
      ? null
      : (conf.mirrorSource && parseMirrorWhitelist(conf.mirrorSource)) || MIRROR_WHITELIST
  const keys = platforms.map((p) => p.platform)

  let candidate
  if (bin) {
    const out = run(bin, ['--version'], { cwd: dirname(bin), timeout: 60_000 })
    const output = `${out.stdout}\n${out.stderr}`
    const build = parseBinaryVersion(output)
    if (build === undefined) throw new Error(`${bin} --version names no build:\n${output}`)
    candidate = {
      repo: null,
      tag: `b${build}`,
      source: 'bin',
      commit: versionCommit(output) ?? null,
      binary: { name: basename(bin), path: resolve(bin), sha256: sha256File(bin) },
      complete: true,
      missing: [],
      core_assets: [],
    }
  } else {
    let release
    if (tag) {
      release = await githubRelease(repo, tag)
      if (!release) throw new Error(`${repo} has no release ${tag}`)
    } else {
      const releases = (await githubReleases(repo)).filter((r) => !r.draft && isTag(r.tag_name))
      release = releases.find(
        (r) =>
          candidateCompleteness(
            contract,
            whitelist,
            r.tag_name,
            (r.assets ?? []).map((a) => a.name),
            keys
          ).complete
      )
      if (!release) throw new Error(`no complete tag among the ${releases.length} newest releases of ${repo}`)
    }
    const names = (release.assets ?? []).map((a) => a.name).sort()
    const completeness = candidateCompleteness(contract, whitelist, release.tag_name, names, keys)
    const coreAssets = names.filter((n) =>
      (contract.assets?.core_backends ?? []).some((b) =>
        new RegExp(`^${b.asset.replace('{tag}', release.tag_name)}$`).test(n)
      )
    )
    candidate = {
      repo,
      tag: release.tag_name,
      source: 'release',
      commit:
        repo === defaultRepo && /^[0-9a-f]{40}$/.test(release.target_commitish ?? '')
          ? release.target_commitish
          : null,
      published_at: release.published_at ?? null,
      ...completeness,
      core_assets: coreAssets,
    }
  }

  let pins
  if (pin && isTag(pin))
    pins = {
      source: 'override',
      per_platform: Object.fromEntries(keys.map((k) => [k, { tag: pin }])),
    }
  else if (pin === 'none')
    pins = { source: 'none', per_platform: Object.fromEntries(keys.map((k) => [k, { tag: null }])) }
  else pins = enginePins(config, conf, core.version)
  const pinTag =
    pins.per_platform['linux-x64']?.tag ?? keys.map((k) => pins.per_platform[k]?.tag).find(Boolean) ?? null
  // The pin's archives from the candidate's repo when it has them (the mirror's signed bytes against
  // the mirror's), else from the engine's own repo.
  let pinRepo = null
  if (pinTag)
    pinRepo =
      candidate.repo &&
      candidate.repo !== defaultRepo &&
      (await githubRelease(candidate.repo, pinTag).catch(() => null))
        ? candidate.repo
        : defaultRepo

  const liveMatrix = []
  for (const { platform, runner } of platforms) {
    liveMatrix.push({
      platform,
      os: runner,
      role: 'candidate',
      tag: candidate.tag,
      repo: candidate.repo ?? 'local',
    })
    const tagHere = pins.per_platform[platform]?.tag
    if (tagHere && tagHere !== candidate.tag)
      liveMatrix.push({ platform, os: runner, role: 'pin', tag: tagHere, repo: pinRepo })
  }

  return {
    schema: RESOLVE_SCHEMA,
    schema_version: 1,
    engine,
    candidate_id: candidateId,
    suites,
    core: {
      ref: coreRef ?? null,
      sha: core.sha,
      version: core.version,
      protected_changes: protectedChanges(config, core.sha),
    },
    conf: { ref: conf.ref, sha: conf.sha },
    candidate,
    pin: { ...pins, tag: pinTag, repo: pinRepo },
    platforms,
    live_matrix: liveMatrix,
    errors,
  }
}

const env = (name, fallback) =>
  process.env[name] === undefined || process.env[name] === '' ? fallback : process.env[name]

async function cmdResolve(argv) {
  const { values: o } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'engine': { type: 'string', default: env('ENGINE', 'llamacpp-upstream') },
      'tag': { type: 'string', default: env('TAG', '') },
      'repo': { type: 'string', default: env('REPO', '') },
      'candidate-id': { type: 'string', default: env('CANDIDATE_ID', 'manual') },
      'core-ref': { type: 'string', default: env('CORE_REF', '') },
      'pin': { type: 'string', default: env('PIN', 'auto') },
      'conf-ref': { type: 'string', default: env('CONF_REF', 'main') },
      'suites': { type: 'string', default: env('SUITES', 'all') },
      'out': { type: 'string', default: '.engine-check/resolve' },
    },
  })
  const config = engineConfig(o.engine)
  const resolved = await resolveRun({
    engine: o.engine,
    tag: o.tag || undefined,
    repo: o.repo || config.default_repo,
    candidateId: o['candidate-id'],
    coreRef: o['core-ref'] || null,
    pin: o.pin,
    confRef: o['conf-ref'],
    suites: o.suites,
    platforms: config.platforms,
  })
  writeJson(join(o.out, 'resolve.json'), resolved)
  githubOutput({
    tag: resolved.candidate.tag,
    repo: resolved.candidate.repo,
    pin: resolved.pin.tag ?? '',
    pin_repo: resolved.pin.repo ?? '',
    conf_sha: resolved.conf.sha ?? '',
    core_sha: resolved.core.sha ?? '',
    complete: String(resolved.candidate.complete),
    live_matrix: JSON.stringify(resolved.live_matrix),
  })
  console.log(
    `candidate ${resolved.candidate.repo}@${resolved.candidate.tag} (${resolved.candidate.complete ? 'complete' : `incomplete: ${JSON.stringify(resolved.candidate.missing)}`}), ` +
      `pin ${resolved.pin.tag ?? 'none'} (${resolved.pin.source}), core ${resolved.core.sha}, conf ${resolved.conf.sha}`
  )
  return 0
}

/** Where the live contract probe of a run writes observed.json: beside its Vitest report. */
const observedDir = (report) => join(dirname(report), `${basename(report, '.json')}.observed`)

/** Run the engine's live files against a fetched build; the report lands at `report`. */
function runLive({ config, fixtures, report, tag, bin, model }) {
  const read = (name) => readFileSync(join(fixtures, name), 'utf8').trim()
  const prefix = liveEnvPrefix(config)
  const vitest = join(ROOT, 'node_modules/vitest/vitest.mjs')
  mkdirSync(dirname(report), { recursive: true })
  const r = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--project',
      'live',
      ...config.live_files,
      '--fileParallelism=false',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${report}`,
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        ATOMIC_LIVE: '1',
        [`${prefix}_BIN`]: bin ?? read('bin-path.txt'),
        [`${prefix}_MODEL`]: model ?? read('model-path.txt'),
        [`${prefix}_TAG`]: tag ?? read('tag.txt'),
        // The live contract probe writes observed.json here; the cell reads it.
        ATOMIC_LIVE_REPORT_DIR: observedDir(report),
      },
    }
  )
  return r.status ?? 1
}

function cmdLive(argv) {
  const { values: o } = parseArgs({
    args: argv,
    strict: true,
    options: {
      engine: { type: 'string', default: env('ENGINE', 'llamacpp-upstream') },
      fixtures: { type: 'string' },
      report: { type: 'string' },
    },
  })
  if (!o.fixtures || !o.report) throw new Error('live needs --fixtures <dir> and --report <file>')
  runLive({ config: engineConfig(o.engine), fixtures: o.fixtures, report: o.report })
  // The verdict is the cell's to give, from the report: a red test is not a tool failure.
  return 0
}

function cmdCell(argv) {
  const { values: o } = parseArgs({
    args: argv,
    strict: true,
    options: {
      engine: { type: 'string', default: env('ENGINE', 'llamacpp-upstream') },
      kind: { type: 'string' },
      platform: { type: 'string' },
      os: { type: 'string' },
      role: { type: 'string' },
      tag: { type: 'string' },
      repo: { type: 'string' },
      fixtures: { type: 'string' },
      vitest: { type: 'string', multiple: true, default: [] },
      step: { type: 'string', multiple: true, default: [] },
      shard: { type: 'string' },
      out: { type: 'string' },
    },
  })
  if (!o.out || !o.platform) throw new Error('cell needs --platform and --out')
  const config = engineConfig(o.engine)
  let cell
  if (o.kind === 'live') {
    cell = liveCell({
      platform: o.platform,
      os: o.os,
      role: o.role,
      tag: o.tag ?? null,
      repo: o.repo ?? null,
      fixture: readJsonIf(o.fixtures && join(o.fixtures, 'fixture.json')) ?? null,
      vitest: readJsonIf(o.vitest[0]),
      observed: o.vitest[0] ? readJsonIf(join(observedDir(o.vitest[0]), 'observed.json')) : undefined,
      required: config.required_live_tests,
      ...(o.fixtures && existsSync(join(o.fixtures, 'fixture.json'))
        ? {}
        : { error: 'the build was not fetched' }),
    })
  } else if (o.kind === 'core') {
    const steps = Object.fromEntries(
      o.step.map((s) => s.split('=')).map(([k, ...v]) => [k, v.join('=') || 'missing'])
    )
    cell = coreCell({
      platform: o.platform,
      os: o.os,
      steps,
      vitest: o.vitest.map(readJsonIf).filter(Boolean),
      expected: config.core_suites,
      ...(o.shard ? { shard: o.shard } : {}),
    })
  } else throw new Error('--kind is live or core')
  writeJson(o.out, cell)
  console.log(`${cell.kind} ${cell.platform}${cell.role ? ` ${cell.role}` : ''}: ${cell.status}`)
  return 0
}

/** Every `*.json` under `dir` that is a cell. */
function findCells(dir) {
  const out = []
  const walk = (d) => {
    for (const name of existsSync(d) ? readdirSync(d) : []) {
      const path = join(d, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.json')) {
        const value = readJsonIf(path)
        if (value?.schema === 'atomic-engine-candidate-cell') out.push(value)
      }
    }
  }
  walk(dir)
  return out
}

function writeResults({ out, run: runInfo, config, resolve: resolved, surface, cells, platforms }) {
  const results = buildResults({
    run: runInfo,
    config,
    resolve: resolved,
    surface,
    cells,
    platforms,
    now: new Date().toISOString(),
  })
  writeJson(join(out, 'results.json'), results)
  const md = renderResultsMarkdown(results)
  writeFileSync(join(out, 'results.md'), md)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
  githubOutput({ status: results.status })
  console.log(`${results.status}: ${join(out, 'results.md')}`)
  return results
}

function cmdResults(argv) {
  const { values: o } = parseArgs({
    args: argv,
    strict: true,
    options: {
      engine: { type: 'string', default: env('ENGINE', 'llamacpp-upstream') },
      artifacts: { type: 'string' },
      out: { type: 'string', default: '.engine-check/results' },
    },
  })
  if (!o.artifacts) throw new Error('results needs --artifacts <dir>')
  const config = engineConfig(o.engine)
  const find = (name) => {
    const hits = []
    const walk = (d) => {
      for (const entry of existsSync(d) ? readdirSync(d) : []) {
        const path = join(d, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (entry === name) hits.push(path)
      }
    }
    walk(o.artifacts)
    return hits[0]
  }
  const resolved = readJsonIf(find('resolve.json'))
  const surface = readJsonIf(find('report.json'))
  mkdirSync(o.out, { recursive: true })
  for (const name of ['resolve.json', 'report.json', 'report.md']) {
    const path = find(name)
    if (path) copyFileSync(path, join(o.out, name))
  }
  const server = process.env.GITHUB_SERVER_URL
  const repository = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  writeResults({
    out: o.out,
    run: {
      mode: 'ci',
      id: runId ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      url: server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : null,
      candidate_id: resolved?.candidate_id ?? env('CANDIDATE_ID', null),
      suites: resolved?.suites ?? env('SUITES', 'all'),
    },
    config,
    resolve: resolved,
    surface,
    cells: findCells(o.artifacts),
    platforms: config.platforms.map((p) => p.platform),
  })
  return 0
}

/** Run `node <args>` from the repo root and report its exit status. */
const node = (args, extra = {}) =>
  spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', ...extra }).status ?? 1

async function cmdLocal(argv) {
  const { values: o } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'engine': { type: 'string', default: 'llamacpp-upstream' },
      'tag': { type: 'string' },
      'bin': { type: 'string' },
      'repo': { type: 'string' },
      'pin': { type: 'string', default: 'auto' },
      'conf': { type: 'string' },
      'conf-ref': { type: 'string', default: 'main' },
      'suites': { type: 'string', default: 'live' },
      'candidate-id': { type: 'string', default: 'local' },
      'out': { type: 'string', default: '.engine-check' },
      'skip-upstream': { type: 'boolean', default: false },
    },
  })
  if (o.tag && o.bin) throw new Error('give --tag or --bin, not both')
  const out = resolve(o.out)
  const cache = join(out, 'cache')
  const config = engineConfig(o.engine)
  const platform = hostPlatform()
  const platforms = config.platforms.filter((p) => p.platform === platform)
  if (platforms.length === 0) platforms.push({ platform, runner: 'local' })

  const resolved = await resolveRun({
    engine: o.engine,
    tag: o.tag,
    repo: o.repo ?? config.default_repo,
    candidateId: o['candidate-id'],
    coreRef: null,
    pin: o.pin,
    confRef: o['conf-ref'],
    confDir: o.conf ? resolve(o.conf) : undefined,
    suites: o.suites,
    bin: o.bin ? resolve(o.bin) : undefined,
    platforms,
  })
  writeJson(join(out, 'resolve.json'), resolved)
  const cand = resolved.candidate
  console.log(
    `\n== candidate ${cand.repo ?? 'local'}@${cand.tag}, pin ${resolved.pin.tag ?? 'none'} (${resolved.pin.source})`
  )
  if (!cand.complete) console.log(`candidate incomplete: ${JSON.stringify(cand.missing)}`)

  // Surface: the same script CI runs, on this host's binaries.
  console.log('\n== surface')
  const surfaceArgs = [
    join(ROOT, 'scripts/engine-surface-diff.mjs'),
    '--engine',
    o.engine,
    ...(o.bin ? ['--candidate-bin', resolve(o.bin)] : ['--candidate', cand.tag, '--repo', cand.repo]),
    '--pin',
    resolved.pin.tag ?? 'none',
    ...(resolved.pin.repo ? ['--pin-repo', resolved.pin.repo] : []),
    ...(o.conf ? ['--conf', resolve(o.conf)] : ['--conf-ref', resolved.conf.sha ?? o['conf-ref']]),
    '--out',
    join(out, 'surface'),
    '--cache',
    cache,
    ...(o['skip-upstream'] ? ['--skip-upstream'] : []),
  ]
  node(surfaceArgs)
  for (const name of ['report.json', 'report.md'])
    if (existsSync(join(out, 'surface', name))) copyFileSync(join(out, 'surface', name), join(out, name))

  // Live: the pin first (its fetch brings the model a local --bin needs), then the candidate.
  const cells = []
  let model = process.env[`${liveEnvPrefix(config)}_MODEL`] || undefined
  const ordered = [...resolved.live_matrix].sort((a, b) => (a.role === 'pin' ? -1 : b.role === 'pin' ? 1 : 0))
  if (o.bin && !model && !ordered.some((m) => m.role === 'pin')) {
    // No pin to bring the model: fetch the candidate's own tag from the engine's repo for it.
    model = fetchBuild({
      tag: cand.tag,
      repo: config.default_repo,
      out: join(cache, 'model'),
      engine: o.engine,
    }).model
  }
  for (const m of ordered) {
    console.log(`\n== live ${m.platform} ${m.role} ${m.tag}`)
    const report = join(out, 'cells', `live-${m.platform}-${m.role}.vitest.json`)
    let fixtures
    let error
    try {
      if (m.role === 'candidate' && o.bin) {
        fixtures = join(out, 'cells', 'local-build')
        writeJson(join(fixtures, 'fixture.json'), {
          repo: null,
          tag: cand.tag,
          asset: { name: cand.binary.name, sha256: cand.binary.sha256, digest_verified: null },
          model: null,
          version_output: null,
        })
        runLive({ config, fixtures, report, tag: cand.tag, bin: cand.binary.path, model })
      } else {
        const build = fetchBuild({
          tag: m.tag,
          repo: m.repo,
          out: join(cache, m.repo.replace('/', '__'), m.tag, m.platform),
          model: model === undefined,
          engine: o.engine,
        })
        fixtures = build.dir
        model ??= build.model
        runLive({ config, fixtures, report, model })
      }
    } catch (e) {
      error = e.message
      console.error(error)
    }
    const cell = liveCell({
      platform: m.platform,
      os: 'local',
      role: m.role,
      tag: m.tag,
      repo: m.repo,
      fixture: readJsonIf(fixtures && join(fixtures, 'fixture.json')) ?? null,
      vitest: readJsonIf(report),
      observed: readJsonIf(join(observedDir(report), 'observed.json')),
      required: config.required_live_tests,
      ...(error ? { error } : {}),
    })
    writeJson(join(out, 'cells', `live-${m.platform}-${m.role}.json`), cell)
    cells.push(cell)
  }

  if (o.suites === 'all') {
    console.log('\n== core suites')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const vitest = join(ROOT, 'node_modules/vitest/vitest.mjs')
    const unitReport = join(out, 'cells', 'core-unit.vitest.json')
    const e2eReport = join(out, 'cells', 'core-e2e.vitest.json')
    const outcome = (status) => (status === 0 ? 'success' : 'failure')
    const steps = {}
    steps.unit = outcome(
      node([
        vitest,
        'run',
        '--project',
        'unit',
        '--project',
        'contract',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${unitReport}`,
      ])
    )
    steps.build = outcome(
      spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
        .status
    )
    steps.build_bin =
      steps.build === 'success'
        ? outcome(
            spawnSync(npm, ['run', 'build:bin'], {
              cwd: ROOT,
              stdio: 'inherit',
              shell: process.platform === 'win32',
            }).status
          )
        : 'skipped'
    steps.e2e =
      steps.build_bin === 'success'
        ? outcome(
            node([
              vitest,
              'run',
              '--project',
              'e2e',
              '--reporter=default',
              '--reporter=json',
              `--outputFile.json=${e2eReport}`,
            ])
          )
        : 'skipped'
    const cell = coreCell({
      platform,
      os: 'local',
      steps,
      vitest: [readJsonIf(unitReport), readJsonIf(e2eReport)].filter(Boolean),
      expected: config.core_suites,
    })
    writeJson(join(out, 'cells', `core-${platform}.json`), cell)
    cells.push(cell)
  }

  console.log('\n== results')
  const results = writeResults({
    out,
    run: { mode: 'local', id: null, url: null, candidate_id: o['candidate-id'], suites: o.suites },
    config,
    resolve: resolved,
    surface: readJsonIf(join(out, 'report.json')),
    cells,
    platforms: platforms.map((p) => p.platform),
  })
  console.log(`\n${relative(process.cwd(), join(out, 'results.md'))}: ${results.status}`)
  for (const r of results.reasons) console.log(`  ${r.status} ${r.code}: ${r.message}`)
  return results.status === 'pass' ? 0 : 1
}

const COMMANDS = { resolve: cmdResolve, live: cmdLive, cell: cmdCell, results: cmdResults, local: cmdLocal }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...rest] = process.argv.slice(2)
  const command = COMMANDS[name]
  if (!command) {
    console.error(`usage: engine-candidate.mjs <${Object.keys(COMMANDS).join('|')}> [options]`)
    process.exit(2)
  }
  Promise.resolve()
    .then(() => command(rest))
    .then(
      (code) => process.exit(code),
      (error) => {
        console.error(error.message)
        process.exit(2)
      }
    )
}
