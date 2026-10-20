// The surface diff of an upstream llama.cpp candidate: everything about a build that can be checked
// without running a model — its `-h`, `--version`, the invocations core makes, the release's
// archives, and what changed upstream since the build core runs today (the pin) — held to the engine
// contract (test/fixtures/llamacpp/engine-contract.json). Pure: `scripts/engine-surface-diff.mjs`
// gathers the inputs, `buildReport` turns them into `report.json`, `renderMarkdown` into `report.md`.
// Findings carry stable ids (`check/subject`) so runs can be compared; `now` is a parameter.
import { checkHelp, diffHelp, MIN_HELP_OPTIONS, parseLlamaHelp } from './llama-help.mjs'
import { engineTagBuild } from './engine-pin.mjs'

export const SURFACE_REPORT_SCHEMA = 'atomic-engine-surface-report'
export const SURFACE_INPUTS_SCHEMA = 'atomic-engine-surface-inputs'

/** Every check, in report order. */
export const CHECKS = [
  { id: 'help.parse', title: '`-h` reads as a help screen' },
  { id: 'help.required_flags', title: 'the build knows every flag core emits for it' },
  { id: 'help.flag_values', title: 'and every closed value' },
  { id: 'help.deprecated', title: 'none of them is deprecated' },
  { id: 'help.env', title: 'the build reads the variables core sets' },
  { id: 'help.diff', title: '`-h` changes since the pin' },
  { id: 'invocations.exit', title: 'the invocations core makes exit 0' },
  { id: 'version.output', title: '`--version` names the build' },
  { id: 'assets.core_backends', title: 'an archive for every backend core installs' },
  { id: 'assets.mirror', title: "every archive conf's mirror requires" },
  { id: 'upstream.watched_paths', title: 'changes to the sources core depends on' },
  { id: 'upstream.contract_strings', title: 'the strings core matches are still printed' },
  { id: 'upstream.release_notes', title: 'commits announcing a removal or rename' },
]

const HINTS = {
  'help.parse': 'Look at help-candidate.txt; the tokenizer is scripts/lib/llama-help.mjs.',
  'help.required_flags':
    'Gate the flag by build in the argv builder (a *_MIN_BUILD) and regenerate the engine contract.',
  'help.flag_values': 'Gate or drop the value in the argv builder and regenerate the engine contract.',
  'help.deprecated': 'Plan the removal: gate the flag by build or drop it before upstream removes it.',
  'help.env': 'Core sets this variable for llama-server; find what replaced it upstream.',
  'help.diff': 'Check that the removal is the one a build gate anticipates.',
  'invocations.exit': 'Core runs this at install, -h probe or device listing; read what the binary printed.',
  'version.output':
    'Core reads the build from --version (parseBinaryVersion); a macOS install refuses a pack whose build differs.',
  'assets.core_backends':
    'Archive names come from src/backend/catalog/archive.ts; without its CPU archive a platform gets no llama.cpp.',
  'assets.mirror': "conf's mirror refuses a tag without every required archive (.github/scripts/mirror.mjs).",
  'upstream.watched_paths': 'Update the contract’s upstream.watched_paths.',
  'upstream.contract_strings': 'Core matches this text; find what upstream prints now.',
  'upstream.release_notes': 'Read the commit: it may remove or rename something core uses.',
}

/**
 * Copy of `WHITELIST` in conf's `.github/scripts/mirror.mjs` (conf 159ed3a), used when conf's own
 * cannot be read. test/contract/engine-surface.test.ts holds it to what conf really mirrored.
 */
export const MIRROR_WHITELIST = [
  { platform: 'windows', pattern: 'win-cpu-x64\\.zip', required: true },
  { platform: 'windows', pattern: 'win-cuda-\\d+\\.\\d+-x64\\.zip', required: true },
  { platform: 'windows', pattern: 'win-vulkan-x64\\.zip', required: true },
  { platform: 'windows', pattern: 'win-rocm-[\\d.]+-x64\\.zip', required: false },
  { platform: 'windows', pattern: 'win-cpu-arm64\\.zip', required: true },
  { platform: 'windows', pattern: 'win-opencl-adreno-arm64\\.zip', required: false },
  { platform: 'windows', pattern: 'win-cuda-\\d+\\.\\d+-arm64\\.zip', required: false },
  { platform: 'linux', pattern: 'ubuntu-x64\\.tar\\.gz', required: true },
  { platform: 'linux', pattern: 'ubuntu-vulkan-x64\\.tar\\.gz', required: true },
  { platform: 'linux', pattern: 'ubuntu-arm64\\.tar\\.gz', required: true },
  { platform: 'linux', pattern: 'ubuntu-vulkan-arm64\\.tar\\.gz', required: false },
  { platform: 'linux', pattern: 'ubuntu-cuda-\\d+\\.\\d+-arm64\\.tar\\.gz', required: false },
  { platform: 'macos', pattern: 'macos-arm64\\.tar\\.gz', required: true },
]

/**
 * The `WHITELIST` array of conf's `mirror.mjs`, read from its source text (exported or not, nothing
 * is executed). `undefined` when the text holds no such array or an entry does not read.
 */
export function parseMirrorWhitelist(source) {
  const block = /\bWHITELIST\s*=\s*\[([\s\S]*?)\n\]/.exec(source)
  if (!block) return undefined
  const entries = []
  for (const [, body] of block[1].matchAll(/\{([^{}]*)\}/g)) {
    const platform = /platform:\s*'([^']*)'/.exec(body)?.[1]
    const pattern = /pattern:\s*'((?:[^'\\]|\\.)*)'/.exec(body)?.[1]
    const required = /required:\s*(true|false)/.exec(body)?.[1]
    if (!platform || pattern === undefined || !required) return undefined
    entries.push({ platform, pattern: pattern.replace(/\\\\/g, '\\'), required: required === 'true' })
  }
  return entries.length > 0 ? entries : undefined
}

const parseU32 = (s) => (/^\+?\d+$/.test(s) && Number(s) <= 4294967295 ? Number(s) : undefined)

/** The build `llama-server --version` prints, as core reads it (`parseBinaryVersion`). */
export function parseBinaryVersion(output) {
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('version:')) continue
    const tokens = line
      .slice('version:'.length)
      .split(/\s+/)
      .filter((t) => t !== '')
    if (tokens[0] !== undefined) {
      const build = parseU32(tokens[0])
      if (build !== undefined) return build
    }
    const index = tokens.findIndex((t) => t.replace(/^\(+/, '') === 'build')
    const next = index < 0 ? undefined : tokens[index + 1]
    if (next === undefined) continue
    const build = parseU32(next.replace(/[^0-9]+$/, ''))
    if (build !== undefined) return build
  }
  return undefined
}

/** The commit `--version` names: `(build N, commit abc1234)` or the older `version: N (abc1234)`. */
export function versionCommit(output) {
  return (
    /\bcommit ([0-9a-f]{7,40})\b/.exec(output)?.[1] ??
    /^version:\s*\d+\s*\(([0-9a-f]{7,40})\)/m.exec(output)?.[1]
  )
}

const finding = (check, subject, severity, message, evidence) => ({
  id: subject === undefined ? check : `${check}/${subject}`,
  check,
  severity,
  ...(subject === undefined ? {} : { subject }),
  message,
  ...(evidence === undefined ? {} : { evidence }),
})

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const contractAssetRe = (pattern, tag) => new RegExp(`^${pattern.replace('{tag}', escapeRegExp(tag))}$`)
const mirrorRe = (pattern, tag) => new RegExp(`^llama-${escapeRegExp(tag)}-bin-${pattern}$`)
/** `llama-<tag>-bin-<rest>` → `<rest>` (`win-vulkan-arm64.zip`). */
const binRest = (name, tag) => new RegExp(`^llama-${escapeRegExp(tag)}-bin-(.+)$`).exec(name)?.[1]
const sameNames = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
/** Archives of the platforms core ships for, as opposed to android, s390x, the xcframework. */
const CORE_PLATFORM = /^(win|ubuntu|macos)-.*-(x64|arm64)\.(zip|tar\.gz)$/

/**
 * The release's archives against what core installs (`assets.core_backends` of the contract) and
 * what conf's mirror requires (its whitelist). `pin` is the pin's archive list from the same repo:
 * an archive the pin had and the candidate lacks is a loss; one neither had is not. A `null`
 * whitelist is an engine conf does not mirror (PrismML: core downloads from the fork itself).
 */
export function checkAssets(contract, { candidate, pin, whitelist }) {
  const findings = []
  const backends = contract.assets?.core_backends ?? []
  if (backends.length === 0)
    findings.push(finding('assets.core_backends', undefined, 'error', 'the contract lists no core backends'))
  const consumed = new Set()
  for (const b of backends) {
    const now = candidate.assets.filter((n) => contractAssetRe(b.asset, candidate.tag).test(n)).sort()
    for (const n of now) consumed.add(n)
    const before = pin ? pin.assets.filter((n) => contractAssetRe(b.asset, pin.tag).test(n)).sort() : null
    const subject = `${b.platform}/${b.backend}`
    if (now.length === 0) {
      const missing = `no ${b.backend} archive in ${candidate.tag}`
      const [severity, message] =
        before !== null && before.length === 0
          ? ['info', `${missing}, nor in ${pin.tag}`]
          : b.cpu
            ? ['break', `${missing}: ${b.platform} gets no llama.cpp`]
            : before !== null
              ? ['warn', `${missing}, which ${pin.tag} had: core stops offering it on ${b.platform}`]
              : ['info', `${missing}: core does not offer it on ${b.platform}`]
      findings.push(
        finding('assets.core_backends', subject, severity, message, {
          pattern: b.asset,
          ...(before && before.length > 0 ? { pin: before } : {}),
        })
      )
    } else if (before && before.length > 0) {
      const moved = !sameNames(
        before.map((n) => binRest(n, pin.tag)),
        now.map((n) => binRest(n, candidate.tag))
      )
      if (moved)
        findings.push(
          finding(
            'assets.core_backends',
            subject,
            'info',
            `${b.backend} moved: ${before.map((n) => binRest(n, pin.tag)).join(', ')} → ${now.map((n) => binRest(n, candidate.tag)).join(', ')}`
          )
        )
    }
  }
  const pinRests = pin ? new Set(pin.assets.map((n) => binRest(n, pin.tag)).filter(Boolean)) : null
  const unused = candidate.assets
    .filter((n) => !consumed.has(n))
    .map((n) => binRest(n, candidate.tag))
    .filter((rest) => rest !== undefined && CORE_PLATFORM.test(rest))
    .sort()
  const fresh = pinRests ? unused.filter((rest) => !pinRests.has(rest)) : []
  for (const rest of fresh)
    findings.push(
      finding(
        'assets.core_backends',
        `new/${rest}`,
        'info',
        `new in ${candidate.tag}: ${rest}, which no backend core installs takes`
      )
    )
  const others = unused.filter((rest) => !fresh.includes(rest))
  if (others.length > 0)
    findings.push(
      finding(
        'assets.core_backends',
        'unconsumed',
        'info',
        `${others.length} archive(s) for the platforms core ships that no backend it installs takes`,
        { archives: others }
      )
    )

  if (whitelist === null) return findings
  if (!whitelist || whitelist.length === 0)
    findings.push(finding('assets.mirror', undefined, 'error', "conf's mirror whitelist is unknown"))
  for (const entry of whitelist ?? []) {
    const now = candidate.assets.filter((n) => mirrorRe(entry.pattern, candidate.tag).test(n))
    if (now.length > 0) continue
    const had = pin ? pin.assets.some((n) => mirrorRe(entry.pattern, pin.tag).test(n)) : false
    if (entry.required)
      findings.push(
        finding(
          'assets.mirror',
          entry.pattern,
          'break',
          `${candidate.tag} has no archive for ${entry.pattern}, which the mirror requires: conf cannot mirror it`
        )
      )
    else if (had)
      findings.push(
        finding(
          'assets.mirror',
          entry.pattern,
          'warn',
          `${candidate.tag} has no archive for ${entry.pattern}, which ${pin.tag} had: the mirror drops that tier`
        )
      )
  }
  return findings
}

/**
 * Whether a release can be tested yet: ggml-org publishes a tag before all of its archives are up.
 * Complete = every archive the mirror requires (none for a `null` whitelist: an engine conf does not
 * mirror) and the CPU archive of each of `platforms` (default: every platform core ships for; the
 * mirror carries no macos-x64, so a check of the mirror names the platforms it runs on).
 */
export function candidateCompleteness(contract, whitelist, tag, assets, platforms) {
  const missing = []
  for (const entry of whitelist ?? [])
    if (entry.required && !assets.some((n) => mirrorRe(entry.pattern, tag).test(n)))
      missing.push({ kind: 'mirror', pattern: entry.pattern })
  for (const b of contract.assets?.core_backends ?? [])
    if (
      b.cpu &&
      (!platforms || platforms.includes(b.platform)) &&
      !assets.some((n) => contractAssetRe(b.asset, tag).test(n))
    )
      missing.push({ kind: 'core', platform: b.platform, backend: b.backend })
  return { complete: missing.length === 0, missing }
}

/** `--version` must name the tag's build: core gates every flag on it and a macOS install checks it. */
export function checkVersion({ tag, output }) {
  const build = parseBinaryVersion(output)
  if (build === undefined)
    return [
      finding(
        'version.output',
        undefined,
        'break',
        'core reads no build number from --version: every build gate sees 0 and a macOS install refuses the pack',
        { output: output.trim().slice(0, 400) }
      ),
    ]
  const expected = tag ? engineTagBuild(tag) : null
  if (expected !== null && build !== expected)
    return [
      finding(
        'version.output',
        undefined,
        'break',
        `--version reports build ${build}, the tag names ${expected}: a macOS install refuses the pack`,
        { output: output.trim().slice(0, 400) }
      ),
    ]
  return []
}

/** Every invocation the contract lists (`-h`, `--version`, `--list-devices`) has to exit 0. */
export function checkInvocations(contract, invocations) {
  const findings = []
  for (const { argv, source } of contract.invocations ?? []) {
    const key = argv.join(' ')
    const ran = invocations.find((i) => i.argv.join(' ') === key)
    if (!ran) findings.push(finding('invocations.exit', key, 'error', `${key} was not run`))
    else if (ran.status !== 0)
      findings.push(
        finding(
          'invocations.exit',
          key,
          'break',
          `${key} ${ran.status === null ? `died (${ran.signal ?? ran.error ?? 'no status'})` : `exits ${ran.status}`}; core runs it (${source})`,
          { output: (ran.output ?? '').trim().slice(-400) }
        )
      )
  }
  return findings
}

const short = (sha) => sha.slice(0, 10)

/**
 * Commits between the pin and the candidate whose subject announces a removal, a rename or a
 * deprecation (the contract's `release_note_keywords`; each ggml-org build's release note is its
 * commit). A `warn` keyword stays a warn only for a commit that touches a watched path, when the
 * commit's files are known; everything below a warn is summed up in one finding.
 */
export function checkReleaseNotes(contract, upstream) {
  const keywords = (contract.upstream?.release_note_keywords ?? []).map((k) => ({
    ...k,
    re: new RegExp(k.pattern, 'i'),
  }))
  const watched = new Set((contract.upstream?.watched_paths ?? []).map((w) => w.path))
  const findings = []
  const others = []
  for (const commit of upstream.commits) {
    const keyword =
      keywords.find((k) => k.severity === 'warn' && k.re.test(commit.subject)) ??
      keywords.find((k) => k.re.test(commit.subject))
    if (!keyword) continue
    const touched = Array.isArray(commit.files) ? commit.files.filter((f) => watched.has(f)) : null
    if (keyword.severity === 'warn' && (touched === null || touched.length > 0))
      findings.push(
        finding(
          'upstream.release_notes',
          short(commit.sha),
          'warn',
          `${commit.subject} (/${keyword.pattern}/)`,
          {
            sha: commit.sha,
            ...(touched ? { watched_files: touched } : {}),
          }
        )
      )
    else others.push({ sha: short(commit.sha), subject: commit.subject })
  }
  if (others.length > 0)
    findings.push(
      finding(
        'upstream.release_notes',
        'others',
        'info',
        `${others.length} more commit(s) match a keyword outside the watched paths, or name args/server/common`,
        { commits: others }
      )
    )
  if (upstream.truncated)
    findings.push(
      finding(
        'upstream.release_notes',
        'truncated',
        'info',
        `the commit list is truncated (${upstream.method}): ${upstream.commits.length} of ${upstream.total_commits ?? 'more'}`
      )
    )
  return findings
}

/** What changed in each watched path, and a watched path the candidate no longer has. */
export function checkWatched(contract, upstream) {
  const findings = []
  for (const { path, why } of contract.upstream?.watched_paths ?? []) {
    const stat = upstream.watched.find((w) => w.path === path)
    if (!stat) {
      findings.push(finding('upstream.watched_paths', path, 'error', `${path} was not compared`))
      continue
    }
    if (stat.exists === false) {
      findings.push(
        finding(
          'upstream.watched_paths',
          path,
          'warn',
          `${path} is gone from the candidate (watched for: ${why}); see where it went`
        )
      )
      continue
    }
    const commits = upstream.commits.filter((c) => Array.isArray(c.files) && c.files.includes(path))
    if (commits.length === 0 && stat.additions === 0 && stat.deletions === 0) continue
    findings.push(
      finding(
        'upstream.watched_paths',
        path,
        'info',
        `${commits.length > 0 ? `${commits.length} commit(s), ` : ''}+${stat.additions} −${stat.deletions} (watched for: ${why})`,
        commits.length > 0
          ? { commits: commits.slice(0, 20).map((c) => `${short(c.sha)} ${c.subject}`) }
          : undefined
      )
    )
  }
  return findings
}

/** Strings searched for in upstream's sources: all but those that are not llama.cpp's own text. */
const searchable = (contract) =>
  (Array.isArray(contract.strings) ? contract.strings : []).filter((s) => s.upstream_text !== null)

/** What a string looks like in upstream's sources: `upstream_text` where a printf format splits it. */
const upstreamText = (s) => s.upstream_text ?? s.text

/**
 * Lines of `files` (path → source text) holding each searchable string of the contract: its
 * `upstream_text` as a case-insensitive substring when it has one, else its `text` the way core
 * matches it (`match: 'regex'` a case-insensitive regex, anything else a case-insensitive substring).
 */
export function countStrings(contract, files) {
  const counts = {}
  for (const s of searchable(contract)) {
    const needle = upstreamText(s)
    let matches
    if (s.match === 'regex' && s.upstream_text === undefined) {
      const re = new RegExp(needle, 'i')
      matches = (line) => re.test(line)
    } else {
      const lower = needle.toLowerCase()
      matches = (line) => line.toLowerCase().includes(lower)
    }
    counts[s.id] = Object.values(files).reduce(
      (sum, text) => sum + text.split('\n').filter(matches).length,
      0
    )
  }
  return counts
}

/**
 * The strings core matches in llama-server's output (the contract's `strings`), counted in the pin's
 * and the candidate's sources. Gone from the candidate → that string's `severity_if_lost`; in neither
 * tree → info (core waits for something upstream never prints). A string whose `upstream_text` is
 * `null` is not llama.cpp's own (the dynamic loader, a GPU API) and is not searched. `undefined` when
 * the contract has no strings: the check is skipped, not failed.
 */
export function checkStrings(contract, upstream) {
  if (!Array.isArray(contract.strings) || contract.strings.length === 0) return undefined
  const findings = []
  for (const s of searchable(contract)) {
    const text = upstreamText(s)
    const counts = upstream.strings?.[s.id]
    if (!counts) {
      findings.push(finding('upstream.contract_strings', s.id, 'error', `"${text}" was not counted`))
      continue
    }
    const evidence = s.source ? { source: s.source } : undefined
    const pin = counts.pin ?? null
    if (counts.candidate === 0 && pin !== null && pin > 0)
      findings.push(
        finding(
          'upstream.contract_strings',
          s.id,
          s.severity_if_lost ?? 'warn',
          `"${text}" is gone from the candidate's sources (${pin} at the pin)`,
          evidence
        )
      )
    else if (counts.candidate === 0)
      findings.push(
        finding(
          'upstream.contract_strings',
          s.id,
          'info',
          `"${text}" is in neither tree: core matches text upstream does not print`,
          evidence
        )
      )
    else if (pin === 0)
      findings.push(finding('upstream.contract_strings', s.id, 'info', `"${text}" is new in the candidate`))
  }
  return findings
}

const RANK = { break: 0, error: 1, warn: 2, info: 3 }

/** The worst severity decides: break, then error (incomplete), then warn; info alone is a pass. */
function statusOf(findings) {
  if (findings.some((f) => f.severity === 'break')) return 'break'
  if (findings.some((f) => f.severity === 'error')) return 'error'
  if (findings.some((f) => f.severity === 'warn')) return 'warn'
  return 'pass'
}

const countsOf = (findings) => ({
  break: findings.filter((f) => f.severity === 'break').length,
  warn: findings.filter((f) => f.severity === 'warn').length,
  info: findings.filter((f) => f.severity === 'info').length,
  error: findings.filter((f) => f.severity === 'error').length,
})

function sideSummary(side) {
  if (!side) return null
  return {
    tag: side.tag ?? null,
    build: side.build ?? null,
    commit: side.commit ?? null,
    repo: side.repo ?? null,
    source: side.source,
    platform: side.platform ?? null,
    binary: side.binary ?? null,
    release: side.release ?? null,
  }
}

/**
 * The report for one candidate. `inputs` is what `engine-surface-diff.mjs` gathered (or a saved
 * `inputs.json`): both sides' `-h`/`--version`/invocation output and archive lists, conf's pin and
 * whitelist, and the upstream history between the two commits.
 */
export function buildReport(contract, inputs, { now, contractSha256 } = {}) {
  const findings = []
  const skipped = {}
  const candidate = inputs.candidate
  const pin = inputs.pin ?? null
  const build = candidate.build ?? (candidate.tag ? engineTagBuild(candidate.tag) : null)

  if (candidate.capture_error) {
    for (const check of ['help.parse', 'invocations.exit', 'version.output'])
      findings.push(
        finding(check, undefined, 'error', `the candidate was not run: ${candidate.capture_error}`)
      )
    skipped['help.diff'] = 'the candidate was not run'
  } else {
    const options = parseLlamaHelp(candidate.help_text ?? '')
    if (build === null)
      findings.push(finding('help.parse', undefined, 'error', 'the candidate’s build is unknown'))
    else findings.push(...checkHelp(contract, build, options))
    const pinOptions = pin?.help_text === undefined ? undefined : parseLlamaHelp(pin.help_text)
    if (!pin) skipped['help.diff'] = 'no pin'
    else if (pin.capture_error)
      findings.push(finding('help.diff', undefined, 'error', `the pin was not run: ${pin.capture_error}`))
    else if (!pinOptions || pinOptions.length < MIN_HELP_OPTIONS)
      findings.push(finding('help.diff', undefined, 'error', 'the pin’s -h does not read as a help screen'))
    else if (build !== null && options.length >= MIN_HELP_OPTIONS)
      findings.push(...diffHelp(pinOptions, options, contract, build))
    findings.push(...checkInvocations(contract, candidate.invocations ?? []))
    findings.push(...checkVersion({ tag: candidate.tag, output: candidate.version_output ?? '' }))
  }

  if (!Array.isArray(candidate.assets)) {
    const why = candidate.assets_error ?? 'a local binary has no release'
    if (candidate.assets_error)
      for (const check of ['assets.core_backends', 'assets.mirror'])
        findings.push(finding(check, undefined, 'error', `no archive list: ${why}`))
    else skipped['assets.core_backends'] = skipped['assets.mirror'] = why
  } else {
    if (inputs.whitelist?.entries === null) skipped['assets.mirror'] = 'conf does not mirror this engine'
    findings.push(
      ...checkAssets(contract, {
        candidate: { tag: candidate.tag, assets: candidate.assets },
        pin: pin && Array.isArray(pin.assets) ? { tag: pin.tag, assets: pin.assets } : null,
        whitelist: inputs.whitelist?.entries,
      })
    )
  }

  const upstream = inputs.upstream ?? { available: false, reason: 'not compared' }
  const strings = Array.isArray(contract.strings) && contract.strings.length > 0
  if (!strings) skipped['upstream.contract_strings'] = 'the contract lists no strings yet'
  if (upstream.available) {
    findings.push(...checkWatched(contract, upstream))
    findings.push(...(checkStrings(contract, upstream) ?? []))
    findings.push(...checkReleaseNotes(contract, upstream))
  } else {
    for (const check of [
      'upstream.watched_paths',
      'upstream.release_notes',
      ...(strings ? ['upstream.contract_strings'] : []),
    ])
      findings.push(finding(check, 'unavailable', 'info', `upstream diff unavailable: ${upstream.reason}`))
  }

  for (const f of findings) {
    const hint = HINTS[f.check]
    if (hint && f.severity !== 'info') f.hint = hint
  }
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const checks = CHECKS.map(({ id, title }) => {
    const own = findings.filter((f) => f.check === id)
    const reason = skipped[id]
    return {
      id,
      title,
      status: reason !== undefined && own.length === 0 ? 'skipped' : statusOf(own),
      counts: countsOf(own),
      ...(reason !== undefined && own.length === 0 ? { skipped: reason } : {}),
    }
  })

  return {
    schema: SURFACE_REPORT_SCHEMA,
    schema_version: 1,
    generated_at: now ?? null,
    engine: contract.engine,
    inputs: {
      contract: {
        schema: contract.schema,
        schema_version: contract.schema_version,
        sha256: contractSha256 ?? null,
      },
      core: inputs.core ?? null,
      conf: inputs.conf ?? null,
      candidate: sideSummary(candidate),
      pin: sideSummary(pin),
      pin_resolution: inputs.pin_resolution ?? null,
      mirror_whitelist: inputs.whitelist ? { source: inputs.whitelist.source } : null,
      upstream: upstream.available
        ? {
            available: true,
            method: upstream.method,
            base: upstream.base,
            head: upstream.head,
            commits: upstream.commits.length,
            truncated: upstream.truncated === true,
          }
        : { available: false, reason: upstream.reason },
      same_as_pin: !!pin && !!candidate.tag && candidate.tag === pin.tag,
    },
    status: statusOf(findings),
    counts: countsOf(findings),
    checks,
    findings,
  }
}

const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|'))
const code = (v) => (v === null || v === undefined || v === '' ? '—' : `\`${v}\``)

/** `report.md`: the same report for a human, rendered from the JSON alone. */
export function renderMarkdown(report) {
  const { candidate, pin, pin_resolution: res, upstream, core, conf } = report.inputs
  const lines = []
  lines.push(
    `# llama.cpp surface: ${candidate?.tag ?? 'local build'} against ${pin?.tag ?? 'no pin'} — ${report.status.toUpperCase()}`,
    ''
  )
  const c = report.counts
  lines.push(`${c.break} break · ${c.warn} warn · ${c.info} info · ${c.error} error`, '')
  lines.push('| | candidate | pin |', '|---|---|---|')
  const row = (label, f) => lines.push(`| ${label} | ${f(candidate)} | ${f(pin)} |`)
  row('tag', (s) => code(s?.tag))
  row('build', (s) => cell(s?.build))
  row('commit', (s) => code(s?.commit))
  row('from', (s) => (s ? cell(s.source === 'bin' ? `local ${s.binary?.path ?? 'binary'}` : s.repo) : '—'))
  row('run on', (s) => cell(s?.platform))
  lines.push('')
  const facts = []
  if (res)
    facts.push(
      `Pin: ${res.source === 'override' ? 'given' : `${res.source === 'list' ? 'the release list' : res.source === 'legacy' ? 'the legacy manifest' : res.source}`}` +
        (res.legacy?.tag ? `; legacy manifest names \`${res.legacy.tag}\`` : '') +
        (conf?.sha ? ` (conf \`${conf.sha.slice(0, 10)}\`)` : '')
    )
  if (core) facts.push(`Core ${core.version ?? '?'}${core.sha ? ` at \`${core.sha.slice(0, 10)}\`` : ''}`)
  facts.push(
    upstream?.available
      ? `Upstream: ${upstream.commits} commit(s) by ${upstream.method}${upstream.truncated ? ' (truncated)' : ''}`
      : `Upstream: unavailable (${upstream?.reason ?? 'not compared'})`
  )
  if (report.inputs.same_as_pin) facts.push('The candidate is the pin.')
  lines.push(...facts.map((f) => `- ${f}`), '')

  lines.push('## Checks', '', '| check | status | break | warn | info | error |', '|---|---|---|---|---|---|')
  for (const check of report.checks)
    lines.push(
      `| \`${check.id}\` ${cell(check.title)} | ${check.status}${check.skipped ? ` (${cell(check.skipped)})` : ''} | ${check.counts.break} | ${check.counts.warn} | ${check.counts.info} | ${check.counts.error} |`
    )
  lines.push('')

  for (const severity of ['break', 'error', 'warn', 'info']) {
    const list = report.findings.filter((f) => f.severity === severity)
    if (list.length === 0) continue
    lines.push(`## ${severity} (${list.length})`, '')
    for (const f of list) {
      const names = f.evidence?.flags ?? f.evidence?.archives
      lines.push(`- \`${f.id}\` — ${f.message}${Array.isArray(names) ? `: ${names.join(', ')}` : ''}`)
      if (f.hint) lines.push(`  - ${f.hint}`)
      const commits = f.evidence?.commits
      if (Array.isArray(commits))
        for (const c of commits.slice(0, 20))
          lines.push(`  - ${typeof c === 'string' ? c : `${c.sha} ${c.subject}`}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** `git log --format=%x1e%H%x09%s --name-only` → `[{sha, subject, files}]`, newest first. */
export function parseGitLog(text) {
  return text
    .split('\x1e')
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [head = '', ...rest] = record.split('\n')
      const tab = head.indexOf('\t')
      return {
        sha: tab < 0 ? head.trim() : head.slice(0, tab),
        subject: tab < 0 ? '' : head.slice(tab + 1),
        files: rest.map((l) => l.trim()).filter((l) => l !== ''),
      }
    })
}

/** `git diff --numstat` → `[{path, additions, deletions}]`; a binary file counts 0/0. */
export function parseNumstat(text) {
  return text
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((parts) => parts.length >= 3)
    .map(([a, d, ...path]) => ({
      path: path.join('\t'),
      additions: a === '-' ? 0 : Number(a),
      deletions: d === '-' ? 0 : Number(d),
    }))
}
