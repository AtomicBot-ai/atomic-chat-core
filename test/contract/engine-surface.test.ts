/**
 * The surface diff of an upstream llama.cpp candidate (scripts/lib/engine-surface.mjs): synthetic
 * history for each kind of change it has to catch (H2 release notes, H4 archives, H5 strings), the
 * mirror whitelist core keeps a copy of, and a golden report for one real pair, b11463 → b11617,
 * built from what `scripts/engine-surface-diff.mjs` gathered for it
 * (test/fixtures/llamacpp/surface/b11463-b11617.inputs.json plus the help/ and version/ captures).
 * Regenerate the golden files with `npx vitest run --project contract -u test/contract/engine-surface.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildReport,
  candidateCompleteness,
  checkAssets,
  checkInvocations,
  checkReleaseNotes,
  checkStrings,
  checkVersion,
  checkWatched,
  countStrings,
  invocationKey,
  MIRROR_WHITELIST,
  parseBinaryVersion,
  parseGitLog,
  parseMirrorWhitelist,
  parseNumstat,
  renderMarkdown,
  versionCommit,
  watches,
} from '../../scripts/lib/engine-surface.mjs'
import type { SurfaceContract, SurfaceInputs, SurfaceUpstream } from '../../scripts/lib/engine-surface.mjs'
import { parseBinaryVersion as parseBinaryVersionTs } from '../../src/backend/version.js'
import baseline from '../../src/backend/catalog/upstream-releases-baseline.json' with { type: 'json' }

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/llamacpp/${path}`, import.meta.url), 'utf8')
const contract = JSON.parse(fixture('engine-contract.json')) as SurfaceContract
const release = (tag: string) =>
  JSON.parse(fixture(`releases/${tag}.json`)) as { tag: string; assets: string[] }
const ids = (findings: Array<{ id: string; severity: string }>, severity: string) =>
  findings.filter((f) => f.severity === severity).map((f) => f.id)

type Upstream = Extract<SurfaceUpstream, { available: true }>
const upstream = (over: Partial<Upstream> = {}): Upstream => ({
  available: true,
  method: 'git',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  commits: [],
  watched: [],
  ...over,
})

describe('H4: the release archives', () => {
  const pin = release('b11463')
  const fresh = release('b11617')
  /** The b11617 list with `edit` applied to its names. */
  const candidate = (edit: (names: string[]) => string[]) => ({ tag: 'b11617', assets: edit(fresh.assets) })
  const check = (cand: { tag: string; assets: string[] }, before = pin) =>
    checkAssets(contract, { candidate: cand, pin: before, whitelist: MIRROR_WHITELIST })

  it('b11463 → b11617: nothing lost; the archives no backend takes are listed once', () => {
    const findings = check(fresh)
    expect(findings.filter((f) => f.severity !== 'info')).toEqual([])
    const unconsumed = findings.find((f) => f.id === 'assets.core_backends/unconsumed')
    expect((unconsumed?.evidence as { archives: string[] }).archives).toContain('win-sycl-x64.zip')
    expect((unconsumed?.evidence as { archives: string[] }).archives).not.toContain('win-vulkan-arm64.zip')
  })

  it('H4a: a required CPU archive gone (ubuntu-arm64) breaks core and the mirror', () => {
    const findings = check(candidate((n) => n.filter((x) => !x.endsWith('-bin-ubuntu-arm64.tar.gz'))))
    expect(ids(findings, 'break')).toEqual([
      'assets.core_backends/linux-arm64/linux-cpu-arm64',
      'assets.mirror/ubuntu-arm64\\.tar\\.gz',
    ])
  })

  it('H4b: an optional GPU archive gone (ubuntu-vulkan-arm64) is a warning', () => {
    const findings = check(candidate((n) => n.filter((x) => !x.endsWith('-bin-ubuntu-vulkan-arm64.tar.gz'))))
    expect(ids(findings, 'break')).toEqual([])
    expect(ids(findings, 'warn')).toEqual([
      'assets.core_backends/linux-arm64/linux-vulkan-arm64',
      'assets.mirror/ubuntu-vulkan-arm64\\.tar\\.gz',
    ])
  })

  it('H4c: a CUDA toolkit minor that moves (13.1 → 13.4) is information', () => {
    const older = {
      tag: 'b11463',
      assets: pin.assets.map((n) => n.replace('win-cuda-13.4-x64', 'win-cuda-13.1-x64')),
    }
    const findings = check(fresh, older)
    expect(findings.filter((f) => f.severity !== 'info')).toEqual([])
    expect(findings.find((f) => f.id === 'assets.core_backends/windows-x64/win-cuda-13-x64')?.message).toBe(
      'win-cuda-13-x64 moved: win-cuda-13.1-x64.zip → win-cuda-13.4-x64.zip'
    )
  })

  it('H4d: a new archive core does not take (win-sycl-x64) is information', () => {
    const older = { tag: 'b11463', assets: pin.assets.filter((n) => !n.endsWith('win-sycl-x64.zip')) }
    const findings = check(fresh, older)
    expect(findings.filter((f) => f.severity !== 'info')).toEqual([])
    expect(ids(findings, 'info')).toContain('assets.core_backends/new/win-sycl-x64.zip')
  })

  it('H4e: the Windows CPU build shipped as .tar.gz breaks core and the mirror', () => {
    const findings = check(candidate((n) => n.map((x) => x.replace('win-cpu-x64.zip', 'win-cpu-x64.tar.gz'))))
    expect(ids(findings, 'break')).toEqual([
      'assets.core_backends/windows-x64/win-cpu-x64',
      'assets.mirror/win-cpu-x64\\.zip',
    ])
  })

  it('an archive neither build had is not a loss (the mirror never carries macos-x64)', () => {
    const mirrored = (tag: string) =>
      baseline.releases[0]!.assets.map((a) => a.name.replace(baseline.releases[0]!.tag, tag))
    const findings = check(
      { tag: 'b11617', assets: mirrored('b11617') },
      { tag: 'b11463', assets: mirrored('b11463') }
    )
    expect(ids(findings, 'break')).toEqual([])
    expect(ids(findings, 'info')).toContain('assets.core_backends/macos-x64/macos-x64')
  })

  it('calls a release complete once every required and every CPU archive is up', () => {
    expect(candidateCompleteness(contract, MIRROR_WHITELIST, 'b11617', fresh.assets)).toEqual({
      complete: true,
      missing: [],
    })
    const early = candidateCompleteness(contract, MIRROR_WHITELIST, 'b11617', [
      'llama-b11617-bin-macos-arm64.tar.gz',
    ])
    expect(early.complete).toBe(false)
    expect(early.missing).toEqual(
      expect.arrayContaining([
        { kind: 'mirror', pattern: 'ubuntu-x64\\.tar\\.gz' },
        { kind: 'core', platform: 'windows-arm64', backend: 'win-cpu-arm64' },
      ])
    )
    const mirrored = baseline.releases[0]!.assets.map((a) => a.name)
    const ci = ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64', 'windows-arm64']
    expect(candidateCompleteness(contract, MIRROR_WHITELIST, 'b11463', mirrored).missing).toEqual([
      { kind: 'core', platform: 'macos-x64', backend: 'macos-x64' },
    ])
    expect(candidateCompleteness(contract, MIRROR_WHITELIST, 'b11463', mirrored, ci).complete).toBe(true)
  })

  it('checks no mirror for an engine conf does not mirror (PrismML), and its tags read as they are', () => {
    const tag = 'prism-b10787-73bfe6c'
    const prism = (t: string) => release('b11617').assets.map((n) => n.replace('b11617', t))
    const findings = checkAssets(contract, {
      candidate: { tag, assets: prism(tag) },
      pin: { tag: 'prism-b10754-2459f68', assets: prism('prism-b10754-2459f68') },
      whitelist: null,
    })
    expect(findings.filter((f) => f.check === 'assets.mirror')).toEqual([])
    expect(findings.filter((f) => f.severity !== 'info')).toEqual([])
    const ci = ['linux-x64', 'macos-arm64', 'windows-x64']
    expect(candidateCompleteness(contract, null, tag, prism(tag), ci)).toEqual({
      complete: true,
      missing: [],
    })
    expect(
      candidateCompleteness(contract, null, tag, [`llama-${tag}-bin-macos-arm64.tar.gz`], ci).missing
    ).toEqual([
      { kind: 'core', platform: 'linux-x64', backend: 'linux-cpu-x64' },
      { kind: 'core', platform: 'windows-x64', backend: 'win-cpu-x64' },
    ])
  })
})

describe("conf's mirror whitelist", () => {
  const select = (tag: string, names: readonly string[]) =>
    names
      .filter((n) => MIRROR_WHITELIST.some((e) => new RegExp(`^llama-${tag}-bin-${e.pattern}$`).test(n)))
      .sort()

  it('adds Linux ROCm, Linux x64 CUDA and Windows arm64 Vulkan to the archives conf historically mirrored of b11463', () => {
    const mirrored = baseline.releases.find((r) => r.tag === 'b11463')!.assets.map((a) => a.name)
    expect(select('b11463', release('b11463').assets)).toEqual(
      [
        ...mirrored,
        'llama-b11463-bin-ubuntu-rocm-10.0-x64.tar.gz',
        'llama-b11463-bin-ubuntu-cuda-12.8-x64.tar.gz',
        'llama-b11463-bin-ubuntu-cuda-13.4-x64.tar.gz',
        'llama-b11463-bin-win-vulkan-arm64.zip',
      ].sort()
    )
  })

  it("reads the array out of conf's source, exported or not, without running it", () => {
    const entry = (e: (typeof MIRROR_WHITELIST)[number], multiline: boolean) => {
      const pattern = e.pattern.replace(/\\/g, '\\\\')
      return multiline
        ? `  {\n    platform: '${e.platform}',\n    pattern: '${pattern}',\n    required: ${e.required},\n  },`
        : `  { platform: '${e.platform}', pattern: '${pattern}', required: ${e.required} },`
    }
    const body = MIRROR_WHITELIST.map((e, i) => entry(e, i % 2 === 1)).join('\n')
    for (const head of ['const WHITELIST = [', 'export const WHITELIST = ['])
      expect(
        parseMirrorWhitelist(`// mirror.mjs\nconst X = 1\n${head}\n${body}\n]\n\nfunction f() {}\n`)
      ).toEqual(MIRROR_WHITELIST)
    expect(parseMirrorWhitelist('export const OTHER = []')).toBeUndefined()
    expect(parseMirrorWhitelist("const WHITELIST = [\n  { platform: 'x' },\n]\n")).toBeUndefined()
  })
})

describe('--version and the invocations', () => {
  it.each(['b10344', 'b10400', 'b11463', 'b11617'])('%s: read as core reads it', (tag) => {
    const output = fixture(`version/${tag}.txt`)
    expect(parseBinaryVersion(output)).toBe(parseBinaryVersionTs(output))
    expect(checkVersion({ tag, output })).toEqual([])
  })

  it('names the commit in both formats', () => {
    expect(versionCommit(fixture('version/b11617.txt'))).toBe('14310190c')
    expect(versionCommit('version: 10344 (a1b2c3d)\nbuilt with cc\n')).toBe('a1b2c3d')
    expect(versionCommit('version: 1.2.3\n')).toBeUndefined()
  })

  it('reads the build of a PrismML tag: the upstream build the fork is cut from', () => {
    const output = 'version: 10787 (73bfe6c)\nbuilt with Apple clang for arm64-apple-darwin\n'
    expect(checkVersion({ tag: 'prism-b10787-73bfe6c', output })).toEqual([])
    expect(ids(checkVersion({ tag: 'prism-b10788-73bfe6c', output }), 'break')).toEqual(['version.output'])
  })

  it('breaks on a build it cannot read, or one that is not the tag’s', () => {
    expect(parseBinaryVersion('llama-server 1.2.3\n')).toBe(parseBinaryVersionTs('llama-server 1.2.3\n'))
    expect(ids(checkVersion({ tag: 'b11617', output: 'llama-server 1.2.3\n' }), 'break')).toEqual([
      'version.output',
    ])
    expect(ids(checkVersion({ tag: 'b11618', output: fixture('version/b11617.txt') }), 'break')).toEqual([
      'version.output',
    ])
  })

  it('breaks on an invocation that fails, and cannot judge one that did not run', () => {
    const findings = checkInvocations(contract, [
      { argv: ['-h'], status: 0 },
      { argv: ['--version'], status: 1, output: 'error: unknown argument' },
    ])
    expect(ids(findings, 'break')).toEqual(['invocations.exit/--version'])
    expect(ids(findings, 'error')).toEqual(['invocations.exit/--list-devices'])
  })

  it('names an invocation by its executable only when it runs another than the server', () => {
    expect(invocationKey({ argv: ['-h'] })).toBe('-h')
    expect(invocationKey({ bin: 'sd-cli', argv: ['--help'] })).toBe('sd-cli --help')
    // An sd-cli run never stands in for the server's own -h.
    expect(ids(checkInvocations(contract, [{ bin: 'sd-cli', argv: ['-h'], status: 0 }]), 'error')).toContain(
      'invocations.exit/-h'
    )
  })
})

describe('H2: the release notes between the pin and the candidate', () => {
  // b10874..b10875, as git read it: the one commit that removed --mmap and --mlock.
  const deprecation = {
    sha: '14a9d09f75683c94c2c4f229efe54670d4209089',
    subject: 'args: officially deprecate --mmap|mlock|dio (#28334)',
    files: ['common/arg.cpp', 'tools/cli/README.md', 'tools/server/README.md'],
  }

  it('warns on a deprecation that touches a watched file', () => {
    const findings = checkReleaseNotes(contract, upstream({ commits: [deprecation] }))
    expect(ids(findings, 'warn')).toEqual(['upstream.release_notes/14a9d09f75'])
  })

  it('keeps a removal elsewhere to information, and warns when the files are unknown', () => {
    const elsewhere = { sha: 'c'.repeat(40), subject: 'vulkan: remove dead code', files: ['ggml/src/x.cpp'] }
    expect(ids(checkReleaseNotes(contract, upstream({ commits: [elsewhere] })), 'info')).toEqual([
      'upstream.release_notes/others',
    ])
    const unknown = { sha: 'd'.repeat(40), subject: 'server: rename the slots endpoint' }
    expect(
      ids(checkReleaseNotes(contract, upstream({ method: 'compare-api', commits: [unknown] })), 'warn')
    ).toEqual(['upstream.release_notes/dddddddddd'])
  })

  it('keeps a commit someone has read to information, with why', () => {
    const read = { sha: 'e'.repeat(40), why: 'renames a helper core never sees' }
    const reviewed = { ...contract, upstream: { ...contract.upstream!, reviewed_commits: [read] } }
    const rename = { sha: read.sha, subject: 'mtmd: rename a helper (#2)', files: ['common/arg.cpp'] }
    const findings = checkReleaseNotes(reviewed, upstream({ commits: [rename] }))
    expect(findings.map((f) => `${f.severity} ${f.id} ${f.message}`)).toEqual([
      'info upstream.release_notes/eeeeeeeeee mtmd: rename a helper (#2) (/rename/): reviewed, renames a helper core never sees',
    ])
    // Only the full sha counts: another commit with the same subject still warns.
    const other = { ...rename, sha: 'f'.repeat(40) }
    expect(ids(checkReleaseNotes(reviewed, upstream({ commits: [other] })), 'warn')).toEqual([
      'upstream.release_notes/ffffffffff',
    ])
  })
})

describe('the watched paths', () => {
  // upstream #31865 moved tools/mtmd/clip.cpp, where `unknown projector type` was thrown, to
  // tools/mtmd/mtmd-model.cpp.
  const clip = { path: 'tools/mtmd/clip.cpp', why: 'unknown projector type' }
  const watching = { ...contract, upstream: { ...contract.upstream!, watched_paths: [clip] } }
  const check = (over: Partial<Upstream>) =>
    checkWatched(watching, upstream(over)).map((f) => `${f.severity} ${f.message}`)
  const consolidate = {
    sha: '7d7f028753'.padEnd(40, '0'),
    subject: 'mtmd: refactoring: remove clip.h, consolidate code into mtmd (#31865)',
    files: ['tools/mtmd/clip.cpp', 'tools/mtmd/mtmd-model.cpp'],
  }

  it('warns when the range removes a watched file', () => {
    expect(
      check({
        commits: [consolidate],
        watched: [{ path: clip.path, exists: false, additions: 0, deletions: 120 }],
      })
    ).toEqual([
      'warn tools/mtmd/clip.cpp is gone from the candidate (watched for: unknown projector type); see where it went',
    ])
  })

  it('warns that the contract is stale when neither build has the file', () => {
    expect(check({ watched: [{ path: clip.path, exists: false, additions: 0, deletions: 0 }] })).toEqual([
      'warn tools/mtmd/clip.cpp is in neither build (watched for: unknown projector type); the contract names a path this range does not have',
    ])
  })

  it('says nothing about a watched file the range left alone', () => {
    expect(check({ watched: [{ path: clip.path, exists: true, additions: 0, deletions: 0 }] })).toEqual([])
  })

  it('watches a folder (`dir/`) as every file under it, and never a file that only shares its prefix', () => {
    expect(watches('mlx_vlm/server/', 'mlx_vlm/server/cli.py')).toBe(true)
    expect(watches('mlx_vlm/server/', 'mlx_vlm/server/sub/x.py')).toBe(true)
    expect(watches('mlx_vlm/server/', 'mlx_vlm/server.py')).toBe(false)
    expect(watches('mlx_vlm/server.py', 'mlx_vlm/server.py')).toBe(true)
    expect(watches('mlx_vlm/server.py', 'mlx_vlm/server.pyc')).toBe(false)
    const server = { path: 'mlx_vlm/server/', why: 'the server' }
    const folder = { ...contract, upstream: { ...contract.upstream!, watched_paths: [server] } }
    const cli = { sha: 'a'.repeat(40), subject: 'server: rename --kv-bits', files: ['mlx_vlm/server/cli.py'] }
    const docs = { sha: 'b'.repeat(40), subject: 'docs: remove the server page', files: ['docs/server.md'] }
    const watched = [{ path: server.path, exists: true, additions: 3, deletions: 1 }]
    expect(
      checkWatched(folder, upstream({ commits: [cli, docs], watched })).map(
        (f) => `${f.severity} ${f.message}`
      )
    ).toEqual(['info 1 commit(s), +3 −1 (watched for: the server)'])
    // A removal in a file under the folder warns; one outside it does not.
    expect(ids(checkReleaseNotes(folder, upstream({ commits: [cli, docs] })), 'warn')).toEqual([
      'upstream.release_notes/aaaaaaaaaa',
    ])
  })
})

describe('H5: the strings core matches, counted in both trees', () => {
  const withStrings: SurfaceContract = {
    ...contract,
    strings: [
      { id: 'ready.listening', text: 'listening on', match: 'substring-ci', severity_if_lost: 'break' },
      {
        id: 'ctx.overflow',
        text: 'the request exceeds the available context size',
        match: 'substring-ci',
        severity_if_lost: 'warn',
      },
      { id: 'ready.loaded', text: 'model loaded', match: 'substring-ci', severity_if_lost: 'warn' },
      { id: 'mtp.new', text: 'draft-mtp', match: 'substring-ci', severity_if_lost: 'break' },
      {
        id: 'device.backend-loaded',
        text: 'load_backend: loaded ',
        match: 'substring-ci',
        upstream_text: '%s: loaded %s backend from %s',
        severity_if_lost: 'warn',
      },
      {
        id: 'device.dyld',
        text: 'Library not loaded',
        match: 'substring-ci',
        upstream_text: null,
        severity_if_lost: 'warn',
      },
      {
        id: 'ctx.request',
        text: 'request \\(\\d+ tokens\\) exceeds',
        match: 'regex',
        severity_if_lost: 'break',
      },
    ],
  }
  const counts = {
    'ready.listening': { pin: 2, candidate: 0 },
    'ctx.overflow': { pin: 0, candidate: 0 },
    'ready.loaded': { pin: 1, candidate: 1 },
    'mtp.new': { pin: 0, candidate: 3 },
    'device.backend-loaded': { pin: 1, candidate: 1 },
    'ctx.request': { pin: 1, candidate: 1 },
  }

  it('a string the pin had and the candidate lost takes its severity; one in neither is information', () => {
    const findings = checkStrings(withStrings, upstream({ strings: counts })) ?? []
    expect(ids(findings, 'break')).toEqual(['upstream.contract_strings/ready.listening'])
    expect(ids(findings, 'info')).toEqual([
      'upstream.contract_strings/ctx.overflow',
      'upstream.contract_strings/mtp.new',
    ])
    expect(ids(findings, 'error')).toEqual([])
  })

  it('counts lines of upstream sources: the printf form where there is one, a regex as core matches it', () => {
    const files = {
      'tools/server/server.cpp': 'LOG_INF("%s: server is LISTENING ON http://%s:%d\\n", __func__);\nint x;\n',
      'ggml/src/ggml-backend-reg.cpp':
        'GGML_LOG_INFO("%s: loaded %s backend from %s\\n", __func__, name, path);\n',
      'tools/server/server-context.cpp': '"request (1234 tokens) exceeds the available context size"\n',
    }
    expect(countStrings(withStrings, files)).toEqual({
      'ready.listening': 1,
      // Core's literal is not what upstream prints (PR7 fixes it): the regex finds the real line.
      'ctx.overflow': 0,
      'ready.loaded': 0,
      'mtp.new': 0,
      'device.backend-loaded': 1,
      'ctx.request': 1,
    })
  })

  it('a contract without strings skips the check instead of failing it', () => {
    const noStrings = Object.fromEntries(
      Object.entries(contract).filter(([key]) => key !== 'strings')
    ) as SurfaceContract
    expect(checkStrings(noStrings, upstream())).toBeUndefined()
    const report = buildReport(noStrings, goldenInputs(), { now: 'x' })
    expect(report.checks.find((c) => c.id === 'upstream.contract_strings')).toMatchObject({
      status: 'skipped',
    })
  })
})

describe('the upstream history of a build that is not upstream', () => {
  it('reports the diff as unavailable and still runs every other check', () => {
    const inputs: SurfaceInputs = {
      ...goldenInputs(),
      upstream: { available: false, reason: 'the candidate commit 0123abc is not in ggml-org/llama.cpp' },
    }
    const report = buildReport(contract, inputs, { now: 'x' })
    expect(report.status).toBe('pass')
    expect(ids(report.findings, 'info')).toEqual(
      expect.arrayContaining(['upstream.watched_paths/unavailable', 'upstream.release_notes/unavailable'])
    )
    expect(report.checks.find((c) => c.id === 'help.required_flags')?.status).toBe('pass')
  })

  it('a local binary has no release: the archive checks are skipped', () => {
    const inputs = goldenInputs()
    inputs.candidate = { ...inputs.candidate, source: 'bin', repo: null, assets: null }
    const report = buildReport(contract, inputs, { now: 'x' })
    expect(report.checks.filter((c) => c.id.startsWith('assets.')).map((c) => c.status)).toEqual([
      'skipped',
      'skipped',
    ])
  })
})

describe('H1 on the surface: b10874 → b10875', () => {
  const side = (tag: string, commit: string): SurfaceInputs['candidate'] => ({
    tag,
    source: 'release',
    repo: 'ggml-org/llama.cpp',
    help_text: fixture(`help/${tag}.txt`),
    version_output: `version: 0.1.0-dev (build ${tag.slice(1)}, commit ${commit})\n`,
    invocations: [
      { argv: ['-h'], status: 0 },
      { argv: ['--version'], status: 0 },
      { argv: ['--list-devices'], status: 0 },
    ],
    assets: release(tag).assets,
  })
  const inputs: SurfaceInputs = {
    candidate: side('b10875', '14a9d09f7'),
    pin: side('b10874', 'e2d2c0d6a'),
    whitelist: { source: 'core-copy', entries: [...MIRROR_WHITELIST] },
    upstream: { available: false, reason: 'not compared' },
  }

  it('this core passes: the removed flags were anticipated by the load-mode gate', () => {
    const report = buildReport(contract, inputs, { now: 'x' })
    expect(report.counts.break).toBe(0)
    expect(ids(report.findings, 'info')).toEqual(
      expect.arrayContaining(['help.diff/removed/--mlock', 'help.diff/removed/--no-mmap'])
    )
  })

  it('a core without that gate breaks on it', () => {
    const ungated: SurfaceContract = {
      ...contract,
      flags: contract.flags
        .filter((f) => f.flag !== '--load-mode')
        .map((f) =>
          f.flag === '--no-mmap' || f.flag === '--mlock'
            ? {
                ...f,
                emitters: Object.fromEntries(
                  Object.keys(f.emitters).map((e) => [e, [{ from: null, until: null }]])
                ),
              }
            : f
        ),
    }
    const report = buildReport(ungated, inputs, { now: 'x' })
    expect(report.status).toBe('break')
    expect(ids(report.findings, 'break')).toEqual([
      'help.required_flags/--mlock',
      'help.required_flags/--no-mmap',
    ])
  })
})

describe('git output', () => {
  it('reads a log with the files of each commit', () => {
    const text =
      '\x1eaaa\targs: one (#1)\n\ncommon/arg.cpp\nREADME.md\n\x1ebbb\tserver: two\n\ntools/server/server.cpp\n'
    expect(parseGitLog(text)).toEqual([
      { sha: 'aaa', subject: 'args: one (#1)', files: ['common/arg.cpp', 'README.md'] },
      { sha: 'bbb', subject: 'server: two', files: ['tools/server/server.cpp'] },
    ])
  })

  it('reads numstat, a binary file as 0/0', () => {
    expect(parseNumstat('13\t3\tcommon/arg.cpp\n-\t-\tmodel.bin\n')).toEqual([
      { path: 'common/arg.cpp', additions: 13, deletions: 3 },
      { path: 'model.bin', additions: 0, deletions: 0 },
    ])
  })
})

/** What engine-surface-diff.mjs gathered for b11463 → b11617, the -h/--version text from the fixtures. */
function goldenInputs(): SurfaceInputs {
  const inputs = JSON.parse(fixture('surface/b11463-b11617.inputs.json')) as SurfaceInputs
  inputs.candidate.help_text = fixture('help/b11617.txt')
  inputs.candidate.version_output = fixture('version/b11617.txt')
  inputs.pin!.help_text = fixture('help/b11463.txt')
  inputs.pin!.version_output = fixture('version/b11463.txt')
  return inputs
}

describe('golden: b11463 → b11617', () => {
  const report = buildReport(contract, goldenInputs(), { now: '2026-10-15T00:00:00.000Z' })

  // The contract watches tools/mtmd/mtmd-model.cpp, which upstream #31865 made out of clip.cpp long
  // after b11617, so this range has neither the file nor `unknown projector type` in the watched files.
  it('warns only about the watched file this range predates, now that core no longer sends --defrag-thold', () => {
    expect(report.status).toBe('warn')
    expect(ids(report.findings, 'warn')).toEqual(['upstream.watched_paths/tools/mtmd/mtmd-model.cpp'])
    expect(ids(report.findings, 'info')).toContain('upstream.contract_strings/error.projector.unknown-type')
    expect(report.counts).toMatchObject({ break: 0, error: 0 })
    expect(ids(report.findings, 'info')).toEqual(
      expect.arrayContaining([
        'assets.core_backends/unconsumed',
        'help.diff/added',
        'upstream.watched_paths/common/arg.cpp',
      ])
    )
  })

  it('matches report.json and report.md', async () => {
    await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot(
      '../fixtures/llamacpp/surface/b11463-b11617.report.json'
    )
    await expect(renderMarkdown(report)).toMatchFileSnapshot(
      '../fixtures/llamacpp/surface/b11463-b11617.report.md'
    )
  })
})

describe('report.md for each engine the check knows', () => {
  const report = buildReport(contract, goldenInputs(), { now: '2026-10-15T00:00:00.000Z' })
  const heading = (engine: string | undefined, source: string) =>
    renderMarkdown({
      ...report,
      engine,
      inputs: { ...report.inputs, pin_resolution: { source, tag: 'x' } },
    })
      .split('\n')
      .filter((line) => line.startsWith('# ') || line.startsWith('- Pin: '))
      .map((line) => line.replace(/ \(conf `[0-9a-f]+`\)$/, ''))

  it('names the engine and where its pin came from', () => {
    expect(heading('llamacpp-upstream', 'list')).toEqual([
      '# llama.cpp surface: b11617 against b11463 — WARN',
      '- Pin: the release list',
    ])
    expect(heading('atomic-prism', 'prism-manifest')[1]).toBe('- Pin: prism-manifest')
    expect(heading('sd-cpp', 'sdcpp-manifest')).toEqual([
      '# stable-diffusion.cpp surface: b11617 against b11463 — WARN',
      "- Pin: conf's sd.cpp manifest",
    ])
    expect(heading('audio-cpp', 'audiocpp-manifest')).toEqual([
      '# audio.cpp surface: b11617 against b11463 — WARN',
      "- Pin: conf's audio.cpp manifest",
    ])
    expect(heading('mlx', 'mlx-manifest')).toEqual([
      '# mlx-server surface: b11617 against b11463 — WARN',
      "- Pin: conf's MLX manifest",
    ])
    expect(heading(undefined, 'override')[1]).toBe('- Pin: given')
    expect(heading(undefined, 'legacy')[1]).toBe('- Pin: the legacy manifest')
  })
})
