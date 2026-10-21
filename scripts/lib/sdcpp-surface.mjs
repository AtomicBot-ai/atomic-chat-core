// The surface diff of a stable-diffusion.cpp candidate (engine `sd-cpp`): what can be checked without
// a model — `sd-server --help` and `--version`, the install probe's `sd-cli --help`, the release's
// archives, and leejet's history between the pin and the candidate — held to the engine contract
// (test/fixtures/sdcpp/engine-contract.json). The report is llama.cpp's (`atomic-engine-surface-report`
// v1, engine-surface.mjs) with sd.cpp's own checks. Also what `resolve` asks of a release before it is
// tested: every archive up, and on conf's signed mirror a staging manifest naming exactly those
// bytes. Pure; scripts/engine-surface-diff.mjs and scripts/engine-candidate.mjs do the I/O.
import {
  checkReleaseNotes,
  checkStrings,
  checkWatched,
  countsOf,
  finding,
  invocationKey,
  sideSummary,
  statusOf,
  SURFACE_REPORT_SCHEMA,
} from './engine-surface.mjs'
import { parseSdcppPinManifest, sdcppTagParts } from './engine-pin.mjs'

/** Every check of an sd.cpp report, in report order. */
export const SDCPP_CHECKS = [
  { id: 'help.parse', title: '`sd-server --help` reads as a help screen' },
  { id: 'help.required_flags', title: 'sd-server knows every flag core emits' },
  { id: 'help.deprecated', title: 'none of them is deprecated' },
  { id: 'help.diff', title: '`--help` changes since the pin' },
  { id: 'invocations.exit', title: 'the invocations core makes exit 0' },
  { id: 'install.probe', title: 'the install probe recognises the build' },
  { id: 'version.output', title: '`--version` names the commit of the tag' },
  { id: 'assets.core_backends', title: 'an archive for every backend core installs' },
  { id: 'upstream.watched_paths', title: 'changes to the sources core depends on' },
  { id: 'upstream.contract_strings', title: 'the strings and routes core uses are still there' },
  { id: 'upstream.release_notes', title: 'commits announcing a removal or rename' },
]

const HINTS = {
  'help.parse': 'Look at help-candidate.txt; the reader is parseSdHelp in scripts/lib/sdcpp-surface.mjs.',
  'help.required_flags':
    'buildServerArgs (src/diffusion/args.ts) emits it: follow the rename there, in required-flags.txt and the contract.',
  'help.deprecated': 'Plan the replacement in buildServerArgs before upstream removes the flag.',
  'invocations.exit': 'Read what the binary printed; core runs --help at install.',
  'install.probe':
    'prepareSdcppTree (src/diffusion/install.ts) refuses a tree whose --help shows none of the markers.',
  'version.output': 'The archive may not be the build of its tag: compare the release with its build run.',
  'assets.core_backends':
    'Archive names: conf mirror-sdcpp.yml (MATRIX), backend ids: src/engine-builds/select.ts; update both and the contract.',
  'upstream.watched_paths': 'Update the contract’s upstream.watched_paths.',
  'upstream.contract_strings': 'Core matches this text or calls this route; find what upstream has now.',
  'upstream.release_notes': 'Read the commit: it may remove or rename something core uses.',
}

/** Fewer options than this means the output is not a help screen we understand: fail closed. */
export const MIN_SD_HELP_OPTIONS = 40

const ALIAS = /^-{1,2}[A-Za-z0-9][\w-]*$/
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
/** An option starts on an indented line with its first alias; help text wraps onto deeper ones. */
const OPTION_LINE = /^ {1,8}-{1,2}[A-Za-z0-9]/

/**
 * Options of an sd.cpp `--help` screen (examples/common/common.cpp): under each `… Options:` header,
 * `  -l, --listen-ip <string>      server listen ip …`, the help wrapping onto lines indented past the
 * options' column. Aliases are exact tokens, so `--vae` is not found in `--vae-format`.
 */
export function parseSdHelp(text) {
  const options = []
  let current
  for (const line of text.replace(/\r\n/g, '\n').replace(ANSI, '').split('\n')) {
    if (OPTION_LINE.test(line)) {
      const aliases = []
      let end = 0
      for (const match of line.matchAll(/[^\s,]+/g)) {
        if (!ALIAS.test(match[0])) break
        aliases.push(match[0])
        end = match.index + match[0].length
      }
      const rest = line.slice(end).trim()
      const hint = /^<[^>]*>/.exec(rest)?.[0] ?? ''
      current = { aliases, hint, help: rest.slice(hint.length).trim() }
      options.push(current)
    } else if (current && /^\s+\S/.test(line)) {
      current.help = `${current.help}\n${line.trim()}`.trim()
    } else current = undefined
  }
  return options.map((o) => ({ ...o, deprecated: /deprecated/i.test(o.help) }))
}

/** The option a flag spells, if the build knows it. */
export const findSdOption = (options, flag) => options.find((o) => o.aliases.includes(flag))

/**
 * The build's `--help` against the flags core emits (the contract's `flags`): one it does not know
 * fails the launch (`break`), or is a `warn` for a flag core emits only when opted in (`-M`); one it
 * marks deprecated is a `warn`.
 */
export function checkSdHelp(contract, options) {
  if (options.length < MIN_SD_HELP_OPTIONS)
    return [
      finding(
        'help.parse',
        undefined,
        'error',
        `read ${options.length} options, expected ${MIN_SD_HELP_OPTIONS}+`
      ),
    ]
  const findings = []
  for (const f of contract.flags) {
    const option = findSdOption(options, f.flag)
    const severity = f.severity ?? 'break'
    if (!option)
      findings.push(
        finding(
          'help.required_flags',
          f.flag,
          severity,
          severity === 'break'
            ? `sd-server does not know ${f.flag}, which core emits: the launch fails`
            : `sd-server does not know ${f.flag}${f.note ? ` (${f.note})` : ''}`,
          { source: f.source }
        )
      )
    else if (option.deprecated)
      findings.push(
        finding(
          'help.deprecated',
          f.flag,
          'warn',
          `sd-server marks ${f.flag} deprecated; core still emits it`,
          {
            help: option.help,
          }
        )
      )
  }
  return findings
}

/**
 * What changed between the pin's and the candidate's `--help`, for the flags core never emits (a lost
 * or deprecated flag core emits is already its own finding).
 */
export function diffSdHelp(pinOptions, candidateOptions, contract) {
  const pin = new Set(pinOptions.flatMap((o) => o.aliases))
  const candidate = new Set(candidateOptions.flatMap((o) => o.aliases))
  const emitted = new Set(contract.flags.map((f) => f.flag))
  const findings = []
  const removed = [...pin].filter((f) => !candidate.has(f) && !emitted.has(f)).sort()
  if (removed.length > 0)
    findings.push(
      finding('help.diff', 'removed', 'info', `${removed.length} flag(s) core never emits are gone`, {
        flags: removed,
      })
    )
  const added = [...candidate].filter((f) => !pin.has(f)).sort()
  if (added.length > 0)
    findings.push(finding('help.diff', 'added', 'info', `${added.length} new flag(s)`, { flags: added }))
  const wasDeprecated = new Set(pinOptions.filter((o) => o.deprecated).flatMap((o) => o.aliases))
  const deprecated = candidateOptions
    .filter((o) => o.deprecated)
    .flatMap((o) => o.aliases)
    .filter((f) => pin.has(f) && !wasDeprecated.has(f) && !emitted.has(f))
    .sort()
  if (deprecated.length > 0)
    findings.push(
      finding(
        'help.diff',
        'deprecated',
        'info',
        `${deprecated.length} flag(s) core never emits are newly deprecated`,
        { flags: deprecated }
      )
    )
  return findings
}

/** The executable of an invocation was not there to run (`spawnSync … ENOENT`). */
export const notInArchive = (ran) => ran.status === null && /ENOENT/.test(ran.error ?? '')

/**
 * The contract's invocations, by their exit: each has its own severity (core reads the output of
 * `--help`, not its exit code). A missing executable is `break` unless the invocation is `optional`
 * (an archive without `sd-cli` is probed through `sd-server`).
 */
export function checkSdInvocations(contract, invocations) {
  const findings = []
  for (const inv of contract.invocations ?? []) {
    const key = invocationKey(inv)
    const ran = invocations.find((i) => invocationKey(i) === key)
    if (!ran) findings.push(finding('invocations.exit', key, 'error', `${key} was not run`))
    else if (notInArchive(ran))
      findings.push(
        inv.optional
          ? finding('invocations.exit', key, 'info', `the archive has no ${inv.bin}`)
          : finding('invocations.exit', key, 'break', `the archive has no ${inv.bin}: core cannot run it`)
      )
    else if (ran.status !== 0)
      findings.push(
        finding(
          'invocations.exit',
          key,
          inv.severity ?? 'break',
          `${key} ${ran.status === null ? `died (${ran.signal ?? ran.error ?? 'no status'})` : `exits ${ran.status}`}; core runs it (${inv.source})`,
          { output: (ran.output ?? '').trim().slice(-400) }
        )
      )
  }
  return findings
}

/**
 * The install probe as core runs it: the first of the contract's `probe.bins` the archive has
 * (`sd-cli`, else `sd-server`), its `--help` holding one of the markers. `texts` maps each binary to
 * what it printed, `undefined` when the archive does not have it.
 */
export function checkSdProbe(contract, texts) {
  const probe = contract.probe
  if (!probe) return []
  const bin = probe.bins.find((b) => texts[b] !== undefined)
  if (!bin) return [finding('install.probe', undefined, 'error', `none of ${probe.bins.join(', ')} ran`)]
  const lower = texts[bin].toLowerCase()
  if (probe.markers.some((m) => lower.includes(m.toLowerCase()))) return []
  return [
    finding(
      'install.probe',
      bin,
      'break',
      `${bin} ${probe.argv.join(' ')} prints none of ${probe.markers.map((m) => `"${m}"`).join(', ')}: the archive installs on no host`,
      { output: texts[bin].trim().slice(0, 400) }
    ),
  ]
}

/** `{version, commit}` from `sd-server --version`, as the contract's `version.pattern` reads it. */
export function parseSdVersion(contract, output) {
  const match = new RegExp(contract.version?.pattern ?? '$^').exec(output)
  return match ? { version: match[1], commit: match[2] } : undefined
}

/**
 * `--version` ties the binary to its tag: its commit has to be the tag's `<sha7>` (a conf mirror tag
 * names the same upstream commit). Core does not read the version, so an unreadable line is a warn.
 */
export function checkSdVersion(contract, { tag, output }) {
  const parsed = parseSdVersion(contract, output)
  const evidence = { output: output.trim().slice(0, 400) }
  if (!parsed)
    return [
      finding(
        'version.output',
        undefined,
        'warn',
        '--version prints no "stable-diffusion.cpp version …, commit …" line: the build cannot be tied to its tag',
        evidence
      ),
    ]
  const parts = tag ? sdcppTagParts(tag) : null
  const findings = []
  if (!/^[0-9a-f]{7,40}$/.test(parsed.commit))
    findings.push(
      finding('version.output', 'commit', 'warn', `--version names no commit (${parsed.commit})`, evidence)
    )
  else if (parts && !parsed.commit.startsWith(parts.sha7) && !parts.sha7.startsWith(parsed.commit))
    findings.push(
      finding(
        'version.output',
        'commit',
        'break',
        `--version names commit ${parsed.commit}, the tag ${parts.sha7}: the archive is not the build of ${tag}`,
        evidence
      )
    )
  if (parsed.version === 'unknown')
    findings.push(
      finding('version.output', 'version', 'info', 'built from a checkout without tags: version unknown')
    )
  else if (parts && parsed.version.replace(/\+$/, '') !== parts.upstream_tag)
    findings.push(
      finding(
        'version.output',
        'version',
        'info',
        `--version says ${parsed.version}, the tag names ${parts.upstream_tag}`
      )
    )
  return findings
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A contract archive pattern for the build of `sha7`. */
export const sdAssetRe = (pattern, sha7) => new RegExp(`^${pattern.replace('{sha7}', escapeRegExp(sha7))}$`)
/** `sd-master-<sha7>-bin-<rest>` → `<rest>`; any other name as it is. */
const binRest = (name, sha7) =>
  new RegExp(`^sd-master-${escapeRegExp(sha7)}-bin-(.+)$`).exec(name)?.[1] ?? name
const ARCHIVE = /\.(zip|tar\.gz|tgz)$/

/** The archives of `assets` (names) each contract backend takes, for the build `tag` names. */
export function sdcppBackendArchives(contract, tag, assets) {
  const sha7 = sdcppTagParts(tag)?.sha7 ?? '\0'
  return Object.fromEntries(
    (contract.assets?.core_backends ?? []).map((b) => [
      b.backend,
      assets.filter((n) => sdAssetRe(b.asset, sha7).test(n)).sort(),
    ])
  )
}

/** The archives of a release core installs: what a passing live run does not cover is listed as unverified. */
export function sdcppCoreAssets(contract, tag, assets) {
  return Object.values(sdcppBackendArchives(contract, tag, assets))
    .flat()
    .sort()
}

/**
 * The release's archives against the backends core installs (`assets.core_backends`). A missing CPU
 * archive leaves its platform without sd.cpp, a missing `required` one stops conf's mirror (both
 * `break`); two archives for one backend stop the mirror too. `pin` is the pin's archive list: a
 * backend the pin had and the candidate lacks is a loss (`warn`).
 */
export function checkSdAssets(contract, { candidate, pin }) {
  const backends = contract.assets?.core_backends ?? []
  if (backends.length === 0)
    return [finding('assets.core_backends', undefined, 'error', 'the contract lists no core backends')]
  const findings = []
  const now = sdcppBackendArchives(contract, candidate.tag, candidate.assets)
  const before = pin ? sdcppBackendArchives(contract, pin.tag, pin.assets) : null
  const sha7 = sdcppTagParts(candidate.tag)?.sha7 ?? ''
  const pinSha7 = pin ? (sdcppTagParts(pin.tag)?.sha7 ?? '') : ''
  for (const b of backends) {
    const names = now[b.backend]
    const had = before?.[b.backend] ?? null
    const subject = `${b.platform}/${b.backend}`
    if (names.length === 0) {
      const missing = `no ${b.backend} archive in ${candidate.tag}`
      const [severity, message] = b.cpu
        ? ['break', `${missing}: ${b.platform} gets no sd.cpp`]
        : b.required
          ? ['break', `${missing}, which conf's mirror requires: conf cannot mirror the tag`]
          : had && had.length > 0
            ? ['warn', `${missing}, which ${pin.tag} had: core stops offering it on ${b.platform}`]
            : had
              ? ['info', `${missing}, nor in ${pin.tag}`]
              : ['info', `${missing}: core does not offer it on ${b.platform}`]
      findings.push(finding('assets.core_backends', subject, severity, message, { pattern: b.asset }))
    } else if (names.length > 1)
      findings.push(
        finding(
          'assets.core_backends',
          subject,
          'break',
          `${names.length} archives match ${b.backend}: conf's mirror refuses the tag`,
          { archives: names }
        )
      )
    else if (had?.length === 1 && binRest(had[0], pinSha7) !== binRest(names[0], sha7))
      findings.push(
        finding(
          'assets.core_backends',
          subject,
          'info',
          `${b.backend} moved: ${binRest(had[0], pinSha7)} → ${binRest(names[0], sha7)}`
        )
      )
  }
  const consumed = new Set(Object.values(now).flat())
  const unused = candidate.assets.filter((n) => ARCHIVE.test(n) && !consumed.has(n)).sort()
  if (unused.length > 0)
    findings.push(
      finding(
        'assets.core_backends',
        'unconsumed',
        'info',
        `${unused.length} archive(s) no backend core installs takes`,
        { archives: unused }
      )
    )
  return findings
}

/**
 * Whether a release can be tested: every archive conf's mirror requires and the CPU archive of each
 * of `platforms` is up exactly once, with the digest GitHub computes once an upload finishes. On
 * conf's signed mirror (`manifest`: the staging manifest at the run's conf commit) the manifest has
 * to name this tag, point its downloads at `downloadBase`, and pin every archive it lists with the
 * size and sha256 the release has. `assets` are the release's (`{name, size, digest}`).
 */
export function sdcppCompleteness({ contract, tag, assets, platforms, manifest, downloadBase }) {
  const missing = []
  if (!sdcppTagParts(tag)) return { complete: false, missing: [{ kind: 'tag', tag }] }
  const wanted = (contract.assets?.core_backends ?? []).filter(
    (b) => b.required || (b.cpu && (platforms ?? []).includes(b.platform))
  )
  const archives = sdcppBackendArchives(
    contract,
    tag,
    assets.map((a) => a.name)
  )
  for (const b of wanted) {
    const names = archives[b.backend]
    if (names.length === 0) missing.push({ kind: 'core', platform: b.platform, backend: b.backend })
    else if (names.length > 1) missing.push({ kind: 'ambiguous', backend: b.backend, names })
    else if (!/^sha256:[0-9a-f]{64}$/.test(assets.find((a) => a.name === names[0])?.digest ?? ''))
      missing.push({ kind: 'digest', backend: b.backend, name: names[0] })
  }
  if (manifest !== undefined) {
    const parsed = manifest === null ? null : parseSdcppPinManifest(manifest)
    if (!parsed) missing.push({ kind: 'manifest', reason: 'conf has no staging manifest core reads' })
    else if (parsed.tag_name !== tag)
      missing.push({ kind: 'manifest', reason: `the staging manifest names ${parsed.tag_name}` })
    else {
      if (parsed.download_base !== downloadBase)
        missing.push({
          kind: 'manifest',
          reason: `the staging manifest downloads from ${parsed.download_base ?? 'upstream'}, not ${downloadBase}`,
        })
      for (const entry of parsed.assets) {
        const asset = assets.find((a) => a.name === entry.name)
        const reason = !asset
          ? 'not in the release'
          : asset.size !== entry.size
            ? `size ${asset.size} in the release, ${entry.size ?? 'none'} in the manifest`
            : asset.digest !== `sha256:${entry.sha256}`
              ? `digest ${asset.digest ?? 'none'} in the release, sha256 ${entry.sha256 ?? 'none'} in the manifest`
              : null
        if (reason) missing.push({ kind: 'manifest-asset', backend: entry.backend, name: entry.name, reason })
      }
      for (const b of wanted)
        if (!parsed.assets.some((a) => a.backend === b.backend))
          missing.push({ kind: 'manifest-asset', backend: b.backend, reason: 'not in the staging manifest' })
    }
  }
  return { complete: missing.length === 0, missing }
}

const RANK = { break: 0, error: 1, warn: 2, info: 3 }

/** A side as the report shows it, with the leejet tag it is cut from. */
const summary = (side) => side && { ...sideSummary(side), upstream: side.upstream ?? null }

/**
 * The report for one sd.cpp candidate, from what scripts/engine-surface-diff.mjs gathered: both
 * sides' `--help` (`help_text`, and `cli_help_text` for `sd-cli`), `--version`, the invocations and
 * the archive lists, the pin's resolution, and the upstream history between the two commits.
 */
export function buildSdcppReport(contract, inputs, { now, contractSha256 } = {}) {
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
    const options = parseSdHelp(candidate.help_text ?? '')
    findings.push(...checkSdHelp(contract, options))
    const pinOptions = pin?.help_text === undefined ? undefined : parseSdHelp(pin.help_text)
    if (!pin) skipped['help.diff'] = 'no pin'
    else if (pin.capture_error)
      findings.push(finding('help.diff', undefined, 'error', `the pin was not run: ${pin.capture_error}`))
    else if (!pinOptions || pinOptions.length < MIN_SD_HELP_OPTIONS)
      findings.push(
        finding('help.diff', undefined, 'error', 'the pin’s --help does not read as a help screen')
      )
    else if (options.length >= MIN_SD_HELP_OPTIONS)
      findings.push(...diffSdHelp(pinOptions, options, contract))
    findings.push(...checkSdInvocations(contract, candidate.invocations ?? []))
    findings.push(
      ...checkSdProbe(contract, { 'sd-cli': candidate.cli_help_text, 'sd-server': candidate.help_text })
    )
    findings.push(...checkSdVersion(contract, { tag: candidate.tag, output: candidate.version_output ?? '' }))
  }

  if (!Array.isArray(candidate.assets)) {
    if (candidate.assets_error)
      findings.push(
        finding('assets.core_backends', undefined, 'error', `no archive list: ${candidate.assets_error}`)
      )
    else skipped['assets.core_backends'] = 'a local binary has no release'
  } else
    findings.push(
      ...checkSdAssets(contract, {
        candidate: { tag: candidate.tag, assets: candidate.assets },
        pin: pin && Array.isArray(pin.assets) ? { tag: pin.tag, assets: pin.assets } : null,
      })
    )

  const upstream = inputs.upstream ?? { available: false, reason: 'not compared' }
  if (upstream.available) {
    findings.push(...checkWatched(contract, upstream))
    findings.push(...(checkStrings(contract, upstream) ?? []))
    findings.push(...checkReleaseNotes(contract, upstream))
  } else
    for (const check of ['upstream.watched_paths', 'upstream.release_notes', 'upstream.contract_strings'])
      findings.push(finding(check, 'unavailable', 'info', `upstream diff unavailable: ${upstream.reason}`))

  for (const f of findings) {
    const hint = HINTS[f.check]
    if (hint && f.severity !== 'info') f.hint = hint
  }
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const checks = SDCPP_CHECKS.map(({ id, title }) => {
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
      candidate: summary(candidate),
      pin: summary(pin),
      pin_resolution: inputs.pin_resolution ?? null,
      mirror_whitelist: null,
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
