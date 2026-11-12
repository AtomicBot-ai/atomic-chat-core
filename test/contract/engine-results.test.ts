/**
 * The verdict of an engine candidate check (scripts/lib/engine-results.mjs): what makes a run pass,
 * fail or stay incomplete, and whose fault a red test is — the candidate's (the pin passes it) or
 * core's (the pin fails it too). Plus the configuration the workflow and `npm run engine:check`
 * read: every required live test it names has to exist, or a renamed test would silently stop
 * counting (`.github/engine-candidate/llamacpp-upstream.json`, `audio-cpp.json`, `mlx.json`), and an
 * audio.cpp or MLX run's results.json carries what conf's approval gate reads.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildResults,
  CANDIDATE_ID_RE,
  coreCell,
  coreMatrix,
  mergeCoreShards,
  liveCell,
  renderResultsMarkdown,
  requiredLiveTests,
  vitestOutcomes,
} from '../../scripts/lib/engine-results.mjs'
import type {
  Cell,
  EngineCandidateConfig,
  ResolveResult,
  VitestReport,
} from '../../scripts/lib/engine-results.mjs'
import { AUDIOCPP_PIN_PLATFORMS, MLX_PIN_PLATFORMS, PIN_PLATFORMS } from '../../scripts/lib/engine-pin.mjs'
import { liveModelPath } from '../../scripts/lib/sdcpp-fixtures.mjs'
import { expandLiveEnv, liveModelDigest, liveModelsKey } from '../../scripts/lib/live-fixtures.mjs'
import { parseAudiocppManifest, parseMlxManifest } from '../../src/engine-builds/index.js'

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

  it('runs the core suites on the five platforms, Windows in two shards, as the workflow always did', () => {
    expect(coreMatrix(config.platforms)).toEqual([
      { platform: 'linux-x64', os: 'ubuntu-latest' },
      { platform: 'linux-arm64', os: 'ubuntu-24.04-arm' },
      { platform: 'macos-arm64', os: 'macos-15' },
      { platform: 'windows-x64', os: 'windows-2022', shard: '1/2', part: '-1' },
      { platform: 'windows-x64', os: 'windows-2022', shard: '2/2', part: '-2' },
      { platform: 'windows-arm64', os: 'windows-11-arm', shard: '1/2', part: '-1' },
      { platform: 'windows-arm64', os: 'windows-11-arm', shard: '2/2', part: '-2' },
    ])
    // Every required test applies on every platform unless it names its own.
    for (const platform of PLATFORMS)
      expect(requiredLiveTests(config.required_live_tests, platform)).toEqual(config.required_live_tests)
    const only = [
      { file: 'a', name: 'everywhere' },
      { file: 'a', name: 'macOS only', platforms: ['macos-arm64'] },
    ]
    expect(requiredLiveTests(only, 'linux-x64').map((t) => t.name)).toEqual(['everywhere'])
    expect(requiredLiveTests(only, 'macos-arm64').map((t) => t.name)).toEqual(['everywhere', 'macOS only'])
    // A test that applies to some builds only, by tag: required of those, of no other.
    const byTag = [...only, { file: 'a', name: 'mirror builds', tag_pattern: '^mirror-' }]
    expect(requiredLiveTests(byTag, 'linux-x64', 'mirror-1').map((t) => t.name)).toEqual([
      'everywhere',
      'mirror builds',
    ])
    expect(requiredLiveTests(byTag, 'linux-x64', 'v1.2.3').map((t) => t.name)).toEqual(['everywhere'])
    expect(requiredLiveTests(byTag, 'linux-x64', null).map((t) => t.name)).toEqual(['everywhere'])
  })

  it('takes candidate ids an orchestrator can find in run-name', () => {
    expect(CANDIDATE_ID_RE.test('conf-b11617')).toBe(true)
    expect(CANDIDATE_ID_RE.test('hatchet:run.42_1')).toBe(true)
    expect(CANDIDATE_ID_RE.test('x y')).toBe(false)
    expect(CANDIDATE_ID_RE.test('a]b')).toBe(false)
    expect(CANDIDATE_ID_RE.test('x'.repeat(81))).toBe(false)
  })
})

describe('the audio-cpp configuration', () => {
  const audio = JSON.parse(
    readFileSync(new URL('.github/engine-candidate/audio-cpp.json', root), 'utf8')
  ) as EngineCandidateConfig & {
    tag_pattern: string
    pins: string
    pin_repo: string
    candidate_manifests: { conf: string }
    upstream: { repo: string; branch: string }
    live_models: Array<{ id: string; url: string; sha256: string; bytes: number }>
    live_env: Record<string, string>
  }
  const AUDIO_PLATFORMS = audio.platforms.map((p) => p.platform)
  const conf = JSON.parse(
    readFileSync(new URL('test/fixtures/audiocpp/conf/audiocpp-manifest.json', root), 'utf8')
  ) as object

  it('reads the tags conf’s manifest takes, upstream’s and the fork rebuilds’, and no side tag', () => {
    const re = new RegExp(audio.tag_pattern)
    for (const tag of ['v0.9.3', 'v0.9.3-a1b2c3d4', 'v0.10.12-a0123456']) {
      expect(re.test(tag), tag).toBe(true)
      expect(() => parseAudiocppManifest({ ...conf, tag_name: tag }), tag).not.toThrow()
    }
    for (const tag of ['v0.9.2-drama3-base-small', 'v0.9.3-a1b2c3', '0.9.3', 'master-883-137f740']) {
      expect(re.test(tag), tag).toBe(false)
      expect(() => parseAudiocppManifest({ ...conf, tag_name: tag }), tag).toThrow()
    }
    expect(audio).toMatchObject({
      engine: 'audio-cpp',
      kind: 'audiocpp',
      pins: 'audiocpp-manifest',
      pin_repo: 'AtomicBot-ai/atomic-chat-conf',
      candidate_manifests: { conf: 'backends/audiocpp-manifest.staging.json' },
      upstream: { repo: '0xShug0/audio.cpp', branch: 'main' },
    })
  })

  it('names a required live test only if the live file has it', () => {
    for (const { file, name } of audio.required_live_tests) {
      const text = readFileSync(new URL(file, root), 'utf8')
      const suites = [...text.matchAll(/describe(?:\.skipIf\([^)]*\))?\(\s*'([^']+)'/g)].map((m) => m[1])
      const tests = [...text.matchAll(/\bit\(\s*'([^']+)'/g)].map((m) => m[1])
      const names = suites.flatMap((suite) => tests.map((t) => `${suite} ${t}`))
      expect(names, `${file} has no test named "${name}"`).toContain(name)
      expect(audio.live_files).toContain(file)
    }
  })

  it('runs live on platforms core ships audio.cpp for, the core suites on the same platforms', () => {
    const shipped = AUDIOCPP_PIN_PLATFORMS.map((p) => p.platform)
    for (const platform of AUDIO_PLATFORMS) expect(shipped).toContain(platform)
    expect(coreMatrix(audio.platforms)).toEqual([
      { platform: 'linux-x64', os: 'ubuntu-latest' },
      { platform: 'linux-arm64', os: 'ubuntu-24.04-arm' },
      { platform: 'macos-arm64', os: 'macos-15' },
    ])
    for (const platform of AUDIO_PLATFORMS)
      expect(requiredLiveTests(audio.required_live_tests, platform)).toEqual(audio.required_live_tests)
  })

  it('fills its live env from what the fetch leaves, MOSS-TTS-Nano on the CPU backend', () => {
    const models = Object.fromEntries(audio.live_models.map((m) => [m.id, liveModelPath('/models', m)]))
    const env = expandLiveEnv(audio.live_env, { engine_dir: '/e', tag: 't', manifest: '/m.json', models })
    expect(env).toEqual({
      ATOMIC_LIVE_AUDIO_ENGINE: '/e',
      ATOMIC_LIVE_AUDIO_TAG: 't',
      ATOMIC_LIVE_AUDIO_MANIFEST: '/m.json',
      // The host's separators: the fetch writes these paths for the host it runs on.
      ATOMIC_LIVE_AUDIO_MODEL: join('/models', '823b0de64f01f1ee', 'moss-tts-nano-100m-q8_0.gguf'),
      ATOMIC_LIVE_AUDIO_FAMILY: 'moss_tts_nano',
      ATOMIC_LIVE_AUDIO_TASK: 'tts',
      ATOMIC_LIVE_AUDIO_MODE: 'speech',
      ATOMIC_LIVE_AUDIO_BACKEND: 'cpu',
    })
    // Pinned by Hugging Face revision, not `main`.
    expect(audio.live_models[0]?.url).toMatch(/\/resolve\/[0-9a-f]{40}\//)
    expect(liveModelsKey(audio.live_models)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('protects paths that exist', () => {
    for (const path of [...audio.protected_paths, ...audio.live_files, audio.contract]) {
      if (!path.endsWith('*')) {
        expect(existsSync(new URL(path, root)), path).toBe(true)
        continue
      }
      const dir = path.slice(0, path.lastIndexOf('/') + 1)
      const prefix = path.slice(dir.length, -1)
      expect(
        readdirSync(new URL(dir, root)).some((name) => name.startsWith(prefix)),
        path
      ).toBe(true)
    }
  })

  it('writes the results.json conf’s approval gate reads: engine, the mirror’s repo and tag, pass', () => {
    const tag = 'v0.9.3-a1b2c3d4'
    const repo = 'AtomicBot-ai/atomic-chat-conf'
    const r = resolved({
      engine: 'audio-cpp',
      candidate: { repo, tag, source: 'release', complete: true, missing: [], core_assets: [] },
      pin: {
        source: 'audiocpp-manifest',
        tag: null,
        repo,
        per_platform: Object.fromEntries(AUDIO_PLATFORMS.map((p) => [p, { tag: null }])),
      },
      platforms: audio.platforms,
      live_matrix: audio.platforms.map(({ platform, runner }) => ({
        platform,
        os: runner,
        role: 'candidate' as const,
        tag,
        repo,
      })),
    })
    const passed: VitestReport = {
      testResults: [
        {
          name: '/runner/atomic-chat-core/test/live/audio-install.test.ts',
          assertionResults: audio.required_live_tests.map((t) => ({ fullName: t.name, status: 'passed' })),
        },
      ],
    }
    const out = buildResults({
      run: { mode: 'ci' },
      config: audio,
      resolve: r,
      surface: surface('pass'),
      cells: [
        ...r.live_matrix.map((m) =>
          liveCell({ ...m, fixture: null, vitest: passed, required: audio.required_live_tests })
        ),
        ...AUDIO_PLATFORMS.map((platform) =>
          coreCell({
            platform,
            steps: { unit: 'success', build: 'success', build_bin: 'success', e2e: 'success' },
            expected: audio.core_suites,
          })
        ),
      ],
      platforms: AUDIO_PLATFORMS,
      now: 'x',
    })
    // conf's `resultsRefusal` (atomic-chat-conf .github/scripts/upstream-verify.mjs): all four.
    expect(out).toMatchObject({ status: 'pass', engine: 'audio-cpp', candidate: { repo, tag } })
    // No approved build yet: no pin cells to compare with, which is not a reason to hold the run.
    expect(out.cells.filter((c) => c.kind === 'live' && c.role === 'pin').map((c) => c.status)).toEqual([
      'no-pin',
      'no-pin',
      'no-pin',
    ])
  })
})

describe('the mlx configuration', () => {
  const mlx = JSON.parse(
    readFileSync(new URL('.github/engine-candidate/mlx.json', root), 'utf8')
  ) as EngineCandidateConfig & {
    tag_pattern: string
    pins: string
    pin_repo?: string
    surface_runner: string
    candidate_manifests: { conf: string }
    upstream: { repo: string; branch: string }
    live_models: Array<{
      id: string
      url: string
      files: Array<{ path: string; sha256: string; bytes: number }>
    }>
    live_env: Record<string, string>
    verified: string[]
  }
  const MLX_PLATFORMS = mlx.platforms.map((p) => p.platform)
  const live = JSON.parse(
    readFileSync(new URL('test/fixtures/mlx/conf/mlx-manifest.json', root), 'utf8')
  ) as object
  const INSTALL = 'test/live/mlx-install.test.ts'

  it('reads the fork’s releases and the builds cores install by name; cores install only the latter', () => {
    const re = new RegExp(mlx.tag_pattern)
    for (const tag of [
      'mlxvlm-macos-arm64-07ba5a1',
      'mlxvlm-macos-arm64-89acca55b02b78b9fd0fd517995cba040b5386a8',
    ]) {
      expect(re.test(tag), tag).toBe(true)
      expect(() => parseMlxManifest({ ...live, tag_name: tag }), tag).not.toThrow()
    }
    // The fork's release of an upstream tag: a candidate, but no core installs it under this name.
    expect(re.test('v0.7.12')).toBe(true)
    expect(() => parseMlxManifest({ ...live, tag_name: 'v0.7.12' })).toThrow('tag_name')
    for (const tag of ['mlxvlm-macos-arm64-07ba5a', 'mlxvlm-linux-x64-07ba5a1', '0.7.12', 'v0.7', 'b11617'])
      expect(re.test(tag), tag).toBe(false)
    expect(mlx).toMatchObject({
      engine: 'mlx',
      kind: 'mlx',
      default_repo: 'AtomicBot-ai/mlx-vlm',
      pins: 'mlx-manifest',
      candidate_manifests: { conf: 'backends/mlx-manifest.staging.json' },
      upstream: { repo: 'Neywa-Labs/mlx-vlm', branch: 'main' },
    })
    // The pin comes from where the live manifest says the core downloads it: the fork, then conf.
    expect(mlx.pin_repo).toBeUndefined()
  })

  it('names a required live test only if the live file has it; the install tests only of installable names', () => {
    for (const { file, name } of mlx.required_live_tests) {
      const text = readFileSync(new URL(file, root), 'utf8')
      const suites = [...text.matchAll(/describe(?:\.skipIf\([^)]*\))?\(\s*'([^']+)'/g)].map((m) => m[1])
      const tests = [...text.matchAll(/\bit\(\s*'([^']+)'/g)].map((m) => m[1])
      const names = suites.flatMap((suite) => tests.map((t) => `${suite} ${t}`))
      expect(names, `${file} has no test named "${name}"`).toContain(name)
      expect(mlx.live_files).toContain(file)
    }
    const install = mlx.required_live_tests.filter((t) => t.file === INSTALL)
    expect(install).toHaveLength(3)
    for (const t of install) expect(t.tag_pattern, t.name).toBe('^mlxvlm-macos-arm64-[0-9a-f]{7,40}$')
    expect(requiredLiveTests(mlx.required_live_tests, 'macos-arm64', 'mlxvlm-macos-arm64-1f48deb')).toEqual(
      mlx.required_live_tests
    )
    expect(requiredLiveTests(mlx.required_live_tests, 'macos-arm64', 'v0.7.12').map((t) => t.file)).toEqual([
      'test/live/mlx.test.ts',
      'test/live/mlx.test.ts',
      'test/live/mlx.test.ts',
    ])
  })

  it('runs everything on Apple Silicon, the surface too: there is no other build to run', () => {
    expect(MLX_PLATFORMS).toEqual(MLX_PIN_PLATFORMS.map((p) => p.platform))
    expect(coreMatrix(mlx.platforms)).toEqual([{ platform: 'macos-arm64', os: 'macos-15' }])
    expect(mlx.platforms[0]?.runner).toBe('macos-15')
    expect(mlx.surface_runner).toBe('macos-15')
  })

  it('fills its live env from what the fetch leaves: the build’s folder, its manifest, the model folder', () => {
    const [model] = mlx.live_models
    const models = { [model?.id as string]: liveModelPath('/models', model as (typeof mlx.live_models)[0]) }
    const env = expandLiveEnv(mlx.live_env, { engine_dir: '/e', tag: 't', manifest: '/m.json', models })
    expect(env).toEqual({
      ATOMIC_LIVE_MLX_RESOURCES: '/e',
      ATOMIC_LIVE_MLX_TAG: 't',
      ATOMIC_LIVE_MLX_MANIFEST: '/m.json',
      ATOMIC_LIVE_MLX_MODEL: join(
        '/models',
        liveModelDigest(model as (typeof mlx.live_models)[0]).slice(0, 16),
        'smollm2-135m'
      ),
    })
    // SmolLM2-135M-Instruct 8-bit, pinned by Hugging Face revision, every file by its sha256.
    expect(model?.url).toBe(
      'https://huggingface.co/mlx-community/SmolLM2-135M-Instruct-8bit/resolve/0f0d9b8218915bc34d401e1a340b8c049d300d5e/'
    )
    expect(model?.files.map((f) => f.path)).toContain('model.safetensors')
    expect(model?.files.map((f) => f.path)).toContain('config.json')
    for (const f of model?.files ?? []) expect(f.sha256, f.path).toMatch(/^[0-9a-f]{64}$/)
    expect(model?.files.reduce((n, f) => n + f.bytes, 0)).toBeLessThan(160_000_000)
    expect(liveModelsKey(mlx.live_models)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('protects paths that exist', () => {
    for (const path of [...mlx.protected_paths, ...mlx.live_files, mlx.contract]) {
      if (!path.endsWith('*')) {
        expect(existsSync(new URL(path, root)), path).toBe(true)
        continue
      }
      const dir = path.slice(0, path.lastIndexOf('/') + 1)
      const prefix = path.slice(dir.length, -1)
      expect(
        readdirSync(new URL(dir, root)).some((name) => name.startsWith(prefix)),
        path
      ).toBe(true)
    }
  })

  it('passes the fork’s v0.7.12 without the install tests no core can run on it, Metal verified', () => {
    const tag = 'v0.7.12'
    const repo = 'AtomicBot-ai/mlx-vlm'
    const pinTag = 'mlxvlm-macos-arm64-07ba5a1'
    const r = resolved({
      engine: 'mlx',
      candidate: { repo, tag, source: 'release', complete: true, missing: [], core_assets: [] },
      pin: {
        source: 'mlx-manifest',
        tag: pinTag,
        repo,
        per_platform: { 'macos-arm64': { tag: pinTag } },
      },
      platforms: mlx.platforms,
      live_matrix: [
        { platform: 'macos-arm64', os: 'macos-15', role: 'candidate' as const, tag, repo },
        { platform: 'macos-arm64', os: 'macos-15', role: 'pin' as const, tag: pinTag, repo },
      ],
    })
    const run = (skippedInstall: boolean): VitestReport => ({
      testResults: [
        {
          name: '/runner/atomic-chat-core/test/live/mlx.test.ts',
          assertionResults: mlx.required_live_tests
            .filter((t) => t.file !== INSTALL)
            .map((t) => ({ fullName: t.name, status: 'passed' })),
        },
        {
          name: `/runner/atomic-chat-core/${INSTALL}`,
          assertionResults: mlx.required_live_tests
            .filter((t) => t.file === INSTALL)
            .map((t) => ({ fullName: t.name, status: skippedInstall ? 'skipped' : 'passed' })),
        },
      ],
    })
    const out = buildResults({
      run: { mode: 'ci' },
      config: mlx,
      resolve: r,
      surface: surface('pass'),
      cells: [
        ...r.live_matrix.map((m) =>
          liveCell({
            ...m,
            fixture: null,
            vitest: run(m.role === 'candidate'),
            required: requiredLiveTests(mlx.required_live_tests, m.platform, m.tag),
          })
        ),
        coreCell({
          platform: 'macos-arm64',
          steps: { unit: 'success', build: 'success', build_bin: 'success', e2e: 'success' },
          expected: mlx.core_suites,
        }),
      ],
      platforms: MLX_PLATFORMS,
      now: 'x',
    })
    expect(out).toMatchObject({ status: 'pass', engine: 'mlx', candidate: { repo, tag } })
    expect(out.verdict.coverage).toEqual({ verified: ['metal'], not_verified: mlx.not_verified })
    // On a build named the way cores install it, a skipped install test holds the run.
    const mirror = liveCell({
      platform: 'macos-arm64',
      role: 'candidate',
      tag: 'mlxvlm-macos-arm64-1f48deb',
      vitest: run(true),
      required: requiredLiveTests(mlx.required_live_tests, 'macos-arm64', 'mlxvlm-macos-arm64-1f48deb'),
    })
    expect(mirror.status).toBe('incomplete')
    expect(mirror.missing_required).toHaveLength(3)
  })
})
