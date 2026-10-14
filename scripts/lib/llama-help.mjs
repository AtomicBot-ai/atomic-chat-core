// Reading `llama-server -h` and holding it to the engine contract
// (test/fixtures/llamacpp/engine-contract.json): does this build still know every flag and closed
// value core emits for it, which of them it marks deprecated, and what changed between two builds.
// Pure; findings carry stable ids (`check/subject`) so runs can be compared.

/** Fewer options than this means the output is not a help screen we understand: fail closed. */
export const MIN_HELP_OPTIONS = 50

const ALIAS = /^--?[A-Za-z][A-Za-z0-9_.+-]*$/
/** Terminal colour codes, should a build ever print them. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const OPTION_LINE = /^-{1,2}[A-Za-z]/

/**
 * Options of a `llama-server -h` screen. `common_arg::to_string()` prints each option at column 0,
 * its aliases and value hint padded to 40 columns (or alone on the line when longer than 37), and the
 * help text in lines indented by 40 spaces; section headers are `----- name -----`.
 */
export function parseLlamaHelp(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(ANSI, '').split('\n')
  const options = []
  let current
  for (const line of lines) {
    if (OPTION_LINE.test(line)) {
      const column = /^.{37} {3}/.test(line) ? line.slice(0, 40) : line
      // Aliases come first; the hint is whatever follows the last one, separators intact
      // (`none,draft-mtp,…` is a list, `<tensor name pattern>=<buffer type>` is not).
      const aliases = []
      let hintStart = 0
      for (const match of column.matchAll(/[^\s,]+/g)) {
        if (!ALIAS.test(match[0])) break
        aliases.push(match[0])
        hintStart = match.index + match[0].length
      }
      const hint = column
        .slice(hintStart)
        .replace(/^[\s,]+/, '')
        .trim()
      current = { aliases, hint, text: line.slice(column.length).trim() }
      options.push(current)
    } else if (current && line.startsWith(' ') && line.trim() !== '') {
      current.text = `${current.text}\n${line.trim()}`.trim()
    } else {
      current = undefined
    }
  }
  return options.map(({ aliases, hint, text: help }) => ({
    aliases,
    hint,
    help,
    env: [...help.matchAll(/\(env: ([A-Z0-9_]+)\)/g)].map((m) => m[1]),
    deprecated: /deprecated/i.test(help),
  }))
}

/** The option a flag spells, if the build knows it. */
export function findOption(options, flag) {
  return options.find((o) => o.aliases.includes(flag))
}

const inRanges = (ranges, build) =>
  (ranges ?? []).some((r) => (r.from === null || build >= r.from) && (r.until === null || build < r.until))

/**
 * Flags (with the closed values) core emits for `build`, by any emitter. `probe_gated` when only
 * emitters that run after a `-h` probe (the contract's `emitters[].probe_gated`) emit it there.
 */
export function requiredAt(contract, build) {
  const probed = new Set((contract.emitters ?? []).filter((e) => e.probe_gated).map((e) => e.name))
  return contract.flags
    .map((f) => {
      const emitters = Object.keys(f.emitters).filter((e) => inRanges(f.emitters[e], build))
      return {
        flag: f.flag,
        emitters,
        probe_gated: emitters.length > 0 && emitters.every((e) => probed.has(e)),
        values: (f.values ?? [])
          .filter((v) => inRanges(v.builds, build))
          .map((v) => ({ value: v.value, probe_gated: v.probe_gated === true })),
      }
    })
    .filter((f) => f.emitters.length > 0)
}

/** A value hint that lists its choices: `[on|off|auto]`, `{none,mean}`, `<0|1>`, `a,b,c`. */
export function hintChoices(hint) {
  const bracketed = /^[[{<](.+)[\]}>]$/.exec(hint)
  if (bracketed) return bracketed[1].split(/[|,]/).map((s) => s.trim())
  if (/^[A-Za-z0-9_.+-]+(,[A-Za-z0-9_.+-]+)+$/.test(hint)) return hint.split(',')
  return undefined
}

const mentions = (text, value) =>
  new RegExp(`(^|[^A-Za-z0-9_+-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_+-]|$)`).test(
    text
  )

const finding = (check, subject, severity, message, evidence) => ({
  id: subject === undefined ? check : `${check}/${subject}`,
  check,
  severity,
  ...(subject === undefined ? {} : { subject }),
  message,
  ...(evidence === undefined ? {} : { evidence }),
})

/**
 * Hold one build's help to the contract. `break`: a flag or listed value core emits for this build is
 * unknown (the launch fails with `invalid argument`); `warn`: deprecated, or a value the help text does
 * not mention; `info`: a probe-gated value core would simply not use; `error`: unreadable help.
 */
export function checkHelp(contract, build, options) {
  if (options.length < MIN_HELP_OPTIONS)
    return [
      finding(
        'help.parse',
        undefined,
        'error',
        `read ${options.length} options, expected ${MIN_HELP_OPTIONS}+`
      ),
    ]
  const findings = []
  for (const required of requiredAt(contract, build)) {
    const option = findOption(options, required.flag)
    if (!option) {
      findings.push(
        finding(
          'help.required_flags',
          required.flag,
          required.probe_gated ? 'info' : 'break',
          required.probe_gated
            ? `b${build} does not know ${required.flag}; core only emits it after its -h probe finds it`
            : `b${build} does not know ${required.flag}, which core emits`,
          { emitters: required.emitters }
        )
      )
      continue
    }
    if (option.deprecated)
      findings.push(
        finding(
          'help.deprecated',
          required.flag,
          'warn',
          `b${build} marks ${required.flag} deprecated; core still emits it`,
          {
            help: option.help,
          }
        )
      )
    const choices = hintChoices(option.hint)
    for (const { value, probe_gated } of required.values) {
      const listed = choices ? choices.includes(value) : mentions(`${option.hint}\n${option.help}`, value)
      if (listed) continue
      const severity = probe_gated ? 'info' : choices ? 'break' : 'warn'
      findings.push(
        finding(
          'help.flag_values',
          `${required.flag}=${value}`,
          severity,
          `b${build} ${choices ? 'does not list' : 'does not mention'} ${required.flag} ${value}`,
          {
            hint: option.hint,
          }
        )
      )
    }
  }
  const envs = new Set(options.flatMap((o) => o.env))
  for (const e of contract.env)
    if (!envs.has(e.name))
      findings.push(finding('help.env', e.name, e.severity, `b${build} no longer reads ${e.name}`))
  return findings
}

/**
 * What changed between two builds' help, against what core emits at the candidate's build. Flags
 * the candidate's checks already report (`help.required_flags`, `help.deprecated`) are not repeated.
 */
export function diffHelp(pinOptions, candidateOptions, contract, candidateBuild) {
  const pin = new Set(pinOptions.flatMap((o) => o.aliases))
  const candidate = new Set(candidateOptions.flatMap((o) => o.aliases))
  const universe = new Set(contract.flags.map((f) => f.flag))
  const required = new Set(requiredAt(contract, candidateBuild).map((r) => r.flag))
  const findings = []
  const removed = [...pin].filter((f) => !candidate.has(f)).sort()
  for (const flag of removed.filter((f) => universe.has(f) && !required.has(f)))
    findings.push(
      finding(
        'help.diff',
        `removed/${flag}`,
        'info',
        `${flag} is gone; core no longer emits it at b${candidateBuild} (anticipated by a build gate)`
      )
    )
  const otherRemoved = removed.filter((f) => !universe.has(f))
  if (otherRemoved.length > 0)
    findings.push(
      finding('help.diff', 'removed', 'info', `${otherRemoved.length} flag(s) core never emits are gone`, {
        flags: otherRemoved,
      })
    )
  const added = [...candidate].filter((f) => !pin.has(f)).sort()
  if (added.length > 0)
    findings.push(finding('help.diff', 'added', 'info', `${added.length} new flag(s)`, { flags: added }))
  const wasDeprecated = new Set(pinOptions.filter((o) => o.deprecated).flatMap((o) => o.aliases))
  const newlyDeprecated = candidateOptions
    .filter((o) => o.deprecated)
    .flatMap((o) => o.aliases)
    .filter((f) => !wasDeprecated.has(f) && pin.has(f))
    .sort()
  for (const flag of newlyDeprecated.filter((f) => universe.has(f) && !required.has(f)))
    findings.push(
      finding(
        'help.diff',
        `deprecated/${flag}`,
        'warn',
        `${flag} is newly deprecated; core emits it at other builds`
      )
    )
  const otherDeprecated = newlyDeprecated.filter((f) => !universe.has(f))
  if (otherDeprecated.length > 0)
    findings.push(
      finding(
        'help.diff',
        'deprecated',
        'info',
        `${otherDeprecated.length} flag(s) core never emits are newly deprecated`,
        {
          flags: otherDeprecated,
        }
      )
    )
  return findings
}
