/**
 * The audio.cpp side of the engine candidate check: the surface diff of a build
 * (scripts/lib/audiocpp-surface.mjs) on the real `--help`, `--version` and archives of upstream
 * v0.9.3 and conf's mirror of a fork build, and on synthetic changes of each kind it has to catch;
 * what `resolve` takes for a complete release; and the manifest the install test points the core at
 * (scripts/lib/audiocpp-fixtures.mjs), held to the core's own manifest parser, ladder and asset URL.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AUDIOCPP_CHECKS,
  audiocppCompleteness,
  audiocppCoreAssets,
  buildAudiocppReport,
  checkAudioAssets,
  checkAudioHelp,
  checkAudioProbe,
  checkAudioVersion,
  diffAudioHelp,
  parseAudioHelp,
} from '../../scripts/lib/audiocpp-surface.mjs'
import type { AudiocppContract } from '../../scripts/lib/audiocpp-surface.mjs'
import type { ReleaseAssetInfo } from '../../scripts/lib/sdcpp-surface.mjs'
import { audiocppHostArchive, audiocppInstallManifest } from '../../scripts/lib/audiocpp-fixtures.mjs'
import { AUDIOCPP_PIN_PLATFORMS } from '../../scripts/lib/engine-pin.mjs'
import { renderMarkdown } from '../../scripts/lib/engine-surface.mjs'
import { audiocppAssetUrl, audiocppHostChoice, parseAudiocppManifest } from '../../src/engine-builds/index.js'

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/audiocpp/${path}`, import.meta.url), 'utf8')
const contract = JSON.parse(fixture('engine-contract.json')) as AudiocppContract
const release = (tag: string) =>
  JSON.parse(fixture(`releases/${tag}.json`)) as {
    repo: string
    tag: string
    assets: Array<Required<ReleaseAssetInfo>>
  }
const UPSTREAM = release('v0.9.3')
const MIRROR = release('v0.9.3-a1b2c3d4')
const names = (r: { assets: Array<{ name: string }> }) => r.assets.map((a) => a.name)
const HELP = fixture('v0.9.3/help.txt')
const VERSION = fixture('v0.9.3/version-macos-arm64.txt')
/** The commit upstream's v0.9.3 tag points to (`git ls-remote`). */
const V093_COMMIT = '41c1f8ffa0d13a1b7e366e30ea5fe5ab8d169d48'
const ids = (findings: Array<{ id: string; severity: string }>, severity: string) =>
  findings.filter((f) => f.severity === severity).map((f) => f.id)
/** `--help` without the lines that `pattern` matches. */
const without = (help: string, pattern: RegExp) =>
  help
    .split('\n')
    .filter((line) => !pattern.test(line))
    .join('\n')

describe('reading audio.cpp’s --help', () => {
  const help = parseAudioHelp(HELP)

  it('reads the flags of the usage block and the option lines, and the endpoint list', () => {
    expect(help.flags.length).toBeGreaterThanOrEqual(24)
    for (const flag of ['--config', '--no-ui', '--threads', '--log', '--log-file', '--load-progress'])
      expect(help.flags).toContain(flag)
    expect(help.routes.length).toBeGreaterThanOrEqual(25)
    expect(help.routes).toContainEqual({ method: 'GET', path: '/v1/audio/voices' })
    expect(help.routes).toContainEqual({ method: 'GET', path: '/v1/ui/models/install-status' })
    expect(help.routes).toContainEqual({ method: 'POST', path: '/v1/audio/speech/live' })
    // The endpoint list's notes (`fields: file, model, …`) are not routes.
    expect(help.routes.every((r) => r.path.startsWith('/'))).toBe(true)
  })

  it('takes a flag core passes as missing when only a longer one, or a help text, names it', () => {
    // --log only in `[--log]`; --log-file stays, and the --load-progress help says "with --log/--log-file".
    const noLog = HELP.replace('[--log] ', '')
    expect(noLog).toContain('--log/--log-file')
    const parsed = parseAudioHelp(noLog)
    expect(parsed.flags).not.toContain('--log')
    expect(parsed.flags).toContain('--log-file')
    expect(ids(checkAudioHelp(contract, parsed), 'break')).toEqual(['help.required_flags/--log'])
  })

  it('on v0.9.3: every flag and route core uses is there', () => {
    expect(checkAudioHelp(contract, help)).toEqual([])
  })

  it('breaks on a lost route, and says when only its method changed', () => {
    const noVoices = parseAudioHelp(without(HELP, /^\s+GET\s+\/v1\/audio\/voices/))
    expect(ids(checkAudioHelp(contract, noVoices), 'break')).toEqual(['help.routes/GET /v1/audio/voices'])
    const postHealth = parseAudioHelp(HELP.replace('GET  /health', 'POST /health'))
    const [found] = checkAudioHelp(contract, postHealth)
    expect(found).toMatchObject({ id: 'help.routes/GET /health', severity: 'break' })
    expect(found?.message).toBe('audiocpp_server lists /health for POST only; core calls GET /health')
  })

  it('fails closed on something that is not a help screen', () => {
    expect(ids(checkAudioHelp(contract, parseAudioHelp('error: unknown option')), 'error')).toEqual([
      'help.parse',
    ])
    // Flags but no endpoint list: a screen of another shape.
    expect(
      ids(checkAudioHelp(contract, parseAudioHelp(HELP.slice(0, HELP.indexOf('Endpoints:')))), 'error')
    ).toEqual(['help.parse'])
  })

  it('lists what changed since the pin among the flags and routes core never uses', () => {
    const pin = parseAudioHelp(without(HELP, /^\s+POST\s+\/v1\/recipes\/run/))
    const candidate = parseAudioHelp(
      without(HELP.replace(/ ?\[--voice-dir <directory>\]/, ''), /^ +--voice-dir/)
    )
    expect(diffAudioHelp(pin, candidate, contract).map((f) => [f.id, f.evidence])).toEqual([
      ['help.diff/removed-flags', { flags: ['--voice-dir'] }],
      ['help.diff/added-routes', { routes: ['POST /v1/recipes/run'] }],
    ])
  })
})

describe('the install probe and --version', () => {
  it('is quiet on v0.9.3 as upstream and as a fork rebuild of it', () => {
    expect(checkAudioProbe(contract, VERSION)).toEqual([])
    expect(
      checkAudioVersion(contract, { tag: 'v0.9.3', output: VERSION, upstreamCommit: V093_COMMIT })
    ).toEqual([])
    expect(
      checkAudioVersion(contract, { tag: 'v0.9.3-a1b2c3d4', output: VERSION, upstreamCommit: V093_COMMIT })
    ).toEqual([])
  })

  it('breaks when --version is not audio.cpp’s, or names another version than the tag', () => {
    expect(ids(checkAudioProbe(contract, 'llama.cpp version: 7000 (abc)'), 'break')).toEqual([
      'install.probe/--version',
    ])
    expect(ids(checkAudioProbe(contract, undefined), 'error')).toEqual(['install.probe'])
    const findings = checkAudioVersion(contract, { tag: 'v0.9.4', output: VERSION })
    expect(ids(findings, 'break')).toEqual(['version.output/version'])
    expect(findings[0]?.message).toBe(
      '--version says 0.9.3, the tag 0.9.4: the archive is not the build of v0.9.4'
    )
  })

  it('warns about a build without a version or a commit, or with another commit than the tag’s', () => {
    const dev = 'audio.cpp dev\ngit: unknown unknown\nbackends: cpu\n'
    expect(ids(checkAudioVersion(contract, { tag: 'v0.9.3', output: dev }), 'warn')).toEqual([
      'version.output/version',
      'version.output/commit',
    ])
    expect(
      ids(
        checkAudioVersion(contract, { tag: 'v0.9.3', output: VERSION, upstreamCommit: 'f'.repeat(40) }),
        'warn'
      )
    ).toEqual(['version.output/commit'])
    expect(ids(checkAudioVersion(contract, { tag: 'v0.9.3', output: '' }), 'warn')).toEqual([
      'version.output',
    ])
  })
})

describe('the archives', () => {
  it('upstream v0.9.3 against itself: every backend it builds, and no arm64 Linux or Windows', () => {
    const findings = checkAudioAssets(contract, {
      candidate: { tag: UPSTREAM.tag, assets: names(UPSTREAM) },
      pin: { tag: UPSTREAM.tag, assets: names(UPSTREAM) },
    })
    // Upstream builds no arm64 Linux or Windows: core would offer audio.cpp on neither.
    expect(ids(findings, 'break')).toEqual([
      'assets.core_backends/windows-arm64/win-cpu-arm64',
      'assets.core_backends/linux-arm64/linux-cpu-arm64',
    ])
    expect(ids(findings, 'warn')).toEqual([])
    expect(audiocppCoreAssets(contract, UPSTREAM.tag, names(UPSTREAM))).toHaveLength(7)
  })

  it('a fork build against the upstream bootstrap: nothing lost, each archive moved to the fork’s name', () => {
    const findings = checkAudioAssets(contract, {
      candidate: { tag: MIRROR.tag, assets: names(MIRROR) },
      pin: { tag: UPSTREAM.tag, assets: names(UPSTREAM) },
    })
    expect(ids(findings, 'break')).toEqual([])
    expect(ids(findings, 'warn')).toEqual([])
    expect(findings.find((f) => f.id === 'assets.core_backends/macos-arm64/macos-arm64')?.message).toBe(
      'macos-arm64 moved: bin-macos-arm64-metal.tar.gz → bin-macos-arm64.zip'
    )
    expect(findings.find((f) => f.id === 'assets.core_backends/unconsumed')?.evidence).toEqual({
      archives: ['audio-v0.9.3-bin-win-cuda13-x64.zip'],
    })
    expect(audiocppCoreAssets(contract, MIRROR.tag, names(MIRROR))).toHaveLength(11)
  })

  it('breaks on a lost CPU or mirror-required archive, warns on a lost optional one the pin had', () => {
    const fresh = names(MIRROR).map((n) => n.replace('v0.9.3', 'v0.9.4'))
    const check = (assets: string[]) =>
      checkAudioAssets(contract, {
        candidate: { tag: 'v0.9.4', assets },
        pin: { tag: MIRROR.tag, assets: names(MIRROR) },
      })
    const drop = (part: string) => fresh.filter((n) => !n.includes(part))
    expect(ids(check(drop('linux-cpu-x64')), 'break')).toEqual([
      'assets.core_backends/linux-x64/linux-cpu-x64',
    ])
    expect(ids(check(drop('cudart')), 'break')).toEqual(['assets.core_backends/windows-x64/win-cudart-cu12'])
    expect(ids(check(drop('linux-cuda13-arm64')), 'warn')).toEqual([
      'assets.core_backends/linux-arm64/linux-cuda13-arm64',
    ])
    // Two archives for one backend: conf's mirror refuses the tag.
    expect(ids(check([...fresh, 'audio-v0.9.4-bin-macos-arm64-metal.tar.gz']), 'break')).toEqual([
      'assets.core_backends/macos-arm64/macos-arm64',
    ])
  })
})

describe('a complete release', () => {
  const LIVE = ['linux-x64', 'linux-arm64', 'macos-arm64']
  const BASE = 'https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download'
  const live = JSON.parse(fixture('conf/audiocpp-manifest.json')) as Record<string, unknown>

  it('upstream: complete on this Mac, waiting for an arm64 Linux build on the live platforms', () => {
    const complete = (platforms: string[]) =>
      audiocppCompleteness({ contract, tag: UPSTREAM.tag, assets: UPSTREAM.assets, platforms })
    expect(complete(['macos-arm64'])).toEqual({ complete: true, missing: [] })
    expect(complete(LIVE).missing).toEqual([
      { kind: 'core', platform: 'linux-arm64', backend: 'linux-cpu-arm64' },
    ])
    expect(audiocppCompleteness({ contract, tag: 'v0.9.2-drama3-base-small', assets: [] }).missing).toEqual([
      { kind: 'tag', tag: 'v0.9.2-drama3-base-small' },
    ])
  })

  it('on conf: the manifest names the tag and pins exactly the bytes of the release', () => {
    const complete = (manifest: unknown, assets = MIRROR.assets) =>
      audiocppCompleteness({
        contract,
        tag: MIRROR.tag,
        assets,
        platforms: LIVE,
        manifest,
        downloadBase: BASE,
      })
    expect(complete(live)).toEqual({ complete: true, missing: [] })
    expect(complete({ ...live, tag_name: 'v0.9.3-a0123456' }).missing).toEqual([
      { kind: 'manifest', reason: 'the staging manifest names v0.9.3-a0123456' },
    ])
    expect(complete(null).missing).toEqual([
      { kind: 'manifest', reason: 'conf has no staging manifest core reads' },
    ])
    const resigned = MIRROR.assets.map((a) =>
      a.name.includes('macos') ? { ...a, size: a.size + 1, digest: `sha256:${'0'.repeat(64)}` } : a
    )
    expect(complete(live, resigned).missing).toEqual([
      {
        kind: 'manifest-asset',
        backend: 'macos-arm64',
        name: 'audio-v0.9.3-bin-macos-arm64.zip',
        reason: 'size 31877121 in the release, 31877120 in the manifest',
      },
    ])
  })
})

describe('the manifest the install test installs from', () => {
  it('is conf’s bootstrap manifest for upstream v0.9.3, archive for archive', () => {
    const doc = audiocppInstallManifest({
      contract,
      tag: UPSTREAM.tag,
      repo: UPSTREAM.repo,
      assets: UPSTREAM.assets,
    })
    const staging = parseAudiocppManifest(JSON.parse(fixture('conf/audiocpp-manifest.staging.json')))
    const parsed = parseAudiocppManifest(doc)
    expect(parsed.tag_name).toBe(staging.tag_name)
    const byBackend = (m: typeof parsed) => [...m.assets].sort((a, b) => a.backend.localeCompare(b.backend))
    expect(byBackend(parsed)).toEqual(byBackend(staging))
    // conf's has no download_base: the core downloads from upstream's release, the same URLs.
    for (const asset of parsed.assets)
      expect(audiocppAssetUrl(parsed, asset)).toBe(
        audiocppAssetUrl(staging, staging.assets.find((a) => a.backend === asset.backend) ?? asset)
      )
  })

  it('downloads each archive of a conf mirror from the mirror’s release, the CPU one of each platform', () => {
    const doc = parseAudiocppManifest(
      audiocppInstallManifest({ contract, tag: MIRROR.tag, repo: MIRROR.repo, assets: MIRROR.assets })
    )
    expect(doc.assets).toHaveLength(11)
    for (const p of AUDIOCPP_PIN_PLATFORMS) {
      const choice = audiocppHostChoice({ os: p.os, arch: p.arch, features: {}, gpus: [] }, doc, new Set())
      expect(choice.backend_id, p.platform).toBe(p.backend)
      const asset = doc.assets.find((a) => a.backend === choice.backend_id)
      const source = MIRROR.assets.find((a) => a.name === asset?.name)
      expect(asset).toMatchObject({ size: source?.size, sha256: source?.digest?.slice('sha256:'.length) })
      expect(audiocppAssetUrl(doc, asset as NonNullable<typeof asset>)).toBe(
        `https://github.com/${MIRROR.repo}/releases/download/${MIRROR.tag}/${asset?.name}`
      )
    }
    expect(doc.assets.find((a) => a.backend === 'win-cudart-cu12')?.companion).toBe(true)
  })

  it('takes this host’s CPU archive for the live run', () => {
    expect(audiocppHostArchive(contract, UPSTREAM.tag, UPSTREAM.assets, 'macos-arm64').asset.name).toBe(
      'audio-v0.9.3-bin-macos-arm64-metal.tar.gz'
    )
    expect(audiocppHostArchive(contract, MIRROR.tag, MIRROR.assets, 'linux-arm64').asset.name).toBe(
      'audio-v0.9.3-bin-linux-cpu-arm64.zip'
    )
    expect(() => audiocppHostArchive(contract, UPSTREAM.tag, UPSTREAM.assets, 'linux-arm64')).toThrow(
      /0 linux-cpu-arm64 archives/
    )
    expect(() => audiocppHostArchive(contract, UPSTREAM.tag, UPSTREAM.assets, 'macos-x64')).toThrow(
      'audio.cpp ships no CPU build for macos-x64'
    )
  })
})

describe('the audio.cpp surface report', () => {
  const side = (r: typeof UPSTREAM) => ({
    tag: r.tag,
    repo: r.repo,
    source: 'release' as const,
    platform: 'macos-arm64',
    help_text: HELP,
    version_output: VERSION,
    invocations: [
      { bin: 'audiocpp_server', argv: ['--help'], status: 0 },
      { bin: 'audiocpp_server', argv: ['--version'], status: 0 },
      { bin: 'audiocpp_server', argv: ['--list-devices'], status: 0 },
    ],
    assets: names(r),
    upstream: { tag: 'v0.9.3', commit: V093_COMMIT, published_at: '2026-10-26T20:46:25Z' },
  })

  it('a fork build against the upstream bootstrap: a pass, the moves and the extra archive as info', () => {
    const report = buildAudiocppReport(
      { ...contract, engine: 'audio-cpp' },
      {
        candidate: side(MIRROR),
        pin: side(UPSTREAM),
        pin_resolution: { source: 'audiocpp-manifest', tag: UPSTREAM.tag },
        upstream: { available: false, reason: 'not compared' },
      },
      { now: '2026-10-29T00:00:00Z' }
    )
    expect(report.schema).toBe('atomic-engine-surface-report')
    expect(report.engine).toBe('audio-cpp')
    expect(report.status).toBe('pass')
    expect(report.counts.break + report.counts.warn + report.counts.error).toBe(0)
    expect(report.checks.map((c) => c.id)).toEqual(AUDIOCPP_CHECKS.map((c) => c.id))
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true)
    expect(report.inputs.candidate).toMatchObject({
      tag: MIRROR.tag,
      commit: null,
      upstream: { tag: 'v0.9.3' },
    })
    const md = renderMarkdown(report)
    expect(md.split('\n')[0]).toBe('# audio.cpp surface: v0.9.3-a1b2c3d4 against v0.9.3 — PASS')
    expect(md).toContain("- Pin: conf's audio.cpp manifest")
  })

  it('without a pin, the help diff is skipped; a break in the help fails it', () => {
    const report = buildAudiocppReport(contract, {
      candidate: { ...side(UPSTREAM), help_text: HELP.replace('[--threads <n>] ', '') },
      pin: null,
    })
    expect(report.status).toBe('break')
    expect(ids(report.findings, 'break')).toEqual([
      'assets.core_backends/linux-arm64/linux-cpu-arm64',
      'assets.core_backends/windows-arm64/win-cpu-arm64',
      'help.required_flags/--threads',
    ])
    expect(report.checks.find((c) => c.id === 'help.diff')).toMatchObject({
      status: 'skipped',
      skipped: 'no pin',
    })
  })

  it('is an error, not a pass, when the candidate could not be run', () => {
    const report = buildAudiocppReport(contract, {
      candidate: { tag: MIRROR.tag, source: 'release', capture_error: 'fetch failed', assets: names(MIRROR) },
      pin: null,
    })
    expect(report.status).toBe('error')
    expect(ids(report.findings, 'error')).toEqual([
      'help.parse',
      'install.probe',
      'invocations.exit',
      'version.output',
    ])
  })
})
