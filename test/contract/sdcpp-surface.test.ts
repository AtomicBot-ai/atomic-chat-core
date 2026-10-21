/**
 * The stable-diffusion.cpp side of the engine candidate check: the surface diff of a build
 * (scripts/lib/sdcpp-surface.mjs) on the real `--help` and archives of master-883-137f740 and on
 * synthetic changes of each kind it has to catch, what `resolve` takes for a complete release (the
 * fork's, and conf's signed mirror with its staging manifest), the manifest the install test points
 * the core at (scripts/lib/sdcpp-fixtures.mjs), and the configuration
 * (`.github/engine-candidate/sd-cpp.json`) the workflow and `npm run engine:check` read.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSdcppReport,
  checkSdAssets,
  checkSdHelp,
  checkSdInvocations,
  checkSdProbe,
  checkSdVersion,
  diffSdHelp,
  findSdOption,
  parseSdHelp,
  sdcppCompleteness,
  sdcppCoreAssets,
} from '../../scripts/lib/sdcpp-surface.mjs'
import type { ReleaseAssetInfo, SdcppContract } from '../../scripts/lib/sdcpp-surface.mjs'
import { liveModelPath, sdcppHostArchive, sdcppInstallManifest } from '../../scripts/lib/sdcpp-fixtures.mjs'
import { coreMatrix, requiredLiveTests } from '../../scripts/lib/engine-results.mjs'
import type { EngineCandidateConfig } from '../../scripts/lib/engine-results.mjs'
import { expandLiveEnv, liveModelsKey } from '../../scripts/lib/live-fixtures.mjs'
import { SDCPP_PIN_PLATFORMS } from '../../scripts/lib/engine-pin.mjs'
import { parseSdcppManifest, sdcppAssetUrl, sdcppHostChoice } from '../../src/engine-builds/index.js'

const root = new URL('../../', import.meta.url)
const fixture = (path: string) => readFileSync(new URL(`../fixtures/sdcpp/${path}`, import.meta.url), 'utf8')
const contract = JSON.parse(fixture('engine-contract.json')) as SdcppContract
const release = (tag: string) =>
  JSON.parse(fixture(`releases/${tag}.json`)) as { tag: string; assets: Array<Required<ReleaseAssetInfo>> }
const FORK = release('master-883-137f740')
const MIRROR = release('master-883-137f740-a36f1b1a')
const names = (r: { assets: Array<{ name: string }> }) => r.assets.map((a) => a.name)
const SERVER_HELP = fixture('help/sd-server-master-883-137f740.txt')
const CLI_HELP = fixture('help/sd-cli-master-883-137f740.txt')
const VERSION = fixture('help/sd-server-version-master-883-137f740.txt')
const ids = (findings: Array<{ id: string; severity: string }>, severity: string) =>
  findings.filter((f) => f.severity === severity).map((f) => f.id)
/** `--help` without the option lines that spell `flag`. */
const without = (help: string, flag: string) =>
  help
    .split('\n')
    .filter((line) => !new RegExp(`^ +(-\\S+, )*${flag.replace(/[-]/g, '\\-')}[ ,]`).test(line))
    .join('\n')

describe('reading sd.cpp’s --help', () => {
  const options = parseSdHelp(SERVER_HELP)

  it('reads every option of a real screen, by its exact aliases', () => {
    expect(options.length).toBeGreaterThan(150)
    expect(findSdOption(options, '-v')?.aliases).toEqual(['-v', '--verbose'])
    expect(findSdOption(options, '--vae')?.hint).toBe('<string>')
    expect(findSdOption(options, '--vae-format')?.help).toMatch(/^VAE latent format override/)
    // Help wraps onto the deeper lines that follow.
    expect(findSdOption(options, '--llm')?.help).toContain('mistral-small3.2 for flux2')
    expect(findSdOption(options, '--qwen2vl')?.deprecated).toBe(true)
    expect(findSdOption(options, '-M')).toBeUndefined()
    expect(findSdOption(parseSdHelp(CLI_HELP), '-M')?.aliases).toEqual(['-M', '--mode'])
  })

  it('takes a flag core emits as missing when only a longer one starts with it', () => {
    const help = without(SERVER_HELP, '--vae')
    expect(help).toContain('--vae-format')
    expect(findSdOption(parseSdHelp(help), '--vae')).toBeUndefined()
    expect(ids(checkSdHelp(contract, parseSdHelp(help)), 'break')).toEqual(['help.required_flags/--vae'])
  })

  it('on master-883: three flags core emits are deprecated, -M is sd-cli’s only', () => {
    const findings = checkSdHelp(contract, options)
    expect(ids(findings, 'break')).toEqual([])
    expect(ids(findings, 'warn').sort()).toEqual([
      'help.deprecated/--clip-on-cpu',
      'help.deprecated/--qwen2vl',
      'help.deprecated/--vae-on-cpu',
      'help.required_flags/-M',
    ])
  })

  it('fails closed on something that is not a help screen', () => {
    expect(ids(checkSdHelp(contract, parseSdHelp('error: unknown option')), 'error')).toEqual(['help.parse'])
  })

  it('lists what changed since the pin among the flags core never emits', () => {
    const pin = parseSdHelp(without(SERVER_HELP, '--tokenizer'))
    const candidate = parseSdHelp(without(without(SERVER_HELP, '--rpc-servers'), '--vae'))
    const findings = diffSdHelp(pin, candidate, contract)
    expect(findings.map((f) => [f.id, f.evidence])).toEqual([
      ['help.diff/removed', { flags: ['--rpc-servers'] }],
      ['help.diff/added', { flags: ['--tokenizer'] }],
    ])
  })
})

describe('the invocations, the install probe and --version', () => {
  const ran = (over: Record<string, unknown> = {}) => [
    { bin: 'sd-server', argv: ['--help'], status: 0 },
    { bin: 'sd-server', argv: ['--version'], status: 0 },
    { bin: 'sd-cli', argv: ['--help'], status: 0, ...over },
  ]

  it('is quiet on a build whose binaries all answer', () => {
    expect(checkSdInvocations(contract, ran())).toEqual([])
    expect(checkSdProbe(contract, { 'sd-cli': CLI_HELP, 'sd-server': SERVER_HELP })).toEqual([])
  })

  it('takes an archive without sd-cli as probed through sd-server, and one without sd-server as broken', () => {
    const noCli = ran({ status: null, error: 'spawnSync /x/sd-cli ENOENT' })
    expect(checkSdInvocations(contract, noCli).map((f) => [f.id, f.severity])).toEqual([
      ['invocations.exit/sd-cli --help', 'info'],
    ])
    expect(checkSdProbe(contract, { 'sd-cli': undefined, 'sd-server': SERVER_HELP })).toEqual([])
    const noServer = ran().map((r) =>
      r.bin === 'sd-server' ? { ...r, status: null, error: 'spawnSync /x/sd-server ENOENT' } : r
    )
    expect(ids(checkSdInvocations(contract, noServer), 'break')).toEqual([
      'invocations.exit/sd-server --help',
      'invocations.exit/sd-server --version',
    ])
  })

  it('warns about an exit core does not read, and breaks when the probe binary shows no marker', () => {
    expect(ids(checkSdInvocations(contract, ran({ status: 1, output: 'boom' })), 'warn')).toEqual([
      'invocations.exit/sd-cli --help',
    ])
    // sd-cli is there, so core probes it, whatever sd-server prints.
    expect(
      ids(checkSdProbe(contract, { 'sd-cli': 'usage: other-tool', 'sd-server': SERVER_HELP }), 'break')
    ).toEqual(['install.probe/sd-cli'])
  })

  it('ties --version to the tag’s commit', () => {
    expect(checkSdVersion(contract, { tag: 'master-883-137f740-a36f1b1a', output: VERSION })).toEqual([
      expect.objectContaining({ id: 'version.output/version', severity: 'info' }),
    ])
    expect(ids(checkSdVersion(contract, { tag: 'master-975-95b3090', output: VERSION }), 'break')).toEqual([
      'version.output/commit',
    ])
    expect(
      checkSdVersion(contract, {
        tag: 'master-975-95b3090',
        output: 'stable-diffusion.cpp version master-975-95b3090+, commit 95b3090',
      })
    ).toEqual([])
    expect(ids(checkSdVersion(contract, { tag: 'master-975-95b3090', output: 'v1.0' }), 'warn')).toEqual([
      'version.output',
    ])
  })
})

describe('the archives', () => {
  const check = (candidate: string[], pin: string[] | null = names(MIRROR)) =>
    checkSdAssets(contract, {
      candidate: { tag: 'master-975-95b3090', assets: candidate },
      pin: pin && { tag: MIRROR.tag, assets: pin },
    })
  /** The 883 fork release renamed to the 975 commit. */
  const fresh = names(FORK).map((n) => n.replace('137f740', '95b3090'))

  it('master-883 against its signed mirror: nothing lost, the archives no backend takes listed once', () => {
    const findings = checkSdAssets(contract, {
      candidate: { tag: FORK.tag, assets: names(FORK) },
      pin: { tag: MIRROR.tag, assets: names(MIRROR) },
    })
    expect(findings.map((f) => [f.id, f.severity])).toEqual([['assets.core_backends/unconsumed', 'info']])
    expect(sdcppCoreAssets(contract, FORK.tag, names(FORK))).toHaveLength(11)
  })

  it('breaks on a lost CPU or mirror-required archive, warns on a lost optional one the pin had', () => {
    const drop = (part: string) => fresh.filter((n) => !n.includes(part))
    expect(ids(check(drop('aarch64.zip')), 'break')).toEqual([
      'assets.core_backends/linux-arm64/linux-cpu-arm64',
    ])
    expect(ids(check(drop('win-vulkan-x64')), 'break')).toEqual([
      'assets.core_backends/windows-x64/win-vulkan-x64',
    ])
    expect(ids(check(drop('aarch64-cuda13')), 'warn')).toEqual([
      'assets.core_backends/linux-arm64/linux-cuda13-arm64',
    ])
    expect(ids(check(drop('aarch64-cuda13'), drop('aarch64-cuda13')), 'warn')).toEqual([])
  })

  it('breaks on two archives for one backend, and reports a moved one', () => {
    const twoMacs = [...fresh, 'sd-master-95b3090-bin-Darwin-macOS-27.0-arm64.zip']
    expect(ids(check(twoMacs), 'break')).toEqual(['assets.core_backends/macos-arm64/macos-arm64'])
    const moved = fresh.map((n) => n.replace('macOS-26.6.2', 'macOS-27.0'))
    expect(check(moved).find((f) => f.id === 'assets.core_backends/macos-arm64/macos-arm64')?.message).toBe(
      'macos-arm64 moved: Darwin-macOS-26.6.2-arm64.zip → Darwin-macOS-27.0-arm64.zip'
    )
  })
})

describe('a complete release', () => {
  const LIVE = ['linux-x64', 'linux-arm64', 'macos-arm64']
  const BASE = 'https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download'
  const live = JSON.parse(fixture('conf/sdcpp-manifest.json')) as {
    tag_name: string
    assets: Array<Record<string, unknown>>
  }

  it('on the fork: every archive the mirror and the live platforms need, up with its digest', () => {
    expect(sdcppCompleteness({ contract, tag: FORK.tag, assets: FORK.assets, platforms: LIVE })).toEqual({
      complete: true,
      missing: [],
    })
    const uploading = FORK.assets.map((a) => (a.name.endsWith('aarch64.zip') ? { ...a, digest: null } : a))
    expect(
      sdcppCompleteness({ contract, tag: FORK.tag, assets: uploading, platforms: LIVE }).missing
    ).toEqual([
      {
        kind: 'digest',
        backend: 'linux-cpu-arm64',
        name: 'sd-master-137f740-bin-Linux-Ubuntu-24.04-aarch64.zip',
      },
    ])
    // linux-cpu-arm64 is optional for the mirror: without a live run on arm64 Linux it is not waited for.
    const noArm = FORK.assets.filter((a) => !a.name.endsWith('aarch64.zip'))
    expect(
      sdcppCompleteness({ contract, tag: FORK.tag, assets: noArm, platforms: ['linux-x64'] }).complete
    ).toBe(true)
    expect(sdcppCompleteness({ contract, tag: FORK.tag, assets: noArm, platforms: LIVE }).missing).toEqual([
      { kind: 'core', platform: 'linux-arm64', backend: 'linux-cpu-arm64' },
    ])
  })

  it('on conf: the manifest names the tag and pins exactly the bytes of the release', () => {
    const complete = (manifest: unknown, assets = MIRROR.assets) =>
      sdcppCompleteness({ contract, tag: MIRROR.tag, assets, platforms: LIVE, manifest, downloadBase: BASE })
    expect(complete(live)).toEqual({ complete: true, missing: [] })
    expect(complete({ ...live, tag_name: 'master-975-95b3090-a0123456' }).missing).toEqual([
      { kind: 'manifest', reason: 'the staging manifest names master-975-95b3090-a0123456' },
    ])
    expect(complete(null).missing).toEqual([
      { kind: 'manifest', reason: 'conf has no staging manifest core reads' },
    ])
    expect(complete({ ...live, download_base: 'https://example.com/x' }).missing).toEqual([
      expect.objectContaining({
        kind: 'manifest',
        reason: expect.stringContaining('downloads from https://example.com/x'),
      }),
    ])
    const resigned = MIRROR.assets.map((a) =>
      a.name.includes('Darwin') ? { ...a, size: a.size + 1, digest: `sha256:${'0'.repeat(64)}` } : a
    )
    expect(complete(live, resigned).missing).toEqual([
      {
        kind: 'manifest-asset',
        backend: 'macos-arm64',
        name: 'sd-master-137f740-bin-Darwin-macOS-26.6.2-arm64.zip',
        reason: 'size 34338632 in the release, 34338631 in the manifest',
      },
    ])
  })
})

describe('the manifest the install test installs from', () => {
  it('is one the core reads, downloading each archive from the release with its size and sha256', () => {
    for (const r of [FORK, MIRROR]) {
      const repo = r === FORK ? 'AtomicBot-ai/stable-diffusion.cpp' : 'AtomicBot-ai/atomic-chat-conf'
      const manifest = parseSdcppManifest(
        sdcppInstallManifest({ contract, tag: r.tag, repo, assets: r.assets })
      )
      expect(manifest.tag_name).toBe(r.tag)
      expect(manifest.assets).toHaveLength(11)
      for (const p of SDCPP_PIN_PLATFORMS) {
        const choice = sdcppHostChoice(
          { os: p.os, arch: p.arch, features: {}, gpus: [] },
          manifest,
          new Set()
        )
        const asset = manifest.assets.find((a) => a.backend === choice.backend_id)
        expect(choice.backend_id, p.platform).toBe(p.backend)
        const source = r.assets.find((a) => a.name === asset?.name)
        expect(asset).toMatchObject({ size: source?.size, sha256: source?.digest?.slice('sha256:'.length) })
        expect(sdcppAssetUrl(manifest, asset as NonNullable<typeof asset>)).toBe(
          `https://github.com/${repo}/releases/download/${r.tag}/${asset?.name}`
        )
      }
      expect(manifest.assets.find((a) => a.backend === 'win-cudart-cu12')?.companion).toBe(true)
    }
  })

  it('takes this host’s CPU archive for the live run', () => {
    expect(sdcppHostArchive(contract, FORK.tag, FORK.assets, 'linux-arm64').asset.name).toBe(
      'sd-master-137f740-bin-Linux-Ubuntu-24.04-aarch64.zip'
    )
    expect(() => sdcppHostArchive(contract, FORK.tag, [], 'macos-arm64')).toThrow(/0 macos-arm64 archives/)
    expect(() => sdcppHostArchive(contract, FORK.tag, FORK.assets, 'macos-x64')).toThrow(/no CPU build/)
  })
})

describe('the sd-cpp configuration', () => {
  const config = JSON.parse(
    readFileSync(new URL('.github/engine-candidate/sd-cpp.json', root), 'utf8')
  ) as EngineCandidateConfig & {
    tag_pattern: string
    live_models: Array<{ id: string; url: string; sha256: string }>
    live_env: Record<string, string>
  }

  it('reads the tags conf’s manifest takes, the fork’s and the signed mirror’s', () => {
    const re = new RegExp(config.tag_pattern)
    for (const tag of ['master-883-137f740', 'master-883-137f740-a36f1b1a']) {
      expect(re.test(tag), tag).toBe(true)
      expect(() =>
        parseSdcppManifest({ ...JSON.parse(fixture('conf/sdcpp-manifest.json')), tag_name: tag })
      ).not.toThrow()
    }
    for (const tag of ['b11617', 'master-883', 'master-883-137f740-atomic'])
      expect(re.test(tag), tag).toBe(false)
  })

  it('names a required live test only if the live file has it', () => {
    for (const { file, name } of config.required_live_tests) {
      const text = readFileSync(new URL(file, root), 'utf8')
      const suites = [...text.matchAll(/describe(?:\.skipIf\([^)]*\))?\(\s*'([^']+)'/g)].map((m) => m[1])
      const tests = [...text.matchAll(/\bit\(\s*'([^']+)'/g)].map((m) => m[1])
      expect(
        suites.flatMap((s) => tests.map((t) => `${s} ${t}`)),
        `${file} has no test named "${name}"`
      ).toContain(name)
      expect(config.live_files).toContain(file)
    }
  })

  it('runs live on platforms core ships sd.cpp for, the core suites on the same platforms', () => {
    const shipped = SDCPP_PIN_PLATFORMS.map((p) => p.platform)
    for (const { platform } of config.platforms) expect(shipped).toContain(platform)
    expect(coreMatrix(config.platforms)).toEqual([
      { platform: 'linux-x64', os: 'ubuntu-latest' },
      { platform: 'linux-arm64', os: 'ubuntu-24.04-arm' },
      { platform: 'macos-arm64', os: 'macos-14' },
    ])
    for (const { platform } of config.platforms)
      expect(requiredLiveTests(config.required_live_tests, platform)).toEqual(config.required_live_tests)
  })

  it('fills its live env from what the fetch leaves, and keys the model cache by the models', () => {
    const models = Object.fromEntries(config.live_models.map((m) => [m.id, liveModelPath('/models', m)]))
    const env = expandLiveEnv(config.live_env, { engine_dir: '/e', tag: 't', manifest: '/m.json', models })
    expect(env).toMatchObject({
      ATOMIC_LIVE_SD_ENGINE: '/e',
      // The host's separators: the fetch writes these paths for the host it runs on.
      ATOMIC_LIVE_SD_MODEL: join('/models', '0b25d143c8469b34', 'flux-2-klein-4b-Q4_K_M.gguf'),
      ATOMIC_LIVE_SD_VAE_FORMAT: 'flux2',
      ATOMIC_LIVE_SD_BACKEND: 'cpu',
    })
    expect(liveModelsKey(config.live_models)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('protects paths that exist', () => {
    for (const path of [...config.protected_paths, ...config.live_files, config.contract]) {
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
})

describe('the sd.cpp surface report', () => {
  const side = (tag: string, repo: string, assets: string[]) => ({
    tag,
    repo,
    source: 'release' as const,
    platform: 'linux-x64',
    help_text: SERVER_HELP,
    cli_help_text: CLI_HELP,
    version_output: VERSION,
    invocations: [
      { bin: 'sd-server', argv: ['--help'], status: 0 },
      { bin: 'sd-server', argv: ['--version'], status: 0 },
      { bin: 'sd-cli', argv: ['--help'], status: 0 },
    ],
    assets,
    upstream: {
      tag: 'master-883-137f740',
      commit: '137f7409bbfb98c70a350a57d6a135487080db96',
      published_at: null,
    },
  })

  it('master-883 against its signed mirror: a warn for the deprecated flags, nothing else to fix', () => {
    const report = buildSdcppReport(
      contract,
      {
        candidate: side(FORK.tag, 'AtomicBot-ai/stable-diffusion.cpp', names(FORK)),
        pin: side(MIRROR.tag, 'AtomicBot-ai/atomic-chat-conf', names(MIRROR)),
        upstream: { available: false, reason: 'not compared' },
      },
      { now: '2026-10-21T00:00:00Z' }
    )
    expect(report.schema).toBe('atomic-engine-surface-report')
    expect(report.engine).toBe('sd-cpp')
    expect(report.status).toBe('warn')
    expect(report.counts).toEqual({ break: 0, warn: 4, info: 5, error: 0 })
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      'help.parse:pass',
      'help.required_flags:warn',
      'help.deprecated:warn',
      'help.diff:pass',
      'invocations.exit:pass',
      'install.probe:pass',
      'version.output:pass',
      'assets.core_backends:pass',
      'upstream.watched_paths:pass',
      'upstream.contract_strings:pass',
      'upstream.release_notes:pass',
    ])
    expect(report.inputs.candidate).toMatchObject({ tag: FORK.tag, upstream: { tag: 'master-883-137f740' } })
    expect(report.inputs.same_as_pin).toBe(false)
  })

  it('is an error, not a pass, when the candidate could not be run', () => {
    const report = buildSdcppReport(contract, {
      candidate: { tag: FORK.tag, source: 'release', capture_error: 'fetch failed', assets: names(FORK) },
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
