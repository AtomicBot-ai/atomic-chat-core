/**
 * The verdict of an engine candidate check (scripts/lib/engine-results.mjs): what makes a run pass,
 * fail or stay incomplete, and whose fault a red test is — the candidate's (the pin passes it) or
 * core's (the pin fails it too). Plus the configuration the workflow and `npm run engine:check`
 * read: every required live test it names has to exist, or a renamed test would silently stop
 * counting (`.github/engine-candidate/llamacpp-upstream.json`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildResults,
  CANDIDATE_ID_RE,
  coreCell,
  mergeCoreShards,
  liveCell,
  renderResultsMarkdown,
  vitestOutcomes,
} from '../../scripts/lib/engine-results.mjs'
import type {
  Cell,
  EngineCandidateConfig,
  ResolveResult,
  VitestReport,
} from '../../scripts/lib/engine-results.mjs'
import { PIN_PLATFORMS } from '../../scripts/lib/engine-pin.mjs'

const root = new URL('../../', import.meta.url)
const config = JSON.parse(
  readFileSync(new URL('.github/engine-candidate/llamacpp-upstream.json', root), 'utf8')
) as EngineCandidateConfig
const PLATFORMS = config.platforms.map((p) => p.platform)
const REQUIRED = config.required_live_tests.map((t) => t.name)
const [FIRST, SECOND] = REQUIRED as [string, string]

/** A live report in Vitest's JSON shape: every required test, some failed or skipped. */
const report = (failed: string[] = [], skipped: string[] = []): VitestReport => ({
  testResults: [
    {
      name: '/home/runner/work/atomic-chat-core/atomic-chat-core/test/live/llamacpp.test.ts',
      assertionResults: REQUIRED.map((name) => ({
        fullName: name,
        status: failed.includes(name) ? 'failed' : skipped.includes(name) ? 'skipped' : 'passed',
      })),
    },
  ],
})

const asset = (tag: string, platform: string) => ({
  name: `llama-${tag}-bin-${platform}.tar.gz`,
  sha256: tag === 'b11617' ? 'a'.repeat(64) : 'b'.repeat(64),
  digest_verified: true,
})

function resolved(over: Partial<ResolveResult> = {}): ResolveResult {
  const candidateTag = over.candidate?.tag ?? 'b11617'
  const pinTag = over.pin?.tag === undefined ? 'b11463' : over.pin.tag
  return {
    schema: 'atomic-engine-candidate-resolve',
    schema_version: 1,
    engine: 'llamacpp-upstream',
    candidate_id: 'phase0-test',
    suites: 'all',
    core: { ref: 'main', sha: 'c'.repeat(40), version: '0.17.0', protected_changes: [] },
    conf: { ref: 'main', sha: 'd'.repeat(40) },
    candidate: {
      repo: 'ggml-org/llama.cpp',
      tag: candidateTag,
      source: 'release',
      complete: true,
      missing: [],
      core_assets: PLATFORMS.map((p) => asset(candidateTag, p).name).concat(
        'llama-b11617-bin-win-cuda-13.4-x64.zip'
      ),
    },
    pin: {
      source: 'list',
      tag: pinTag,
      repo: 'ggml-org/llama.cpp',
      per_platform: Object.fromEntries(PLATFORMS.map((p) => [p, { tag: pinTag }])),
    },
    platforms: config.platforms,
    live_matrix: config.platforms.flatMap(({ platform, runner }) => [
      { platform, os: runner, role: 'candidate' as const, tag: candidateTag, repo: 'ggml-org/llama.cpp' },
      ...(pinTag && pinTag !== candidateTag
        ? [{ platform, os: runner, role: 'pin' as const, tag: pinTag, repo: 'ggml-org/llama.cpp' }]
        : []),
    ]),
    errors: [],
    ...over,
  }
}

const surface = (status: 'pass' | 'warn' | 'break' | 'error') => ({
  status,
  counts: { break: status === 'break' ? 1 : 0, warn: 0, info: 0, error: status === 'error' ? 1 : 0 },
  findings:
    status === 'break'
      ? [{ id: 'help.required_flags/--load-mode', severity: 'break' }]
      : status === 'error'
        ? [{ id: 'help.parse', severity: 'error' }]
        : [],
  inputs: { same_as_pin: false },
})

/** Every cell the matrix of `r` expects; `edit` changes what one platform's cells report. */
function cells(
  r: ResolveResult,
  edit: { platform?: string; candidate?: VitestReport | null; pin?: VitestReport | null; core?: string } = {}
): Cell[] {
  const out: Cell[] = r.live_matrix.flatMap((m) => {
    const own = edit.platform === m.platform ? edit[m.role] : undefined
    if (own === null) return []
    return [
      liveCell({
        platform: m.platform,
        os: m.os,
        role: m.role,
        tag: m.tag,
        repo: m.repo,
        fixture: { asset: asset(m.tag, m.platform), model: { sha256: 'e'.repeat(64), verified: true } },
        vitest: own ?? report(),
        required: config.required_live_tests,
      }),
    ]
  })
  if (r.suites === 'all')
    for (const platform of PLATFORMS) {
      const unit = edit.platform === platform && edit.core ? edit.core : 'success'
      out.push(
        coreCell({
          platform,
          steps: { unit, build: 'success', build_bin: 'success', e2e: 'success' },
          expected: config.core_suites,
        })
      )
    }
  return out
}

/** `s`: the surface report, `null` for none at all. */
const results = (r: ResolveResult, c: Cell[], s: ReturnType<typeof surface> | null = surface('warn')) =>
  buildResults({
    run: { mode: 'ci' },
    config,
    resolve: r,
    ...(s ? { surface: s } : {}),
    cells: c,
    platforms: PLATFORMS,
    now: 'x',
  })
const codes = (res: { reasons: Array<{ code: string }> }) => res.reasons.map((x) => x.code)

describe('the verdict of a candidate run', () => {
  it('everything green, the surface only warning: pass, the CPU archives verified, GPU named as not', () => {
    const r = resolved()
    const res = results(r, cells(r))
    expect(res.status).toBe('pass')
    expect(res.reasons).toEqual([])
    expect(res.verdict.verified_assets.map((a) => a.platform)).toEqual(PLATFORMS)
    expect(res.verdict.unverified_assets).toEqual(['llama-b11617-bin-win-cuda-13.4-x64.zip'])
    expect(res.verdict.coverage.not_verified).toEqual(['cuda', 'vulkan', 'rocm', 'opencl'])
  })

  it('a required live test skipped: incomplete', () => {
    const r = resolved()
    const res = results(r, cells(r, { platform: 'windows-arm64', candidate: report([], [SECOND]) }))
    expect(res.status).toBe('incomplete')
    expect(codes(res)).toEqual(['required_test_missing'])
  })

  it('only the candidate fails: fail, a candidate regression', () => {
    const r = resolved()
    const res = results(r, cells(r, { platform: 'linux-arm64', candidate: report([FIRST]) }))
    expect(res.status).toBe('fail')
    expect(res.verdict.candidate_regressions).toEqual([{ platform: 'linux-arm64', test: FIRST }])
    expect(res.verdict.core_failures).toEqual([])
  })

  it('the pin fails the same test: fail, a core failure rather than the candidate’s', () => {
    const r = resolved()
    const res = results(
      r,
      cells(r, { platform: 'macos-arm64', candidate: report([FIRST]), pin: report([FIRST]) })
    )
    expect(res.status).toBe('fail')
    expect(res.verdict.core_failures).toEqual([{ platform: 'macos-arm64', test: FIRST }])
    expect(res.verdict.candidate_regressions).toEqual([])
  })

  it('a cell that left no artifact: incomplete', () => {
    const r = resolved()
    const res = results(r, cells(r, { platform: 'windows-x64', pin: null }))
    expect(res.status).toBe('incomplete')
    expect(codes(res)).toEqual(['cell_missing'])
    expect(
      res.cells.find((c) => c.platform === 'windows-x64' && c.kind === 'live' && c.role === 'pin')?.status
    ).toBe('missing')
  })

  it('a surface break fails the run; a surface that could not run leaves it incomplete', () => {
    const r = resolved()
    expect(results(r, cells(r), surface('break'))).toMatchObject({
      status: 'fail',
      reasons: [
        expect.objectContaining({ code: 'surface_break', detail: ['help.required_flags/--load-mode'] }),
      ],
    })
    expect(results(r, cells(r), surface('error')).status).toBe('incomplete')
    expect(codes(results(r, cells(r), null))).toEqual(['surface_missing'])
  })

  it('suites=live: the core suites are not requested, not missing', () => {
    const r = resolved({ suites: 'live' })
    const res = results(r, cells(r))
    expect(res.status).toBe('pass')
    expect(res.cells.filter((c) => c.kind === 'core').map((c) => c.status)).toEqual(
      PLATFORMS.map(() => 'not-requested')
    )
  })

  it('a failing core suite fails the run', () => {
    const r = resolved()
    const res = results(r, cells(r, { platform: 'windows-x64', core: 'failure' }))
    expect(res.status).toBe('fail')
    expect(codes(res)).toEqual(['core_suite_failed'])
  })

  it('the candidate is the pin: the pin cells are same-as-pin, and a failure is the candidate’s alone', () => {
    const r = resolved({
      pin: { source: 'list', tag: 'b11617', repo: 'ggml-org/llama.cpp', per_platform: {} },
    })
    r.pin.per_platform = Object.fromEntries(PLATFORMS.map((p) => [p, { tag: 'b11617' }]))
    const green = results(r, cells(r))
    expect(green.status).toBe('pass')
    expect(green.cells.filter((c) => c.kind === 'live' && c.role === 'pin').map((c) => c.status)).toEqual(
      PLATFORMS.map(() => 'same-as-pin')
    )
    const red = results(r, cells(r, { platform: 'linux-x64', candidate: report([FIRST]) }))
    expect(red.status).toBe('fail')
    expect(red.verdict.candidate_failures).toEqual([{ platform: 'linux-x64', test: FIRST }])
  })

  it('archives still being uploaded: incomplete, whatever else went wrong', () => {
    const r = resolved()
    r.candidate = {
      ...r.candidate,
      complete: false,
      missing: [{ kind: 'mirror', pattern: 'ubuntu-arm64\\.tar\\.gz' }],
    }
    r.live_matrix = []
    const res = results(r, [], surface('break'))
    expect(res.status).toBe('incomplete')
    expect(codes(res)).toContain('candidate_incomplete')
    expect(codes(res)).not.toContain('cell_missing')
  })

  it('lists the drift the live contract probe saw on the candidate, without judging it', () => {
    const r = resolved()
    const observed = {
      schema: 'atomic-engine-observed',
      schema_version: 1,
      breaks: [],
      drift: [{ kind: 'string', id: 'ready.http-listening', verdict: 'lost', severity: 'warn', text: 'x' }],
    }
    const withProbe = cells(r).map((c) =>
      c.kind === 'live' && c.platform === 'linux-x64' && c.role === 'candidate'
        ? liveCell({ ...c, tag: c.tag, vitest: report(), required: config.required_live_tests, observed })
        : c
    )
    const res = results(r, withProbe)
    expect(res.status).toBe('pass')
    expect(res.verdict.drift).toEqual([
      {
        platform: 'linux-x64',
        kind: 'string',
        id: 'ready.http-listening',
        verdict: 'lost',
        severity: 'warn',
      },
    ])
    expect(renderResultsMarkdown(res)).toContain('- linux-x64: warn string `ready.http-listening` lost')
    expect(
      liveCell({ platform: 'x', role: 'pin', tag: 'b1', required: [], observed: { schema: 'other' } })
        .observed
    ).toBeUndefined()
  })

  it('renders results.md from the JSON', () => {
    const r = resolved()
    const md = renderResultsMarkdown(
      results(r, cells(r, { platform: 'linux-arm64', candidate: report([FIRST]) }))
    )
    expect(md).toContain('— FAIL')
    expect(md).toContain('## Candidate regressions (the pin passes)')
    expect(md).toContain(`- linux-arm64: ${FIRST}`)
    expect(md).toContain(
      `| linux-x64 | pass (0/0) | pass b11463 (${REQUIRED.length}/${REQUIRED.length}) | pass b11617 (${REQUIRED.length}/${REQUIRED.length}) |`
    )
  })
})

describe('cells', () => {
  it('reads Vitest JSON: the full name, the repo-relative file, pending as skipped', () => {
    expect(
      vitestOutcomes({
        testResults: [
          {
            name: 'C:\\a\\test\\core\\test\\live\\llamacpp.test.ts',
            assertionResults: [
              { ancestorTitles: ['a real llama.cpp backend'], title: 'x', status: 'pending' },
              { fullName: 'y z', status: 'failed' },
            ],
          },
        ],
      })
    ).toEqual([
      { file: 'test/live/llamacpp.test.ts', name: 'a real llama.cpp backend x', status: 'skipped' },
      { file: 'test/live/llamacpp.test.ts', name: 'y z', status: 'failed' },
    ])
  })

  it('a live cell whose tests never ran is incomplete, not a pass', () => {
    const cell = liveCell({
      platform: 'linux-x64',
      role: 'candidate',
      tag: 'b11617',
      required: config.required_live_tests,
    })
    expect(cell).toMatchObject({ status: 'incomplete', error: 'the live tests left no report' })
  })

  it('a core cell with a step that never ran is incomplete', () => {
    const cell = coreCell({
      platform: 'linux-x64',
      steps: { unit: 'success', build: 'success' },
      expected: config.core_suites,
    })
    expect(cell.status).toBe('incomplete')
    expect(cell.steps).toEqual({ unit: 'success', build: 'success', build_bin: 'missing', e2e: 'missing' })
  })
})

describe('core suites split over shards (Windows)', () => {
  const shard = (k: string, steps: Record<string, string>, failed: string[] = []) => ({
    ...coreCell({ platform: 'windows-arm64', steps, expected: config.core_suites, shard: k }),
    ...(failed.length ? { failed_tests: failed } : {}),
  })
  const first = (unit = 'success') =>
    shard('1/2', { unit, build: 'success', build_bin: 'success', e2e: 'success' })
  const second = (unit = 'success', failed: string[] = []) =>
    shard('2/2', { unit, build: 'skipped', build_bin: 'skipped', e2e: 'skipped' }, failed)

  it('passes when both shards pass; the steps only the first runs count once', () => {
    const [cell] = mergeCoreShards([first(), second()])
    expect(cell).toMatchObject({
      platform: 'windows-arm64',
      status: 'pass',
      shard: '2/2',
      steps: { unit: 'success', build: 'success', build_bin: 'success', e2e: 'success' },
    })
  })

  it('fails when either shard fails, with its failed tests', () => {
    const [cell] = mergeCoreShards([first(), second('failure', ['src/core/x.test.ts: hangs'])])
    expect(cell?.status).toBe('fail')
    expect(cell?.failed_tests).toEqual(['src/core/x.test.ts: hangs'])
  })

  it('is incomplete when a shard left no cell', () => {
    expect(mergeCoreShards([second()])[0]?.status).toBe('incomplete')
    expect(mergeCoreShards([first()])[0]?.status).toBe('incomplete')
  })

  it('leaves an unsharded platform as it is, and the run passes on merged shards', () => {
    const linux = coreCell({
      platform: 'linux-x64',
      steps: { unit: 'success', build: 'success', build_bin: 'success', e2e: 'success' },
      expected: config.core_suites,
    })
    expect(mergeCoreShards([linux])).toEqual([linux])
    const merged = mergeCoreShards([linux, first(), second()])
    expect(merged.map((c) => `${c.platform}:${c.status}`)).toEqual(['linux-x64:pass', 'windows-arm64:pass'])
  })
})

describe('the llamacpp-upstream configuration', () => {
  it('names a required live test only if the live file has it', () => {
    for (const { file, name } of config.required_live_tests) {
      const text = readFileSync(new URL(file, root), 'utf8')
      const suites = [...text.matchAll(/describe(?:\.skipIf\([^)]*\))?\(\s*'([^']+)'/g)].map((m) => m[1])
      const tests = [...text.matchAll(/\bit\(\s*'([^']+)'/g)].map((m) => m[1])
      const names = suites.flatMap((s) => tests.map((t) => `${s} ${t}`))
      expect(names, `${file} has no test named "${name}"`).toContain(name)
      expect(config.live_files).toContain(file)
    }
  })

  it('runs on the platforms the pins are computed for, and every protected path exists', () => {
    expect(PLATFORMS).toEqual(PIN_PLATFORMS.map((p) => p.platform))
    for (const path of [...config.protected_paths, ...config.live_files, config.contract])
      expect(existsSync(new URL(path, root)), path).toBe(true)
  })

  it('takes candidate ids an orchestrator can find in run-name', () => {
    expect(CANDIDATE_ID_RE.test('conf-b11617')).toBe(true)
    expect(CANDIDATE_ID_RE.test('hatchet:run.42_1')).toBe(true)
    expect(CANDIDATE_ID_RE.test('x y')).toBe(false)
    expect(CANDIDATE_ID_RE.test('a]b')).toBe(false)
    expect(CANDIDATE_ID_RE.test('x'.repeat(81))).toBe(false)
  })
})
