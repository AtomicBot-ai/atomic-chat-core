/**
 * The MLX side of the engine candidate check: the surface diff of a build (scripts/lib/mlx-surface.mjs)
 * on the real `--help` of the pin and of v0.7.12, the fork's and conf's releases, and on synthetic
 * changes of each kind it has to catch; what `resolve` takes for a complete release, the fork's or
 * conf's mirror of it; and the manifest the install test points the core at
 * (scripts/lib/mlx-fixtures.mjs), held to the core's own parser, host choice and asset URL.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildMlxReport,
  checkMlxArchive,
  checkMlxAssets,
  checkMlxHelp,
  checkMlxProbe,
  diffMlxHelp,
  MLX_CHECKS,
  mlxCompleteness,
  mlxCoreAssets,
  mlxManifestUpstreamTagFor,
  parseMlxHelp,
} from '../../scripts/lib/mlx-surface.mjs'
import type { MlxContract } from '../../scripts/lib/mlx-surface.mjs'
import type { ReleaseAssetInfo } from '../../scripts/lib/sdcpp-surface.mjs'
import { mlxHostArchive, mlxInstallManifest } from '../../scripts/lib/mlx-fixtures.mjs'
import { renderMarkdown } from '../../scripts/lib/engine-surface.mjs'
import { mlxAssetUrl, mlxHostChoice, parseMlxManifest } from '../../src/engine-builds/index.js'

const fixture = (path: string) => readFileSync(new URL(`../fixtures/mlx/${path}`, import.meta.url), 'utf8')
const contract = JSON.parse(fixture('engine-contract.json')) as MlxContract
const release = (tag: string) =>
  JSON.parse(fixture(`releases/${tag}.json`)) as {
    repo: string
    tag: string
    published_at: string
    assets: Array<Required<ReleaseAssetInfo>>
  }
const FORK = release('v0.7.12')
const PIN = release('mlxvlm-macos-arm64-07ba5a1')
const MIRROR = release('mlxvlm-macos-arm64-1f48deb')
const names = (r: { assets: Array<{ name: string }> }) => r.assets.map((a) => a.name)
const HELP = fixture('help/v0.7.12.txt')
const PIN_HELP = fixture('help/mlxvlm-macos-arm64-07ba5a1.txt')
const LIVE = JSON.parse(fixture('conf/mlx-manifest.json')) as Record<string, unknown>
const STAGING = JSON.parse(fixture('conf/mlx-manifest.staging.json')) as Record<string, unknown>
const CONF_BASE = 'https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download'
const ids = (findings: Array<{ id: string; severity: string }>, severity: string) =>
  findings.filter((f) => f.severity === severity).map((f) => f.id)
/** `--help` without the lines that `pattern` matches. */
const without = (help: string, pattern: RegExp) =>
  help
    .split('\n')
    .filter((line) => !pattern.test(line))
    .join('\n')

describe('reading mlx-server’s --help', () => {
  const help = parseMlxHelp(HELP)

  it('reads argparse’s usage line, every flag of the usage block and the option lines, and the choices', () => {
    expect(help.usage).toBe(true)
    expect(help.flags.length).toBeGreaterThanOrEqual(40)
    for (const flag of ['--model', '--max-kv-size', '--kv-bits', '--kv-key-bits', '--model-dir'])
      expect(help.flags).toContain(flag)
    // An alias on the same option line counts; a flag a help text only mentions does not.
    expect(help.flags).toContain('--thinking-eos-token')
    expect(help.choices).toMatchObject({
      '--draft-kind': ['dflash', 'eagle3', 'mtp'],
      '--kv-quant-scheme': ['turboquant', 'uniform'],
    })
    expect(parseMlxHelp(PIN_HELP).flags.length).toBeGreaterThanOrEqual(35)
  })

  it('on the pin and on v0.7.12: every flag and choice core passes is there', () => {
    expect(checkMlxHelp(contract, help)).toEqual([])
    expect(checkMlxHelp(contract, parseMlxHelp(PIN_HELP))).toEqual([])
  })

  it('takes a flag core passes as missing when only a longer one names it', () => {
    // --kv-bits gone from the usage block and its option line; --kv-key-bits stays, and its help
    // still says "floor(--kv-bits)".
    const noKvBits = without(HELP.replace('[--kv-bits KV_BITS] ', ''), /^ {2}--kv-bits /)
    expect(noKvBits).toContain('floor(--kv-bits)')
    const parsed = parseMlxHelp(noKvBits)
    expect(parsed.flags).not.toContain('--kv-bits')
    expect(parsed.flags).toContain('--kv-key-bits')
    expect(ids(checkMlxHelp(contract, parsed), 'break')).toEqual(['help.required_flags/--kv-bits'])
  })

  it('breaks on a choice core passes that the build no longer takes', () => {
    const noEagle = parseMlxHelp(HELP.replaceAll('{dflash,eagle3,mtp}', '{dflash,mtp}'))
    const [found] = checkMlxHelp(contract, noEagle)
    expect(found).toMatchObject({ id: 'help.choices/--draft-kind', severity: 'break' })
    expect(found?.message).toBe(
      'mlx-server takes --draft-kind dflash|mtp; core also passes eagle3: that launch fails'
    )
    // A flag that stops listing choices at all: argparse would take any value, the check cannot tell.
    const free = parseMlxHelp(
      HELP.replaceAll('--kv-quant-scheme {uniform,turboquant}', '--kv-quant-scheme SCHEME')
    )
    expect(ids(checkMlxHelp(contract, free), 'break')).toEqual(['help.choices/--kv-quant-scheme'])
  })

  it('fails closed on something that is not its help screen', () => {
    expect(
      ids(checkMlxHelp(contract, parseMlxHelp('mlx-server: error: unrecognized arguments')), 'error')
    ).toEqual(['help.parse'])
    // Another program's argparse screen.
    expect(
      ids(checkMlxHelp(contract, parseMlxHelp(HELP.replace('usage: mlx-server', 'usage: other'))), 'error')
    ).toEqual(['help.parse'])
  })

  it('lists what changed since the pin among the flags core never passes, and the choices of those it does', () => {
    expect(diffMlxHelp(parseMlxHelp(PIN_HELP), help, contract).map((f) => [f.id, f.evidence])).toEqual([
      [
        'help.diff/added-flags',
        {
          flags: [
            '--decision-model',
            '--expert-cache-gb',
            '--max-pixels',
            '--mesh-model',
            '--min-pixels',
            '--model-dir',
          ],
        },
      ],
    ])
    const moreKinds = parseMlxHelp(HELP.replaceAll('{dflash,eagle3,mtp}', '{dflash,eagle3,medusa,mtp}'))
    expect(diffMlxHelp(help, moreKinds, contract).map((f) => [f.id, f.message])).toEqual([
      ['help.diff/choices--draft-kind', '--draft-kind choices: +medusa'],
    ])
  })
})

describe('the install probe and what the archive unpacks to', () => {
  const ran = (status: number | null, output = HELP) => ({ argv: ['--help'], status, output })

  it('is quiet on a build whose --help exits 0 with argparse’s usage line', () => {
    expect(checkMlxProbe(contract, ran(0))).toEqual([])
    expect(checkMlxProbe(contract, ran(0, PIN_HELP))).toEqual([])
  })

  it('breaks on another exit or another screen, and is an error when it did not run', () => {
    expect(checkMlxProbe(contract, ran(2))[0]).toMatchObject({
      id: 'install.probe/--help',
      severity: 'break',
      message: 'mlx-server --help exits 2: the archive installs on no Mac',
    })
    expect(checkMlxProbe(contract, ran(0, 'Traceback (most recent call last):'))[0]?.message).toBe(
      'mlx-server --help prints no /usage:\\s*mlx-server/: the archive installs on no Mac'
    )
    expect(ids(checkMlxProbe(contract, undefined), 'error')).toEqual(['install.probe'])
  })

  it('wants mlx-server alone at the root of the archive', () => {
    expect(checkMlxArchive(contract, ['mlx-server'])).toEqual([])
    expect(checkMlxArchive(contract, ['dist'])[0]).toMatchObject({
      id: 'archive.layout',
      severity: 'break',
      message: 'the archive unpacks to dist, not mlx-server: the install finds no mlx-server at its root',
    })
    expect(ids(checkMlxArchive(contract, ['mlx-server', 'requirements.lock.txt']), 'break')).toEqual([
      'archive.layout',
    ])
    expect(ids(checkMlxArchive(contract, undefined), 'error')).toEqual(['archive.layout'])
  })
})

describe('the archive', () => {
  it('the fork’s v0.7.12 against the pin: the same archive, nothing lost, the lock file not counted', () => {
    expect(
      checkMlxAssets(contract, {
        candidate: { tag: FORK.tag, assets: names(FORK) },
        pin: { tag: PIN.tag, assets: names(PIN) },
      })
    ).toEqual([])
    expect(mlxCoreAssets(contract, FORK.tag, names(FORK))).toEqual(['mlxvlm-mlx-server-macos-arm64.tar.gz'])
  })

  it('breaks on a release without it, or with two', () => {
    const check = (assets: string[]) =>
      checkMlxAssets(contract, {
        candidate: { tag: 'v0.7.13', assets },
        pin: { tag: PIN.tag, assets: names(PIN) },
      })
    expect(ids(check(['requirements.lock.txt']), 'break')).toEqual([
      'assets.core_backends/macos-arm64/macos-arm64',
    ])
    expect(check(['requirements.lock.txt'])[0]?.message).toBe(
      'no macos-arm64 archive in v0.7.13: macos-arm64 gets no mlx-server'
    )
    // Another archive no backend takes is only listed.
    expect(ids(check([...names(FORK), 'mlxvlm-mlx-server-macos-x64.tar.gz']), 'info')).toEqual([
      'assets.core_backends/unconsumed',
    ])
  })
})

describe('a complete release', () => {
  it('the fork’s: its archive up with a digest, whatever the tag', () => {
    for (const r of [FORK, PIN])
      expect(mlxCompleteness({ contract, tag: r.tag, assets: r.assets, platforms: ['macos-arm64'] })).toEqual(
        {
          complete: true,
          missing: [],
        }
      )
    const uploading = FORK.assets.map((a) => (a.name.endsWith('.tar.gz') ? { ...a, digest: null } : a))
    expect(
      mlxCompleteness({ contract, tag: FORK.tag, assets: uploading, platforms: ['macos-arm64'] }).missing
    ).toEqual([{ kind: 'digest', backend: 'macos-arm64', name: 'mlxvlm-mlx-server-macos-arm64.tar.gz' }])
    expect(mlxCompleteness({ contract, tag: 'latest', assets: [] }).missing).toEqual([
      { kind: 'tag', tag: 'latest' },
    ])
  })

  it('on conf: the staging manifest names the tag, downloads from conf and pins exactly the release’s bytes', () => {
    const complete = (manifest: unknown, assets = MIRROR.assets) =>
      mlxCompleteness({
        contract,
        tag: MIRROR.tag,
        assets,
        platforms: ['macos-arm64'],
        manifest,
        downloadBase: CONF_BASE,
      })
    expect(complete(STAGING)).toEqual({ complete: true, missing: [] })
    expect(complete({ ...STAGING, tag_name: 'mlxvlm-macos-arm64-0123456' }).missing).toEqual([
      { kind: 'manifest', reason: 'the staging manifest names mlxvlm-macos-arm64-0123456' },
    ])
    expect(complete(null).missing).toEqual([
      { kind: 'manifest', reason: 'conf has no staging manifest core reads' },
    ])
    // Still the fork's release in the manifest: the core would not download what was checked.
    expect(complete({ ...STAGING, upstream_repo: 'AtomicBot-ai/mlx-vlm' }).missing).toEqual([
      {
        kind: 'manifest',
        reason: `the staging manifest downloads from https://github.com/AtomicBot-ai/mlx-vlm/releases/download, not ${CONF_BASE}`,
      },
    ])
    const rebuilt = MIRROR.assets.map((a) => (a.name.endsWith('.tar.gz') ? { ...a, size: a.size + 1 } : a))
    expect(complete(STAGING, rebuilt).missing).toEqual([
      {
        kind: 'manifest-asset',
        backend: 'macos-arm64',
        name: 'mlxvlm-mlx-server-macos-arm64.tar.gz',
        reason: 'size 254933852 in the release, 254933851 in the manifest',
      },
    ])
  })

  it('names the upstream tag a build is based on only where conf’s manifest naming it says', () => {
    expect(mlxManifestUpstreamTagFor([STAGING, LIVE], MIRROR.tag)).toBe('v0.7.12')
    // conf main's live manifest predates upstream_tag.
    expect(mlxManifestUpstreamTagFor([STAGING, LIVE], PIN.tag)).toBeNull()
    expect(mlxManifestUpstreamTagFor([undefined, undefined], MIRROR.tag)).toBeNull()
  })
})

describe('the manifest the install test installs from', () => {
  const doc = (r: typeof FORK) =>
    mlxInstallManifest({ contract, tag: r.tag, repo: r.repo, assets: r.assets, updatedAt: r.published_at })

  it('is conf’s live manifest for the fork build it pins, field for field', () => {
    const { $schema: _schema, ...live } = LIVE
    expect(doc(PIN)).toEqual(live)
    expect(parseMlxManifest(doc(PIN))).toEqual(parseMlxManifest(LIVE))
  })

  it('is conf’s staging manifest for conf’s mirror, downloading the mirror’s release', () => {
    const parsed = parseMlxManifest(doc(MIRROR))
    expect(parsed).toEqual(parseMlxManifest(STAGING))
    const choice = mlxHostChoice({ os: 'macos', arch: 'arm64' }, parsed)
    const asset = parsed.assets.find((a) => a.backend === choice.backend_id)
    expect(asset).toBeDefined()
    expect(mlxAssetUrl(parsed, asset as NonNullable<typeof asset>)).toBe(
      `${CONF_BASE}/${MIRROR.tag}/mlxvlm-mlx-server-macos-arm64.tar.gz`
    )
  })

  it('is one no core reads for the fork’s release of an upstream tag: cores install the mirror’s name only', () => {
    expect(doc(FORK)).toMatchObject({ upstream_repo: 'AtomicBot-ai/mlx-vlm', tag_name: 'v0.7.12' })
    expect(() => parseMlxManifest(doc(FORK))).toThrow('tag_name')
  })

  it('takes the Apple Silicon archive for the live run, and none elsewhere', () => {
    expect(mlxHostArchive(contract, FORK.tag, FORK.assets, 'macos-arm64').asset.name).toBe(
      'mlxvlm-mlx-server-macos-arm64.tar.gz'
    )
    expect(() => mlxHostArchive(contract, FORK.tag, FORK.assets, 'linux-x64')).toThrow(
      'mlx-server ships no CPU build for linux-x64'
    )
  })
})

describe('the MLX surface report', () => {
  const side = (r: typeof FORK, help: string, upstreamTag: string | null) => ({
    tag: r.tag,
    repo: r.repo,
    source: 'release' as const,
    platform: 'macos-arm64',
    help_text: help,
    invocations: [{ bin: 'mlx-server', argv: ['--help'], status: 0 }],
    archive_entries: ['mlx-server'],
    assets: names(r),
    ...(upstreamTag ? { upstream: { tag: upstreamTag, commit: null, published_at: null } } : {}),
  })

  it('the fork’s v0.7.12 against the pin: a pass, the new flags as info', () => {
    const report = buildMlxReport(
      { ...contract, engine: 'mlx' },
      {
        candidate: side(FORK, HELP, 'v0.7.12'),
        pin: side(PIN, PIN_HELP, null),
        pin_resolution: { source: 'mlx-manifest', tag: PIN.tag },
        upstream: { available: false, reason: 'the pin names no commit' },
      },
      { now: '2026-11-12T00:00:00Z' }
    )
    expect(report.schema).toBe('atomic-engine-surface-report')
    expect(report.engine).toBe('mlx')
    expect(report.status).toBe('pass')
    expect(report.counts.break + report.counts.warn + report.counts.error).toBe(0)
    expect(report.checks.map((c) => c.id)).toEqual(MLX_CHECKS.map((c) => c.id))
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true)
    expect(report.inputs.candidate).toMatchObject({
      tag: 'v0.7.12',
      commit: null,
      upstream: { tag: 'v0.7.12' },
    })
    const md = renderMarkdown(report)
    expect(md.split('\n')[0]).toBe('# mlx-server surface: v0.7.12 against mlxvlm-macos-arm64-07ba5a1 — PASS')
    expect(md).toContain("- Pin: conf's MLX manifest")
  })

  it('without a pin the help diff is skipped; a lost flag, a failing probe or a nested archive fails it', () => {
    const report = buildMlxReport(contract, {
      candidate: {
        ...side(FORK, without(HELP.replace(' [--max-kv-size MAX_KV_SIZE]', ''), /^ {2}--max-kv-size /), null),
        invocations: [{ bin: 'mlx-server', argv: ['--help'], status: 1, output: 'Traceback' }],
        archive_entries: ['mlx-server-dir'],
      },
      pin: null,
    })
    expect(report.status).toBe('break')
    expect(ids(report.findings, 'break')).toEqual([
      'archive.layout',
      'help.required_flags/--max-kv-size',
      'install.probe/--help',
      'invocations.exit/mlx-server --help',
    ])
    expect(report.checks.find((c) => c.id === 'help.diff')).toMatchObject({
      status: 'skipped',
      skipped: 'no pin',
    })
  })

  it('is an error, not a pass, when the candidate could not be run', () => {
    const report = buildMlxReport(contract, {
      candidate: { tag: FORK.tag, source: 'release', capture_error: 'fetch failed', assets: names(FORK) },
      pin: null,
    })
    expect(report.status).toBe('error')
    expect(ids(report.findings, 'error')).toEqual([
      'archive.layout',
      'help.parse',
      'install.probe',
      'invocations.exit',
    ])
  })
})
