// The surface diff of an audio.cpp candidate (engine `audio-cpp`): what can be checked without a
// model — `audiocpp_server --help` (the flags core passes, the routes core calls), `--version` and
// `--list-devices`, the release's archives, and 0xShug0's history between the pin and the
// candidate — held to the engine contract (test/fixtures/audiocpp/engine-contract.json). The report is
// llama.cpp's (`atomic-engine-surface-report` v1, engine-surface.mjs) with audio.cpp's own checks;
// archives, completeness and the report's assembly are sd.cpp's (sdcpp-surface.mjs) with audio.cpp's
// release spec. Pure; scripts/engine-surface-diff.mjs and scripts/engine-candidate.mjs do the I/O.
import { finding } from './engine-surface.mjs'
import { audiocppTagParts, parseAudiocppPinManifest } from './engine-pin.mjs'
import {
  checkReleaseAssets,
  checkSdInvocations,
  escapeRegExp,
  releaseBackendArchives,
  releaseCompleteness,
  releaseCoreAssets,
  releaseReport,
} from './sdcpp-surface.mjs'

/** Every check of an audio.cpp report, in report order. */
export const AUDIOCPP_CHECKS = [
  { id: 'help.parse', title: '`audiocpp_server --help` reads as a help screen' },
  { id: 'help.required_flags', title: 'the server knows every flag core passes' },
  { id: 'help.routes', title: 'it lists every route core calls' },
  { id: 'help.diff', title: '`--help` changes since the pin' },
  { id: 'invocations.exit', title: 'the invocations core makes exit 0' },
  { id: 'install.probe', title: 'the install probe recognises the build' },
  { id: 'version.output', title: '`--version` names the version of the tag' },
  { id: 'assets.core_backends', title: 'an archive for every backend core installs' },
  { id: 'upstream.watched_paths', title: 'changes to the sources core depends on' },
  { id: 'upstream.contract_strings', title: 'the routes and log text core uses are still in the sources' },
  { id: 'upstream.release_notes', title: 'commits announcing a removal or rename' },
]

const HINTS = {
  'help.parse':
    'Look at help-candidate.txt; the reader is parseAudioHelp in scripts/lib/audiocpp-surface.mjs.',
  'help.required_flags':
    'buildAudioServerArgs (src/audio/args.ts) passes it: follow the rename there and in the contract.',
  'help.routes':
    'The audio service calls it (src/audio/server-process.ts, request.ts): follow the change there and in the contract.',
  'invocations.exit': 'Read what the binary printed; core runs --version and --list-devices at install.',
  'install.probe':
    'prepareAudiocppTree (src/audio/install.ts) refuses a tree whose --version does not start with "audio.cpp ".',
  'version.output': 'The archive may not be the build of its tag: compare the release with its build run.',
  'assets.core_backends':
    'Archive names: conf mirror-audiocpp.yml (MATRIX), backend ids: src/engine-builds/select.ts; update both and the contract.',
  'upstream.watched_paths': 'Update the contract’s upstream.watched_paths.',
  'upstream.contract_strings': 'Core calls this route or matches this text; find what upstream has now.',
  'upstream.release_notes': 'Read the commit: it may remove or rename something core uses.',
}

/** Fewer flags or routes than these means the output is not a help screen we understand: fail closed. */
export const MIN_AUDIO_HELP_FLAGS = 15
export const MIN_AUDIO_HELP_ROUTES = 5

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
/** A flag where the usage block names one: `[--config <server.json>]`, `[--ui]`. */
const USAGE_FLAG = /\[(--[A-Za-z0-9][\w-]*)/g
/** An option line: the flag first, two to eight spaces in; wrapped help is indented far deeper. */
const OPTION_LINE = /^ {1,8}(--[A-Za-z0-9][\w-]*)/
/** An endpoint line: `  GET  /v1/audio/voices?model=<id>`, `  POST /v1/models/load  available with …`. */
const ENDPOINT_LINE = /^\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/

/**
 * Flags and routes of `audiocpp_server --help`: the flags its usage block and option lines name
 * (as whole tokens, so `--log-file` never stands for `--log`, and never a flag a help text only
 * mentions), and the `METHOD /path` lines under `Endpoints:`, the path without its query or the
 * optional part in brackets.
 */
export function parseAudioHelp(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(ANSI, '').split('\n')
  const flags = new Set()
  const routes = []
  let endpoints = false
  for (const line of lines) {
    if (/^Endpoints:\s*$/.test(line)) {
      endpoints = true
      continue
    }
    if (endpoints) {
      const match = ENDPOINT_LINE.exec(line)
      if (!match) continue
      const path = match[2].replace(/[?[].*$/, '')
      if (!routes.some((r) => r.method === match[1] && r.path === path))
        routes.push({ method: match[1], path })
      continue
    }
    for (const m of line.matchAll(USAGE_FLAG)) flags.add(m[1])
    const option = OPTION_LINE.exec(line)?.[1]
    if (option) flags.add(option)
  }
  return { flags: [...flags].sort(), routes }
}

const routeKey = (r) => `${r.method} ${r.path}`

/**
 * The build's `--help` against the flags core passes (the contract's `flags`) and the routes it calls
 * (`routes`): one the build does not list fails the launch or the request it serves (`break`, or the
 * entry's own severity).
 */
export function checkAudioHelp(contract, help) {
  if (help.flags.length < MIN_AUDIO_HELP_FLAGS || help.routes.length < MIN_AUDIO_HELP_ROUTES)
    return [
      finding(
        'help.parse',
        undefined,
        'error',
        `read ${help.flags.length} flags and ${help.routes.length} routes, expected ${MIN_AUDIO_HELP_FLAGS}+ and ${MIN_AUDIO_HELP_ROUTES}+`
      ),
    ]
  const findings = []
  for (const f of contract.flags ?? []) {
    if (help.flags.includes(f.flag)) continue
    const severity = f.severity ?? 'break'
    findings.push(
      finding(
        'help.required_flags',
        f.flag,
        severity,
        `audiocpp_server does not know ${f.flag}, which core passes${severity === 'break' ? ': the launch fails' : ''}`,
        { source: f.source }
      )
    )
  }
  for (const r of contract.routes ?? []) {
    if (help.routes.some((h) => routeKey(h) === routeKey(r))) continue
    const other = help.routes.filter((h) => h.path === r.path).map((h) => h.method)
    findings.push(
      finding(
        'help.routes',
        routeKey(r),
        r.severity ?? 'break',
        other.length > 0
          ? `audiocpp_server lists ${r.path} for ${other.join(', ')} only; core calls ${routeKey(r)}`
          : `audiocpp_server lists no ${routeKey(r)}, which core calls`,
        { source: r.source }
      )
    )
  }
  return findings
}

/**
 * What changed between the pin's and the candidate's `--help`, among the flags core never passes and
 * the routes core never calls (a lost one core uses is already its own finding).
 */
export function diffAudioHelp(pin, candidate, contract) {
  const findings = []
  const passed = new Set((contract.flags ?? []).map((f) => f.flag))
  const called = new Set((contract.routes ?? []).map(routeKey))
  const diff = (kind, before, after, used) => {
    const removed = before.filter((x) => !after.includes(x) && !used.has(x)).sort()
    const added = after.filter((x) => !before.includes(x)).sort()
    if (removed.length > 0)
      findings.push(
        finding(
          'help.diff',
          `removed-${kind}`,
          'info',
          `${removed.length} ${kind} core never uses are gone`,
          {
            [kind]: removed,
          }
        )
      )
    if (added.length > 0)
      findings.push(
        finding('help.diff', `added-${kind}`, 'info', `${added.length} new ${kind}`, { [kind]: added })
      )
  }
  diff('flags', pin.flags, candidate.flags, passed)
  diff('routes', pin.routes.map(routeKey), candidate.routes.map(routeKey), called)
  return findings
}

/** `{version, commit}` from `audiocpp_server --version`, as the contract's `version` patterns read it. */
export function parseAudioVersionOutput(contract, output) {
  const version = new RegExp(contract.version?.pattern ?? '$^', 'm').exec(output)?.[1]
  if (version === undefined) return undefined
  return {
    version,
    commit: new RegExp(contract.version?.commit_pattern ?? '$^', 'm').exec(output)?.[1] ?? null,
  }
}

/**
 * The install probe as core runs it (`prepareAudiocppTree`): `--version` has to print a line starting
 * with the contract's marker, or the archive installs on no host. `output` is `undefined` when the
 * build was not run.
 */
export function checkAudioProbe(contract, output) {
  const probe = contract.probe
  if (!probe) return []
  if (output === undefined)
    return [finding('install.probe', undefined, 'error', `${probe.argv.join(' ')} did not run`)]
  if (output.split(/\r?\n/).some((line) => line.startsWith(probe.marker))) return []
  return [
    finding(
      'install.probe',
      probe.argv.join(' '),
      'break',
      `audiocpp_server ${probe.argv.join(' ')} prints no line starting "${probe.marker}": the archive installs on no host`,
      { output: output.trim().slice(0, 400) }
    ),
  ]
}

/**
 * `--version` ties the binary to its tag: its version has to be the tag's `X.Y.Z` (`break`), and its
 * commit the upstream tag's (`upstreamCommit`, from `git ls-remote`; a `warn`, since the fork's build
 * could one day commit its patches). A build without a version (`dev`) or a commit is a `warn`: it
 * cannot be tied to its tag.
 */
export function checkAudioVersion(contract, { tag, output, upstreamCommit }) {
  const parsed = parseAudioVersionOutput(contract, output)
  const evidence = { output: output.trim().slice(0, 400) }
  if (!parsed)
    return [
      finding(
        'version.output',
        undefined,
        'warn',
        '--version prints no "audio.cpp <version>" line: the build cannot be tied to its tag',
        evidence
      ),
    ]
  const parts = tag ? audiocppTagParts(tag) : null
  const findings = []
  if (!/^\d+\.\d+\.\d+$/.test(parsed.version))
    findings.push(
      finding(
        'version.output',
        'version',
        'warn',
        `--version says "${parsed.version}": built without AUDIOCPP_VERSION, so not tied to a tag`,
        evidence
      )
    )
  else if (parts && parsed.version !== parts.version)
    findings.push(
      finding(
        'version.output',
        'version',
        'break',
        `--version says ${parsed.version}, the tag ${parts.version}: the archive is not the build of ${tag}`,
        evidence
      )
    )
  const commit = parsed.commit
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit))
    findings.push(
      finding('version.output', 'commit', 'warn', `--version names no commit (${commit ?? 'none'})`, evidence)
    )
  else if (upstreamCommit && !upstreamCommit.startsWith(commit) && !commit.startsWith(upstreamCommit))
    findings.push(
      finding(
        'version.output',
        'commit',
        'warn',
        `--version names commit ${commit}, the upstream tag ${parts?.upstream_tag ?? ''} is ${upstreamCommit.slice(0, 10)}`,
        evidence
      )
    )
  return findings
}

/** A contract archive pattern for the build cut from `upstreamTag` (`v0.9.3`). */
export const audioAssetRe = (pattern, upstreamTag) =>
  new RegExp(`^${pattern.replace('{version}', escapeRegExp(upstreamTag))}$`)

/** `audio-<vX.Y.Z>-<rest>` → `<rest>`; any other name as it is. */
const archiveRest = (name, upstreamTag) =>
  new RegExp(`^audio-${escapeRegExp(upstreamTag)}-(.+)$`).exec(name)?.[1] ?? name

/**
 * audio.cpp as a release engine: tags `vX.Y.Z(-a<rev>)`, archives named by the bare upstream tag
 * (also on conf's `-a<rev>` mirror), conf's `backends/audiocpp-manifest.json`.
 */
export const AUDIOCPP_RELEASE = {
  project: 'audio.cpp',
  tagParts: audiocppTagParts,
  assetRe: (pattern, tag) => audioAssetRe(pattern, audiocppTagParts(tag)?.upstream_tag ?? '\0'),
  archiveKind: (name, tag) => archiveRest(name, audiocppTagParts(tag)?.upstream_tag ?? ''),
  parseManifest: parseAudiocppPinManifest,
}

/** The archives of `assets` (names) each contract backend takes, for the build `tag` names. */
export function audiocppBackendArchives(contract, tag, assets) {
  return releaseBackendArchives(contract, tag, assets, AUDIOCPP_RELEASE)
}

/** The archives of a release core installs: what a passing live run does not cover is listed as unverified. */
export function audiocppCoreAssets(contract, tag, assets) {
  return releaseCoreAssets(contract, tag, assets, AUDIOCPP_RELEASE)
}

/** The release's archives against the backends core installs (`checkReleaseAssets`). */
export function checkAudioAssets(contract, input) {
  return checkReleaseAssets(contract, input, AUDIOCPP_RELEASE)
}

/**
 * Whether an audio.cpp release can be tested (`releaseCompleteness`): every archive conf's mirror
 * requires and the CPU archive of each live platform up once with its digest; on conf, a staging
 * manifest naming the tag and exactly those bytes.
 */
export function audiocppCompleteness(input) {
  return releaseCompleteness(input, AUDIOCPP_RELEASE)
}

/**
 * The report for one audio.cpp candidate, from what scripts/engine-surface-diff.mjs gathered: both
 * sides' `--help` (`help_text`) and `--version`, the invocations and the archive lists, the pin's
 * resolution, and the upstream history between the two tags' commits.
 */
export function buildAudiocppReport(contract, inputs, options = {}) {
  const findings = []
  const skipped = {}
  const candidate = inputs.candidate
  const pin = inputs.pin ?? null

  if (candidate.capture_error) {
    for (const check of ['help.parse', 'invocations.exit', 'install.probe', 'version.output'])
      findings.push(
        finding(check, undefined, 'error', `the candidate was not run: ${candidate.capture_error}`)
      )
    skipped['help.diff'] = 'the candidate was not run'
  } else {
    const help = parseAudioHelp(candidate.help_text ?? '')
    findings.push(...checkAudioHelp(contract, help))
    const readable = (h) => h.flags.length >= MIN_AUDIO_HELP_FLAGS && h.routes.length >= MIN_AUDIO_HELP_ROUTES
    if (!pin) skipped['help.diff'] = 'no pin'
    else if (pin.capture_error)
      findings.push(finding('help.diff', undefined, 'error', `the pin was not run: ${pin.capture_error}`))
    else if (pin.help_text === undefined || !readable(parseAudioHelp(pin.help_text)))
      findings.push(
        finding('help.diff', undefined, 'error', 'the pin’s --help does not read as a help screen')
      )
    else if (readable(help)) findings.push(...diffAudioHelp(parseAudioHelp(pin.help_text), help, contract))
    findings.push(...checkSdInvocations(contract, candidate.invocations ?? []))
    findings.push(...checkAudioProbe(contract, candidate.version_output))
    findings.push(
      ...checkAudioVersion(contract, {
        tag: candidate.tag,
        output: candidate.version_output ?? '',
        upstreamCommit: candidate.upstream?.commit ?? null,
      })
    )
  }

  if (!Array.isArray(candidate.assets)) {
    if (candidate.assets_error)
      findings.push(
        finding('assets.core_backends', undefined, 'error', `no archive list: ${candidate.assets_error}`)
      )
    else skipped['assets.core_backends'] = 'a local binary has no release'
  } else
    findings.push(
      ...checkAudioAssets(contract, {
        candidate: { tag: candidate.tag, assets: candidate.assets },
        pin: pin && Array.isArray(pin.assets) ? { tag: pin.tag, assets: pin.assets } : null,
      })
    )

  return releaseReport(
    contract,
    inputs,
    { findings, skipped, checks: AUDIOCPP_CHECKS, hints: HINTS },
    options
  )
}
