// The verdict of one engine candidate check (scripts/engine-candidate.mjs, .github/workflows/
// engine-candidate.yml): what `resolve` fixed (core, conf, candidate, pins), the surface report, and
// one cell per job of the matrix — core suites per OS, live tests per OS × {pin, candidate} — become
// results.json (schema atomic-engine-candidate-results v1) and results.md. Pure; `now` is a parameter.
//
// pass: everything expected ran and passed. fail: the candidate (or core) fails something, or the
// surface breaks. incomplete: something expected is missing — a cell, a required test, the surface,
// or the release itself is not fully uploaded yet — so nobody can say pass.

export const RESULTS_SCHEMA = 'atomic-engine-candidate-results'
export const RESOLVE_SCHEMA = 'atomic-engine-candidate-resolve'
export const CELL_SCHEMA = 'atomic-engine-candidate-cell'

/** `candidate_id`: what the orchestrator finds its run by, in `run-name`. */
export const CANDIDATE_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/

const OUTCOMES = { passed: 'passed', failed: 'failed' }

/** A Vitest JSON report → `[{file, name, status}]`, `name` being the test's full name. */
export function vitestOutcomes(report) {
  return (report?.testResults ?? []).flatMap((file) => {
    const path = String(file.name ?? '').replace(/\\/g, '/')
    const at = path.lastIndexOf('/test/')
    const rel = at < 0 ? path : path.slice(at + 1)
    return (file.assertionResults ?? []).map((t) => ({
      file: rel,
      name: t.fullName ?? [...(t.ancestorTitles ?? []), t.title].join(' '),
      status: OUTCOMES[t.status] ?? 'skipped',
    }))
  })
}

const count = (tests) => ({
  passed: tests.filter((t) => t.status === 'passed').length,
  failed: tests.filter((t) => t.status === 'failed').length,
  skipped: tests.filter((t) => t.status === 'skipped').length,
})

/**
 * What the live contract probe (test/live/llamacpp-contract.test.ts) saw of the engine contract, from
 * its `observed.json`: the breaks it failed on and the drift (a string or route lost or appeared).
 */
function observedOf(observed) {
  if (observed?.schema !== 'atomic-engine-observed') return undefined
  return {
    breaks: Array.isArray(observed.breaks) ? observed.breaks : [],
    drift: (Array.isArray(observed.drift) ? observed.drift : []).map(({ kind, id, verdict, severity }) => ({
      kind,
      id,
      verdict,
      severity,
    })),
  }
}

/**
 * A live cell: one platform, one role (`pin` or `candidate`). `fixture` is what fetch-live-fixtures
 * wrote (the archive and model hashes), `vitest` the JSON report of the live files (absent when the
 * tests never ran), `required` the tests that have to pass for the cell to count.
 */
export function liveCell({ platform, os, role, tag, repo, fixture, vitest, required, observed, error }) {
  const tests = vitest ? vitestOutcomes(vitest) : []
  const passed = new Set(tests.filter((t) => t.status === 'passed').map((t) => t.name))
  const failedTests = tests.filter((t) => t.status === 'failed').map((t) => t.name)
  const missing = vitest
    ? required.map((r) => r.name).filter((n) => !passed.has(n) && !failedTests.includes(n))
    : []
  const status = !vitest
    ? 'incomplete'
    : failedTests.length > 0
      ? 'fail'
      : missing.length > 0
        ? 'incomplete'
        : 'pass'
  return {
    schema: CELL_SCHEMA,
    kind: 'live',
    platform,
    os,
    role,
    tag,
    repo,
    status,
    asset: fixture?.asset ?? null,
    model: fixture?.model ? { sha256: fixture.model.sha256, verified: fixture.model.verified } : null,
    version_output: fixture?.version_output ?? null,
    tests: count(tests),
    failed_tests: failedTests,
    missing_required: missing,
    ...(observedOf(observed) ? { observed: observedOf(observed) } : {}),
    ...(error ? { error } : !vitest ? { error: 'the live tests left no report' } : {}),
  }
}

/**
 * A core cell: one platform, the outcome of each suite step (`success`, `failure`, `cancelled`,
 * `skipped`, as GitHub reports them) and the Vitest reports of the suites that have one.
 */
export function coreCell({ platform, os, steps, vitest = [], expected }) {
  const tests = vitest.flatMap((r) => vitestOutcomes(r))
  const outcome = Object.fromEntries(expected.map((name) => [name, steps[name] ?? 'missing']))
  const values = Object.values(outcome)
  const status = values.includes('failure')
    ? 'fail'
    : values.every((v) => v === 'success')
      ? 'pass'
      : 'incomplete'
  return {
    schema: CELL_SCHEMA,
    kind: 'core',
    platform,
    os,
    status,
    steps: outcome,
    tests: count(tests),
    failed_tests: tests.filter((t) => t.status === 'failed').map((t) => `${t.file}: ${t.name}`),
  }
}

const reason = (status, code, message, detail) => ({ status, code, message, ...(detail ? { detail } : {}) })

/**
 * results.json. `resolve` is resolve.json (or `undefined` when that job left nothing), `surface`
 * the surface report.json, `cells` every cell found; `platforms` the ones this run covers (all five
 * in CI, the host locally).
 */
export function buildResults({ run, config, resolve, surface, cells, platforms, now }) {
  const reasons = []
  const suites = resolve?.suites ?? run?.suites ?? 'all'
  if (!resolve) reasons.push(reason('incomplete', 'resolve_missing', 'the resolve job left no resolve.json'))
  for (const error of resolve?.errors ?? []) reasons.push(reason('incomplete', 'resolve_error', error))
  const candidate = resolve?.candidate ?? null
  const incompleteCandidate = candidate && candidate.complete === false
  if (incompleteCandidate)
    reasons.push(
      reason(
        'incomplete',
        'candidate_incomplete',
        `${candidate.tag} is missing archives (upstream may still be uploading them)`,
        candidate.missing
      )
    )

  if (!surface) reasons.push(reason('incomplete', 'surface_missing', 'no surface report'))
  else if (surface.status === 'break')
    reasons.push(
      reason(
        'fail',
        'surface_break',
        'the surface diff found a break',
        surface.findings.filter((f) => f.severity === 'break').map((f) => f.id)
      )
    )
  else if (surface.status === 'error')
    reasons.push(
      reason(
        'incomplete',
        'surface_error',
        'a surface check could not run',
        surface.findings.filter((f) => f.severity === 'error').map((f) => f.id)
      )
    )

  const live = cells.filter((c) => c.kind === 'live')
  const core = cells.filter((c) => c.kind === 'core')
  const matrix = resolve?.live_matrix ?? []
  const outCells = []
  const verdict = {
    candidate_regressions: [],
    core_failures: [],
    candidate_failures: [],
    pin_failures: [],
    drift: [],
    verified_assets: [],
    unverified_assets: [],
    coverage: { verified: ['cpu'], not_verified: config?.not_verified ?? [] },
  }

  for (const platform of platforms) {
    const pinTag = resolve?.pin?.per_platform?.[platform]?.tag ?? null
    const byRole = {}
    for (const role of ['pin', 'candidate']) {
      const expected = matrix.find((m) => m.platform === platform && m.role === role)
      const found = live.find((c) => c.platform === platform && c.role === role)
      let cell = found
      if (!expected && !found) {
        const status =
          role === 'pin' && candidate && pinTag === candidate.tag
            ? 'same-as-pin'
            : role === 'pin' && !pinTag
              ? 'no-pin'
              : 'not-run'
        cell = {
          kind: 'live',
          platform,
          role,
          tag: role === 'pin' ? pinTag : (candidate?.tag ?? null),
          status,
        }
        if (status === 'not-run' && !incompleteCandidate)
          reasons.push(reason('incomplete', 'cell_missing', `live ${platform} ${role} was not scheduled`))
      } else if (!found) {
        cell = {
          kind: 'live',
          platform,
          role,
          tag: expected.tag,
          repo: expected.repo,
          os: expected.os,
          status: 'missing',
        }
        if (!incompleteCandidate)
          reasons.push(reason('incomplete', 'cell_missing', `live ${platform} ${role} left no result`))
      } else if (found.status === 'incomplete')
        reasons.push(
          reason(
            'incomplete',
            found.missing_required?.length ? 'required_test_missing' : 'cell_incomplete',
            `live ${platform} ${role}: ${found.error ?? 'required tests did not run'}`,
            found.missing_required
          )
        )
      byRole[role] = cell
      outCells.push(cell)
    }

    const cand = byRole.candidate
    const pin = byRole.pin
    const pinFailed = new Set(pin.failed_tests ?? [])
    for (const test of cand.failed_tests ?? []) {
      if (pin.status === 'pass' || (pin.failed_tests && !pinFailed.has(test)))
        verdict.candidate_regressions.push({ platform, test })
      else if (pinFailed.has(test)) verdict.core_failures.push({ platform, test })
      else verdict.candidate_failures.push({ platform, test })
    }
    for (const test of pin.failed_tests ?? [])
      if (!(cand.failed_tests ?? []).includes(test)) verdict.pin_failures.push({ platform, test })
    // Drift is reported, not judged: a lost string core needs fails the probe's own test.
    for (const d of cand.observed?.drift ?? []) verdict.drift.push({ platform, ...d })
    if (cand.status === 'pass' && cand.asset)
      verdict.verified_assets.push({
        platform,
        name: cand.asset.name,
        sha256: cand.asset.sha256,
        digest_verified: cand.asset.digest_verified ?? null,
      })
  }
  if (verdict.candidate_regressions.length > 0)
    reasons.push(
      reason(
        'fail',
        'candidate_regression',
        'the candidate fails tests the pin passes',
        verdict.candidate_regressions
      )
    )
  if (verdict.core_failures.length > 0)
    reasons.push(
      reason('fail', 'core_failure', 'tests fail on the pin as well as the candidate', verdict.core_failures)
    )
  if (verdict.candidate_failures.length > 0)
    reasons.push(reason('fail', 'candidate_failure', 'the candidate fails tests', verdict.candidate_failures))

  for (const platform of platforms) {
    const cell = core.find((c) => c.platform === platform)
    if (suites !== 'all') outCells.push({ kind: 'core', platform, status: 'not-requested' })
    else if (!cell) {
      outCells.push({ kind: 'core', platform, status: 'missing' })
      if (!incompleteCandidate)
        reasons.push(reason('incomplete', 'cell_missing', `core ${platform} left no result`))
    } else {
      outCells.push(cell)
      if (cell.status === 'fail')
        reasons.push(
          reason('fail', 'core_suite_failed', `core suites fail on ${platform}`, cell.failed_tests)
        )
      else if (cell.status !== 'pass')
        reasons.push(
          reason('incomplete', 'core_suite_incomplete', `core suites did not all run on ${platform}`)
        )
    }
  }

  const verifiedNames = new Set(verdict.verified_assets.map((a) => a.name))
  verdict.unverified_assets = (candidate?.core_assets ?? []).filter((n) => !verifiedNames.has(n)).sort()

  // An archive set still being uploaded is retried later, whatever else it did.
  const status = incompleteCandidate
    ? 'incomplete'
    : reasons.some((r) => r.status === 'fail')
      ? 'fail'
      : reasons.some((r) => r.status === 'incomplete')
        ? 'incomplete'
        : 'pass'

  return {
    schema: RESULTS_SCHEMA,
    schema_version: 1,
    generated_at: now ?? null,
    engine: resolve?.engine ?? config?.engine ?? null,
    run: run ?? null,
    core: resolve?.core ?? null,
    conf: resolve?.conf ?? null,
    candidate,
    pin: resolve?.pin ?? null,
    status,
    reasons,
    surface: surface
      ? { status: surface.status, counts: surface.counts, same_as_pin: surface.inputs?.same_as_pin ?? false }
      : { status: 'missing' },
    cells: outCells,
    verdict,
  }
}

const ICON = { pass: 'pass', fail: 'FAIL', incomplete: 'incomplete', missing: 'missing' }

/** results.md, rendered from results.json alone. */
export function renderResultsMarkdown(results) {
  const lines = []
  const cand = results.candidate
  lines.push(
    `# ${results.engine ?? 'engine'} candidate ${cand?.tag ?? '?'}${cand?.source === 'bin' ? ' (local build)' : cand?.repo ? ` (${cand.repo})` : ''} — ${results.status.toUpperCase()}`,
    ''
  )
  const facts = []
  if (results.run?.candidate_id) facts.push(`candidate id \`${results.run.candidate_id}\``)
  if (results.core)
    facts.push(`core ${results.core.version ?? '?'} at \`${(results.core.sha ?? '?').slice(0, 10)}\``)
  if (results.conf?.sha) facts.push(`conf \`${results.conf.sha.slice(0, 10)}\``)
  if (results.pin) facts.push(`pin ${results.pin.tag ?? 'none'} (${results.pin.source})`)
  if (results.run?.url) facts.push(`[run](${results.run.url})`)
  lines.push(facts.join(' · '), '')
  if (results.reasons.length > 0) {
    lines.push('## Why not pass', '')
    for (const r of results.reasons) lines.push(`- **${r.status}** \`${r.code}\` — ${r.message}`)
    lines.push('')
  }
  lines.push(
    `Surface: **${results.surface.status}**` +
      (results.surface.counts
        ? ` (${results.surface.counts.break} break, ${results.surface.counts.warn} warn, ${results.surface.counts.info} info, ${results.surface.counts.error} error)`
        : ''),
    ''
  )
  const platforms = [...new Set(results.cells.map((c) => c.platform))]
  lines.push('| platform | core | live pin | live candidate |', '|---|---|---|---|')
  const show = (c) =>
    !c
      ? '—'
      : `${ICON[c.status] ?? c.status}${c.tag && c.kind === 'live' ? ` ${c.tag}` : ''}${c.tests ? ` (${c.tests.passed}/${c.tests.passed + c.tests.failed + c.tests.skipped})` : ''}`
  for (const p of platforms) {
    const find = (kind, role) =>
      results.cells.find((c) => c.platform === p && c.kind === kind && (!role || c.role === role))
    lines.push(
      `| ${p} | ${show(find('core'))} | ${show(find('live', 'pin'))} | ${show(find('live', 'candidate'))} |`
    )
  }
  lines.push('')
  const v = results.verdict
  for (const [title, list] of [
    ['Candidate regressions (the pin passes)', v.candidate_regressions],
    ['Core failures (the pin fails too)', v.core_failures],
    ['Candidate failures', v.candidate_failures],
    ['Pin failures (the candidate passes)', v.pin_failures],
  ])
    if (list.length > 0) lines.push(`## ${title}`, '', ...list.map((x) => `- ${x.platform}: ${x.test}`), '')
  if (v.drift.length > 0)
    lines.push(
      '## Drift the live probe saw on the candidate',
      '',
      ...v.drift.map((d) => `- ${d.platform}: ${d.severity} ${d.kind} \`${d.id}\` ${d.verdict}`),
      ''
    )
  if (v.verified_assets.length > 0)
    lines.push(
      '## Verified archives',
      '',
      ...v.verified_assets.map((a) => `- ${a.platform}: \`${a.name}\` sha256 \`${a.sha256}\``),
      ''
    )
  lines.push(
    `Not verified: ${v.coverage.not_verified.join(', ') || 'nothing'}` +
      (v.unverified_assets.length > 0 ? ` — ${v.unverified_assets.length} archive(s) core installs` : ''),
    ''
  )
  return `${lines.join('\n').trimEnd()}\n`
}
