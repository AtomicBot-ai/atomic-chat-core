// The surface diff of an MLX candidate (engine `mlx`): what can be checked without a model —
// `mlx-server --help` (the flags core passes and the choices of the ones that take a choice), the
// install probe on it, what the archive unpacks to, the release's archive, and Neywa-Labs/mlx-vlm's
// history between the pin's and the candidate's upstream tags — held to the engine contract
// (test/fixtures/mlx/engine-contract.json). The report is llama.cpp's (`atomic-engine-surface-report`
// v1, engine-surface.mjs) with MLX's own checks; the archive, completeness and report assembly are
// sd.cpp's (sdcpp-surface.mjs) with MLX's release spec. Pure; scripts/engine-surface-diff.mjs and
// scripts/engine-candidate.mjs do the I/O.
//
// One build, one platform: `mlxvlm-mlx-server-macos-arm64.tar.gz` holding a PyInstaller onefile
// `mlx-server`. It has no `--version`, so nothing ties the binary to its tag but the release it came
// from: the fork's release of an upstream tag (`vX.Y.Z`) or a build named by the fork commit it was
// made at (`mlxvlm-macos-arm64-<hex>`, conf's mirror and the fork's older releases).
import { finding } from './engine-surface.mjs'
import { mlxManifestUpstreamTag, mlxTagParts, parseMlxPinManifest } from './engine-pin.mjs'
import {
  checkReleaseAssets,
  checkSdInvocations,
  releaseBackendArchives,
  releaseCompleteness,
  releaseCoreAssets,
  releaseReport,
} from './sdcpp-surface.mjs'

/** Every check of an MLX report, in report order. */
export const MLX_CHECKS = [
  { id: 'help.parse', title: '`mlx-server --help` reads as an argparse help screen' },
  { id: 'help.required_flags', title: 'the server knows every flag core passes' },
  { id: 'help.choices', title: 'and every value core passes to a flag with choices' },
  { id: 'help.diff', title: '`--help` changes since the pin' },
  { id: 'invocations.exit', title: 'the invocations core makes exit 0' },
  { id: 'install.probe', title: 'the install probe recognises the build' },
  { id: 'archive.layout', title: 'the archive unpacks to what the install runs' },
  { id: 'assets.core_backends', title: 'the archive core installs' },
  { id: 'upstream.watched_paths', title: 'changes to the sources core depends on' },
  { id: 'upstream.contract_strings', title: 'the routes and env core uses are still in the sources' },
  { id: 'upstream.release_notes', title: 'commits announcing a removal or rename' },
]

const HINTS = {
  'help.parse': 'Look at help-candidate.txt; the reader is parseMlxHelp in scripts/lib/mlx-surface.mjs.',
  'help.required_flags':
    'buildMlxServerArgs (src/runtime/mlx/args.ts) passes it: follow the rename there and in the contract.',
  'help.choices':
    'buildMlxServerArgs passes this value (DRAFT_KINDS, the KV schemes in src/runtime/mlx/config.ts): follow the change there and in the contract.',
  'invocations.exit': 'Read what the binary printed: the install probe needs `--help` to exit 0.',
  'install.probe':
    'probeMlxServer (src/engine-builds/builds.ts) refuses a build whose --help does not exit 0 with argparse’s `usage: mlx-server`.',
  'archive.layout':
    'probeMlxServer runs <unpacked archive>/mlx-server; the fork’s release-atomic.yml packs it and conf’s mirror-mlx.yml refuses anything else.',
  'assets.core_backends':
    'Archive name: the fork’s release-atomic.yml and conf’s mirror-mlx.yml (ASSET); backend id: mlxHostChoice in src/engine-builds/select.ts.',
  'upstream.watched_paths': 'Update the contract’s upstream.watched_paths.',
  'upstream.contract_strings': 'Core calls this route or sets this variable; find what upstream has now.',
  'upstream.release_notes': 'Read the commit: it may remove or rename something core uses.',
}

/** Fewer options than this means the output is not the help screen we understand: fail closed. */
export const MIN_MLX_HELP_FLAGS = 15

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
/** A flag of the usage block, with the choices argparse prints for it: `[--draft-kind {dflash,eagle3,mtp}]`. */
const USAGE_FLAG = /\[(--[A-Za-z0-9][\w-]*)(?:\s+\{([^}]*)\})?/g
/** An option line of the `options:` section: two spaces in, then the flag and its aliases. */
const OPTION_LINE = /^ {2,8}(-{1,2}[A-Za-z0-9][\w-]*)/
/** One alias of an option line and the choices after it: `--kv-quant-scheme {uniform,turboquant}`. */
const OPTION_ALIAS = /(--[A-Za-z0-9][\w-]*)(?:\s+(?:\{([^}]*)\}|[A-Z][A-Z0-9_]*))?/g

/**
 * Flags and choices of `mlx-server --help` (argparse): whether it prints argparse's usage line for
 * `mlx-server`, every flag its usage block and its option lines name (as whole tokens, so
 * `--kv-bits` is never found in `--kv-key-bits`), and for each flag with choices the set argparse
 * lists, `{dflash,eagle3,mtp}`.
 */
export function parseMlxHelp(text) {
  const clean = text.replace(/\r\n/g, '\n').replace(ANSI, '')
  const flags = new Set()
  const choices = {}
  const addChoices = (flag, list) => {
    if (list === undefined) return
    const values = list
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    choices[flag] = [...new Set([...(choices[flag] ?? []), ...values])].sort()
  }
  for (const line of clean.split('\n')) {
    for (const m of line.matchAll(USAGE_FLAG)) {
      flags.add(m[1])
      addChoices(m[1], m[2])
    }
    if (!OPTION_LINE.test(line)) continue
    // The aliases run up to the help text, two or more spaces after the last one.
    const head = line.trim().split(/\s{2,}/)[0] ?? ''
    for (const m of head.matchAll(OPTION_ALIAS)) {
      flags.add(m[1])
      addChoices(m[1], m[2])
    }
  }
  return {
    usage: /^usage:\s*mlx-server\b/im.test(clean),
    flags: [...flags].sort(),
    choices: Object.fromEntries(Object.entries(choices).sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}

/**
 * The build's `--help` against the flags core passes (the contract's `flags`) and, for a flag with
 * `choices`, every value core passes to it: one the build does not know fails the launch that
 * passes it (`break`, or the entry's own severity).
 */
export function checkMlxHelp(contract, help) {
  if (!help.usage || help.flags.length < MIN_MLX_HELP_FLAGS)
    return [
      finding(
        'help.parse',
        undefined,
        'error',
        `read ${help.flags.length} flags${help.usage ? '' : ' and no `usage: mlx-server` line'}, expected ${MIN_MLX_HELP_FLAGS}+`
      ),
    ]
  const findings = []
  for (const f of contract.flags ?? []) {
    const severity = f.severity ?? 'break'
    if (!help.flags.includes(f.flag)) {
      findings.push(
        finding(
          'help.required_flags',
          f.flag,
          severity,
          `mlx-server does not know ${f.flag}, which core passes${severity === 'break' ? ': the launch fails' : ''}`,
          { source: f.source }
        )
      )
      continue
    }
    if (!f.choices) continue
    const known = help.choices[f.flag]
    const missing = f.choices.filter((value) => !known?.includes(value))
    if (missing.length > 0)
      findings.push(
        finding(
          'help.choices',
          f.flag,
          severity,
          known
            ? `mlx-server takes ${f.flag} ${known.join('|')}; core also passes ${missing.join(', ')}: that launch fails`
            : `mlx-server lists no choices for ${f.flag}; core passes ${f.choices.join(', ')}`,
          { source: f.source, missing }
        )
      )
  }
  return findings
}

/**
 * What changed between the pin's and the candidate's `--help` among the flags core never passes, and
 * the choices of the flags core does pass (a lost flag or value core uses is already its own finding).
 */
export function diffMlxHelp(pin, candidate, contract) {
  const findings = []
  const passed = new Set((contract.flags ?? []).map((f) => f.flag))
  const removed = pin.flags.filter((f) => !candidate.flags.includes(f) && !passed.has(f)).sort()
  const added = candidate.flags.filter((f) => !pin.flags.includes(f)).sort()
  if (removed.length > 0)
    findings.push(
      finding('help.diff', 'removed-flags', 'info', `${removed.length} flags core never passes are gone`, {
        flags: removed,
      })
    )
  if (added.length > 0)
    findings.push(finding('help.diff', 'added-flags', 'info', `${added.length} new flags`, { flags: added }))
  for (const flag of [...passed].sort()) {
    const before = pin.choices[flag] ?? []
    const after = candidate.choices[flag] ?? []
    const gained = after.filter((v) => !before.includes(v))
    const lost = before.filter((v) => !after.includes(v))
    if (gained.length === 0 && lost.length === 0) continue
    findings.push(
      finding(
        'help.diff',
        `choices${flag}`,
        'info',
        `${flag} choices: ${[...gained.map((v) => `+${v}`), ...lost.map((v) => `-${v}`)].join(' ')}`,
        { flags: [flag], gained, lost }
      )
    )
  }
  return findings
}

/**
 * The install probe as core runs it (`probeMlxServer`): `--help` exits 0 and prints the contract's
 * pattern (argparse's `usage: mlx-server`), or the archive installs on no Mac. `ran` is the
 * invocation's result, `undefined` when it did not run.
 */
export function checkMlxProbe(contract, ran) {
  const probe = contract.probe
  if (!probe) return []
  const argv = probe.argv.join(' ')
  if (!ran) return [finding('install.probe', undefined, 'error', `mlx-server ${argv} did not run`)]
  const matched = new RegExp(probe.pattern, 'i').test(ran.output ?? '')
  if (ran.status === 0 && matched) return []
  const why = [
    ran.status === 0 ? null : `exits ${ran.status ?? ran.signal ?? 'without a status'}`,
    matched ? null : `prints no /${probe.pattern}/`,
  ]
    .filter(Boolean)
    .join(' and ')
  return [
    finding('install.probe', argv, 'break', `mlx-server ${argv} ${why}: the archive installs on no Mac`, {
      output: (ran.output ?? '').trim().slice(0, 400),
    }),
  ]
}

/**
 * What the archive unpacks to (`entries`: the names at its root, `undefined` when it was not
 * unpacked) against the contract's `archive.entries`: the install runs `<dir>/mlx-server` of the
 * unpacked archive, and conf's mirror refuses an archive holding anything else (`break`).
 */
export function checkMlxArchive(contract, entries) {
  const expected = contract.archive?.entries
  if (!expected) return []
  if (!Array.isArray(entries))
    return [finding('archive.layout', undefined, 'error', 'the archive was not unpacked')]
  const got = [...entries].sort()
  const want = [...expected].sort()
  if (got.length === want.length && got.every((name, i) => name === want[i])) return []
  return [
    finding(
      'archive.layout',
      undefined,
      'break',
      `the archive unpacks to ${got.join(', ') || 'nothing'}, not ${want.join(', ')}: the install finds no ${want[0]} at its root`,
      { entries: got }
    ),
  ]
}

/** A contract archive pattern: the MLX archive's name does not carry the tag. */
export const mlxAssetRe = (pattern) => new RegExp(`^${pattern}$`)

/** Where the core downloads the build a conf MLX manifest names (`mlxAssetUrl`), without the tag and the name. */
export const mlxDownloadBase = (manifest) => `https://github.com/${manifest.upstream_repo}/releases/download`

/**
 * MLX as a release engine: tags `vX.Y.Z` (the fork's release of an upstream tag) or
 * `mlxvlm-macos-arm64-<hex>`, one archive whatever the tag, conf's `backends/mlx-manifest.json`
 * (`parseManifest` adds the download base `releaseCompleteness` compares, from `upstream_repo`).
 */
export const MLX_RELEASE = {
  project: 'mlx-server',
  tagParts: mlxTagParts,
  assetRe: (pattern) => mlxAssetRe(pattern),
  archiveKind: (name) => name,
  parseManifest: (value) => {
    const parsed = parseMlxPinManifest(value)
    return parsed && { ...parsed, download_base: mlxDownloadBase(parsed) }
  },
}

/** The archives of `assets` (names) each contract backend takes. */
export function mlxBackendArchives(contract, tag, assets) {
  return releaseBackendArchives(contract, tag, assets, MLX_RELEASE)
}

/** The archives of a release core installs: what a passing live run does not cover is listed as unverified. */
export function mlxCoreAssets(contract, tag, assets) {
  return releaseCoreAssets(contract, tag, assets, MLX_RELEASE)
}

/** The release's archive against the backend core installs (`checkReleaseAssets`). */
export function checkMlxAssets(contract, input) {
  return checkReleaseAssets(contract, input, MLX_RELEASE)
}

/**
 * Whether an MLX release can be tested (`releaseCompleteness`): its archive up once with its digest;
 * on conf, a staging manifest naming the tag, downloading from conf, and pinning exactly those bytes.
 */
export function mlxCompleteness(input) {
  return releaseCompleteness(input, MLX_RELEASE)
}

/** The upstream tag the conf manifest naming `tag` says the build is based on, among `docs`. */
export function mlxManifestUpstreamTagFor(docs, tag) {
  const doc = docs.find((d) => parseMlxPinManifest(d)?.tag_name === tag)
  return doc ? mlxManifestUpstreamTag(doc) : null
}

/**
 * The report for one MLX candidate, from what scripts/engine-surface-diff.mjs gathered: both sides'
 * `--help` (`help_text`), the invocations, what the candidate's archive unpacked to
 * (`archive_entries`) and the archive lists, the pin's resolution, and the upstream history between
 * the two upstream tags.
 */
export function buildMlxReport(contract, inputs, options = {}) {
  const findings = []
  const skipped = {}
  const candidate = inputs.candidate
  const pin = inputs.pin ?? null
  const helpKey = (side) => side.invocations?.find((i) => i.argv?.join(' ') === '--help')

  if (candidate.capture_error) {
    for (const check of ['help.parse', 'invocations.exit', 'install.probe', 'archive.layout'])
      findings.push(
        finding(check, undefined, 'error', `the candidate was not run: ${candidate.capture_error}`)
      )
    skipped['help.diff'] = 'the candidate was not run'
  } else {
    const help = parseMlxHelp(candidate.help_text ?? '')
    findings.push(...checkMlxHelp(contract, help))
    const readable = (h) => h.usage && h.flags.length >= MIN_MLX_HELP_FLAGS
    if (!pin) skipped['help.diff'] = 'no pin'
    else if (pin.capture_error)
      findings.push(finding('help.diff', undefined, 'error', `the pin was not run: ${pin.capture_error}`))
    else if (pin.help_text === undefined || !readable(parseMlxHelp(pin.help_text)))
      findings.push(
        finding('help.diff', undefined, 'error', 'the pin’s --help does not read as a help screen')
      )
    else if (readable(help)) findings.push(...diffMlxHelp(parseMlxHelp(pin.help_text), help, contract))
    findings.push(...checkSdInvocations(contract, candidate.invocations ?? []))
    const ran = helpKey(candidate)
    findings.push(
      ...checkMlxProbe(contract, ran && { ...ran, output: ran.output ?? candidate.help_text ?? '' })
    )
    findings.push(...checkMlxArchive(contract, candidate.archive_entries ?? undefined))
  }

  if (!Array.isArray(candidate.assets)) {
    if (candidate.assets_error)
      findings.push(
        finding('assets.core_backends', undefined, 'error', `no archive list: ${candidate.assets_error}`)
      )
    else skipped['assets.core_backends'] = 'a local binary has no release'
  } else
    findings.push(
      ...checkMlxAssets(contract, {
        candidate: { tag: candidate.tag, assets: candidate.assets },
        pin: pin && Array.isArray(pin.assets) ? { tag: pin.tag, assets: pin.assets } : null,
      })
    )

  return releaseReport(contract, inputs, { findings, skipped, checks: MLX_CHECKS, hints: HINTS }, options)
}
